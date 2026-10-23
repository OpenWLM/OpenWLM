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

/**
 * Émoticônes personnalisées : copie de la clé AES chiffrée par le client pour sa propre clé
 * publique (format encryptForLocal), stockée par le serveur sans pouvoir la lire. Sans elle, la
 * clé n'existait qu'en IndexedDB et disparaissait à la déconnexion.
 *  - acceptée à l'upload et renvoyée par /emoticons/custom/my ;
 *  - ajoutée après coup (émoticônes plus anciennes) par le propriétaire seulement, une seule fois ;
 *  - forme contrôlée (JSON { iv, data, key } base64, ≤ 4 Ko).
 * Serveur isolé (dossier temporaire, port libre).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, '../server/index.js');
const JWT_SECRET = crypto.randomBytes(32).toString('hex');

let serverProc;
let tmpDir;
let port;
let db;
let alice;
let bob;

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
const request = (apiPath, method, token, body, headers = {}) => new Promise((resolve) => {
  const payload = body === undefined ? '' : (Buffer.isBuffer(body) ? body : JSON.stringify(body));
  const h = { ...headers };
  if (body !== undefined) {
    if (!h['Content-Type']) h['Content-Type'] = 'application/json';
    h['Content-Length'] = Buffer.byteLength(payload);
  }
  if (token) h['Authorization'] = `Bearer ${token}`;
  const req = http.request({ hostname: '127.0.0.1', port, path: apiPath, method, headers: h }, (res) => {
    let raw = '';
    res.on('data', (c) => { raw += c; });
    res.on('end', () => { let d; try { d = JSON.parse(raw); } catch { d = raw; } resolve({ status: res.statusCode, data: d }); });
  });
  req.on('error', () => resolve({ status: 0 }));
  if (payload) req.write(payload);
  req.end();
});
const tok = (id) => jwt.sign({ id, tv: 0 }, JWT_SECRET, { expiresIn: '1h' });
const b64 = (n) => crypto.randomBytes(n).toString('base64');
const encryptedKey = () => JSON.stringify({ iv: b64(12), data: b64(48), key: b64(256) });

/** Upload multipart d'une émoticône (blob « chiffré » factice) avec les champs attendus. */
const upload = (token, fields) => {
  const boundary = 'emokeyboundary';
  const parts = [];
  for (const [k, v] of Object.entries(fields)) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="encrypted_asset.bin"\r\nContent-Type: application/octet-stream\r\n\r\n${'\u0000'.repeat(64)}\r\n`);
  parts.push(`--${boundary}--\r\n`);
  return request('/api/emoticons/custom/upload', 'POST', token, Buffer.from(parts.join('')), { 'Content-Type': `multipart/form-data; boundary=${boundary}` });
};

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwlm-emokey-'));
  port = await getFreePort();
  serverProc = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: tmpDir,
    env: { ...process.env, PORT: String(port), JWT_SECRET, NODE_ENV: 'test' },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  await waitForPort(port);
  db = new Database(path.join(tmpDir, 'messenger.db'));
  const insert = db.prepare("INSERT INTO users (username, nickname, status, password_hash, salt, token_version) VALUES (?, ?, 'online', 'h', 's', 0)");
  alice = Number(insert.run('ek_alice', 'Alice').lastInsertRowid);
  bob = Number(insert.run('ek_bob', 'Bob').lastInsertRowid);
});

after(async () => {
  try { db?.close(); } catch { /* ignore */ }
  if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM');
  await sleep(200);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('upload avec clé chiffrée : stockée telle quelle et renvoyée au propriétaire', async () => {
  const key = encryptedKey();
  const r = await upload(tok(alice), { shortcut: '(cle)', mimeType: 'image/png', width: 32, height: 32, isAnimated: 0, encryptedKey: key });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const my = await request('/api/emoticons/custom/my', 'GET', tok(alice));
  const mine = my.data.emoticons.find((e) => e.id === r.data.emoticon.id);
  assert.equal(mine.encrypted_key, key);
  // Clé mal formée refusée, rien d'enregistré
  const bad = await upload(tok(alice), { shortcut: '(mauvaise)', mimeType: 'image/png', width: 32, height: 32, isAnimated: 0, encryptedKey: '{"iv":"x"}' });
  assert.equal(bad.status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM custom_emoticons WHERE shortcut = '(mauvaise)'").get().c, 0);
});

test('émoticône ancienne (sans copie) : la clé est ajoutée par son propriétaire, une seule fois', async () => {
  const r = await upload(tok(alice), { shortcut: '(ancienne)', mimeType: 'image/png', width: 32, height: 32, isAnimated: 0 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const id = r.data.emoticon.id;
  assert.equal(db.prepare('SELECT encrypted_key FROM custom_emoticons WHERE id = ?').get(id).encrypted_key, null);

  // Bob (pas propriétaire) : refusé
  assert.equal((await request('/api/emoticons/custom/key', 'POST', tok(bob), { id, encryptedKey: encryptedKey() })).status, 404);
  // Alice : enregistrée
  const key = encryptedKey();
  assert.equal((await request('/api/emoticons/custom/key', 'POST', tok(alice), { id, encryptedKey: key })).status, 200);
  assert.equal(db.prepare('SELECT encrypted_key FROM custom_emoticons WHERE id = ?').get(id).encrypted_key, key);
  // Déjà enregistrée : pas d'écrasement
  assert.equal((await request('/api/emoticons/custom/key', 'POST', tok(alice), { id, encryptedKey: encryptedKey() })).status, 404);
  assert.equal(db.prepare('SELECT encrypted_key FROM custom_emoticons WHERE id = ?').get(id).encrypted_key, key);
  // Forme contrôlée
  assert.equal((await request('/api/emoticons/custom/key', 'POST', tok(alice), { id: 'emo_x', encryptedKey: key })).status, 400);
  assert.equal((await request('/api/emoticons/custom/key', 'POST', tok(alice), { id, encryptedKey: 'x'.repeat(5000) })).status, 400);
});
