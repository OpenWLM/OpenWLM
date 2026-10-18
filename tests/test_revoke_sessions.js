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
 * « Déconnecter mes autres sessions » (POST /api/sessions/revoke-others) : les autres
 * appareils sont coupés (connexion temps réel + Push), l'appareil courant reste connecté avec
 * un nouveau cookie. Serveur de test dédié + base temporaire — jamais la prod.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, '../server/index.js');
const JWT_SECRET = crypto.randomBytes(32).toString('hex');

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
    res.on('end', () => { let d; try { d = JSON.parse(raw); } catch { d = raw; } resolve({ status: res.statusCode, data: d, headers: res.headers }); });
  });
  req.on('error', () => resolve({ status: 0 }));
  if (postData) req.write(postData);
  req.end();
});
const tok = (id, tv = 0) => jwt.sign({ id, tv }, JWT_SECRET, { expiresIn: '1h' });
const connect = (id, token = tok(id)) => new Promise((resolve, reject) => {
  const s = ClientIO(`http://127.0.0.1:${port}`, { auth: { token }, transports: ['websocket'], forceNew: true, reconnection: false });
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwlm-revoke-'));
  port = await getFreePort();
  serverProc = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: tmpDir,
    env: { ...process.env, PORT: String(port), JWT_SECRET, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitForPort(port);

  withDb((db) => {
    const insert = db.prepare("INSERT INTO users (username, nickname, status, password_hash, salt, token_version) VALUES (?, ?, 'online', 'h', 's', 0)");
    aliceId = Number(insert.run('rv_alice', 'Alice').lastInsertRowid);
    bobId = Number(insert.run('rv_bob', 'Bob').lastInsertRowid);
    const push = db.prepare('INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)');
    push.run(aliceId, 'https://push.example/alice-pc', 'k', 'a', Date.now());
    push.run(aliceId, 'https://push.example/alice-phone', 'k', 'a', Date.now());
    push.run(bobId, 'https://push.example/bob', 'k', 'a', Date.now());
  });
});

after(async () => {
  if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM');
  await sleep(200);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});


const once = (s, ev, ms = 4000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`Timeout ${ev}`)), ms);
  s.once(ev, (...args) => { clearTimeout(t); resolve(args); });
});
const cookieToken = (headers) => {
  const c = [].concat(headers['set-cookie'] || []).find((x) => x.startsWith('token='));
  return c ? c.slice(6, c.indexOf(';')) : null;
};

test('sans authentification → 401', async () => {
  const r = await reqJson('/api/sessions/revoke-others', 'POST', null, {});
  assert.equal(r.status, 401);
});

test('les autres appareils sont coupés, celui-ci reste connecté avec un nouveau cookie', async () => {
  const current = await connect(aliceId);
  const other = await connect(aliceId);
  const bob = await connect(bobId);
  try {
    const revoked = once(other, 'session_revoked');
    const otherDown = once(other, 'disconnect');
    const r = await reqJson('/api/sessions/revoke-others', 'POST', tok(aliceId), { socketId: current.id, keepPushEndpoint: 'https://push.example/alice-pc' });
    assert.equal(r.status, 200);
    assert.equal(r.data.disconnected, 1);
    assert.equal(r.data.pushRemoved, 1);
    await revoked;
    await otherDown;
    await sleep(300);
    assert.equal(current.connected, true, "l'appareil courant doit rester connecté");
    assert.equal(bob.connected, true, 'les autres comptes ne sont pas touchés');
    assert.ok(!current.events.some((e) => e.name === 'session_revoked'));

    // Ancien jeton : refusé avec un code lisible par le client (HTTP et temps réel)
    const oldMe = await reqJson('/api/user/me', 'GET', tok(aliceId));
    assert.equal(oldMe.status, 401);
    assert.equal(oldMe.data.code, 'session_revoked');
    const err = await connect(aliceId).then(() => null, (e) => e);
    assert.equal(err?.data?.code, 'session_revoked');

    // Nouveau cookie : valide partout
    const fresh = cookieToken(r.headers);
    assert.ok(fresh, 'nouveau cookie attendu');
    assert.equal((await reqJson('/api/user/me', 'GET', fresh)).status, 200);
    const again = await connect(aliceId, fresh);
    again.close();

    // Push : seul l'abonnement de cet appareil reste (ceux de Bob intacts)
    const subs = withDb((db) => db.prepare('SELECT user_id, endpoint FROM push_subscriptions ORDER BY endpoint').all());
    assert.deepEqual(subs.map((x) => x.endpoint), ['https://push.example/alice-pc', 'https://push.example/bob']);
  } finally {
    current.close(); other.close(); bob.close();
  }
});

test('limité à 10 demandes par quart d\'heure et par compte', async () => {
  let token = tok(bobId, 0);
  let last;
  for (let i = 0; i < 11; i++) {
    last = await reqJson('/api/sessions/revoke-others', 'POST', token, {});
    if (last.status === 200) token = cookieToken(last.headers);
    else break;
  }
  assert.equal(last.status, 429);
});
