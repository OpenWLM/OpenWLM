import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import { io as ClientIO } from 'socket.io-client';

/**
 * GET /api/conversations/pending : conversations ayant des messages jamais remis
 * (reçus pendant que le destinataire était hors ligne). Serveur de test dédié + base
 * temporaire — jamais la prod.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, '../server/index.js');
const JWT_SECRET = crypto.randomBytes(32).toString('hex');

let serverProc;
let tmpDir;
let port;
let aliceId;
let bobId;
let charlieId;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getFreePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.listen(0, () => { const { port: p } = srv.address(); srv.close(() => resolve(p)); });
  srv.on('error', reject);
});
const waitForPort = async (p, timeoutMs = 15000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const s = net.connect(p, '127.0.0.1', () => { s.end(); resolve(true); });
      s.on('error', () => resolve(false));
    });
    if (ok) return;
    await sleep(150);
  }
  throw new Error(`Serveur non démarré sur le port ${p}`);
};
const reqJson = (apiPath, method, token, body) => new Promise((resolve) => {
  const postData = body !== undefined ? JSON.stringify(body) : '';
  const headers = {};
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(postData); }
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const req = http.request({ hostname: '127.0.0.1', port, path: apiPath, method, headers }, (res) => {
    let raw = '';
    res.on('data', (c) => { raw += c; });
    res.on('end', () => { let d; try { d = JSON.parse(raw); } catch { d = raw; } resolve({ status: res.statusCode, data: d }); });
  });
  req.on('error', () => resolve({ status: 0 }));
  if (postData) req.write(postData);
  req.end();
});
const tok = (id) => jwt.sign({ id, tv: 0 }, JWT_SECRET, { expiresIn: '1h' });
const connect = (id) => new Promise((resolve, reject) => {
  const s = ClientIO(`http://127.0.0.1:${port}`, { auth: { token: tok(id) }, transports: ['websocket'], forceNew: true, reconnection: false });
  s.events = [];
  s.onAny((name, payload) => s.events.push({ name, payload }));
  s.once('connect', () => resolve(s));
  s.once('connect_error', reject);
  setTimeout(() => reject(new Error('Timeout socket')), 3000);
});
const send = (s, senderId, receiverId, extra = {}) => new Promise((resolve) => {
  s.emit('send_message', { senderId, receiverId, text: `m_${crypto.randomUUID()}`, type: 'text', ...extra }, resolve);
});
const withDb = (fn) => {
  const db = new Database(path.join(tmpDir, 'messenger.db'));
  try { return fn(db); } finally { db.close(); }
};
const pendingOf = async (id) => reqJson('/api/conversations/pending', 'GET', tok(id));

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwlm-convpriv-'));
  port = await getFreePort();
  serverProc = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: tmpDir,
    env: { ...process.env, PORT: String(port), JWT_SECRET, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitForPort(port);

  withDb((db) => {
    const insert = db.prepare("INSERT INTO users (username, nickname, status, password_hash, salt, token_version) VALUES (?, ?, 'online', 'h', 's', 0)");
    aliceId = Number(insert.run('cp_alice', 'Alice').lastInsertRowid);
    bobId = Number(insert.run('cp_bob', 'Bob').lastInsertRowid);
    charlieId = Number(insert.run('cp_charlie', 'Charlie').lastInsertRowid);
    const contact = db.prepare('INSERT INTO contacts (user_id, contact_id, status, blocked) VALUES (?, ?, 1, 0)');
    // Alice <-> Bob et Bob <-> Charlie sont contacts ; Alice et Charlie ne le sont pas.
    contact.run(aliceId, bobId); contact.run(bobId, aliceId);
    contact.run(bobId, charlieId); contact.run(charlieId, bobId);
  });
});

after(async () => {
  if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM');
  await sleep(200);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('messages reçus hors ligne listés, puis retirés une fois l\'historique chargé', async () => {
  const b = await connect(bobId);
  const c = await connect(charlieId);
  try {
    // Alice est hors ligne ; Bob et Charlie (non-contact d'Alice) lui écrivent
    assert.equal((await send(b, bobId, aliceId)).success, true);
    assert.equal((await send(b, bobId, aliceId)).success, true);
    // Charlie n'est pas contact d'Alice : envoi refusé par canInteract, rien de listé
    await send(c, charlieId, aliceId);

    const pending = await pendingOf(aliceId);
    assert.equal(pending.status, 200);
    assert.deepEqual(pending.data.map((r) => r.contactId), [bobId]);
    assert.equal(pending.data[0].count, 2);

    // Bob ne voit pas les messages en attente d'Alice (ce sont les siens, envoyés)
    assert.deepEqual((await pendingOf(bobId)).data, []);

    // Alice charge l'historique : les messages passent « remis », plus rien en attente
    const hist = await reqJson(`/api/messages/${aliceId}/${bobId}`, 'GET', tok(aliceId));
    assert.equal(hist.status, 200);
    assert.deepEqual((await pendingOf(aliceId)).data, []);
  } finally { b.disconnect(); c.disconnect(); }
});

test('contact bloqué : ses messages non remis ne rouvrent pas d\'onglet', async () => {
  const b = await connect(bobId);
  try {
    assert.equal((await send(b, bobId, aliceId)).success, true);
    withDb((db) => db.prepare('UPDATE contacts SET blocked = 1 WHERE user_id = ? AND contact_id = ?').run(aliceId, bobId));
    assert.deepEqual((await pendingOf(aliceId)).data, []);
    withDb((db) => db.prepare('UPDATE contacts SET blocked = 0 WHERE user_id = ? AND contact_id = ?').run(aliceId, bobId));
    assert.equal((await pendingOf(aliceId)).data.length, 1);
  } finally { b.disconnect(); }
});

test('authentification requise', async () => {
  assert.equal((await reqJson('/api/conversations/pending', 'GET', null)).status, 401);
});
