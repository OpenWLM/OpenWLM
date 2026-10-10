import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import { io as ClientIO } from 'socket.io-client';

/**
 * Durcissements suite à l'audit #2 :
 *  #1 checkers_move : coordonnées non entières rejetées (pas de crash)
 *  #2 /user/keys : remplacement de clés exige la preuve du mot de passe
 *  #3 change-password : nouveau coffre requis si un coffre existe
 *  #4 accept-invite : invitation déjà traitée non rejouable
 *  #5 push/subscribe : endpoint non-HTTPS/privé rejeté
 *  #6 webrtc_signal : objet trop volumineux rejeté
 *
 * Nécessite le serveur sur http://localhost:3001 (skip sinon).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const jwtSecretPath = path.join(PROJECT_ROOT, '.jwt_secret');
const JWT_SECRET = fs.existsSync(jwtSecretPath) ? fs.readFileSync(jwtSecretPath, 'utf8').trim() : null;
const db = new Database(path.join(PROJECT_ROOT, 'messenger.db'));

const PWD = crypto.randomBytes(32).toString('hex');
const NEWPWD = crypto.randomBytes(32).toString('hex');
const hashPwd = (hex, salt) => crypto.pbkdf2Sync(hex, salt, 210000, 64, 'sha512').toString('hex');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const probe = () => new Promise((resolve) => {
  if (!JWT_SECRET) return resolve(false);
  const req = http.request({ hostname: 'localhost', port: 3001, path: '/api/push/status', method: 'GET' }, (res) => { res.resume(); resolve(res.statusCode === 200); });
  req.on('error', () => resolve(false));
  req.end();
});
const serverUp = await probe();
const tok = (id, username) => jwt.sign({ id, username, tv: 0 }, JWT_SECRET);

const reqJson = (apiPath, method, token, body) => new Promise((resolve) => {
  const postData = body !== undefined ? JSON.stringify(body) : '';
  const headers = {};
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(postData); }
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const req = http.request({ hostname: 'localhost', port: 3001, path: apiPath, method, headers }, (res) => {
    let raw = '';
    res.on('data', (c) => { raw += c; });
    res.on('end', () => { let d; try { d = JSON.parse(raw); } catch { d = raw; } resolve({ status: res.statusCode, data: d }); });
  });
  req.on('error', () => resolve({ status: 0 }));
  if (postData) req.write(postData);
  req.end();
});

const connect = (token) => new Promise((resolve, reject) => {
  const s = ClientIO('http://localhost:3001', { auth: { token }, transports: ['websocket'] });
  s.once('connect', () => resolve(s));
  s.once('connect_error', reject);
  setTimeout(() => reject(new Error('Timeout socket')), 3000);
});
const onceOrNull = (socket, event, ms) => new Promise((resolve) => {
  const handler = (payload) => { socket.off(event, handler); resolve(payload); };
  socket.on(event, handler);
  setTimeout(() => { socket.off(event, handler); resolve(null); }, ms);
});

const ALL_IDS = [10001, 10002, 10003, 10004, 10005, 10006, 10007];
function cleanup() {
  try { db.prepare(`DELETE FROM contacts WHERE user_id IN (${ALL_IDS}) OR contact_id IN (${ALL_IDS})`).run(); } catch {}
  try { db.prepare(`DELETE FROM invitations WHERE sender_id IN (${ALL_IDS}) OR receiver_id IN (${ALL_IDS})`).run(); } catch {}
  try { db.prepare(`DELETE FROM push_subscriptions WHERE user_id IN (${ALL_IDS})`).run(); } catch {}
  try { db.prepare(`DELETE FROM users WHERE id IN (${ALL_IDS})`).run(); } catch {}
}
function seedUser(id, username, { vault = null } = {}) {
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare(`
    INSERT INTO users (id, username, password_hash, salt, nickname, psm, avatar, scene, status, token_version, global_private, encrypted_private_key)
    VALUES (?, ?, ?, ?, ?, 'PSM', '/assets/usertiles/chess.png', '/assets/scenes/0006.png', 'online', 0, 0, ?)
  `).run(id, username, hashPwd(PWD, salt), salt, username, vault);
}

// ── #2 /user/keys ──
test('#2 /user/keys : remplacement exige la preuve du mot de passe', { skip: serverUp ? false : 'Serveur non démarré' }, async () => {
  cleanup();
  seedUser(10001, 'hk_user');
  try {
    const t = tok(10001, 'hk_user');
    const jwk = (n) => ({ kty: 'RSA', n: 'A'.repeat(342) + n, e: 'AQAB' });
    const vault = { encryptedKeyBase64: 'A'.repeat(512), ivBase64: 'A'.repeat(16) };
    // Première installation (aucune clé) → autorisée sans mot de passe
    assert.equal((await reqJson('/api/user/keys', 'POST', t, { publicKey: jwk('a'), encryptedPrivateKey: vault })).status, 200);
    // Remplacement sans mot de passe → refusé
    assert.equal((await reqJson('/api/user/keys', 'POST', t, { publicKey: jwk('b'), encryptedPrivateKey: vault })).status, 403);
    // Remplacement avec mauvais mot de passe → refusé
    assert.equal((await reqJson('/api/user/keys', 'POST', t, { publicKey: jwk('b'), encryptedPrivateKey: vault, authKeyHex: NEWPWD })).status, 403);
    // Remplacement avec le bon mot de passe → accepté
    assert.equal((await reqJson('/api/user/keys', 'POST', t, { publicKey: jwk('b'), encryptedPrivateKey: vault, authKeyHex: PWD })).status, 200);
  } finally { cleanup(); }
});

// ── #3 change-password ──
test('#3 change-password : nouveau coffre requis si un coffre existe', { skip: serverUp ? false : 'Serveur non démarré' }, async () => {
  cleanup();
  seedUser(10002, 'cp_user', { vault: JSON.stringify({ iv: 'x', data: 'y' }) });
  try {
    const t = tok(10002, 'cp_user');
    // Sans nouveau coffre → refusé
    const noVault = await reqJson('/api/user/change-password', 'POST', t, { oldAuthKeyHex: PWD, newAuthKeyHex: NEWPWD });
    assert.equal(noVault.status, 400, 'un coffre existant impose un nouveau coffre');
    // Avec nouveau coffre → accepté
    const withVault = await reqJson('/api/user/change-password', 'POST', t, { oldAuthKeyHex: PWD, newAuthKeyHex: NEWPWD, newEncryptedPrivateKey: { encryptedKeyBase64: 'A'.repeat(512), ivBase64: 'A'.repeat(16) } });
    assert.equal(withVault.status, 200, 'avec coffre → accepté');
  } finally { cleanup(); }
});

// ── #4 accept-invite ──
test('#4 accept-invite : une invitation déjà traitée n\'est pas rejouable', { skip: serverUp ? false : 'Serveur non démarré' }, async () => {
  cleanup();
  seedUser(10003, 'inv_sender');
  seedUser(10004, 'inv_receiver');
  try {
    const t = tok(10004, 'inv_receiver');
    // Invitation déjà acceptée
    const accepted = db.prepare("INSERT INTO invitations (sender_id, receiver_id, status) VALUES (?, ?, 'accepted')").run(10003, 10004);
    const replay = await reqJson('/api/accept-invite', 'POST', t, { invitationId: Number(accepted.lastInsertRowid) });
    assert.equal(replay.status, 404, 'une invitation déjà acceptée ne doit pas être rejouable');
    // Invitation pending → acceptée
    const pending = db.prepare("INSERT INTO invitations (sender_id, receiver_id, status) VALUES (?, ?, 'pending')").run(10003, 10004);
    const ok = await reqJson('/api/accept-invite', 'POST', t, { invitationId: Number(pending.lastInsertRowid) });
    assert.equal(ok.status, 200, 'invitation pending acceptée');
    // Rejeu → refusé
    const replay2 = await reqJson('/api/accept-invite', 'POST', t, { invitationId: Number(pending.lastInsertRowid) });
    assert.equal(replay2.status, 404, 'rejeu refusé');
  } finally { cleanup(); }
});

// ── #5 push/subscribe ──
test('#5 push/subscribe : endpoint non-HTTPS ou privé rejeté, endpoint public accepté', { skip: serverUp ? false : 'Serveur non démarré' }, async () => {
  cleanup();
  seedUser(10005, 'push_user');
  try {
    const t = tok(10005, 'push_user');
    assert.equal((await reqJson('/api/push/subscribe', 'POST', t, { subscription: { endpoint: 'http://localhost:9999/x' } })).status, 400, 'http localhost rejeté');
    assert.equal((await reqJson('/api/push/subscribe', 'POST', t, { subscription: { endpoint: 'https://127.0.0.1/x' } })).status, 400, 'IP privée rejetée');
    assert.equal((await reqJson('/api/push/subscribe', 'POST', t, { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'x', auth: 'y' } } })).status, 200, 'endpoint public accepté');
  } finally { cleanup(); }
});

// ── #1 checkers + #6 webrtc (sockets) ──
test('#1 checkers_move : coordonnées non entières rejetées (pas de crash)', { skip: serverUp ? false : 'Serveur non démarré' }, async () => {
  cleanup();
  seedUser(10006, 'ck_a');
  seedUser(10007, 'ck_b');
  db.prepare('INSERT INTO contacts (user_id, contact_id, status, blocked) VALUES (?, ?, 1, 0)').run(10006, 10007);
  db.prepare('INSERT INTO contacts (user_id, contact_id, status, blocked) VALUES (?, ?, 1, 0)').run(10007, 10006);
  const s1 = await connect(tok(10006, 'ck_a'));
  const s2 = await connect(tok(10007, 'ck_b'));
  try {
    s1.emit('game_invite', { target: 10007, gameType: 'checkers' });
    await wait(250);
    s2.emit('game_accept', { target: 10006, gameType: 'checkers' });
    await wait(450);

    const errP = onceOrNull(s1, 'game_error', 800);
    const moveP = onceOrNull(s2, 'checkers_move', 800);
    s1.emit('checkers_move', { target: 10007, from: { row: 5.5, col: 0 }, to: { row: 4, col: 1 } });
    assert.ok(await errP, 'coordonnée fractionnaire doit produire un game_error');
    assert.equal(await moveP, null, 'aucun coup ne doit être diffusé');
    assert.equal(await probe(), true, 'le serveur reste en vie');
  } finally { s1.disconnect(); s2.disconnect(); cleanup(); }
});

test('#6 webrtc_signal : objet trop volumineux rejeté, objet valide relayé', { skip: serverUp ? false : 'Serveur non démarré' }, async () => {
  cleanup();
  seedUser(10006, 'ck_a');
  seedUser(10007, 'ck_b');
  db.prepare('INSERT INTO contacts (user_id, contact_id, status, blocked) VALUES (?, ?, 1, 0)').run(10006, 10007);
  db.prepare('INSERT INTO contacts (user_id, contact_id, status, blocked) VALUES (?, ?, 1, 0)').run(10007, 10006);
  const s1 = await connect(tok(10006, 'ck_a'));
  const s2 = await connect(tok(10007, 'ck_b'));
  try {
    await wait(200);
    let p = onceOrNull(s2, 'webrtc_signal', 400);
    s1.emit('webrtc_signal', { target: 10007, signal: { type: 'offer', sdp: 'x'.repeat(70000) } });
    assert.equal(await p, null, 'objet trop volumineux non relayé');

    p = onceOrNull(s2, 'webrtc_signal', 700);
    s1.emit('webrtc_signal', { target: 10007, signal: { type: 'offer', sdp: 'abc' } });
    assert.ok(await p, 'objet valide relayé');
  } finally { s1.disconnect(); s2.disconnect(); cleanup(); }
});
