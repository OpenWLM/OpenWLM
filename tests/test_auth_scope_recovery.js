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

const codeFrom = (out) => (out.match(/[A-Z2-9]{5}(?:-[A-Z2-9]{5}){3}/) || [])[0];
const decryptNonce = (encryptedNonce) => crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(encryptedNonce, 'base64')).toString();

test('récupération : rien sans le code de l\'administrateur, coffre jamais remis au seul identifiant', async () => {
  assert.equal((await request('/api/auth/recovery/challenge', 'POST', null, { username: 'rec_alice' })).status, 404, 'pas de fenêtre ouverte');
  const opened = recoveryScript('rec_alice', '--hours', '1');
  assert.equal(opened.status, 0, opened.stderr);
  const code = codeFrom(opened.stdout);
  assert.ok(code, `code affiché : ${opened.stdout}`);
  assert.ok(!db.prepare("SELECT auth_recovery_code_hash FROM users WHERE username = 'rec_alice'").get().auth_recovery_code_hash.includes(code), 'seule une empreinte est stockée');
  // Fenêtre ouverte mais sans code, ou avec un mauvais code : pas de coffre
  const noCode = await request('/api/auth/recovery/challenge', 'POST', null, { username: 'rec_alice' });
  assert.equal(noCode.status, 404);
  assert.equal(noCode.data.vault, undefined);
  assert.equal((await request('/api/auth/recovery/challenge', 'POST', null, { username: 'rec_alice', code: 'AAAAA-AAAAA-AAAAA-AAAAA' })).status, 404);
  // Bon code (saisi en minuscules) : coffre et défi
  const ch = await request('/api/auth/recovery/challenge', 'POST', null, { username: 'REC_alice ', code: code.toLowerCase() });
  assert.equal(ch.status, 200);
  assert.ok(ch.data.vault);
  // Seconde demande : le défi en cours n'est pas remplacé
  const ch2 = await request('/api/auth/recovery/challenge', 'POST', null, { username: 'rec_alice', code });
  assert.equal(decryptNonce(ch2.data.encryptedNonce), decryptNonce(ch.data.encryptedNonce));
});

test('récupération réussie : nouvelle clé, anciennes sessions révoquées, cibles Push supprimées, fenêtre refermée', async () => {
  const user = db.prepare("SELECT id, token_version FROM users WHERE username = 'rec_alice'").get();
  const oldToken = tok(user.id);
  assert.equal((await request('/api/user/me', 'GET', oldToken)).status, 200, 'ancienne session valable avant');
  db.prepare('INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)').run(user.id, 'https://push.example/perdu', 'k', 'a', Date.now());
  db.prepare('INSERT INTO fcm_tokens (user_id, token, created_at) VALUES (?, ?, ?)').run(user.id, `perdu:APA91b${'x'.repeat(30)}`, Date.now());

  const code = codeFrom(recoveryScript('rec_alice', '--hours', '1').stdout);
  const ch = await request('/api/auth/recovery/challenge', 'POST', null, { username: 'rec_alice', code });
  const nonce = decryptNonce(ch.data.encryptedNonce);
  const newKey = 'b'.repeat(64);
  // Bonne preuve mais sans le code : refusé
  assert.equal((await request('/api/auth/recovery/complete', 'POST', null, { username: 'rec_alice', nonce, newAuthKeyHex: newKey })).status, 401);
  // Mauvaise preuve : refusé
  assert.equal((await request('/api/auth/recovery/complete', 'POST', null, { username: 'rec_alice', code, nonce: 'x'.repeat(64), newAuthKeyHex: newKey })).status, 401);
  const done = await request('/api/auth/recovery/complete', 'POST', null, { username: 'rec_alice', code, nonce, newAuthKeyHex: newKey });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.match(String(done.headers['set-cookie'] || ''), /token=/);

  const after = db.prepare('SELECT token_version, auth_recovery_until, auth_recovery_code_hash FROM users WHERE id = ?').get(user.id);
  assert.equal(after.token_version, (user.token_version || 0) + 1, 'sessions révoquées');
  assert.equal(after.auth_recovery_until, 0);
  assert.equal(after.auth_recovery_code_hash, null, 'code à usage unique');
  assert.equal((await request('/api/user/me', 'GET', oldToken)).status, 401, 'l\'ancienne session (appareil perdu) ne fonctionne plus');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM push_subscriptions WHERE user_id = ?').get(user.id).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM fcm_tokens WHERE user_id = ?').get(user.id).c, 0);
  assert.equal((await request('/api/login', 'POST', null, { username: 'rec_alice', password: newKey })).status, 200);
  assert.equal((await request('/api/auth/recovery/challenge', 'POST', null, { username: 'rec_alice', code })).status, 404, 'le code ne resert pas');

  // Journal d'audit : ouverture, coffre remis, réussite
  const events = db.prepare('SELECT event FROM auth_recovery_log WHERE user_id = ? ORDER BY id').all(user.id).map((r) => r.event);
  for (const e of ['ouverte', 'coffre remis', 'réussie']) assert.ok(events.includes(e), `événement « ${e} » : ${events.join(', ')}`);
  const log = recoveryScript('--log', 'rec_alice');
  assert.equal(log.status, 0);
  assert.match(log.stdout, /réussie/);
});

test('récupération : 5 codes erronés referment la fenêtre', async () => {
  const code = codeFrom(recoveryScript('rec_alice', '--hours', '1').stdout);
  for (let i = 0; i < 5; i++) {
    assert.equal((await request('/api/auth/recovery/challenge', 'POST', null, { username: 'rec_alice', code: `ZZZZZ-ZZZZZ-ZZZZZ-ZZZZ${i}` })).status, 404);
  }
  assert.equal((await request('/api/auth/recovery/challenge', 'POST', null, { username: 'rec_alice', code })).status, 404, 'même le bon code est refusé après 5 échecs');
  assert.equal(db.prepare("SELECT auth_recovery_until FROM users WHERE username = 'rec_alice'").get().auth_recovery_until, 0);
});

test('script de récupération : identifiant inconnu → code 2, --close referme, --all écrit un fichier 600', async () => {
  assert.equal(recoveryScript('personne').status, 2);
  const code = codeFrom(recoveryScript('rec_alice').stdout);
  assert.equal(recoveryScript('--close', 'rec_alice').status, 0);
  assert.equal((await request('/api/auth/recovery/challenge', 'POST', null, { username: 'rec_alice', code })).status, 404);
  const all = spawnSync(process.execPath, [path.join(ROOT, 'scripts/auth-recovery.mjs'), '--all', '--hours', '1'], {
    cwd: tmpDir, env: { ...process.env, OPENWLM_DB: path.join(tmpDir, 'messenger.db') }, encoding: 'utf8'
  });
  assert.equal(all.status, 0, all.stderr);
  const file = fs.readdirSync(tmpDir).find((f) => f.startsWith('recovery-codes-'));
  assert.ok(file, 'fichier de codes créé');
  assert.equal(fs.statSync(path.join(tmpDir, file)).mode & 0o777, 0o600);
  assert.ok(codeFrom(fs.readFileSync(path.join(tmpDir, file), 'utf8')));
  assert.equal(recoveryScript('--close', '--all').status, 0);
});

test('logout-device : exige une session', async () => {
  assert.equal((await request('/api/logout-device', 'POST')).status, 401);
  const u = db.prepare("SELECT id, token_version FROM users WHERE username = 'rec_alice'").get();
  const t = jwt.sign({ id: u.id, tv: u.token_version }, JWT_SECRET, { expiresIn: '1h' });
  assert.equal((await request('/api/logout-device', 'POST', t)).status, 200);
});
