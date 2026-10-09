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
 * Anti-triche Jeu de Dames — le serveur doit être AUTORITAIRE :
 *  - rejeter une téléportation (déplacement non diagonal/valide) ;
 *  - rejeter un faux saut (aucune pièce adverse entre les cases) ;
 *  - rejeter un coup hors-tour ;
 *  - accepter et diffuser un coup légal.
 *
 * Nécessite le serveur démarré sur http://localhost:3001 (skip sinon).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const jwtSecretPath = path.join(PROJECT_ROOT, '.jwt_secret');
const JWT_SECRET = fs.existsSync(jwtSecretPath) ? fs.readFileSync(jwtSecretPath, 'utf8').trim() : null;
const db = new Database(path.join(PROJECT_ROOT, 'messenger.db'));

const IDS = { white: 9501, black: 9502 };
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
  try { db.prepare('DELETE FROM contacts WHERE user_id IN (9501,9502) OR contact_id IN (9501,9502)').run(); } catch {}
  try { db.prepare('DELETE FROM users WHERE id IN (9501,9502)').run(); } catch {}
}

function seed() {
  cleanup();
  const insertUser = db.prepare(`
    INSERT INTO users (id, username, password_hash, salt, nickname, psm, avatar, scene, status, token_version, global_private)
    VALUES (?, ?, 'hash', 'salt', ?, 'PSM', '/assets/usertiles/chess.png', '/assets/scenes/0006.png', 'online', 0, 0)
  `);
  insertUser.run(IDS.white, 'ck_white', 'White');
  insertUser.run(IDS.black, 'ck_black', 'Black');
  db.prepare('INSERT INTO contacts (user_id, contact_id, status, blocked) VALUES (?, ?, 1, 0)').run(IDS.white, IDS.black);
  db.prepare('INSERT INTO contacts (user_id, contact_id, status, blocked) VALUES (?, ?, 1, 0)').run(IDS.black, IDS.white);
}

test('dames : coups illégaux rejetés côté serveur, coup légal accepté', { skip: serverUp ? false : 'Serveur non démarré' }, async () => {
  seed();
  const s1 = await connect(tok(IDS.white, 'ck_white'));
  const s2 = await connect(tok(IDS.black, 'ck_black'));
  try {
    // Démarrer une partie de dames (l'initiateur = Blancs, joue en premier)
    s1.emit('game_invite', { target: IDS.black, gameType: 'checkers' });
    await wait(250);
    s2.emit('game_accept', { target: IDS.white, gameType: 'checkers' });
    await wait(450);

    // 1) Téléportation (déplacement non diagonal) -> rejetée
    let p = onceOrNull(s2, 'checkers_move', 400);
    s1.emit('checkers_move', { target: IDS.black, from: { row: 5, col: 0 }, to: { row: 0, col: 3 } });
    assert.equal(await p, null, 'une téléportation doit être rejetée');

    // 2) Faux saut (aucune pièce adverse entre les cases) -> rejeté
    p = onceOrNull(s2, 'checkers_move', 400);
    s1.emit('checkers_move', { target: IDS.black, from: { row: 5, col: 2 }, to: { row: 3, col: 4 } });
    assert.equal(await p, null, 'un faux saut (sans pièce à capturer) doit être rejeté');

    // 3) Coup hors-tour (les Noirs jouent alors que c'est aux Blancs) -> rejeté
    p = onceOrNull(s1, 'checkers_move', 400);
    s2.emit('checkers_move', { target: IDS.white, from: { row: 2, col: 1 }, to: { row: 3, col: 0 } });
    assert.equal(await p, null, 'un coup hors-tour doit être rejeté');

    // 4) Coup légal (pion blanc 5,0 -> 4,1) -> accepté et diffusé
    p = onceOrNull(s2, 'checkers_move', 800);
    s1.emit('checkers_move', { target: IDS.black, from: { row: 5, col: 0 }, to: { row: 4, col: 1 } });
    const move = await p;
    assert.ok(
      move && move.from && move.from.row === 5 && move.from.col === 0 && move.to.row === 4 && move.to.col === 1,
      'un coup légal doit être accepté et diffusé'
    );
    assert.equal(move.isJump, false, 'coup simple non-saut');
    assert.equal(move.isPromotion, false, 'pas de promotion ici');
  } finally {
    s1.disconnect();
    s2.disconnect();
    cleanup();
  }
});
