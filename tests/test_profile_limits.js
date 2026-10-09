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
 * F2 — Non-régression : bornes de taille du surnom (nickname ≤ 50) et du
 * message personnel (psm ≤ 150), côté serveur, à l'inscription et à la mise à jour.
 *
 * Nécessite le serveur démarré sur http://localhost:3001 (skip sinon).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const jwtSecretPath = path.join(PROJECT_ROOT, '.jwt_secret');
const JWT_SECRET = fs.existsSync(jwtSecretPath) ? fs.readFileSync(jwtSecretPath, 'utf8').trim() : null;
const db = new Database(path.join(PROJECT_ROOT, 'messenger.db'));

const UID = 9401;

const makeHttp = (apiPath, method, token, body) => new Promise((resolve) => {
  const postData = body ? JSON.stringify(body) : '';
  const headers = {};
  if (body) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(postData);
  }
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const req = http.request({ hostname: 'localhost', port: 3001, path: apiPath, method, headers }, (res) => {
    let raw = '';
    res.on('data', (c) => { raw += c; });
    res.on('end', () => {
      let d;
      try { d = JSON.parse(raw); } catch { d = raw; }
      resolve({ status: res.statusCode, data: d });
    });
  });
  req.on('error', () => resolve({ status: 0 }));
  if (postData) req.write(postData);
  req.end();
});

const probe = async () => {
  if (!JWT_SECRET) return false;
  const r = await makeHttp('/api/push/status', 'GET');
  return r.status === 200;
};
const serverUp = await probe();
const tok = (id, username) => jwt.sign({ id, username, tv: 0 }, JWT_SECRET);

function cleanup() {
  try { db.prepare('DELETE FROM users WHERE id = ?').run(UID); } catch {}
  try { db.prepare("DELETE FROM users WHERE username LIKE 'plim_%'").run(); } catch {}
}

function seedUser() {
  cleanup();
  db.prepare(`
    INSERT INTO users (id, username, password_hash, salt, nickname, psm, avatar, scene, status, token_version, global_private)
    VALUES (?, 'plim_user', 'hash', 'salt', 'Plim', 'PSM', '/assets/usertiles/chess.png', '/assets/scenes/0006.png', 'online', 0, 0)
  `).run(UID);
}

test('signup : surnom > 50 caractères rejeté (400)', { skip: serverUp ? false : 'Serveur non démarré' }, async () => {
  try {
    const cap = await makeHttp('/api/captcha', 'GET');
    assert.equal(cap.status, 200, 'captcha accessible');
    const res = await makeHttp('/api/signup', 'POST', null, {
      username: 'plim_' + crypto.randomBytes(4).toString('hex'),
      password: crypto.randomBytes(32).toString('hex'),
      nickname: 'x'.repeat(51),
      captchaId: cap.data.id,
      captchaAnswer: cap.data.num1 + cap.data.num2
    });
    assert.equal(res.status, 400, 'signup avec surnom trop long doit être refusé');
  } finally {
    cleanup();
  }
});

test('update : surnom > 50 ou PSM > 150 rejetés (400), bornes exactes acceptées (200)', { skip: serverUp ? false : 'Serveur non démarré' }, async () => {
  seedUser();
  try {
    const token = tok(UID, 'plim_user');

    const longNick = await makeHttp('/api/user/update', 'POST', token, { nickname: 'x'.repeat(51) });
    assert.equal(longNick.status, 400, 'nickname > 50 doit être refusé');

    const longPsm = await makeHttp('/api/user/update', 'POST', token, { psm: 'y'.repeat(151) });
    assert.equal(longPsm.status, 400, 'psm > 150 doit être refusé');

    const ok = await makeHttp('/api/user/update', 'POST', token, { nickname: 'x'.repeat(50), psm: 'y'.repeat(150) });
    assert.equal(ok.status, 200, 'bornes exactes (50/150) doivent être acceptées');
  } finally {
    cleanup();
  }
});
