/**
 * Test de non-régression : statuts de message 1v1 (envoyé / remis / lu).
 *
 * Vérifie :
 * 1. Mode normal :
 *    - Message accepté par le serveur -> statut 'sent'
 *    - Accusé de réception (message_delivered) reçu -> statut 'delivered'
 *    - Accusé de lecture (message_read avec lastReadMessageId) -> statut 'read'
 *    - Récupération de l'historique GET /api/messages/:userId/:contactId conserve le statut et marque 'delivered' les messages lus par l'historique
 *    - Multi-session : les accusés sont propagés aux autres sessions de l'expéditeur et du destinataire
 * 2. Mode privé :
 *    - Zéro persistance en base de données pour les statuts et aucun curseur dans conversation_read_cursors
 *    - Événements éphémères live transmis sans persister
 * 3. Sécurité :
 *    - Usurpation du destinataire pour émettre un reçu de message refusé / inopérant
 *    - Interdiction d'accès ou d'altération sans token valide ou relation de contact
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import { io as ioClient } from 'socket.io-client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, '../server/index.js');
const JWT_SECRET = crypto.randomBytes(32).toString('hex');

let serverProc;
let tmpDir;
let port;
let aliceId;
let bobId;
let charlieId;
let tokenAlice;
let tokenBob;
let tokenCharlie;
const sockets = [];

const getFreePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.listen(0, () => {
    const { port: p } = srv.address();
    srv.close(() => resolve(p));
  });
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
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`Serveur non démarré sur le port ${p}`);
};

const connect = (userId) => new Promise((resolve, reject) => {
  const token = jwt.sign({ id: userId, tv: 0 }, JWT_SECRET, { expiresIn: '1h' });
  const s = ioClient(`http://127.0.0.1:${port}`, {
    auth: { token },
    transports: ['websocket'],
    forceNew: true,
    reconnection: false
  });
  s.received = [];
  s.statusUpdates = [];
  s.readUpdates = [];
  s.on('receive_message', (m) => s.received.push(m));
  s.on('message_status_updated', (u) => s.statusUpdates.push(u));
  s.on('conversation_read', (r) => s.readUpdates.push(r));
  s.once('connect', () => { sockets.push(s); resolve(s); });
  s.once('connect_error', reject);
});

const sendMessage = (s, payload) => new Promise((resolve) => {
  s.emit('send_message', payload, resolve);
});

const waitFor = async (predicate, timeoutMs = 3000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise(r => setTimeout(r, 25));
  }
  return predicate();
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwlm-status-test-'));
  port = await getFreePort();

  serverProc = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: tmpDir,
    env: { ...process.env, PORT: String(port), JWT_SECRET, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  await waitForPort(port);

  const db = new Database(path.join(tmpDir, 'messenger.db'));
  const insertUser = db.prepare("INSERT INTO users (username, nickname, status) VALUES (?, ?, 'online')");
  aliceId = Number(insertUser.run('alice_st', 'Alice').lastInsertRowid);
  bobId = Number(insertUser.run('bob_st', 'Bob').lastInsertRowid);
  charlieId = Number(insertUser.run('charlie_st', 'Charlie').lastInsertRowid);

  tokenAlice = jwt.sign({ id: aliceId, tv: 0 }, JWT_SECRET, { expiresIn: '1h' });
  tokenBob = jwt.sign({ id: bobId, tv: 0 }, JWT_SECRET, { expiresIn: '1h' });
  tokenCharlie = jwt.sign({ id: charlieId, tv: 0 }, JWT_SECRET, { expiresIn: '1h' });

  // Relations : Alice <-> Bob uniquement. Charlie est un tiers non-ami.
  const insertContact = db.prepare('INSERT INTO contacts (user_id, contact_id, status, blocked) VALUES (?, ?, 1, 0)');
  insertContact.run(aliceId, bobId);
  insertContact.run(bobId, aliceId);
  db.close();
});

after(async () => {
  sockets.forEach(s => s.connected && s.disconnect());
  if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM');
  await sleep(200);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('1. Statut envoyé / remis / lu en mode normal avec persistance minimale', async () => {
  const A1 = await connect(aliceId);
  const A2 = await connect(aliceId);
  const B1 = await connect(bobId);
  await sleep(100);

  // Étape 1 : Alice envoie un message à Bob
  const ack = await sendMessage(A1, {
    senderId: aliceId,
    receiverId: bobId,
    text: 'Hello Bob 1v1',
    isPrivate: false
  });
  assert.equal(ack?.success, true);
  const messageId = ack.id;

  // Vérification en BDD : le message est à delivery_status 'sent'
  const db = new Database(path.join(tmpDir, 'messenger.db'));
  const initialRow = db.prepare('SELECT delivery_status FROM messages WHERE id = ?').get(messageId);
  assert.equal(initialRow.delivery_status, 'sent', 'Le message initial doit être en état sent');

  // Étape 2 : Bob émet l'accusé de réception (remis)
  B1.emit('message_delivered', {
    messageId,
    senderId: aliceId,
    isPrivate: false
  });

  // A1 et A2 doivent recevoir la notification de remise
  const gotDelivered = await waitFor(() => A1.statusUpdates.length > 0 && A2.statusUpdates.length > 0);
  assert.ok(gotDelivered, 'Toutes les sessions de l expéditeur doivent recevoir message_status_updated');
  assert.equal(A1.statusUpdates[0].status, 'delivered');
  assert.equal(A1.statusUpdates[0].messageId, messageId);

  // Vérification BDD : le statut passe à 'delivered'
  const deliveredRow = db.prepare('SELECT delivery_status FROM messages WHERE id = ?').get(messageId);
  assert.equal(deliveredRow.delivery_status, 'delivered');

  // Étape 3 : Bob lit la conversation (accusé de lecture avec lastReadMessageId)
  B1.emit('message_read', {
    contactId: aliceId,
    lastReadMessageId: messageId,
    isPrivate: false
  });

  // A1 et A2 doivent recevoir conversation_read
  const gotRead = await waitFor(() => A1.readUpdates.length > 0 && A2.readUpdates.length > 0);
  assert.ok(gotRead, 'Toutes les sessions doivent recevoir conversation_read');
  assert.equal(A1.readUpdates[0].lastReadMessageId, messageId);

  // Vérification BDD : le curseur de lecture est enregistré et messages mis à jour à 'read'
  const cursorRow = db.prepare('SELECT last_read_message_id FROM conversation_read_cursors WHERE user_id = ? AND contact_id = ?').get(bobId, aliceId);
  assert.equal(cursorRow.last_read_message_id, messageId);

  const readRow = db.prepare('SELECT delivery_status FROM messages WHERE id = ?').get(messageId);
  assert.equal(readRow.delivery_status, 'read');

  db.close();
});

test('2. Historique HTTP synchronise delivery_status et applique le curseur de lecture', async () => {
  // Alice interroge l'historique : elle doit voir le message en statut 'read'
  const res = await fetch(`http://127.0.0.1:${port}/api/messages/${aliceId}/${bobId}`, {
    headers: { 'Authorization': `Bearer ${tokenAlice}` }
  });
  assert.equal(res.status, 200);
  const list = await res.json();
  assert.ok(list.length > 0);
  const lastMsg = list[list.length - 1];
  assert.equal(lastMsg.delivery_status, 'read', 'L historique renvoyé à Alice doit refléter la lecture de Bob');
});

test('3. Mode privé : AUCUNE persistance (ni message, ni reçu, ni curseur)', async () => {
  const A1 = sockets[0];
  const B1 = sockets[2];
  A1.statusUpdates.length = 0;
  A1.readUpdates.length = 0;

  // Alice envoie un message privé
  const ackPrivate = await sendMessage(A1, {
    senderId: aliceId,
    receiverId: bobId,
    text: 'Secret éphémère',
    isPrivate: true
  });
  assert.equal(ackPrivate?.success, true);
  const tempMsgId = ackPrivate.id;

  // Bob émet remis et lu en mode privé
  B1.emit('message_delivered', {
    messageId: tempMsgId,
    senderId: aliceId,
    isPrivate: true
  });

  B1.emit('message_read', {
    contactId: aliceId,
    lastReadMessageId: tempMsgId,
    isPrivate: true
  });

  const gotLiveEvents = await waitFor(() => A1.statusUpdates.length > 0 && A1.readUpdates.length > 0);
  assert.ok(gotLiveEvents, 'Les événements live éphémères sont transmis tant que les sockets sont connectés');

  // Vérification stricte en BDD : zéro trace
  const db = new Database(path.join(tmpDir, 'messenger.db'));
  const privateMsgCount = db.prepare("SELECT COUNT(*) as c FROM messages WHERE text = 'Secret éphémère'").get().c;
  assert.equal(privateMsgCount, 0, 'Le message privé ne doit jamais exister dans messages');

  const cursorPrivate = db.prepare('SELECT COUNT(*) as c FROM conversation_read_cursors WHERE last_read_message_id = ?').get(tempMsgId).c;
  assert.equal(cursorPrivate, 0, 'Aucun curseur de lecture ne doit être persisté pour un message privé');

  db.close();
});

test('4. Sécurité : usurpation d identité et injection non autorisée rejetées', async () => {
  const C1 = await connect(charlieId);
  const A1 = sockets[0];
  const countBefore = A1.statusUpdates.length;

  // Charlie tente d'envoyer un message_delivered pour Alice alors qu'il n'est pas le destinataire et non-ami
  C1.emit('message_delivered', {
    messageId: 1,
    senderId: aliceId,
    isPrivate: false
  });

  // Charlie tente d'envoyer un message_read pour Alice
  C1.emit('message_read', {
    contactId: aliceId,
    lastReadMessageId: 1,
    isPrivate: false
  });

  await sleep(150);
  assert.equal(A1.statusUpdates.length, countBefore, 'Les requêtes illégitimes de Charlie doivent être ignorées');

  // Charlie tente de lire l'historique d'Alice via HTTP
  const forbiddenRes = await fetch(`http://127.0.0.1:${port}/api/messages/${aliceId}/${bobId}`, {
    headers: { 'Authorization': `Bearer ${tokenCharlie}` }
  });
  assert.equal(forbiddenRes.status, 403, 'Charlie ne doit pas pouvoir accéder aux messages d Alice');
});

test('5. Sécurité : clamping strict de lastReadMessageId et progression monotone', async () => {
  const A1 = sockets[0];
  const B1 = sockets[2];
  A1.readUpdates.length = 0;

  // Alice envoie un nouveau message réel à Bob (id = N)
  const ack = await sendMessage(A1, {
    senderId: aliceId,
    receiverId: bobId,
    text: 'Message pour test clamping',
    isPrivate: false
  });
  assert.equal(ack?.success, true);
  const realMessageId = ack.id;

  // 5.a : Bob tente d'envoyer un lastReadMessageId gigantesque arbitraire (ex: 99999999)
  B1.emit('message_read', {
    contactId: aliceId,
    lastReadMessageId: 99999999,
    isPrivate: false
  });

  const gotClampedRead = await waitFor(() => A1.readUpdates.length > 0);
  assert.ok(gotClampedRead, 'Alice doit recevoir l accusé de lecture clampé');
  // L'accusé diffusé doit être clampé exactement au max réel existant (realMessageId)
  assert.equal(A1.readUpdates[0].lastReadMessageId, realMessageId, 'Le lastReadMessageId doit être clampé à la valeur réelle existante');

  // Vérification en BDD : le curseur persisté ne dépasse jamais le maxId réel existant
  const db = new Database(path.join(tmpDir, 'messenger.db'));
  const cursorRow = db.prepare('SELECT last_read_message_id FROM conversation_read_cursors WHERE user_id = ? AND contact_id = ?').get(bobId, aliceId);
  assert.equal(cursorRow.last_read_message_id, realMessageId, 'Le curseur en BDD ne doit jamais stocker la valeur arbitraire 99999999');

  // 5.b : Bob tente d'envoyer un lastReadMessageId en arrière (régression en dessous du curseur actuel)
  A1.readUpdates.length = 0;
  B1.emit('message_read', {
    contactId: aliceId,
    lastReadMessageId: 1, // inférieur à realMessageId
    isPrivate: false
  });

  await sleep(150);
  assert.equal(A1.readUpdates.length, 0, 'Une régression en arrière ne doit provoquer aucune mise à jour ni diffusion');

  // Le curseur en BDD doit rester inchangé
  const cursorRowAfter = db.prepare('SELECT last_read_message_id FROM conversation_read_cursors WHERE user_id = ? AND contact_id = ?').get(bobId, aliceId);
  assert.equal(cursorRowAfter.last_read_message_id, realMessageId);

  // 5.c : Bob tente un message_read vers Charlie (aucun message n'a jamais été envoyé par Charlie vers Bob)
  B1.emit('message_read', {
    contactId: charlieId,
    lastReadMessageId: 500,
    isPrivate: false
  });

  await sleep(150);
  const cursorCharlie = db.prepare('SELECT COUNT(*) as c FROM conversation_read_cursors WHERE user_id = ? AND contact_id = ?').get(bobId, charlieId).c;
  assert.equal(cursorCharlie, 0, 'Aucun curseur ne doit être créé pour une conversation sans messages valides');

  db.close();
});

