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
import webpush from 'web-push';
import { io as ClientIO } from 'socket.io-client';

/**
 * Relecture de sécurité d'octobre 2026, lot 6 (serveur isolé) :
 *  - Wizz / clin d'œil : identifiant du destinataire normalisé (« 7e1 » passait le contrôle
 *    d'amitié comme 7 mais la notification Push partait vers 70) ;
 *  - liste des contacts : présence et message perso masqués hors relation mutuelle non bloquée
 *    (comme en temps réel) ;
 *  - WebSocket : origine vérifiée à l'ouverture (l'option cors ne couvre que le polling) ;
 *  - émoticônes personnalisées : volume total limité par compte.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, '../server/index.js');
const JWT_SECRET = crypto.randomBytes(32).toString('hex');
const VAPID = webpush.generateVAPIDKeys();

let serverProc;
let tmpDir;
let port;
let db;
let serverLog = '';

// Identifiants choisis : 7 et 70 (« 7e1 »), et des comptes sans lien avec eux
const ALICE = 500;
const CAROL = 7;
const DAVE = 70;
const BOB = 501;
const ERIN = 502;
const FRANK = 503;

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
const tok = (id) => jwt.sign({ id, tv: 0 }, JWT_SECRET, { expiresIn: '1h' });
const request = (apiPath, method, token, body) => new Promise((resolve) => {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const h = {};
  if (body !== undefined) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(payload); }
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
/** Envoi multipart minimal (un fichier et des champs texte). */
const upload = (apiPath, token, fields, fileBytes) => new Promise((resolve) => {
  const boundary = '----openwlm' + crypto.randomBytes(8).toString('hex');
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="e.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`));
  parts.push(fileBytes);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  const body = Buffer.concat(parts);
  const req = http.request({
    hostname: '127.0.0.1', port, path: apiPath, method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length, Authorization: `Bearer ${token}` }
  }, (res) => {
    let raw = '';
    res.on('data', (c) => { raw += c; });
    res.on('end', () => { let d; try { d = JSON.parse(raw); } catch { d = raw; } resolve({ status: res.statusCode, data: d }); });
  });
  req.on('error', () => resolve({ status: 0 }));
  req.write(body);
  req.end();
});
/** Connexion WebSocket ; `origin` : en-tête Origin envoyé (absent si undefined). */
const connect = (token, origin) => new Promise((resolve, reject) => {
  const s = ClientIO(`http://127.0.0.1:${port}`, {
    auth: { token }, transports: ['websocket'], forceNew: true, reconnection: false,
    ...(origin ? { extraHeaders: { Origin: origin } } : {})
  });
  const timer = setTimeout(() => { s.close(); reject(new Error('timeout')); }, 3000);
  s.once('connect', () => { clearTimeout(timer); resolve(s); });
  s.once('connect_error', (err) => { clearTimeout(timer); s.close(); reject(err); });
});

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwlm-lot6-'));
  port = await getFreePort();
  serverProc = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: tmpDir,
    env: { ...process.env, PORT: String(port), JWT_SECRET, NODE_ENV: 'test', VAPID_PUBLIC_KEY: VAPID.publicKey, VAPID_PRIVATE_KEY: VAPID.privateKey },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProc.stdout.on('data', (c) => { serverLog += c; });
  serverProc.stderr.on('data', (c) => { serverLog += c; });
  await waitForPort(port);
  db = new Database(path.join(tmpDir, 'messenger.db'));
  const insert = db.prepare("INSERT INTO users (id, username, nickname, psm, status, password_hash, salt, token_version) VALUES (?, ?, ?, ?, 'online', 'h', 's', 0)");
  insert.run(ALICE, 'l6_alice', 'Alice', 'psm alice');
  insert.run(CAROL, 'l6_carol', 'Carol', 'psm carol');
  insert.run(DAVE, 'l6_dave', 'Dave', 'psm dave');
  insert.run(BOB, 'l6_bob', 'Bob', 'psm bob');
  insert.run(ERIN, 'l6_erin', 'Erin', 'psm secret erin');
  insert.run(FRANK, 'l6_frank', 'Frank', 'psm secret frank');
  const c = db.prepare('INSERT INTO contacts (user_id, contact_id, status, blocked) VALUES (?, ?, 1, ?)');
  // Alice ↔ Carol (7) : amies ; Dave (70) n'a aucun lien avec Alice
  c.run(ALICE, CAROL, 0); c.run(CAROL, ALICE, 0);
  // Bob ↔ Alice mutuels ; Erin a supprimé Bob (seul Bob → Erin reste) ; Frank a bloqué Bob
  c.run(BOB, ALICE, 0); c.run(ALICE, BOB, 0);
  c.run(BOB, ERIN, 0);
  c.run(BOB, FRANK, 0); c.run(FRANK, BOB, 1);
  // Cibles Push refusées à l'envoi (adresse locale) : leur rejet est journalisé, ce qui
  // montre vers qui une notification est partie
  const sub = db.prepare('INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)');
  sub.run(CAROL, 'https://127.0.0.1/push-carol-seven', 'x', 'y', Date.now());
  sub.run(DAVE, 'https://127.0.0.1/push-dave-seventy', 'x', 'y', Date.now());
});

after(async () => {
  try { db?.close(); } catch { /* ignore */ }
  if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM');
  await sleep(200);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('Wizz : « 7e1 » ne notifie pas l’utilisateur 70, étranger à l’expéditeur', async () => {
  const s = await connect(tok(ALICE));
  try {
    // Témoin : un Wizz normal vers Carol (7) déclenche bien sa notification
    s.emit('send_wizz', { senderId: ALICE, receiverId: CAROL });
    for (let i = 0; i < 20 && !serverLog.includes('push-carol-seven'); i++) await sleep(100);
    assert.ok(serverLog.includes('push-carol-seven'), 'la notification de Carol est tentée (témoin)');
    s.emit('send_wizz', { senderId: ALICE, receiverId: `${CAROL}e1` });
    s.emit('send_wink', { senderId: ALICE, receiverId: `${CAROL}e1`, winkId: 'kiss' });
    await sleep(800);
    assert.ok(!serverLog.includes('push-dave-seventy'), 'aucune notification vers Dave (70)');
  } finally {
    s.close();
  }
});

test('liste des contacts : un contact qui m’a supprimé ou bloqué apparaît hors ligne, sans message perso', async () => {
  const res = await request(`/api/contacts/${BOB}`, 'GET', tok(BOB));
  assert.equal(res.status, 200);
  const byId = Object.fromEntries(res.data.map((c) => [c.id, c]));
  assert.equal(byId[ALICE].status, 'online', 'contact mutuel : vrai statut');
  assert.equal(byId[ALICE].psm, 'psm alice');
  for (const id of [ERIN, FRANK]) {
    assert.equal(byId[id].status, 'offline', `contact ${id} : hors ligne`);
    assert.ok(!byId[id].psm, `contact ${id} : message perso masqué`);
  }
  // Et Frank, qui a bloqué Bob, ne voit pas non plus le sien
  const frank = await request(`/api/contacts/${FRANK}`, 'GET', tok(FRANK));
  const bobSeenByFrank = frank.data.find((c) => c.id === BOB);
  assert.equal(bobSeenByFrank.status, 'offline');
  assert.ok(!bobSeenByFrank.psm);
});

test('WebSocket : origine étrangère refusée, page du serveur et clients sans origine acceptés', async () => {
  await assert.rejects(connect(tok(ALICE), 'https://evil.example'), 'origine étrangère');
  await assert.rejects(connect(tok(ALICE), 'http://192.0.2.10:8080'), 'autre hôte du réseau');
  const same = await connect(tok(ALICE), `http://127.0.0.1:${port}`);
  same.close();
  const none = await connect(tok(ALICE));
  none.close();
});

test('émoticônes : volume total par compte limité (20 Mo)', async () => {
  const add = db.prepare("INSERT INTO custom_emoticons (id, owner_id, shortcut, mime_type, file_size, width, height, is_animated, asset_filename, created_at) VALUES (?, ?, ?, 'image/gif', ?, 64, 64, 1, 'none.bin', ?)");
  for (let i = 0; i < 20; i++) add.run(`emo_fill_${i}`, BOB, `fill${i}`, 1024 * 1024 - 100, Date.now());
  const res = await upload('/api/emoticons/custom/upload', tok(BOB), { shortcut: 'over', mimeType: 'image/png', width: '32', height: '32', isAnimated: '0' }, crypto.randomBytes(4096));
  assert.equal(res.status, 400, JSON.stringify(res.data));
  assert.equal(res.data.code, 'emoticon_bytes_quota');
  // Sous le plafond : accepté
  db.prepare("DELETE FROM custom_emoticons WHERE owner_id = ? AND id LIKE 'emo_fill_%'").run(BOB);
  const ok = await upload('/api/emoticons/custom/upload', tok(BOB), { shortcut: 'small', mimeType: 'image/png', width: '32', height: '32', isAnimated: '0' }, crypto.randomBytes(4096));
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
});
