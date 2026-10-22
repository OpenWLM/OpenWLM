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
 * Durcissements de la revue du 2026-10-22 :
 * - réinitialisation d'urgence des clés E2E : les cibles Push (Web Push, FCM) de tous les
 *   appareils du compte disparaissent, y compris ceux hors ligne au moment du reset ;
 * - blocage : seulement un contact existant (pas d'événement de statut vers un identifiant
 *   arbitraire), déblocage toujours possible ;
 * - modifications de profil / mode privé limitées par compte (diffusées à tous les contacts).
 * Serveur de test dédié + base temporaire.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, '../server/index.js');
const JWT_SECRET = crypto.randomBytes(32).toString('hex');
const pbkdf2 = (key, salt) => crypto.pbkdf2Sync(key, salt, 210000, 64, 'sha512').toString('hex');
const AUTH_KEY = crypto.randomBytes(32).toString('hex');
const SALT = crypto.randomBytes(16).toString('hex');
let carolId;
let malloryId;

let serverProc;
let tmpDir;
let port;
let aliceId;
let bobId;

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
const withDb = (fn) => {
  const db = new Database(path.join(tmpDir, 'messenger.db'));
  try { return fn(db); } finally { db.close(); }
};
const tok = (id) => jwt.sign({ id, tv: withDb((db) => db.prepare('SELECT token_version FROM users WHERE id = ?').get(id).token_version || 0) }, JWT_SECRET, { expiresIn: '1h' });

const connect = (id) => new Promise((resolve, reject) => {
  const s = ClientIO(`http://127.0.0.1:${port}`, { auth: { token: tok(id) }, transports: ['websocket'], forceNew: true, reconnection: false });
  s.events = [];
  s.onAny((name, payload) => s.events.push({ name, payload }));
  s.once('connect', () => resolve(s));
  s.once('connect_error', reject);
  setTimeout(() => reject(new Error('Timeout socket')), 3000);
});

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwlm-hardening-'));
  port = await getFreePort();
  serverProc = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: tmpDir,
    env: { ...process.env, PORT: String(port), JWT_SECRET, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitForPort(port);
  withDb((db) => {
    const insert = db.prepare("INSERT INTO users (username, nickname, status, password_hash, salt, token_version) VALUES (?, ?, 'online', ?, ?, 0)");
    aliceId = Number(insert.run('hd_alice', 'Alice', pbkdf2(AUTH_KEY, SALT), SALT).lastInsertRowid);
    bobId = Number(insert.run('hd_bob', 'Bob', 'h', 's').lastInsertRowid);
    carolId = Number(insert.run('hd_carol', 'Carol', 'h', 's').lastInsertRowid);
    malloryId = Number(insert.run('hd_mallory', 'Mallory', 'h', 's').lastInsertRowid);
    // Alice et Bob sont contacts (dans les deux sens) ; Mallory n'est contact de personne
    const contact = db.prepare('INSERT INTO contacts (user_id, contact_id) VALUES (?, ?)');
    contact.run(aliceId, bobId);
    contact.run(bobId, aliceId);
  });
});

after(async () => {
  if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM');
  await sleep(200);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('réinitialisation E2E : plus aucune cible Push pour le compte, même hors ligne', async () => {
  withDb((db) => {
    db.prepare('INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)').run(aliceId, 'https://push.example/alice-offline-pc', 'k', 'a', Date.now());
    db.prepare('INSERT INTO fcm_tokens (user_id, token, created_at) VALUES (?, ?, ?)').run(aliceId, `alice-offline-phone:APA91b${'x'.repeat(30)}`, Date.now());
    db.prepare('INSERT INTO fcm_tokens (user_id, token, created_at) VALUES (?, ?, ?)').run(bobId, `bob-phone:APA91b${'x'.repeat(30)}`, Date.now());
  });
  const r = await reqJson('/api/user/reset-e2e-keys', 'POST', tok(aliceId), {
    authKeyHex: AUTH_KEY,
    publicKey: { kty: 'RSA', n: 'A'.repeat(342), e: 'AQAB' },
    encryptedPrivateKey: { encryptedKeyBase64: 'A'.repeat(512), ivBase64: 'A'.repeat(16) }
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const counts = withDb((db) => ({
    web: db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(aliceId).n,
    fcm: db.prepare('SELECT COUNT(*) AS n FROM fcm_tokens WHERE user_id = ?').get(aliceId).n,
    bob: db.prepare('SELECT COUNT(*) AS n FROM fcm_tokens WHERE user_id = ?').get(bobId).n
  }));
  assert.deepEqual(counts, { web: 0, fcm: 0, bob: 1 });
});

test('blocage : identifiant invalide → 400, non-contact → 404 sans aucun événement', async () => {
  assert.equal((await reqJson('/api/contacts/block', 'POST', tok(malloryId), { contactId: 'abc', block: true })).status, 400);
  assert.equal((await reqJson('/api/contacts/block', 'POST', tok(malloryId), { contactId: malloryId, block: true })).status, 400);
  const carol = await connect(carolId);
  try {
    const r = await reqJson('/api/contacts/block', 'POST', tok(malloryId), { contactId: carolId, block: true });
    assert.equal(r.status, 404);
    await sleep(400);
    assert.ok(!carol.events.some((e) => e.name === 'user_status_changed'), 'aucun événement de statut vers un non-contact');
  } finally {
    carol.disconnect();
  }
});

test('blocage puis déblocage d\'un vrai contact : 200 et événement de statut', async () => {
  const bob = await connect(bobId);
  try {
    const blockRes = await reqJson('/api/contacts/block', 'POST', tok(aliceId), { contactId: bobId, block: true });
    assert.equal(blockRes.status, 200);
    const unblockRes = await reqJson('/api/contacts/block', 'POST', tok(aliceId), { contactId: bobId, block: false });
    assert.equal(unblockRes.status, 200, 'le déblocage reste possible');
    await sleep(300);
    const statuses = bob.events.filter((e) => e.name === 'user_status_changed' && e.payload?.userId === aliceId);
    assert.equal(statuses.length, 2);
    assert.equal(statuses[0].payload.status, 'offline');
  } finally {
    bob.disconnect();
  }
});

test('profil et mode privé : 30 modifications par minute et par compte, puis 429', async () => {
  const token = tok(bobId);
  for (let i = 0; i < 20; i++) {
    assert.equal((await reqJson('/api/user/update', 'POST', token, { psm: `psm ${i}` })).status, 200);
  }
  for (let i = 0; i < 10; i++) {
    assert.equal((await reqJson('/api/user/global-private', 'POST', token, { globalPrivate: i % 2 === 0 })).status, 200);
  }
  const limited = await reqJson('/api/user/update', 'POST', token, { status: 'busy' });
  assert.equal(limited.status, 429);
  assert.equal(limited.data.code, 'profile_rate_limited');
  assert.equal((await reqJson('/api/user/global-private', 'POST', token, { globalPrivate: false })).status, 429);
  // Les autres comptes ne sont pas touchés
  assert.equal((await reqJson('/api/user/update', 'POST', tok(carolId), { psm: 'ok' })).status, 200);
});
