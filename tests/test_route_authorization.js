import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';
import net from 'net';
import crypto from 'crypto';
import { spawn } from 'child_process';
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
 * Serveur ISOLÉ (dossier temporaire, port libre, secret JWT du test) : ne parle jamais au serveur
 * présent sur :3001 (la prod, éventuellement) et n'écrit pas dans le messenger.db du dépôt.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const SERVER_ENTRY = path.join(PROJECT_ROOT, 'server/index.js');
const JWT_SECRET = crypto.randomBytes(32).toString('hex');

let serverProc;
let tmpDir;
let port;
let db;

const IDS = { owner: 9301, contact: 9302, stranger: 9303 };
const EMOTE_ID = 'emo_auth_test';
const EMOTE_FILE = `auth_test_asset_${process.pid}.bin`;
// Dossier des émoticônes du serveur (relatif au code, pas au dossier de travail)
const EMOTICONS_DIR = path.join(PROJECT_ROOT, 'uploads', 'emoticons');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const getFreePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.listen(0, () => { const { port: p } = srv.address(); srv.close(() => resolve(p)); });
  srv.on('error', reject);
});
const waitForPort = async (p, timeoutMs = 15000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const sock = net.connect(p, '127.0.0.1', () => { sock.end(); resolve(true); });
      sock.on('error', () => resolve(false));
    });
    if (ok) return;
    await wait(150);
  }
  throw new Error(`Serveur de test non démarré sur le port ${p}`);
};

const makeHttp = (apiPath, method, token) => new Promise((resolve) => {
  const req = http.request({
    hostname: '127.0.0.1',
    port,
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

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwlm-routeauth-'));
  port = await getFreePort();
  serverProc = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: tmpDir,
    env: { ...process.env, PORT: String(port), JWT_SECRET, NODE_ENV: 'test' },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  await waitForPort(port);
  db = new Database(path.join(tmpDir, 'messenger.db'));
});

after(async () => {
  try { db?.close(); } catch { /* ignore */ }
  if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM');
  await wait(200);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const tok = (id, username) => jwt.sign({ id, username, tv: 0 }, JWT_SECRET);
const connect = (token) => new Promise((resolve, reject) => {
  const s = ClientIO(`http://127.0.0.1:${port}`, { auth: { token }, transports: ['websocket'], forceNew: true, reconnection: false });
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

test('public-key : self + contact autorisés, étranger refusé (403)', async () => {
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

test('emoticon asset : propriétaire + contact autorisés, étranger refusé (403)', async () => {
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

test('jeux : un étranger ne peut pas injecter game_restart / game_quit', async () => {
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

test('jeux : un restart légitime (partie active) est bien livré', async () => {
  seed();
  const s1 = await connect(tok(IDS.owner, 'auth_owner'));
  const s2 = await connect(tok(IDS.contact, 'auth_contact'));
  try {
    s1.emit('game_invite', { target: IDS.contact, gameType: 'morpion' });
    await wait(200);
    s2.emit('game_accept', { target: IDS.owner, gameType: 'morpion' });
    await wait(400);

    // En pleine partie, « Rejouer » est refusé (l'interface ne le propose qu'à la fin)
    const refused = await new Promise((resolve) => {
      s2.once('game_restart', () => resolve('delivered'));
      s1.once('game_error', (e) => resolve(e?.message));
      s1.emit('game_restart', { target: IDS.contact });
      setTimeout(() => resolve(null), 800);
    });
    assert.match(String(refused), /en cours/i, 'restart en pleine partie refusé');

    // Partie jouée jusqu'au bout (X gagne : 0, 1, 2)
    for (const [sock, target, index] of [[s1, IDS.contact, 0], [s2, IDS.owner, 3], [s1, IDS.contact, 1], [s2, IDS.owner, 4], [s1, IDS.contact, 2]]) {
      sock.emit('game_move', { target, index });
      await wait(120);
    }

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
