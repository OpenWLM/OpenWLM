import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';

/**
 * Portée stable de la clé d'authentification (AUTH_KEY_SCOPE, GET /api/auth/scope) et
 * récupération ouverte par l'administrateur (scripts/auth-recovery.mjs, /api/auth/recovery/*) :
 *  - le coffre n'est remis que pour un compte en récupération ;
 *  - seule la réponse au défi chiffré pour la clé publique du compte enregistre la nouvelle clé ;
 *  - la fenêtre se referme après usage ;
 *  - /api/logout-device exige une session.
 * Serveur isolé (dossier temporaire, port libre).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SERVER_ENTRY = path.join(ROOT, 'server/index.js');
const JWT_SECRET = crypto.randomBytes(32).toString('hex');

let serverProc;
let tmpDir;
let port;
let db;
let privateKey;

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
const request = (apiPath, method, token, body) => new Promise((resolve) => {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const headers = {};
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
  if (token) headers.Authorization = `Bearer ${token}`;
  // Une IP par requête (serveur de confiance pour CF-Connecting-IP) : la limite d'authentification
  // (10 / min / IP) ne doit pas se déclencher dans le test
  headers['CF-Connecting-IP'] = `198.51.100.${1 + Math.floor(Math.random() * 250)}`;
  const req = http.request({ hostname: '127.0.0.1', port, path: apiPath, method, headers }, (res) => {
    let raw = '';
    res.on('data', (c) => { raw += c; });
    res.on('end', () => { let d; try { d = JSON.parse(raw); } catch { d = raw; } resolve({ status: res.statusCode, data: d, headers: res.headers }); });
  });
  req.on('error', () => resolve({ status: 0 }));
  if (payload) req.write(payload);
  req.end();
});
const tok = (id) => jwt.sign({ id, tv: 0 }, JWT_SECRET, { expiresIn: '1h' });
const hashPwd = (hex, salt) => crypto.pbkdf2Sync(hex, salt, 210000, 64, 'sha512').toString('hex');
const recoveryScript = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/auth-recovery.mjs'), ...args], {
  env: { ...process.env, OPENWLM_DB: path.join(tmpDir, 'messenger.db') }, encoding: 'utf8'
});

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwlm-scope-'));
  port = await getFreePort();
  serverProc = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: tmpDir,
    env: { ...process.env, PORT: String(port), JWT_SECRET, NODE_ENV: 'test', AUTH_KEY_SCOPE: 'Messenger.Example.Org', CLOUDFLARE_IP_RANGES: '127.0.0.1/32,::1/128' },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  await waitForPort(port);
  db = new Database(path.join(tmpDir, 'messenger.db'));
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = pair.privateKey;
  const publicJwk = pair.publicKey.export({ format: 'jwk' });
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare("INSERT INTO users (username, nickname, status, password_hash, salt, token_version, public_key, encrypted_private_key) VALUES (?, ?, 'offline', ?, ?, 0, ?, ?)")
    .run('rec_alice', 'Alice', hashPwd('a'.repeat(64), salt), salt, JSON.stringify(publicJwk), JSON.stringify({ encryptedKeyBase64: 'QUFB', ivBase64: 'QkJC' }));
});

after(async () => {
  try { db?.close(); } catch { /* ignore */ }
  if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM');
  await sleep(200);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('portée annoncée : AUTH_KEY_SCOPE en minuscules', async () => {
  const r = await request('/api/auth/scope', 'GET');
  assert.equal(r.status, 200);
  assert.equal(r.data.scope, 'messenger.example.org');
});

test('récupération : coffre refusé hors fenêtre, défi seulement résolu par la clé privée du compte', async () => {
  assert.equal((await request('/api/auth/recovery/challenge', 'POST', null, { username: 'rec_alice' })).status, 404, 'pas de fenêtre ouverte');
  assert.equal((await request('/api/auth/recovery/challenge', 'POST', null, { username: 'inconnu' })).status, 404);

  const opened = recoveryScript('rec_alice', '--hours', '1');
  assert.equal(opened.status, 0, opened.stderr);

  const ch = await request('/api/auth/recovery/challenge', 'POST', null, { username: 'REC_alice ' });
  assert.equal(ch.status, 200);
  assert.ok(ch.data.vault, 'coffre remis pendant la fenêtre');
  const newKey = 'b'.repeat(64);
  // Mauvaise réponse au défi : refusé
  assert.equal((await request('/api/auth/recovery/complete', 'POST', null, { username: 'rec_alice', nonce: 'x'.repeat(64), newAuthKeyHex: newKey })).status, 401);
  // Le défi a été consommé par l'échec ? Non : il reste valable jusqu'à la bonne réponse ou 5 min
  const ch2 = await request('/api/auth/recovery/challenge', 'POST', null, { username: 'rec_alice' });
  const nonce = crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(ch2.data.encryptedNonce, 'base64')).toString();
  const done = await request('/api/auth/recovery/complete', 'POST', null, { username: 'rec_alice', nonce, newAuthKeyHex: newKey });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.match(String(done.headers['set-cookie'] || ''), /token=/);

  // Nouvelle clé valable, ancienne refusée, fenêtre refermée
  assert.equal((await request('/api/login', 'POST', null, { username: 'rec_alice', password: newKey })).status, 200);
  assert.equal((await request('/api/login', 'POST', null, { username: 'rec_alice', password: 'a'.repeat(64) })).status, 401);
  assert.equal((await request('/api/auth/recovery/challenge', 'POST', null, { username: 'rec_alice' })).status, 404);
  // Rejouer la bonne réponse : refusé
  assert.equal((await request('/api/auth/recovery/complete', 'POST', null, { username: 'rec_alice', nonce, newAuthKeyHex: 'c'.repeat(64) })).status, 401);
});

test('script de récupération : identifiant inconnu → code 2, --close referme', async () => {
  assert.equal(recoveryScript('personne').status, 2);
  assert.equal(recoveryScript('rec_alice').status, 0);
  assert.equal(recoveryScript('--close', 'rec_alice').status, 0);
  assert.equal((await request('/api/auth/recovery/challenge', 'POST', null, { username: 'rec_alice' })).status, 404);
});

test('logout-device : exige une session', async () => {
  assert.equal((await request('/api/logout-device', 'POST')).status, 401);
  const id = db.prepare("SELECT id FROM users WHERE username = 'rec_alice'").get().id;
  assert.equal((await request('/api/logout-device', 'POST', tok(id))).status, 200);
});
