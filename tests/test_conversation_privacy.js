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
import { io as ClientIO } from 'socket.io-client';

/**
 * Mode privé PAR CONVERSATION : état persisté côté serveur (table conversation_privacy).
 * Serveur de test dédié + base temporaire — jamais la prod.
 *
 *  - migration : table vide au départ, comportement par défaut inchangé (non privé) ;
 *  - le `isPrivate` envoyé par le client n'est plus décisionnaire (dans un sens comme dans l'autre) ;
 *  - chacun n'écrit que SA ligne (owner = identité authentifiée de la socket) ;
 *  - personne ne peut retirer la confidentialité voulue par l'autre ;
 *  - l'état est relu à la reconnexion via la liste des contacts (pas besoin de rebasculer).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, '../server/index.js');
const JWT_SECRET = crypto.randomBytes(32).toString('hex');

let serverProc;
let tmpDir;
let port;
let aliceId;
let bobId;
let charlieId;

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
const reqJson = (apiPath, method, token, body) => new Promise((resolve) => {
  const postData = body !== undefined ? JSON.stringify(body) : '';
  const headers = {};
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(postData); }
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const req = http.request({ hostname: '127.0.0.1', port, path: apiPath, method, headers }, (res) => {
    let raw = '';
    res.on('data', (c) => { raw += c; });
    res.on('end', () => { let d; try { d = JSON.parse(raw); } catch { d = raw; } resolve({ status: res.statusCode, data: d }); });
  });
  req.on('error', () => resolve({ status: 0 }));
  if (postData) req.write(postData);
  req.end();
});
const tok = (id) => jwt.sign({ id, tv: 0 }, JWT_SECRET, { expiresIn: '1h' });
const connect = (id) => new Promise((resolve, reject) => {
  const s = ClientIO(`http://127.0.0.1:${port}`, { auth: { token: tok(id) }, transports: ['websocket'], forceNew: true, reconnection: false });
  s.events = [];
  s.onAny((name, payload) => s.events.push({ name, payload }));
  s.once('connect', () => resolve(s));
  s.once('connect_error', reject);
  setTimeout(() => reject(new Error('Timeout socket')), 3000);
});
const send = (s, senderId, receiverId, extra = {}) => new Promise((resolve) => {
  s.emit('send_message', { senderId, receiverId, text: `m_${crypto.randomUUID()}`, type: 'text', ...extra }, resolve);
});
const withDb = (fn) => {
  const db = new Database(path.join(tmpDir, 'messenger.db'));
  try { return fn(db); } finally { db.close(); }
};
const row = (owner, contact) => withDb((db) => db.prepare('SELECT is_private FROM conversation_privacy WHERE owner_id = ? AND contact_id = ?').get(owner, contact));
const storedCount = () => withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM messages').get().n);
const contactsOf = async (id) => (await reqJson(`/api/contacts/${id}`, 'GET', tok(id))).data;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwlm-convpriv-'));
  port = await getFreePort();
  serverProc = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: tmpDir,
    env: { ...process.env, PORT: String(port), JWT_SECRET, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitForPort(port);

  withDb((db) => {
    const insert = db.prepare("INSERT INTO users (username, nickname, status, password_hash, salt, token_version) VALUES (?, ?, 'online', 'h', 's', 0)");
    aliceId = Number(insert.run('cp_alice', 'Alice').lastInsertRowid);
    bobId = Number(insert.run('cp_bob', 'Bob').lastInsertRowid);
    charlieId = Number(insert.run('cp_charlie', 'Charlie').lastInsertRowid);
    const contact = db.prepare('INSERT INTO contacts (user_id, contact_id, status, blocked) VALUES (?, ?, 1, 0)');
    // Alice <-> Bob et Bob <-> Charlie sont contacts ; Alice et Charlie ne le sont pas.
    contact.run(aliceId, bobId); contact.run(bobId, aliceId);
    contact.run(bobId, charlieId); contact.run(charlieId, bobId);
  });
});

after(async () => {
  if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM');
  await sleep(200);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('migration : table vide, contacts non privés par défaut, message stocké normalement', async () => {
  assert.equal(withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM conversation_privacy').get().n), 0);
  const list = await contactsOf(aliceId);
  const bob = list.find((c) => c.id === bobId);
  assert.equal(bob.my_private, 0);
  assert.equal(bob.their_private, 0);

  const a = await connect(aliceId);
  try {
    const before = storedCount();
    const ack = await send(a, aliceId, bobId);
    assert.equal(ack.success, true);
    assert.equal(ack.isPrivate, false);
    assert.equal(storedCount(), before + 1, 'message normal persisté');
  } finally { a.disconnect(); }
});

test('isPrivate:true du client sans préférence enregistrée → stocké normalement (pas de sur-confidentialité)', async () => {
  const a = await connect(aliceId);
  try {
    const before = storedCount();
    const ack = await send(a, aliceId, bobId, { isPrivate: true });
    assert.equal(ack.success, true);
    assert.equal(ack.isPrivate, false, 'le serveur décide : conversation non privée');
    assert.equal(storedCount(), before + 1);
  } finally { a.disconnect(); }
});

test('préférence du destinataire : isPrivate:false du client ignoré, rien n\'est stocké', async () => {
  const a = await connect(aliceId);
  const b = await connect(bobId);
  try {
    b.emit('toggle_private_mode', { senderId: bobId, receiverId: aliceId, isPrivate: true });
    await sleep(200);
    assert.equal(row(bobId, aliceId)?.is_private, 1, 'ligne de Bob persistée');
    const notif = a.events.find((e) => e.name === 'private_mode_changed');
    assert.ok(notif, 'Alice est notifiée en direct');
    assert.equal(notif.payload.senderId, bobId);
    assert.equal(notif.payload.isPrivate, true);
    assert.equal(notif.payload.effectivePrivate, true);

    const before = storedCount();
    const ack = await send(a, aliceId, bobId, { isPrivate: false });
    assert.equal(ack.success, true);
    assert.equal(ack.isPrivate, true, 'forcé privé par la préférence de Bob');
    assert.equal(storedCount(), before, 'aucun stockage');

    // Alice ne peut pas retirer la confidentialité voulue par Bob : elle n'écrit que sa ligne
    a.emit('toggle_private_mode', { senderId: aliceId, receiverId: bobId, isPrivate: false });
    await sleep(200);
    assert.equal(row(bobId, aliceId)?.is_private, 1, 'la ligne de Bob est intacte');
    assert.equal(row(aliceId, bobId)?.is_private, 0);
    const ack2 = await send(a, aliceId, bobId, { isPrivate: false });
    assert.equal(ack2.isPrivate, true, 'toujours privé tant que Bob le veut');
    assert.equal(storedCount(), before);
  } finally {
    b.emit('toggle_private_mode', { senderId: bobId, receiverId: aliceId, isPrivate: false });
    await sleep(150);
    a.disconnect(); b.disconnect();
  }
});

test('altération : on ne peut écrire que SA propre ligne', async () => {
  const a = await connect(aliceId);
  try {
    // senderId usurpé → rejeté, aucune ligne pour Bob
    a.emit('toggle_private_mode', { senderId: bobId, receiverId: aliceId, isPrivate: true });
    // champ ownerId injecté → ignoré, seule la ligne d'Alice est écrite
    a.emit('toggle_private_mode', { ownerId: bobId, senderId: aliceId, receiverId: bobId, isPrivate: true });
    // Charlie n'est pas un contact d'Alice → rejeté
    a.emit('toggle_private_mode', { senderId: aliceId, receiverId: charlieId, isPrivate: true });
    // Charges malformées → ignorées sans crash
    a.emit('toggle_private_mode', { senderId: aliceId, receiverId: 'abc', isPrivate: true });
    a.emit('toggle_private_mode', { senderId: aliceId, receiverId: bobId, isPrivate: 'yes' });
    a.emit('toggle_private_mode', null);
    await sleep(250);

    assert.equal(row(bobId, aliceId)?.is_private ?? 0, 0, 'la ligne de Bob n\'a pas été touchée');
    assert.equal(row(aliceId, bobId)?.is_private, 1, 'Alice a écrit sa propre ligne');
    assert.equal(row(aliceId, charlieId), undefined, 'aucune ligne vers un non-contact');
    assert.equal(withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM conversation_privacy WHERE owner_id <> ? AND is_private = 1').get(aliceId).n), 0,
      'aucune ligne activée pour un autre propriétaire');
  } finally {
    a.emit('toggle_private_mode', { senderId: aliceId, receiverId: bobId, isPrivate: false });
    await sleep(150);
    a.disconnect();
  }
});

test('resynchronisation : état changé pendant que le contact est hors ligne, relu à la reconnexion', async () => {
  // Alice est hors ligne ; Bob active le mode privé de la conversation puis son mode global
  const b = await connect(bobId);
  try {
    b.emit('toggle_private_mode', { senderId: bobId, receiverId: aliceId, isPrivate: true });
    await sleep(200);
    let bob = (await contactsOf(aliceId)).find((c) => c.id === bobId);
    assert.equal(bob.their_private, 1, 'Alice voit la préférence de Bob sans avoir reçu l\'événement');
    assert.equal(bob.my_private, 0);

    b.emit('toggle_private_mode', { senderId: bobId, receiverId: aliceId, isPrivate: false });
    assert.equal((await reqJson('/api/user/global-private', 'POST', tok(bobId), { globalPrivate: true })).status, 200);
    await sleep(200);
    bob = (await contactsOf(aliceId)).find((c) => c.id === bobId);
    assert.equal(bob.their_private, 0);
    assert.equal(bob.global_private, 1, 'mode global relu');

    assert.equal((await reqJson('/api/user/global-private', 'POST', tok(bobId), { globalPrivate: false })).status, 200);
    bob = (await contactsOf(aliceId)).find((c) => c.id === bobId);
    assert.equal(bob.global_private, 0, 'désactivation du global relue sans rebasculer');
  } finally { b.disconnect(); }
});

test('multi-sessions : les autres sessions du propriétaire reçoivent private_mode_self_sync', async () => {
  const a1 = await connect(aliceId);
  const a2 = await connect(aliceId);
  try {
    a1.emit('toggle_private_mode', { senderId: aliceId, receiverId: bobId, isPrivate: true });
    await sleep(200);
    const sync = a2.events.find((e) => e.name === 'private_mode_self_sync');
    assert.ok(sync, 'la seconde session est resynchronisée');
    assert.equal(sync.payload.contactId, bobId);
    assert.equal(sync.payload.isPrivate, true);
    assert.equal((await contactsOf(aliceId)).find((c) => c.id === bobId).my_private, 1);
  } finally {
    a1.emit('toggle_private_mode', { senderId: aliceId, receiverId: bobId, isPrivate: false });
    await sleep(150);
    a1.disconnect(); a2.disconnect();
  }
});
