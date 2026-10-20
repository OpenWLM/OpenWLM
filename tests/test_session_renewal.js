import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';

/**
 * Session d'un appareil mémorisé (« se souvenir de cet appareil ») :
 * - login avec remember=true → cookie de 30 jours, jeton marqué `rm` ; sinon 24 h ;
 * - GET /api/user/me réémet le cookie d'un jeton `rm` de plus de 12 h (session glissante),
 *   jamais celui d'une session normale ni d'un jeton récent ;
 * - un jeton révoqué (token_version) n'est jamais renouvelé.
 *
 * Nécessite le serveur de test démarré sur http://localhost:3001 (skip sinon).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const jwtSecretPath = path.join(PROJECT_ROOT, '.jwt_secret');
const JWT_SECRET = fs.existsSync(jwtSecretPath) ? fs.readFileSync(jwtSecretPath, 'utf8').trim() : null;
const db = new Database(path.join(PROJECT_ROOT, 'messenger.db'));

const UID = 9431;
const HOUR = 60 * 60;

const request = (apiPath, method, { token, cookie, body } = {}) => new Promise((resolve) => {
  const postData = body ? JSON.stringify(body) : '';
  const headers = {};
  if (body) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(postData);
  }
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (cookie) headers['Cookie'] = `token=${cookie}`;
  const req = http.request({ hostname: 'localhost', port: 3001, path: apiPath, method, headers }, (res) => {
    let raw = '';
    res.on('data', (c) => { raw += c; });
    res.on('end', () => {
      let d;
      try { d = JSON.parse(raw); } catch { d = raw; }
      resolve({ status: res.statusCode, data: d, setCookie: res.headers['set-cookie'] });
    });
  });
  req.on('error', () => resolve({ status: 0 }));
  if (postData) req.write(postData);
  req.end();
});

const probe = async () => {
  if (!JWT_SECRET) return false;
  const r = await request('/api/push/status', 'GET');
  return r.status === 200;
};
const serverUp = await probe();
const skip = serverUp ? false : 'Serveur non démarré';

const sessionCookie = (setCookie) => [].concat(setCookie || []).find((c) => c.startsWith('token='));
const maxAgeOf = (cookie) => Number((/Max-Age=(\d+)/i.exec(cookie) || [])[1]);
const tokenOf = (cookie) => decodeURIComponent(cookie.split(';')[0].slice('token='.length));

/** Jeton émis il y a `ageS` secondes. */
const tokenAged = (ageS, extra = {}, ttlS = 30 * 24 * HOUR) => {
  const iat = Math.floor(Date.now() / 1000) - ageS;
  return jwt.sign({ id: UID, username: 'renew_user', tv: 0, iat, exp: iat + ttlS, ...extra }, JWT_SECRET);
};

// Même dérivation que le serveur (server/middleware/auth.js) : compte créé sans passer par
// /api/signup, dont le plafond par IP est déjà atteint par le reste de la suite.
const AUTH_KEY = crypto.randomBytes(32).toString('hex');
const SALT = crypto.randomBytes(16).toString('hex');
const PASSWORD_HASH = crypto.pbkdf2Sync(AUTH_KEY, SALT, 210000, 64, 'sha512').toString('hex');

function seedUser() {
  db.prepare('DELETE FROM users WHERE id = ?').run(UID);
  db.prepare(`
    INSERT INTO users (id, username, password_hash, salt, nickname, psm, avatar, scene, status, token_version, global_private)
    VALUES (?, 'renew_user', ?, ?, 'Renew', '', '/assets/usertiles/chess.png', '/assets/scenes/0006.png', 'online', 0, 0)
  `).run(UID, PASSWORD_HASH, SALT);
}
const cleanup = () => {
  try { db.prepare('DELETE FROM users WHERE id = ?').run(UID); } catch { /* ignore */ }
};

test('user/me : jeton mémorisé de plus de 12 h réémis pour 30 jours', { skip }, async () => {
  seedUser();
  try {
    const res = await request('/api/user/me', 'GET', { cookie: tokenAged(13 * HOUR, { rm: 1 }) });
    assert.equal(res.status, 200);
    const c = sessionCookie(res.setCookie);
    assert.ok(c, 'cookie de session réémis');
    assert.equal(maxAgeOf(c), 30 * 24 * HOUR);
    assert.match(c, /HttpOnly/i);
    assert.match(c, /SameSite=Strict/i);
    const payload = jwt.verify(tokenOf(c), JWT_SECRET);
    assert.equal(payload.rm, 1, 'le nouveau jeton reste « mémorisé »');
    assert.equal(payload.id, UID);
    assert.ok(Math.floor(Date.now() / 1000) - payload.iat < 60, 'nouveau jeton récent');
  } finally {
    cleanup();
  }
});

test('user/me : pas de renouvellement pour un jeton récent ou une session normale', { skip }, async () => {
  seedUser();
  try {
    const recent = await request('/api/user/me', 'GET', { cookie: tokenAged(HOUR, { rm: 1 }) });
    assert.equal(recent.status, 200);
    assert.equal(sessionCookie(recent.setCookie), undefined, 'jeton mémorisé récent : pas de Set-Cookie');

    const normal = await request('/api/user/me', 'GET', { cookie: tokenAged(13 * HOUR, {}, 24 * HOUR) });
    assert.equal(normal.status, 200);
    assert.equal(sessionCookie(normal.setCookie), undefined, 'session normale : jamais prolongée');
  } finally {
    cleanup();
  }
});

test('user/me : un jeton mémorisé révoqué n\'est pas renouvelé', { skip }, async () => {
  seedUser();
  try {
    db.prepare('UPDATE users SET token_version = 1 WHERE id = ?').run(UID);
    const res = await request('/api/user/me', 'GET', { cookie: tokenAged(13 * HOUR, { rm: 1 }) });
    assert.equal(res.status, 401);
    assert.equal(sessionCookie(res.setCookie), undefined);
  } finally {
    cleanup();
  }
});

test('login : 30 jours avec remember=true, 24 h sinon', { skip }, async () => {
  seedUser();
  try {
    const login = (extra) => request('/api/login', 'POST', { body: { username: 'renew_user', password: AUTH_KEY, ...extra } });

    const remembered = await login({ remember: true });
    assert.equal(remembered.status, 200);
    const rc = sessionCookie(remembered.setCookie);
    assert.equal(maxAgeOf(rc), 30 * 24 * HOUR);
    assert.equal(jwt.verify(tokenOf(rc), JWT_SECRET).rm, 1);

    const normal = await login({});
    assert.equal(normal.status, 200);
    const nc = sessionCookie(normal.setCookie);
    assert.equal(maxAgeOf(nc), 24 * HOUR);
    assert.equal(jwt.verify(tokenOf(nc), JWT_SECRET).rm, undefined);

    // Valeur non booléenne : session normale
    const loose = await login({ remember: 'yes' });
    assert.equal(loose.status, 200);
    assert.equal(maxAgeOf(sessionCookie(loose.setCookie)), 24 * HOUR);
  } finally {
    cleanup();
  }
});
