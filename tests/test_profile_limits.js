// Garde-fou des tests « live » chargé ici aussi, pas seulement par `npm test` (--import) :
// lancé à la main, ce fichier s'arrête si le serveur sur :3001 n'est pas le serveur de test
// de ce checkout (la prod, par exemple)
import '../scripts/live_server_guard.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import { solvePow } from './helpers/pow.js';

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
      captchaAnswer: cap.data.num1 + cap.data.num2,
      powNonce: solvePow(cap.data.pow)
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

test('mise en forme : seule la longueur visible compte, longueur brute bornée', { skip: serverUp ? false : 'Serveur non démarré' }, async () => {
  seedUser();
  try {
    const token = tok(UID, 'plim_user');

    // 50 caractères visibles + balises (59 caractères bruts) : accepté
    const okNick = await makeHttp('/api/user/update', 'POST', token, { nickname: `[c=4]${'x'.repeat(50)}[/c]` });
    assert.equal(okNick.status, 200, 'les balises ne comptent pas dans les 50 caractères');
    const okPsm = await makeHttp('/api/user/update', 'POST', token, { psm: `[c=4]${'y'.repeat(150)}[/c=12]` });
    assert.equal(okPsm.status, 200, 'les balises ne comptent pas dans les 150 caractères');

    // 51 caractères visibles : refusé, même entourés de balises
    const longNick = await makeHttp('/api/user/update', 'POST', token, { nickname: `[b]${'x'.repeat(51)}[/b]` });
    assert.equal(longNick.status, 400, '51 caractères visibles doivent être refusés');

    // Balises à rallonge : la longueur brute reste bornée (300 / 600)
    const rawNick = await makeHttp('/api/user/update', 'POST', token, { nickname: 'a' + '[b][/b]'.repeat(50) });
    assert.equal(rawNick.status, 400, 'surnom > 300 caractères bruts refusé');
    const rawPsm = await makeHttp('/api/user/update', 'POST', token, { psm: 'a' + '[i][/i]'.repeat(100) });
    assert.equal(rawPsm.status, 400, 'PSM > 600 caractères bruts refusé');

    const stored = db.prepare('SELECT nickname, psm FROM users WHERE id = ?').get(UID);
    assert.equal(stored.nickname, `[c=4]${'x'.repeat(50)}[/c]`, 'le surnom est stocké avec ses balises');
    assert.equal(stored.psm, `[c=4]${'y'.repeat(150)}[/c=12]`);
  } finally {
    cleanup();
  }
});
