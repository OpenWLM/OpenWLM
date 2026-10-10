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
 * Non-régression — bugs d'imports du refactor :
 *  1. `manual_disconnect` référençait `socketToUser` non importé (ReferenceError → crash).
 *     → le serveur doit RESTER EN VIE après l'événement.
 *  2. `/api/logout` référençait `getUserRoom` non importé (ReferenceError avalée) → sockets non coupées.
 *     → la socket doit être RÉELLEMENT coupée au logout.
 *
 * Nécessite le serveur démarré sur http://localhost:3001 (skip sinon).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const jwtSecretPath = path.join(PROJECT_ROOT, '.jwt_secret');
const JWT_SECRET = fs.existsSync(jwtSecretPath) ? fs.readFileSync(jwtSecretPath, 'utf8').trim() : null;
const db = new Database(path.join(PROJECT_ROOT, 'messenger.db'));

const UID = 9951;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const probe = () => new Promise((resolve) => {
  if (!JWT_SECRET) return resolve(false);
  const req = http.request({ hostname: 'localhost', port: 3001, path: '/api/push/status', method: 'GET' }, (res) => { res.resume(); resolve(res.statusCode === 200); });
  req.on('error', () => resolve(false));
  req.end();
});
const serverUp = await probe();
const tok = (id, username) => jwt.sign({ id, username, tv: 0 }, JWT_SECRET);

const connect = (token) => new Promise((resolve, reject) => {
  const s = ClientIO('http://localhost:3001', { auth: { token }, transports: ['websocket'] });
  s.once('connect', () => resolve(s));
  s.once('connect_error', reject);
  setTimeout(() => reject(new Error('Timeout socket')), 3000);
});

const postJson = (apiPath, token, body) => new Promise((resolve) => {
  const postData = JSON.stringify(body || {});
  const req = http.request({
    hostname: 'localhost', port: 3001, path: apiPath, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData), ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  }, (res) => {
    let raw = '';
    res.on('data', (c) => { raw += c; });
    res.on('end', () => { let d; try { d = JSON.parse(raw); } catch { d = raw; } resolve({ status: res.statusCode, data: d }); });
  });
  req.on('error', () => resolve({ status: 0 }));
  req.write(postData);
  req.end();
});

function cleanup() { try { db.prepare('DELETE FROM users WHERE id = ?').run(UID); } catch {} }
function seed() {
  cleanup();
  db.prepare(`
    INSERT INTO users (id, username, password_hash, salt, nickname, psm, avatar, scene, status, token_version, global_private)
    VALUES (?, 'md_user', 'hash', 'salt', 'MD', 'PSM', '/assets/usertiles/chess.png', '/assets/scenes/0006.png', 'online', 0, 0)
  `).run(UID);
}

test('manual_disconnect : ne fait pas crasher le serveur (import manquant)', { skip: serverUp ? false : 'Serveur non démarré' }, async () => {
  seed();
  const s = await connect(tok(UID, 'md_user'));
  try {
    s.emit('manual_disconnect');
    await wait(400);
    const alive = await probe();
    assert.equal(alive, true, 'le serveur doit rester en vie après manual_disconnect');
  } finally {
    try { s.disconnect(); } catch {}
    cleanup();
  }
});

test('logout : coupe réellement la socket (disconnectSockets effectif)', { skip: serverUp ? false : 'Serveur non démarré' }, async () => {
  seed();
  const s = await connect(tok(UID, 'md_user'));
  try {
    const disconnected = new Promise((resolve) => {
      s.once('disconnect', () => resolve(true));
      setTimeout(() => resolve(false), 2500);
    });
    const res = await postJson('/api/logout', tok(UID, 'md_user'), {});
    assert.equal(res.status, 200, 'logout accepté');
    assert.equal(await disconnected, true, 'la socket doit être coupée après logout');
    assert.equal(await probe(), true, 'le serveur doit rester en vie après logout');
  } finally {
    try { s.disconnect(); } catch {}
    cleanup();
  }
});
