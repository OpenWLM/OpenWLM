import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';

/**
 * Durcissement — /api/user/keys valide la forme de la clé publique (JWK RSA)
 * et la présence du coffre chiffré. Nécessite le serveur sur http://localhost:3001.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const jwtSecretPath = path.join(PROJECT_ROOT, '.jwt_secret');
const JWT_SECRET = fs.existsSync(jwtSecretPath) ? fs.readFileSync(jwtSecretPath, 'utf8').trim() : null;
const db = new Database(path.join(PROJECT_ROOT, 'messenger.db'));

const UID = 9701;

const post = (apiPath, token, body) => new Promise((resolve) => {
  const postData = JSON.stringify(body);
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

const probe = () => new Promise((resolve) => {
  if (!JWT_SECRET) return resolve(false);
  const req = http.request({ hostname: 'localhost', port: 3001, path: '/api/push/status', method: 'GET' }, (res) => { res.resume(); resolve(res.statusCode === 200); });
  req.on('error', () => resolve(false));
  req.end();
});
const serverUp = await probe();
const tok = (id, username) => jwt.sign({ id, username, tv: 0 }, JWT_SECRET);

function cleanup() { try { db.prepare('DELETE FROM users WHERE id = ?').run(UID); } catch {} }
function seed() {
  cleanup();
  db.prepare(`
    INSERT INTO users (id, username, password_hash, salt, nickname, psm, avatar, scene, status, token_version, global_private)
    VALUES (?, 'kv_user', 'hash', 'salt', 'KV', 'PSM', '/assets/usertiles/chess.png', '/assets/scenes/0006.png', 'online', 0, 0)
  `).run(UID);
}

test('/api/user/keys : JWK RSA + coffre valides acceptés, formes invalides rejetées (400)', { skip: serverUp ? false : 'Serveur non démarré' }, async () => {
  seed();
  try {
    const token = tok(UID, 'kv_user');
    const validJwk = { kty: 'RSA', n: 'abc', e: 'AQAB' };

    const ok = await post('/api/user/keys', token, { publicKey: validJwk, encryptedPrivateKey: { iv: 'x', data: 'y' } });
    assert.equal(ok.status, 200, 'JWK RSA + coffre valides acceptés');

    const badKty = await post('/api/user/keys', token, { publicKey: { kty: 'EC', n: 'a', e: 'b' }, encryptedPrivateKey: {} });
    assert.equal(badKty.status, 400, 'kty non RSA rejeté');

    const missingFields = await post('/api/user/keys', token, { publicKey: { foo: 'bar' }, encryptedPrivateKey: {} });
    assert.equal(missingFields.status, 400, 'JWK sans n/e rejeté');

    const noVault = await post('/api/user/keys', token, { publicKey: validJwk });
    assert.equal(noVault.status, 400, 'coffre manquant rejeté');
  } finally {
    cleanup();
  }
});
