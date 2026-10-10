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
 * Révocation de session — après POST /api/user/change-password, la socket de l'utilisateur
 * doit être RÉELLEMENT coupée côté serveur (pas seulement un token_version incrémenté),
 * et la session courante doit être renouvelée (Set-Cookie).
 *
 * Nécessite le serveur sur http://localhost:3001 (skip sinon).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const jwtSecretPath = path.join(PROJECT_ROOT, '.jwt_secret');
const JWT_SECRET = fs.existsSync(jwtSecretPath) ? fs.readFileSync(jwtSecretPath, 'utf8').trim() : null;
const db = new Database(path.join(PROJECT_ROOT, 'messenger.db'));

const UID = 9801;
const OLD_KEY = crypto.randomBytes(32).toString('hex');
const NEW_KEY = crypto.randomBytes(32).toString('hex');

const hashPwd = (hex, salt) => crypto.pbkdf2Sync(hex, salt, 210000, 64, 'sha512').toString('hex');

const probe = () => new Promise((resolve) => {
  if (!JWT_SECRET) return resolve(false);
  const req = http.request({ hostname: 'localhost', port: 3001, path: '/api/push/status', method: 'GET' }, (res) => { res.resume(); resolve(res.statusCode === 200); });
  req.on('error', () => resolve(false));
  req.end();
});
const serverUp = await probe();
const tok = () => jwt.sign({ id: UID, username: 'rev_user', tv: 0 }, JWT_SECRET);

const connect = (token) => new Promise((resolve, reject) => {
  const s = ClientIO('http://localhost:3001', { auth: { token }, transports: ['websocket'] });
  s.once('connect', () => resolve(s));
  s.once('connect_error', reject);
  setTimeout(() => reject(new Error('Timeout socket')), 3000);
});

const postJson = (apiPath, token, body) => new Promise((resolve) => {
  const postData = JSON.stringify(body);
  const req = http.request({
    hostname: 'localhost', port: 3001, path: apiPath, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData), ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  }, (res) => {
    let raw = '';
    res.on('data', (c) => { raw += c; });
    res.on('end', () => { let d; try { d = JSON.parse(raw); } catch { d = raw; } resolve({ status: res.statusCode, data: d, setCookie: res.headers['set-cookie'] }); });
  });
  req.on('error', () => resolve({ status: 0 }));
  req.write(postData);
  req.end();
});

function cleanup() { try { db.prepare('DELETE FROM users WHERE id = ?').run(UID); } catch {} }
function seed() {
  cleanup();
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPwd(OLD_KEY, salt);
  db.prepare(`
    INSERT INTO users (id, username, password_hash, salt, nickname, psm, avatar, scene, status, token_version, global_private)
    VALUES (?, 'rev_user', ?, ?, 'Rev', 'PSM', '/assets/usertiles/chess.png', '/assets/scenes/0006.png', 'online', 0, 0)
  `).run(UID, hash, salt);
}

test('change-password : la socket est réellement déconnectée + session renouvelée', { skip: serverUp ? false : 'Serveur non démarré' }, async () => {
  seed();
  const s = await connect(tok());
  try {
    const disconnected = new Promise((resolve) => {
      s.once('disconnect', () => resolve(true));
      setTimeout(() => resolve(false), 2500);
    });

    const res = await postJson('/api/user/change-password', tok(), {
      oldAuthKeyHex: OLD_KEY,
      newAuthKeyHex: NEW_KEY,
      newEncryptedPrivateKey: { encryptedKeyBase64: 'A'.repeat(100), ivBase64: 'A'.repeat(16) }
    });
    assert.equal(res.status, 200, 'changement de mot de passe accepté');
    assert.ok(Array.isArray(res.setCookie) && res.setCookie.some((c) => c.startsWith('token=')), 'session courante renouvelée (Set-Cookie)');

    assert.equal(await disconnected, true, 'la socket de l\'utilisateur est coupée côté serveur');
  } finally {
    try { s.disconnect(); } catch {}
    cleanup();
  }
});
