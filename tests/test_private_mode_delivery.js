// Garde-fou des tests « live » chargé ici aussi, pas seulement par `npm test` (--import) :
// lancé à la main, ce fichier s'arrête si le serveur sur :3001 n'est pas le serveur de test
// de ce checkout (la prod, par exemple)
import '../scripts/live_server_guard.mjs';
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
 * Mode privé : rien n'est conservé côté serveur. Un message privé vers un contact SANS
 * session connectée serait perdu ; le serveur doit donc le REFUSER explicitement
 * (code RECIPIENT_OFFLINE_PRIVATE) au lieu de répondre « succès ».
 *
 * Nécessite le serveur sur http://localhost:3001 (skip sinon).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const jwtSecretPath = path.join(PROJECT_ROOT, '.jwt_secret');
const JWT_SECRET = fs.existsSync(jwtSecretPath) ? fs.readFileSync(jwtSecretPath, 'utf8').trim() : null;

const IDS = { a: 9981, b: 9982 };
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
  const s = ClientIO('http://localhost:3001', { auth: { token }, transports: ['websocket'], reconnection: false });
  s.once('connect', () => resolve(s));
  s.once('connect_error', reject);
  setTimeout(() => reject(new Error('Timeout socket')), 3000);
});
const send = (socket, body) => new Promise((resolve) => {
  socket.emit('send_message', { senderId: IDS.a, receiverId: IDS.b, text: '{"v":2}', type: 'text', ...body }, resolve);
});

test('mode privé : refus explicite si le destinataire est hors ligne, remise s\'il est connecté', { skip: serverUp ? false : 'Serveur non démarré' }, async () => {
  const db = new Database(path.join(PROJECT_ROOT, 'messenger.db'));
  const cleanup = () => {
    try { db.prepare('DELETE FROM messages WHERE sender_id IN (9981,9982) OR receiver_id IN (9981,9982)').run(); } catch { /* ignore */ }
    try { db.prepare('DELETE FROM conversation_privacy WHERE owner_id IN (9981,9982) OR contact_id IN (9981,9982)').run(); } catch { /* ignore */ }
    try { db.prepare('DELETE FROM contacts WHERE user_id IN (9981,9982) OR contact_id IN (9981,9982)').run(); } catch { /* ignore */ }
    try { db.prepare('DELETE FROM users WHERE id IN (9981,9982)').run(); } catch { /* ignore */ }
  };
  cleanup();
  const insertUser = db.prepare(`INSERT INTO users (id, username, password_hash, salt, nickname, status, token_version, global_private)
    VALUES (?, ?, 'hash', 'salt', ?, 'online', 0, 0)`);
  insertUser.run(IDS.a, 'priv_a', 'A');
  insertUser.run(IDS.b, 'priv_b', 'B');
  db.prepare('INSERT INTO contacts (user_id, contact_id, status, blocked) VALUES (?, ?, 1, 0)').run(IDS.a, IDS.b);
  db.prepare('INSERT INTO contacts (user_id, contact_id, status, blocked) VALUES (?, ?, 1, 0)').run(IDS.b, IDS.a);
  const countStored = () => db.prepare('SELECT COUNT(*) AS n FROM messages WHERE sender_id = ?').get(IDS.a).n;
  // Le mode privé par conversation est désormais l'état persisté (conversation_privacy),
  // le `isPrivate` du client n'est plus décisionnaire.
  const setConvPrivate = (on) => db.prepare(`INSERT INTO conversation_privacy (owner_id, contact_id, is_private) VALUES (?, ?, ?)
    ON CONFLICT(owner_id, contact_id) DO UPDATE SET is_private = excluded.is_private`).run(IDS.a, IDS.b, on ? 1 : 0);

  const sA = await connect(tok(IDS.a, 'priv_a'));
  let sB = null;
  try {
    // 1) B hors ligne, conversation privée → refusé, rien n'est stocké
    setConvPrivate(true);
    const offline = await send(sA, { isPrivate: true });
    assert.equal(offline.success, false, 'message privé vers contact hors ligne refusé');
    assert.equal(offline.code, 'RECIPIENT_OFFLINE_PRIVATE');
    assert.equal(countStored(), 0, 'rien n\'est stocké en mode privé');

    // 2) Mode privé GLOBAL imposé par le destinataire (message non marqué privé par l'émetteur)
    setConvPrivate(false);
    db.prepare('UPDATE users SET global_private = 1 WHERE id = ?').run(IDS.b);
    const forced = await send(sA, { isPrivate: false });
    assert.equal(forced.success, false, 'mode privé global du destinataire : refus aussi');
    assert.equal(forced.code, 'RECIPIENT_OFFLINE_PRIVATE');
    db.prepare('UPDATE users SET global_private = 0 WHERE id = ?').run(IDS.b);

    // 3) Message normal vers B hors ligne → accepté et stocké (remis à la reconnexion)
    const normal = await send(sA, { isPrivate: false });
    assert.equal(normal.success, true, 'message normal accepté même hors ligne');
    assert.equal(countStored(), 1, 'message normal stocké');

    // 4) B connecté, message privé → accepté, remis en direct, non stocké
    setConvPrivate(true);
    sB = await connect(tok(IDS.b, 'priv_b'));
    await wait(100);
    const received = new Promise((resolve) => sB.once('receive_message', resolve));
    const online = await send(sA, { isPrivate: true });
    assert.equal(online.success, true, 'message privé vers contact connecté accepté');
    assert.equal(online.isPrivate, true);
    const msg = await received;
    assert.equal(msg.isPrivate, true, 'remis en direct');
    assert.equal(countStored(), 1, 'toujours rien de stocké pour le message privé');
  } finally {
    sA.disconnect();
    if (sB) sB.disconnect();
    cleanup();
    db.close();
  }
});
