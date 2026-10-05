/**
 * Test de non-régression : synchronisation temps réel multi-session.
 *
 * Lance le VRAI serveur (server/index.js) dans un répertoire temporaire
 * (base messenger.db isolée, aucune donnée de prod touchée), puis :
 *  - Alice ouvre 2 sessions (A1, A2), Bob ouvre 2 sessions (B1, B2) ;
 *  - A1 envoie un message à Bob ;
 *  - B1 et B2 doivent recevoir `receive_message` ;
 *  - A2 doit recevoir `receive_message` (synchro de l'expéditeur) ;
 *  - A1 ne doit PAS recevoir de doublon (il a déjà l'ack) ;
 *  - après déconnexion de B1, B2 reçoit toujours les messages.
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
  s.on('receive_message', (m) => s.received.push(m));
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwlm-multisession-'));
  port = await getFreePort();

  serverProc = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: tmpDir, // messenger.db est créé ici (BDD isolée)
    env: { ...process.env, PORT: String(port), JWT_SECRET, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  serverProc.stderr.on('data', d => { stderr += d.toString(); });
  serverProc.on('exit', (code) => {
    if (code && code !== 0) console.error('[server stderr]', stderr);
  });

  await waitForPort(port);

  // Création de 2 comptes en relation mutuelle acceptée, directement en BDD isolée
  const db = new Database(path.join(tmpDir, 'messenger.db'));
  const insertUser = db.prepare("INSERT INTO users (username, nickname, status) VALUES (?, ?, 'online')");
  aliceId = Number(insertUser.run('alice_ms', 'Alice').lastInsertRowid);
  bobId = Number(insertUser.run('bob_ms', 'Bob').lastInsertRowid);
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

test('multi-session : fanout destinataire + synchro des autres sessions expéditeur, sans doublon', async () => {
  const A1 = await connect(aliceId);
  const A2 = await connect(aliceId);
  const B1 = await connect(bobId);
  const B2 = await connect(bobId);
  await sleep(150);

  const ack = await sendMessage(A1, {
    senderId: aliceId,
    receiverId: bobId,
    text: 'ciphertext-opaque-1',
    style: null,
    audio: null,
    type: 'text',
    isPrivate: false
  });
  assert.equal(ack?.success, true, `Ack attendu, reçu: ${JSON.stringify(ack)}`);

  const allGot = await waitFor(() => B1.received.length && B2.received.length && A2.received.length);
  assert.ok(allGot, 'B1, B2 et A2 doivent recevoir le message');

  for (const [name, s] of [['B1', B1], ['B2', B2], ['A2', A2]]) {
    assert.equal(s.received.length, 1, `${name} doit recevoir exactement 1 message`);
    const m = s.received[0];
    assert.equal(m.id, ack.id, `${name} : même id que l'ack`);
    assert.equal(m.senderId, aliceId);
    assert.equal(m.receiverId, bobId);
    assert.equal(m.text, 'ciphertext-opaque-1');
  }

  await sleep(200);
  assert.equal(A1.received.length, 0, "A1 (session d'origine) ne doit pas recevoir de doublon");
});

test("multi-session : une session qui se déconnecte n'empêche pas les autres de recevoir", async () => {
  const [A1, A2, B1, B2] = sockets;
  [A1, A2, B1, B2].forEach(s => { s.received.length = 0; });

  B1.disconnect();
  await sleep(150);

  const ack = await sendMessage(A2, {
    senderId: aliceId,
    receiverId: bobId,
    text: 'ciphertext-opaque-2',
    style: null,
    audio: null,
    type: 'text',
    isPrivate: false
  });
  assert.equal(ack?.success, true);

  assert.ok(await waitFor(() => B2.received.length === 1 && A1.received.length === 1),
    'B2 et A1 doivent recevoir le message envoyé depuis A2');
  await sleep(200);
  assert.equal(A2.received.length, 0, 'A2 (origine) sans doublon');
  assert.equal(B1.received.length, 0, 'B1 déconnecté ne reçoit rien');
});

test("sécurité : impossible d'usurper un autre expéditeur depuis une session", async () => {
  const B2 = sockets[3];
  const ack = await sendMessage(B2, {
    senderId: aliceId, // B2 est authentifié comme Bob
    receiverId: bobId,
    text: 'spoof',
    type: 'text'
  });
  assert.equal(ack?.success, false);
});
