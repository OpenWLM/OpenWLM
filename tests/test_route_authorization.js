import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import { io as ClientIO } from 'socket.io-client';

/**
 * Non-régression — Durcissement des droits d'accès (points 1/2/3) :
 *  1. game_restart / game_quit : réservés aux contacts mutuels + partie active (anti-injection).
 *  2. GET /api/user/:userId/public-key : soi-même ou contact mutuel uniquement.
 *  3. GET /api/emoticons/custom/asset/:assetId : propriétaire ou contact du propriétaire.
 *
 * Nécessite le serveur démarré sur http://localhost:3001 (skip sinon).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');

const jwtSecretPath = path.join(PROJECT_ROOT, '.jwt_secret');
const JWT_SECRET = fs.existsSync(jwtSecretPath) ? fs.readFileSync(jwtSecretPath, 'utf8').trim() : null;
const db = new Database(path.join(PROJECT_ROOT, 'messenger.db'));

const IDS = { owner: 9301, contact: 9302, stranger: 9303 };
const EMOTE_ID = 'emo_auth_test';
const EMOTE_FILE = 'auth_test_asset.bin';
const EMOTICONS_DIR = path.join(PROJECT_ROOT, 'uploads', 'emoticons');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const makeHttp = (apiPath, method, token) => new Promise((resolve) => {
  const req = http.request({
    hostname: 'localhost',
    port: 3001,
    path: apiPath,
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => {
      try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
      catch { resolve({ status: res.statusCode, body }); }
    });
  });
  req.on('error', () => resolve({ status: 0 }));
  req.end();
});

const probeServer = async () => {
  if (!JWT_SECRET) return false;
  const res = await makeHttp('/api/push/status', 'GET');
  return res.status === 200;
};
const serverUp = await probeServer();

const tok = (id, username) => jwt.sign({ id, username, tv: 0 }, JWT_SECRET);
const connect = (token) => new Promise((resolve, reject) => {
  const s = ClientIO('http://localhost:3001', { auth: { token }, transports: ['websocket'] });
  s.once('connect', () => resolve(s));
  s.once('connect_error', reject);
  setTimeout(() => reject(new Error('Timeout connexion socket')), 3000);
});

function cleanup() {
  try { db.prepare('DELETE FROM contacts WHERE user_id IN (9301,9302,9303) OR contact_id IN (9301,9302,9303)').run(); } catch {}
  try { db.prepare('DELETE FROM custom_emoticons WHERE id = ?').run(EMOTE_ID); } catch {}
  try { db.prepare('DELETE FROM users WHERE id IN (9301,9302,9303)').run(); } catch {}
  try { const p = path.join(EMOTICONS_DIR, EMOTE_FILE); if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
}

function seed() {
  cleanup();
  const insertUser = db.prepare(`
    INSERT INTO users (id, username, password_hash, salt, nickname, psm, avatar, scene, status, token_version, global_private)
    VALUES (?, ?, 'hash', 'salt', ?, 'PSM', '/assets/usertiles/chess.png', '/assets/scenes/0006.png', 'online', 0, 0)
  `);
  insertUser.run(IDS.owner, 'auth_owner', 'Owner');
  insertUser.run(IDS.contact, 'auth_contact', 'Contact');
  insertUser.run(IDS.stranger, 'auth_stranger', 'Stranger');

  db.prepare('UPDATE users SET public_key = ? WHERE id = ?')
    .run(JSON.stringify({ kty: 'RSA', n: 'test-n', e: 'AQAB' }), IDS.owner);

  // Contact mutuel owner <-> contact uniquement
  db.prepare('INSERT INTO contacts (user_id, contact_id, status, blocked) VALUES (?, ?, 1, 0)').run(IDS.owner, IDS.contact);
  db.prepare('INSERT INTO contacts (user_id, contact_id, status, blocked) VALUES (?, ?, 1, 0)').run(IDS.contact, IDS.owner);

  db.prepare(`
    INSERT INTO custom_emoticons (id, owner_id, shortcut, mime_type, file_size, width, height, asset_filename, created_at)
    VALUES (?, ?, '(authtest)', 'image/png', 16, 4, 4, ?, ?)
  `).run(EMOTE_ID, IDS.owner, EMOTE_FILE, Date.now());

  if (!fs.existsSync(EMOTICONS_DIR)) fs.mkdirSync(EMOTICONS_DIR, { recursive: true });
  fs.writeFileSync(path.join(EMOTICONS_DIR, EMOTE_FILE), Buffer.from('0123456789abcdef'));
}

test('public-key : self + contact autorisés, étranger refusé (403)', { skip: serverUp ? false : 'Serveur non démarré' }, async () => {
  seed();
  try {
    const self = await makeHttp(`/api/user/${IDS.owner}/public-key`, 'GET', tok(IDS.owner, 'auth_owner'));
    const contact = await makeHttp(`/api/user/${IDS.owner}/public-key`, 'GET', tok(IDS.contact, 'auth_contact'));
    const stranger = await makeHttp(`/api/user/${IDS.owner}/public-key`, 'GET', tok(IDS.stranger, 'auth_stranger'));
    assert.equal(self.status, 200, 'self doit être autorisé');
    assert.equal(contact.status, 200, 'contact doit être autorisé');
    assert.equal(stranger.status, 403, 'étranger doit être refusé');
  } finally { cleanup(); }
});

test('emoticon asset : propriétaire + contact autorisés, étranger refusé (403)', { skip: serverUp ? false : 'Serveur non démarré' }, async () => {
  seed();
  try {
    const owner = await makeHttp(`/api/emoticons/custom/asset/${EMOTE_ID}`, 'GET', tok(IDS.owner, 'auth_owner'));
    const contact = await makeHttp(`/api/emoticons/custom/asset/${EMOTE_ID}`, 'GET', tok(IDS.contact, 'auth_contact'));
    const stranger = await makeHttp(`/api/emoticons/custom/asset/${EMOTE_ID}`, 'GET', tok(IDS.stranger, 'auth_stranger'));
    assert.equal(owner.status, 200, 'propriétaire doit être autorisé');
    assert.equal(contact.status, 200, 'contact doit être autorisé');
    assert.equal(stranger.status, 403, 'étranger doit être refusé');
  } finally { cleanup(); }
});

test('jeux : un étranger ne peut pas injecter game_restart / game_quit', { skip: serverUp ? false : 'Serveur non démarré' }, async () => {
  seed();
  const s1 = await connect(tok(IDS.owner, 'auth_owner'));
  const s3 = await connect(tok(IDS.stranger, 'auth_stranger'));
  try {
    let restartReceived = false;
    let quitReceived = false;
    s1.on('game_restart', () => { restartReceived = true; });
    s1.on('game_quit', () => { quitReceived = true; });

    s3.emit('game_restart', { target: IDS.owner });
    s3.emit('game_quit', { target: IDS.owner });
    await wait(500);

    assert.equal(restartReceived, false, 'game_restart doit être bloqué');
    assert.equal(quitReceived, false, 'game_quit doit être bloqué');
  } finally {
    s1.disconnect(); s3.disconnect(); cleanup();
  }
});

test('jeux : un restart légitime (partie active) est bien livré', { skip: serverUp ? false : 'Serveur non démarré' }, async () => {
  seed();
  const s1 = await connect(tok(IDS.owner, 'auth_owner'));
  const s2 = await connect(tok(IDS.contact, 'auth_contact'));
  try {
    s1.emit('game_invite', { target: IDS.contact, gameType: 'morpion' });
    await wait(200);
    s2.emit('game_accept', { target: IDS.owner, gameType: 'morpion' });
    await wait(400);

    const received = await new Promise((resolve) => {
      s2.once('game_restart', (payload) => resolve(payload));
      s1.emit('game_restart', { target: IDS.contact });
      setTimeout(() => resolve(null), 800);
    });

    assert.ok(received && received.from === IDS.owner, 'game_restart doit être livré au joueur légitime');
  } finally {
    s1.disconnect(); s2.disconnect(); cleanup();
  }
});
