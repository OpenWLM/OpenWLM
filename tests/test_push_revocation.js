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

/**
 * Les notifications suivent les sessions : un appareil déconnecté ne reçoit plus le nom des
 * expéditeurs ni la sonnerie des appels.
 * - POST /api/logout révoque toutes les sessions du compte → plus aucun abonnement Web Push ni
 *   jeton FCM pour ce compte ;
 * - POST /api/user/change-password coupe les autres appareils → seules les cibles Push de
 *   l'appareil courant (keepPushEndpoint, keepFcmToken) restent ;
 * - les autres comptes ne sont jamais touchés.
 * Serveur de test dédié + base temporaire.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, '../server/index.js');
const JWT_SECRET = crypto.randomBytes(32).toString('hex');

// Même dérivation que le serveur (server/middleware/auth.js)
const pbkdf2 = (key, salt) => crypto.pbkdf2Sync(key, salt, 210000, 64, 'sha512').toString('hex');
const OLD_KEY = crypto.randomBytes(32).toString('hex');
const NEW_KEY = crypto.randomBytes(32).toString('hex');
const SALT = crypto.randomBytes(16).toString('hex');

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

const targetsOf = (id) => withDb((db) => ({
  web: db.prepare('SELECT endpoint FROM push_subscriptions WHERE user_id = ? ORDER BY endpoint').all(id).map((r) => r.endpoint),
  fcm: db.prepare('SELECT token FROM fcm_tokens WHERE user_id = ? ORDER BY token').all(id).map((r) => r.token)
}));
const seedTargets = (id, label) => withDb((db) => {
  const web = db.prepare('INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)');
  const fcm = db.prepare('INSERT INTO fcm_tokens (user_id, token, created_at) VALUES (?, ?, ?)');
  for (const device of ['pc', 'phone']) {
    web.run(id, `https://push.example/${label}-${device}`, 'k', 'a', Date.now());
    fcm.run(id, `${label}-${device}:APA91b${'x'.repeat(30)}`, Date.now());
  }
});

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwlm-pushrev-'));
  port = await getFreePort();
  serverProc = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: tmpDir,
    env: { ...process.env, PORT: String(port), JWT_SECRET, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitForPort(port);
  withDb((db) => {
    const insert = db.prepare("INSERT INTO users (username, nickname, status, password_hash, salt, token_version) VALUES (?, ?, 'online', ?, ?, 0)");
    aliceId = Number(insert.run('pr_alice', 'Alice', pbkdf2(OLD_KEY, SALT), SALT).lastInsertRowid);
    bobId = Number(insert.run('pr_bob', 'Bob', 'h', 's').lastInsertRowid);
  });
});

after(async () => {
  if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM');
  await sleep(200);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('déconnexion : plus aucun abonnement Web Push ni jeton FCM pour le compte', async () => {
  seedTargets(aliceId, 'alice');
  seedTargets(bobId, 'bob');
  const r = await reqJson('/api/logout', 'POST', tok(aliceId), {});
  assert.equal(r.status, 200);
  assert.deepEqual(targetsOf(aliceId), { web: [], fcm: [] });
  assert.equal(targetsOf(bobId).web.length, 2, 'les autres comptes ne sont pas touchés');
  assert.equal(targetsOf(bobId).fcm.length, 2);
});

test('changement de mot de passe : seules les cibles Push de l\'appareil courant restent', async () => {
  seedTargets(aliceId, 'alice');
  const r = await reqJson('/api/user/change-password', 'POST', tok(aliceId), {
    oldAuthKeyHex: OLD_KEY,
    newAuthKeyHex: NEW_KEY,
    keepPushEndpoint: 'https://push.example/alice-pc',
    keepFcmToken: `alice-phone:APA91b${'x'.repeat(30)}`
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(targetsOf(aliceId), { web: ['https://push.example/alice-pc'], fcm: [`alice-phone:APA91b${'x'.repeat(30)}`] });
  assert.equal(targetsOf(bobId).fcm.length, 2, 'les autres comptes ne sont pas touchés');
});

test('changement de mot de passe sans cible à garder : toutes les cibles du compte supprimées', async () => {
  withDb((db) => { db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(aliceId); db.prepare('DELETE FROM fcm_tokens WHERE user_id = ?').run(aliceId); });
  seedTargets(aliceId, 'alice');
  const r = await reqJson('/api/user/change-password', 'POST', tok(aliceId), { oldAuthKeyHex: NEW_KEY, newAuthKeyHex: OLD_KEY });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(targetsOf(aliceId), { web: [], fcm: [] });
});

test('GET /api/health : le serveur répond et sa base est lisible', async () => {
  const r = await reqJson('/api/health', 'GET');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { ok: true });
});

test('GET /api/health : 404 pour une requête venue d\'Internet (via Cloudflare)', async () => {
  for (const header of ['cf-ray', 'cf-connecting-ip']) {
    const r = await new Promise((resolve) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: '/api/health', method: 'GET', headers: { [header]: header === 'cf-ray' ? '8f00000000000000-CDG' : '203.0.113.7' } },
        (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', () => resolve(0));
      req.end();
    });
    assert.equal(r, 404, header);
  }
});
