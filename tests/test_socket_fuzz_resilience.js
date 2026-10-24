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
 * Robustesse — le serveur s'arrête désormais sur uncaughtException (pour être relancé
 * sain par son superviseur). Il ne faut donc JAMAIS qu'une donnée client malformée
 * puisse déclencher une exception non gérée : ce test envoie des charges invalides
 * sur tous les événements socket, puis vérifie que le serveur répond toujours.
 *
 * Nécessite le serveur sur http://localhost:3001 (skip sinon).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const jwtSecretPath = path.join(PROJECT_ROOT, '.jwt_secret');
const JWT_SECRET = fs.existsSync(jwtSecretPath) ? fs.readFileSync(jwtSecretPath, 'utf8').trim() : null;
const db = new Database(path.join(PROJECT_ROOT, 'messenger.db'));

const IDS = { a: 9951, b: 9952 };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const status = () => new Promise((resolve) => {
  const req = http.request({ hostname: 'localhost', port: 3001, path: '/api/push/status', method: 'GET' }, (res) => { res.resume(); resolve(res.statusCode); });
  req.on('error', () => resolve(0));
  req.setTimeout(2000, () => { req.destroy(); resolve(0); });
  req.end();
});
const serverUp = JWT_SECRET ? (await status()) === 200 : false;

const tok = (id, username) => jwt.sign({ id, username, tv: 0 }, JWT_SECRET);
const connect = (token) => new Promise((resolve, reject) => {
  const s = ClientIO('http://localhost:3001', { auth: { token }, transports: ['websocket'], reconnection: false });
  s.once('connect', () => resolve(s));
  s.once('connect_error', reject);
  setTimeout(() => reject(new Error('Timeout socket')), 3000);
});

function cleanup() {
  try { db.prepare('DELETE FROM contacts WHERE user_id IN (9951,9952) OR contact_id IN (9951,9952)').run(); } catch { /* ignore */ }
  try { db.prepare('DELETE FROM messages WHERE sender_id IN (9951,9952) OR receiver_id IN (9951,9952)').run(); } catch { /* ignore */ }
  try { db.prepare('DELETE FROM users WHERE id IN (9951,9952)').run(); } catch { /* ignore */ }
}
function seed() {
  cleanup();
  const insertUser = db.prepare(`
    INSERT INTO users (id, username, password_hash, salt, nickname, status, token_version, global_private)
    VALUES (?, ?, 'hash', 'salt', ?, 'online', 0, 0)
  `);
  insertUser.run(IDS.a, 'fuzz_a', 'A');
  insertUser.run(IDS.b, 'fuzz_b', 'B');
  db.prepare('INSERT INTO contacts (user_id, contact_id, status, blocked) VALUES (?, ?, 1, 0)').run(IDS.a, IDS.b);
  db.prepare('INSERT INTO contacts (user_id, contact_id, status, blocked) VALUES (?, ?, 1, 0)').run(IDS.b, IDS.a);
}

const EVENTS = [
  'call_accept', 'call_reject', 'call_request', 'checkers_move', 'end_call',
  'game_accept', 'game_decline', 'game_invite', 'game_move', 'game_quit',
  'game_restart', 'game_resync', 'message_delivered', 'message_read', 'minesweeper_move',
  'puissance4_move', 'send_message', 'send_wink', 'send_wizz', 'toggle_private_mode',
  'webrtc_signal',
  // Événement inconnu (ex. ancien « identify » envoyé par un vieux client) : doit être ignoré
  'unknown_event'
];

const PAYLOADS = [
  undefined, null, 0, -1, 1e308, 'x', '', true, [], [1, 2, 3], {},
  { target: { nested: true } }, { target: [IDS.b] }, { target: 'abc' },
  { senderId: IDS.a, receiverId: { $gt: 0 }, text: { a: 1 }, style: [1], type: 42 },
  { senderId: IDS.a, receiverId: IDS.b, text: 123, audio: {}, isPrivate: 'yes' },
  { senderId: IDS.a, receiverId: IDS.b, winkId: ['a'] },
  { opponentId: IDS.b, gameType: { x: 1 }, move: 'bad', board: null, from: {}, to: [] },
  { opponentId: IDS.b, row: 'a', col: null, column: 1e9, x: NaN, y: Infinity },
  { contactId: IDS.b, lastReadMessageId: 'abc', messageId: {}, isPrivate: [] },
  { target: IDS.b, signal: { type: 'offer', sdp: { evil: true } } },
  IDS.b, String(IDS.b)
];

test('événements socket : charges malformées sans crash serveur', { skip: serverUp ? false : 'Serveur non démarré' }, async () => {
  seed();
  const s1 = await connect(tok(IDS.a, 'fuzz_a'));
  const s2 = await connect(tok(IDS.b, 'fuzz_b'));
  try {
    for (const event of EVENTS) {
      for (const payload of PAYLOADS) {
        s1.emit(event, payload);
        s1.emit(event, payload, () => {}); // variante avec callback d'ack
      }
      await wait(20);
    }
    await wait(500);

    assert.equal(await status(), 200, 'le serveur HTTP répond toujours');
    assert.equal(s2.connected, true, 'les autres sockets restent connectées');

    // Une nouvelle connexion fonctionne toujours (le processus n'a pas été relancé entre-temps)
    const s3 = await connect(tok(IDS.b, 'fuzz_b'));
    s3.disconnect();
  } finally {
    s1.disconnect();
    s2.disconnect();
    cleanup();
  }
});
