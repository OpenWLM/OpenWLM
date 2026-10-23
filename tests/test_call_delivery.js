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
 * Remise des appels : « ça sonne » côté appelant UNIQUEMENT quand un appareil de l'appelé a
 * confirmé la réception ; sinon réveil (Push) et appel redonné à l'appareil qui se reconnecte.
 * Serveur de test dédié + base temporaire — jamais la prod (Push non configuré : pushed=false).
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
const withDb = (fn) => {
  const db = new Database(path.join(tmpDir, 'messenger.db'));
  try { return fn(db); } finally { db.close(); }
};
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


const once = (s, ev, ms = 6000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`Timeout ${ev}`)), ms);
  s.once(ev, (...args) => { clearTimeout(t); resolve(args); });
});
const none = (s, ev, ms) => new Promise((resolve, reject) => {
  const h = () => reject(new Error(`${ev} reçu alors qu'il ne devait pas l'être`));
  s.once(ev, h);
  setTimeout(() => { s.off(ev, h); resolve(); }, ms);
});
const call = (caller, target) => caller.emit('call_request', { target, signal: 'offre-chiffree', audioOnly: true });

test('« ça sonne » seulement après l\'accusé de réception de l\'appelé', async () => {
  const a = await connect(aliceId);
  const b = await connect(bobId);
  try {
    b.on('incoming_call', (_data, ack) => setTimeout(() => ack({ ok: true }), 700));
    const t0 = Date.now();
    const ringing = once(a, 'call_ringing');
    call(a, bobId);
    await ringing;
    assert.ok(Date.now() - t0 >= 650, 'call_ringing attend l\'accusé');
    a.emit('end_call', { target: bobId });
  } finally { a.disconnect(); b.disconnect(); }
});

test('appareil « fantôme » (pas d\'accusé) : pas de sonnerie annoncée, réveil, puis appel redonné à la reconnexion', async () => {
  const a = await connect(aliceId);
  const zombie = await connect(bobId);
  let b2 = null;
  try {
    zombie.on('incoming_call', () => { /* gelé : ne répond pas */ });
    const waking = once(a, 'call_waking', 7000);
    const noRing = none(a, 'call_ringing', 5000);
    call(a, bobId);
    const [w] = await waking;
    assert.equal(w.target, bobId);
    assert.equal(w.pushed, false, 'Push non configuré dans le serveur de test');
    await noRing;

    // Le téléphone se réveille : nouvelle connexion → l'appel en attente lui est présenté
    b2 = await connect(bobId);
    const ringing = once(a, 'call_ringing');
    const [incoming, ack] = await once(b2, 'incoming_call');
    assert.equal(incoming.caller, aliceId);
    assert.equal(incoming.signal, 'offre-chiffree', 'offre chiffrée conservée et redonnée');
    ack({ ok: true });
    await ringing;
    a.emit('end_call', { target: bobId });
  } finally { a.disconnect(); zombie.disconnect(); b2?.disconnect(); }
});

test('« Refuser » depuis la notification : POST /api/calls/decline', async () => {
  const a = await connect(aliceId);
  const zombie = await connect(bobId);
  try {
    zombie.on('incoming_call', () => {});
    call(a, bobId);
    await once(a, 'call_waking', 7000);
    // Un tiers ne peut pas refuser à la place de Bob
    assert.equal((await reqJson('/api/calls/decline', 'POST', tok(charlieId), { callerId: aliceId })).status, 403);
    const rejected = once(a, 'call_rejected');
    assert.equal((await reqJson('/api/calls/decline', 'POST', tok(bobId), { callerId: aliceId })).status, 200);
    const [r] = await rejected;
    assert.equal(r.by, bobId);
    assert.equal((await reqJson('/api/calls/decline', 'POST', tok(bobId), { callerId: aliceId })).status, 404, 'plus d\'appel en attente');
    assert.equal((await reqJson('/api/calls/decline', 'POST', tok(bobId), { callerId: 'x' })).status, 400);
  } finally { a.disconnect(); zombie.disconnect(); }
});

test('appelant qui raccroche pendant le réveil : l\'appel n\'est plus redonné', async () => {
  // Charlie appelle : Bob vient de refuser Alice (délai de 10 s avant un nouvel appel de sa part)
  const a = await connect(charlieId);
  const zombie = await connect(bobId);
  let b2 = null;
  try {
    zombie.on('incoming_call', () => {});
    call(a, bobId);
    await once(a, 'call_waking', 7000);
    a.emit('end_call', { target: bobId });
    await sleep(200);
    b2 = await connect(bobId);
    await none(b2, 'incoming_call', 1500);
  } finally { a.disconnect(); zombie.disconnect(); b2?.disconnect(); }
});

test('appelé hors ligne sans appareil réveillable : injoignable', async () => {
  const a = await connect(aliceId);
  try {
    await sleep(300);
    const unavailable = once(a, 'call_unavailable');
    call(a, bobId);
    await unavailable;
  } finally { a.disconnect(); }
});

test('retour au premier plan sans reconnexion (call_resync) : l\'appel en attente est redonné', async () => {
  // Charlie appelle : Bob vient de refuser Alice (délai de 10 s avant un nouvel appel de sa part)
  const a = await connect(charlieId);
  const b = await connect(bobId);
  try {
    // Page suspendue : la connexion survit mais l'appel n'est pas confirmé
    let frozen = true;
    const presented = [];
    b.on('incoming_call', (data, ack) => { presented.push(data); if (!frozen) ack({ ok: true }); });
    call(a, bobId);
    await once(a, 'call_waking', 7000);
    // La page revient au premier plan : elle redemande les appels en attente
    frozen = false;
    const ringing = once(a, 'call_ringing');
    b.emit('call_resync');
    await ringing;
    assert.equal(presented.length, 2);
    assert.equal(presented[1].signal, 'offre-chiffree');
    a.emit('end_call', { target: bobId });
  } finally { a.disconnect(); b.disconnect(); }
});

test('un seul appel présenté à la fois : un second appelant reçoit « occupé »', async () => {
  const a = await connect(aliceId);
  const c = await connect(charlieId);
  const b = await connect(bobId);
  try {
    b.on('incoming_call', (_d, ack) => ack({ ok: true }));
    const ringing = once(a, 'call_ringing');
    call(a, bobId);
    await ringing;
    const busy = once(c, 'call_busy');
    call(c, bobId);
    const [r] = await busy;
    assert.equal(r.target, bobId);
    // L'appel d'Alice terminé : Charlie peut appeler
    a.emit('end_call', { target: bobId });
    await sleep(200);
    const ringingC = once(c, 'call_ringing');
    call(c, bobId);
    await ringingC;
    c.emit('end_call', { target: bobId });
  } finally { a.disconnect(); b.disconnect(); c.disconnect(); }
});
