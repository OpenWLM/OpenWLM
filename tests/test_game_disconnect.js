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
 * Jeux — une déconnexion transitoire (veille mobile / coupure réseau) ne doit PAS
 * être interprétée comme un abandon : la partie survit et reprend à la reconnexion.
 * Un quit explicite, lui, doit prévenir l'adversaire.
 *
 * Nécessite le serveur démarré sur http://localhost:3001 (skip sinon).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const jwtSecretPath = path.join(PROJECT_ROOT, '.jwt_secret');
const JWT_SECRET = fs.existsSync(jwtSecretPath) ? fs.readFileSync(jwtSecretPath, 'utf8').trim() : null;
const db = new Database(path.join(PROJECT_ROOT, 'messenger.db'));

const IDS = { a: 9601, b: 9602 };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const probe = () => new Promise((resolve) => {
  if (!JWT_SECRET) return resolve(false);
  const req = http.request({ hostname: 'localhost', port: 3001, path: '/api/push/status', method: 'GET' }, (res) => {
    res.resume();
    resolve(res.statusCode === 200);
  });
  req.on('error', () => resolve(false));
  req.end();
});
const serverUp = await probe();

const tok = (id, username) => jwt.sign({ id, username, tv: 0 }, JWT_SECRET);
const connect = (token) => new Promise((resolve, reject) => {
  const s = ClientIO('http://localhost:3001', { auth: { token }, transports: ['websocket'] });
  s.once('connect', () => resolve(s));
  s.once('connect_error', reject);
  setTimeout(() => reject(new Error('Timeout connexion socket')), 3000);
});
const onceOrNull = (socket, event, ms) => new Promise((resolve) => {
  const handler = (payload) => { socket.off(event, handler); resolve(payload); };
  socket.on(event, handler);
  setTimeout(() => { socket.off(event, handler); resolve(null); }, ms);
});

function cleanup() {
  try { db.prepare('DELETE FROM contacts WHERE user_id IN (9601,9602) OR contact_id IN (9601,9602)').run(); } catch {}
  try { db.prepare('DELETE FROM users WHERE id IN (9601,9602)').run(); } catch {}
}
function seed() {
  cleanup();
  const insertUser = db.prepare(`
    INSERT INTO users (id, username, password_hash, salt, nickname, psm, avatar, scene, status, token_version, global_private)
    VALUES (?, ?, 'hash', 'salt', ?, 'PSM', '/assets/usertiles/chess.png', '/assets/scenes/0006.png', 'online', 0, 0)
  `);
  insertUser.run(IDS.a, 'gd_a', 'A');
  insertUser.run(IDS.b, 'gd_b', 'B');
  db.prepare('INSERT INTO contacts (user_id, contact_id, status, blocked) VALUES (?, ?, 1, 0)').run(IDS.a, IDS.b);
  db.prepare('INSERT INTO contacts (user_id, contact_id, status, blocked) VALUES (?, ?, 1, 0)').run(IDS.b, IDS.a);
}

test('jeux : veille ≠ abandon (reprise possible), quit explicite = synchro', { skip: serverUp ? false : 'Serveur non démarré' }, async () => {
  seed();
  let s1 = await connect(tok(IDS.a, 'gd_a'));
  let s2 = await connect(tok(IDS.b, 'gd_b'));
  try {
    // Démarrer une partie de dames (A = Blancs, joue en premier)
    s1.emit('game_invite', { target: IDS.b, gameType: 'checkers' });
    await wait(250);
    s2.emit('game_accept', { target: IDS.a, gameType: 'checkers' });
    await wait(450);

    // 1) Veille simulée : B se déconnecte. A ne doit PAS recevoir de game_quit.
    let quitSeen = onceOrNull(s1, 'game_quit', 700);
    s2.disconnect();
    assert.equal(await quitSeen, null, 'une déconnexion (veille) ne doit pas être un abandon');

    // 2) B (hors ligne) manque un coup de A, puis se reconnecte et resynchronise.
    s1.emit('checkers_move', { target: IDS.b, from: { row: 5, col: 0 }, to: { row: 4, col: 1 } });
    await wait(300); // B est hors ligne : il ne reçoit pas ce coup

    s2 = await connect(tok(IDS.b, 'gd_b'));
    await wait(300);
    const resyncSeen = onceOrNull(s2, 'game_resync_state', 900);
    s2.emit('game_resync', { target: IDS.a });
    const st = await resyncSeen;
    assert.ok(st && st.active && st.gameType === 'checkers', 'le resync renvoie la partie active');
    assert.equal(st.board[4][1], 'w', 'le plateau resynchronisé contient le coup joué hors-ligne');
    assert.equal(st.isMyTurn, true, "c'est au tour de B après le coup de A");

    // 3) Quit explicite de A : B doit être prévenu.
    const explicitQuit = onceOrNull(s2, 'game_quit', 900);
    s1.emit('game_quit', { target: IDS.b });
    const q = await explicitQuit;
    assert.ok(q && q.from === IDS.a, 'un quit explicite doit prévenir l\'adversaire');
  } finally {
    try { s1.disconnect(); } catch {}
    try { s2.disconnect(); } catch {}
    cleanup();
  }
});
