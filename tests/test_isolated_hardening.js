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
 * Tests ISOLÉS (serveur de test dédié + base temporaire — jamais la prod) pour les correctifs :
 *  - P1 push : un endpoint appartenant à un autre compte n'est pas réattribué (409) ;
 *  - P1 push : endpoint non-HTTPS/privé rejeté ;
 *  - P1 socket : manual_disconnect ferme réellement la socket ;
 *  - P2 keys : remplacement de clés exige la preuve du mot de passe.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, '../server/index.js');
const JWT_SECRET = crypto.randomBytes(32).toString('hex');
const PWD = crypto.randomBytes(32).toString('hex');
const hashPwd = (hex, salt) => crypto.pbkdf2Sync(hex, salt, 210000, 64, 'sha512').toString('hex');

let serverProc;
let tmpDir;
let port;
let aliceId;
let bobId;

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
    await new Promise((r) => setTimeout(r, 150));
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

const connect = (token) => new Promise((resolve, reject) => {
  const s = ClientIO(`http://127.0.0.1:${port}`, { auth: { token }, transports: ['websocket'], forceNew: true, reconnection: false });
  s.once('connect', () => resolve(s));
  s.once('connect_error', reject);
  setTimeout(() => reject(new Error('Timeout socket')), 3000);
});
const tok = (id, tv = 0) => jwt.sign({ id, tv }, JWT_SECRET, { expiresIn: '1h' });

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwlm-iso-'));
  port = await getFreePort();
  serverProc = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: tmpDir,
    env: { ...process.env, PORT: String(port), JWT_SECRET, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitForPort(port);

  const db = new Database(path.join(tmpDir, 'messenger.db'));
  const salt = crypto.randomBytes(16).toString('hex');
  const insert = db.prepare("INSERT INTO users (username, nickname, status, password_hash, salt, token_version) VALUES (?, ?, 'online', ?, ?, 0)");
  aliceId = Number(insert.run('iso_alice', 'Alice', hashPwd(PWD, salt), salt).lastInsertRowid);
  bobId = Number(insert.run('iso_bob', 'Bob', hashPwd(PWD, salt), salt).lastInsertRowid);
  db.close();
});

after(async () => {
  if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('P1 push : un endpoint d’un autre compte n’est pas réattribué (409)', async () => {
  const endpoint = 'https://fcm.googleapis.com/fcm/send/iso-test-1';
  const a = await reqJson('/api/push/subscribe', 'POST', tok(aliceId), { subscription: { endpoint, keys: { p256dh: 'x', auth: 'y' } } });
  assert.equal(a.status, 200, 'A s’abonne');
  const b = await reqJson('/api/push/subscribe', 'POST', tok(bobId), { subscription: { endpoint, keys: { p256dh: 'x', auth: 'y' } } });
  assert.equal(b.status, 409, 'B ne peut pas réattribuer l’endpoint de A');
  // Le propriétaire peut renouveler
  const a2 = await reqJson('/api/push/subscribe', 'POST', tok(aliceId), { subscription: { endpoint, keys: { p256dh: 'x', auth: 'y' } } });
  assert.equal(a2.status, 200, 'A renouvelle son abonnement');
});

test('P1 push : endpoint non-HTTPS/privé rejeté', async () => {
  assert.equal((await reqJson('/api/push/subscribe', 'POST', tok(aliceId), { subscription: { endpoint: 'http://localhost:9/x' } })).status, 400);
  assert.equal((await reqJson('/api/push/subscribe', 'POST', tok(aliceId), { subscription: { endpoint: 'https://127.0.0.1/x' } })).status, 400);
});

test('P1 socket : manual_disconnect ferme réellement la socket', async () => {
  const s = await connect(tok(bobId));
  const disconnected = new Promise((resolve) => {
    s.once('disconnect', () => resolve(true));
    setTimeout(() => resolve(false), 2500);
  });
  s.emit('manual_disconnect');
  assert.equal(await disconnected, true, 'la socket doit être coupée par le serveur');
});

test('P2 keys : remplacement de clés exige la preuve du mot de passe', async () => {
  const jwk = (n) => ({ kty: 'RSA', n: 'A'.repeat(200) + n, e: 'AQAB' });
  const vault = { encryptedKeyBase64: 'A'.repeat(100), ivBase64: 'A'.repeat(16) };
  const t = tok(aliceId);
  assert.equal((await reqJson('/api/user/keys', 'POST', t, { publicKey: jwk('a'), encryptedPrivateKey: vault })).status, 200, 'première installation');
  assert.equal((await reqJson('/api/user/keys', 'POST', t, { publicKey: jwk('b'), encryptedPrivateKey: vault })).status, 403, 'remplacement sans mot de passe refusé');
  assert.equal((await reqJson('/api/user/keys', 'POST', t, { publicKey: jwk('b'), encryptedPrivateKey: vault, authKeyHex: PWD })).status, 200, 'remplacement avec mot de passe accepté');
});
