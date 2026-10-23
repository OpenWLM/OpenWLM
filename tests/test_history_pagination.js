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
 * Historique paginé (GET /api/messages/:userId/:contactId) : les `limit` derniers messages par
 * ordre chronologique, `before` pour la page précédente, en-tête X-Has-More. Et
 * /api/logout-device : retire le cookie de CE navigateur sans révoquer les autres sessions.
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
const request = (apiPath, method, token) => new Promise((resolve) => {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const req = http.request({ hostname: '127.0.0.1', port, path: apiPath, method, headers }, (res) => {
    let raw = '';
    res.on('data', (c) => { raw += c; });
    res.on('end', () => { let d; try { d = JSON.parse(raw); } catch { d = raw; } resolve({ status: res.statusCode, data: d, headers: res.headers }); });
  });
  req.on('error', () => resolve({ status: 0 }));
  req.end();
});
const tok = (id) => jwt.sign({ id, tv: 0 }, JWT_SECRET, { expiresIn: '1h' });

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwlm-page-'));
  port = await getFreePort();
  serverProc = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: tmpDir,
    env: { ...process.env, PORT: String(port), JWT_SECRET, NODE_ENV: 'test' },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  await waitForPort(port);
  db = new Database(path.join(tmpDir, 'messenger.db'));
  const insert = db.prepare("INSERT INTO users (username, nickname, status, password_hash, salt, token_version) VALUES (?, ?, 'online', 'h', 's', 0)");
  alice = Number(insert.run('pg_alice', 'Alice').lastInsertRowid);
  bob = Number(insert.run('pg_bob', 'Bob').lastInsertRowid);
  const msg = db.prepare("INSERT INTO messages (sender_id, receiver_id, text, type, delivery_status, timestamp) VALUES (?, ?, ?, 'text', 'sent', ?)");
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  db.transaction(() => {
    for (let i = 0; i < 350; i++) msg.run(i % 2 ? alice : bob, i % 2 ? bob : alice, `m${i}`, new Date(t0 + i * 1000).toISOString());
  })();
});

after(async () => {
  try { db?.close(); } catch { /* ignore */ }
  if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM');
  await sleep(200);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('historique : les 300 derniers messages, dans l’ordre, avec X-Has-More', async () => {
  const r = await request(`/api/messages/${alice}/${bob}`, 'GET', tok(alice));
  assert.equal(r.status, 200);
  assert.equal(r.data.length, 300);
  assert.equal(r.data[0].text, 'm50');
  assert.equal(r.data[299].text, 'm349');
  assert.equal(r.headers['x-has-more'], '1');
});

test('historique : page précédente avec before, puis plus rien', async () => {
  const first = await request(`/api/messages/${alice}/${bob}`, 'GET', tok(alice));
  const oldest = first.data[0].id;
  const r = await request(`/api/messages/${alice}/${bob}?before=${oldest}`, 'GET', tok(alice));
  assert.equal(r.data.length, 50);
  assert.equal(r.data[0].text, 'm0');
  assert.equal(r.data[49].text, 'm49');
  assert.equal(r.headers['x-has-more'], '0');
  const small = await request(`/api/messages/${alice}/${bob}?limit=10`, 'GET', tok(alice));
  assert.equal(small.data.length, 10);
  assert.equal(small.data[9].text, 'm349');
  const huge = await request(`/api/messages/${alice}/${bob}?limit=999999`, 'GET', tok(alice));
  assert.equal(huge.data.length, 350, 'plafond 1000 : tout tient');
  assert.equal(huge.headers['x-has-more'], '0');
});

test('logout-device : retire le cookie sans révoquer les sessions du compte', async () => {
  const tvBefore = db.prepare('SELECT token_version FROM users WHERE id = ?').get(alice).token_version;
  const r = await request('/api/logout-device', 'POST', tok(alice));
  assert.equal(r.status, 200);
  assert.match(String(r.headers['set-cookie'] || ''), /token=;/);
  assert.equal(db.prepare('SELECT token_version FROM users WHERE id = ?').get(alice).token_version, tvBefore);
  assert.equal((await request(`/api/messages/${alice}/${bob}?limit=1`, 'GET', tok(alice))).status, 200, 'le jeton des autres appareils reste valable');
});
