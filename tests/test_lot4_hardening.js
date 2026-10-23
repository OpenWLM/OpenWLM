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
 * Relecture d'octobre 2026, lot 4 (serveur isolé) :
 *  - verrouillage de connexion par identifiant ET adresse IP : un tiers ne bloque plus un compte ;
 *  - migration de la clé d'authentification (liée au serveur) : preuve de l'ancienne, sans
 *    toucher aux sessions ni au coffre ;
 *  - quota de stockage des messages par expéditeur.
 * Le serveur de test fait confiance à CF-Connecting-IP (CLOUDFLARE_IP_RANGES = boucle locale).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, '../server/index.js');
const JWT_SECRET = crypto.randomBytes(32).toString('hex');
const PWD_HEX = crypto.randomBytes(32).toString('hex');
const hashPwd = (hex, salt) => crypto.pbkdf2Sync(hex, salt, 210000, 64, 'sha512').toString('hex');
const TEST_QUOTA = 150 * 1024;

let serverProc;
let tmpDir;
let port;
let db;
let alice;
let bob;

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
const request = (apiPath, method, token, body, headers = {}) => new Promise((resolve) => {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const h = { ...headers };
  if (body !== undefined) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(payload); }
  if (token) h['Authorization'] = `Bearer ${token}`;
  const req = http.request({ hostname: '127.0.0.1', port, path: apiPath, method, headers: h }, (res) => {
    let raw = '';
    res.on('data', (c) => { raw += c; });
    res.on('end', () => { let d; try { d = JSON.parse(raw); } catch { d = raw; } resolve({ status: res.statusCode, data: d }); });
  });
  req.on('error', () => resolve({ status: 0 }));
  if (payload) req.write(payload);
  req.end();
});
const connect = (token) => new Promise((resolve, reject) => {
  const s = ClientIO(`http://127.0.0.1:${port}`, { auth: { token }, transports: ['websocket'], forceNew: true, reconnection: false });
  s.once('connect', () => resolve(s));
  s.once('connect_error', reject);
  setTimeout(() => reject(new Error('Timeout socket')), 3000);
});
const tok = (id) => jwt.sign({ id, tv: 0 }, JWT_SECRET, { expiresIn: '1h' });
const emitAck = (s, event, data) => new Promise((resolve) => s.emit(event, data, resolve));
const envelope = (mid, pad = 0) => JSON.stringify({ v: 2, mid, from: 1, to: 2, iv: 'AAAA', body: 'x'.repeat(pad), sig: 'AA' });
const login = (username, password, ip) => request('/api/login', 'POST', null, { username, password }, { 'CF-Connecting-IP': ip });

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwlm-lot4-'));
  port = await getFreePort();
  serverProc = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: tmpDir,
    env: { ...process.env, PORT: String(port), JWT_SECRET, NODE_ENV: 'test', CLOUDFLARE_IP_RANGES: '127.0.0.1/32,::1/128', OPENWLM_TEST_SENDER_STORAGE_QUOTA: String(TEST_QUOTA) },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  await waitForPort(port);
  db = new Database(path.join(tmpDir, 'messenger.db'));
  const salt = crypto.randomBytes(16).toString('hex');
  const insert = db.prepare("INSERT INTO users (username, nickname, status, password_hash, salt, token_version) VALUES (?, ?, 'online', ?, ?, 0)");
  alice = Number(insert.run('l4_alice', 'Alice', hashPwd(PWD_HEX, salt), salt).lastInsertRowid);
  bob = Number(insert.run('l4_bob', 'Bob', 'h', 's').lastInsertRowid);
  const c = db.prepare('INSERT INTO contacts (user_id, contact_id, status, blocked) VALUES (?, ?, 1, 0)');
  c.run(alice, bob); c.run(bob, alice);
});

after(async () => {
  try { db?.close(); } catch { /* ignore */ }
  if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM');
  await sleep(200);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('verrouillage de connexion : 10 échecs depuis une IP ne bloquent pas le compte depuis une autre', async () => {
  const wrong = 'f'.repeat(64);
  for (let i = 0; i < 10; i++) assert.equal((await login('l4_alice', wrong, '203.0.113.9')).status, 401);
  assert.equal((await login('l4_alice', wrong, '203.0.113.9')).status, 429, 'l’attaquant est bloqué');
  assert.equal((await login('l4_alice', PWD_HEX, '203.0.113.9')).status, 429, 'même avec le bon mot de passe, depuis son IP');
  const legit = await login('l4_alice', PWD_HEX, '198.51.100.7');
  assert.equal(legit.status, 200, `la propriétaire se connecte depuis chez elle : ${JSON.stringify(legit.data)}`);
});

test('migration de la clé d’authentification : preuve de l’ancienne, sessions et coffre inchangés', async () => {
  const before = db.prepare('SELECT token_version, encrypted_private_key FROM users WHERE id = ?').get(alice);
  const newKey = crypto.randomBytes(32).toString('hex');
  // Mauvaise ancienne clé : refusé
  assert.equal((await request('/api/user/migrate-auth-key', 'POST', tok(alice), { oldAuthKeyHex: 'e'.repeat(64), newAuthKeyHex: newKey })).status, 401);
  // Bonne ancienne clé : enregistrée
  assert.equal((await request('/api/user/migrate-auth-key', 'POST', tok(alice), { oldAuthKeyHex: PWD_HEX, newAuthKeyHex: newKey })).status, 200);
  assert.equal((await login('l4_alice', PWD_HEX, '198.51.100.8')).status, 401, 'l’ancienne clé ne passe plus');
  assert.equal((await login('l4_alice', newKey, '198.51.100.8')).status, 200, 'la nouvelle clé passe');
  const after = db.prepare('SELECT token_version, encrypted_private_key FROM users WHERE id = ?').get(alice);
  assert.equal(after.token_version, before.token_version, 'les sessions existantes restent valides');
  assert.equal(after.encrypted_private_key, before.encrypted_private_key, 'le coffre est inchangé');
  // Un autre compte ne peut pas migrer la clé d’Alice (jeton de Bob, preuve d’Alice)
  assert.equal((await request('/api/user/migrate-auth-key', 'POST', tok(bob), { oldAuthKeyHex: newKey, newAuthKeyHex: PWD_HEX })).status, 401);
});

test('quota de stockage par expéditeur : refus explicite une fois le quota atteint', async () => {
  const s = await connect(tok(alice));
  await sleep(100);
  let refused = null;
  for (let i = 0; i < 8; i++) {
    const r = await emitAck(s, 'send_message', { senderId: alice, receiverId: bob, text: envelope(`q${i}`, 40 * 1024), type: 'audio' });
    if (!r.success) { refused = r; break; }
  }
  assert.ok(refused, 'le quota (150 Ko) doit finir par refuser');
  assert.equal(refused.code, 'storage_quota');
  const stored = db.prepare('SELECT COALESCE(SUM(LENGTH(text)), 0) AS b FROM messages WHERE sender_id = ?').get(alice).b;
  assert.ok(stored <= TEST_QUOTA, `stocké ${stored} > quota`);
  s.disconnect();
});
