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
import { toFcmMessage, createFcmDispatcher, isValidFcmToken } from '../server/utils/fcm.js';

/**
 * Notifications de l'app Android (Firebase Cloud Messaging).
 * - Module server/utils/fcm.js : format des messages (jamais de contenu, priorité, durée de vie),
 *   envoi à chaque appareil, nettoyage des jetons expirés — avec un faux client FCM.
 * - Routes /api/push/fcm/register|unregister et « Déconnecter mes autres sessions » : serveur de
 *   test dédié + base temporaire, sans clé Firebase (le serveur doit démarrer sans).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, '../server/index.js');
const JWT_SECRET = crypto.randomBytes(32).toString('hex');

const fakeToken = (label) => `${label}:APA91b${crypto.randomBytes(24).toString('base64url')}`;

// --- Module FCM (isolé) -------------------------------------------------------------------

test('toFcmMessage : message « data », sans contenu, priorité haute et TTL par défaut', () => {
  const msg = toFcmMessage('tok', {
    title: 'Alice - OpenWLM', body: '🔐 Message chiffré (E2EE)', l10n: 'encrypted',
    senderId: 7, url: '/?chat=7', tag: 'openwlm-chat-7'
  });
  assert.equal(msg.token, 'tok');
  assert.deepEqual(msg.data, {
    type: 'message', title: 'Alice - OpenWLM', body: '🔐 Message chiffré (E2EE)', l10n: 'encrypted',
    tag: 'openwlm-chat-7', senderId: '7', url: '/?chat=7'
  });
  assert.ok(Object.values(msg.data).every((v) => typeof v === 'string'), 'FCM data : chaînes uniquement');
  assert.equal(msg.notification, undefined, "pas de bloc notification : c'est l'app qui l'affiche");
  assert.equal(msg.android.priority, 'high');
  assert.equal(msg.android.ttl, 86400 * 1000);
});

test('toFcmMessage : appel → données de l\'appel aplaties, TTL 45 s ; fin d\'appel en priorité normale', () => {
  const call = toFcmMessage('tok', {
    type: 'call', title: 'Bob — OpenWLM', body: '📞 Appel audio entrant', l10n: 'callAudio', tag: 'openwlm-call-3', senderId: 3,
    data: { url: '/?chat=3', senderId: 3, type: 'call', callerId: 3, expiresAt: 1700000000000 }
  }, { TTL: 45, urgency: 'high' });
  assert.equal(call.data.type, 'call');
  assert.equal(call.data.callerId, '3');
  assert.equal(call.data.expiresAt, '1700000000000');
  assert.equal(call.data.url, '/?chat=3');
  assert.equal(call.android.priority, 'high');
  assert.equal(call.android.ttl, 45000);
  assert.ok(!('signal' in call.data) && !JSON.stringify(call).includes('sdp'), "jamais l'offre d'appel");

  const cancel = toFcmMessage('tok', { type: 'call_cancel', reason: 'missed', l10n: 'callMissed', data: { type: 'call_cancel' } }, { TTL: 3600, urgency: 'normal' });
  assert.equal(cancel.data.reason, 'missed');
  assert.equal(cancel.android.priority, 'normal');
});

test('isValidFcmToken', () => {
  assert.ok(isValidFcmToken(fakeToken('a')));
  for (const bad of [undefined, null, 42, '', 'court', 'a'.repeat(4097), 'abc def ghi jkl mno pqr stu', '<script>alert(1)</script>xxxx']) {
    assert.equal(isValidFcmToken(bad), false, String(bad));
  }
});

test('dispatcher : envoi à chaque appareil, jeton expiré supprimé, FCM non configuré sans erreur', async () => {
  const sentTo = [];
  const deleted = [];
  const messaging = {
    send: async (msg) => {
      if (msg.token === 'stale') throw Object.assign(new Error('gone'), { code: 'messaging/registration-token-not-registered' });
      if (msg.token === 'flaky') throw Object.assign(new Error('unavailable'), { code: 'messaging/internal-error' });
      sentTo.push(msg.token);
      return 'id';
    }
  };
  const silent = { log() {}, warn() {} };
  const dispatch = createFcmDispatcher({
    getMessaging: async () => messaging,
    listTokens: (id) => (id === 1 ? ['ok1', 'ok2', 'stale', 'flaky'] : []),
    deleteToken: (t) => deleted.push(t),
    log: silent
  });
  assert.deepEqual(await dispatch(1, { title: 't', l10n: 'message' }), { sent: 2, failed: 2 });
  assert.deepEqual(sentTo.sort(), ['ok1', 'ok2']);
  assert.deepEqual(deleted, ['stale'], 'seul le jeton désinscrit est supprimé');
  assert.deepEqual(await dispatch(2, { title: 't' }), { sent: 0, failed: 0 });

  const disabled = createFcmDispatcher({ getMessaging: async () => null, listTokens: () => ['x'], deleteToken: () => {}, log: silent });
  assert.deepEqual(await disabled(1, { title: 't' }), { sent: 0, failed: 0, reason: 'fcm_not_configured' });
});

// --- Routes (serveur de test dédié) -------------------------------------------------------

let serverProc;
let serverLog = '';
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
const tokensOf = (id) => withDb((db) => db.prepare('SELECT token FROM fcm_tokens WHERE user_id = ? ORDER BY token').all(id).map((r) => r.token));

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwlm-fcm-'));
  port = await getFreePort();
  const env = { ...process.env, PORT: String(port), JWT_SECRET, NODE_ENV: 'test' };
  delete env.FIREBASE_SERVICE_ACCOUNT;
  serverProc = spawn(process.execPath, [SERVER_ENTRY], { cwd: tmpDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  serverProc.stdout.on('data', (c) => { serverLog += c; });
  serverProc.stderr.on('data', (c) => { serverLog += c; });
  await waitForPort(port);
  withDb((db) => {
    const insert = db.prepare("INSERT INTO users (username, nickname, status, password_hash, salt, token_version) VALUES (?, ?, 'online', 'h', 's', 0)");
    aliceId = Number(insert.run('fcm_alice', 'Alice').lastInsertRowid);
    bobId = Number(insert.run('fcm_bob', 'Bob').lastInsertRowid);
  });
});

after(async () => {
  if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM');
  await sleep(200);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('serveur démarré sans clé Firebase : FCM désactivé, signalé par /api/push/status', async () => {
  const r = await reqJson('/api/push/status', 'GET');
  assert.equal(r.status, 200);
  assert.equal(r.data.hasFcm, false);
  assert.match(serverLog, /\[FCM\] FIREBASE_SERVICE_ACCOUNT non configuré/);
});

test('register / unregister : authentification et format du jeton exigés', async () => {
  assert.equal((await reqJson('/api/push/fcm/register', 'POST', null, { token: fakeToken('x') })).status, 401);
  assert.equal((await reqJson('/api/push/fcm/unregister', 'POST', null, { token: fakeToken('x') })).status, 401);
  assert.equal((await reqJson('/api/push/fcm/register', 'POST', tok(aliceId), { token: 'pas un jeton !' })).status, 400);
  assert.equal((await reqJson('/api/push/fcm/register', 'POST', tok(aliceId), {})).status, 400);
});

test('register : idempotent ; un jeton repris par un autre compte change de propriétaire', async () => {
  const phone = fakeToken('phone');
  assert.equal((await reqJson('/api/push/fcm/register', 'POST', tok(aliceId), { token: phone })).status, 200);
  assert.equal((await reqJson('/api/push/fcm/register', 'POST', tok(aliceId), { token: phone })).status, 200);
  assert.deepEqual(tokensOf(aliceId), [phone]);

  // Bob se connecte sur le même téléphone : Alice n'y reçoit plus rien
  assert.equal((await reqJson('/api/push/fcm/register', 'POST', tok(bobId), { token: phone })).status, 200);
  assert.deepEqual(tokensOf(aliceId), []);
  assert.deepEqual(tokensOf(bobId), [phone]);

  // Alice ne peut pas retirer le jeton de Bob
  await reqJson('/api/push/fcm/unregister', 'POST', tok(aliceId), { token: phone });
  assert.deepEqual(tokensOf(bobId), [phone]);
  assert.equal((await reqJson('/api/push/fcm/unregister', 'POST', tok(bobId), { token: phone })).status, 200);
  assert.deepEqual(tokensOf(bobId), []);
});

test('register : 20 appareils maximum par compte', async () => {
  withDb((db) => {
    const ins = db.prepare('INSERT INTO fcm_tokens (user_id, token, created_at) VALUES (?, ?, ?)');
    for (let i = 0; i < 20; i++) ins.run(bobId, fakeToken(`b${i}`), Date.now());
  });
  const r = await reqJson('/api/push/fcm/register', 'POST', tok(bobId), { token: fakeToken('extra') });
  assert.equal(r.status, 400);
  // Ré-enregistrer un jeton déjà connu reste possible
  const known = tokensOf(bobId)[0];
  assert.equal((await reqJson('/api/push/fcm/register', 'POST', tok(bobId), { token: known })).status, 200);
  withDb((db) => db.prepare('DELETE FROM fcm_tokens WHERE user_id = ?').run(bobId));
});

test('« Déconnecter mes autres sessions » supprime les jetons FCM des autres appareils', async () => {
  const mine = fakeToken('mine');
  const lost = fakeToken('lost');
  const bobPhone = fakeToken('bob');
  withDb((db) => {
    const ins = db.prepare('INSERT INTO fcm_tokens (user_id, token, created_at) VALUES (?, ?, ?)');
    ins.run(aliceId, mine, Date.now());
    ins.run(aliceId, lost, Date.now());
    ins.run(bobId, bobPhone, Date.now());
  });
  const r = await reqJson('/api/sessions/revoke-others', 'POST', tok(aliceId), { keepFcmToken: mine });
  assert.equal(r.status, 200);
  assert.equal(r.data.pushRemoved, 1);
  assert.deepEqual(tokensOf(aliceId), [mine], "le jeton de l'appareil courant est gardé");
  assert.deepEqual(tokensOf(bobId), [bobPhone], 'les autres comptes ne sont pas touchés');

  // Depuis un navigateur (pas de jeton à garder) : tous les jetons Android du compte partent
  const r2 = await reqJson('/api/sessions/revoke-others', 'POST', tok(aliceId), {});
  assert.equal(r2.status, 200);
  assert.deepEqual(tokensOf(aliceId), []);
});

test('serveur démarré avec une clé de compte de service : firebase-admin initialisé', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwlm-fcm-key-'));
  const keyPath = path.join(dir, 'service-account.json');
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  fs.writeFileSync(keyPath, JSON.stringify({
    type: 'service_account',
    project_id: 'openwlm-test',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    client_email: 'fcm@openwlm-test.iam.gserviceaccount.com'
  }), { mode: 0o600 });
  const p = await getFreePort();
  let log = '';
  const proc = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: dir,
    env: { ...process.env, PORT: String(p), JWT_SECRET, NODE_ENV: 'test', FIREBASE_SERVICE_ACCOUNT: keyPath },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.stdout.on('data', (c) => { log += c; });
  proc.stderr.on('data', (c) => { log += c; });
  try {
    await waitForPort(p);
    const start = Date.now();
    while (!/\[FCM\] (Configuré|Configuration invalide)/.test(log) && Date.now() - start < 10000) await sleep(100);
    assert.match(log, /\[FCM\] Configuré \(projet openwlm-test\)/);
  } finally {
    proc.kill('SIGTERM');
    await sleep(200);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
