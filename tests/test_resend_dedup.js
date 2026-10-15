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
 * Renvoi idempotent : un message « Non envoyé » est renvoyé avec le MÊME `mid`
 * (l'index unique (sender_id, mid) côté serveur rend l'écriture idempotente). Un second
 * envoi du même `mid` doit répondre « succès » avec le même id, SANS créer de doublon ni
 * rediffuser une seconde copie au destinataire.
 *
 * Nécessite le serveur sur http://localhost:3001 (skip sinon).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const jwtSecretPath = path.join(PROJECT_ROOT, '.jwt_secret');
const JWT_SECRET = fs.existsSync(jwtSecretPath) ? fs.readFileSync(jwtSecretPath, 'utf8').trim() : null;

const IDS = { a: 9991, b: 9992 };
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
  socket.emit('send_message', { senderId: IDS.a, receiverId: IDS.b, type: 'text', ...body }, resolve);
});

// Le serveur ne déchiffre pas : un mid arbitraire suffit à exercer la déduplication.
const MID = 'resend-dedup-mid-0000';
const envelope = JSON.stringify({ v: 2, from: IDS.a, to: IDS.b, mid: MID });

test('renvoi idempotent : même mid → une seule ligne, accusé « duplicate », pas de rediffusion', { skip: serverUp ? false : 'Serveur non démarré' }, async () => {
  const db = new Database(path.join(PROJECT_ROOT, 'messenger.db'));
  const cleanup = () => {
    try { db.prepare('DELETE FROM messages WHERE sender_id IN (9991,9992) OR receiver_id IN (9991,9992)').run(); } catch { /* ignore */ }
    try { db.prepare('DELETE FROM contacts WHERE user_id IN (9991,9992) OR contact_id IN (9991,9992)').run(); } catch { /* ignore */ }
    try { db.prepare('DELETE FROM users WHERE id IN (9991,9992)').run(); } catch { /* ignore */ }
  };
  cleanup();
  const insertUser = db.prepare(`INSERT INTO users (id, username, password_hash, salt, nickname, status, token_version, global_private)
    VALUES (?, ?, 'hash', 'salt', ?, 'online', 0, 0)`);
  insertUser.run(IDS.a, 'dedup_a', 'A');
  insertUser.run(IDS.b, 'dedup_b', 'B');
  db.prepare('INSERT INTO contacts (user_id, contact_id, status, blocked) VALUES (?, ?, 1, 0)').run(IDS.a, IDS.b);
  db.prepare('INSERT INTO contacts (user_id, contact_id, status, blocked) VALUES (?, ?, 1, 0)').run(IDS.b, IDS.a);
  const countStored = () => db.prepare('SELECT COUNT(*) AS n FROM messages WHERE sender_id = ? AND mid = ?').get(IDS.a, MID).n;

  const sA = await connect(tok(IDS.a, 'dedup_a'));
  let sB = null;
  try {
    sB = await connect(tok(IDS.b, 'dedup_b'));
    await wait(100);
    let received = 0;
    sB.on('receive_message', () => { received += 1; });

    // 1) Premier envoi : accepté et stocké, remis une fois
    const first = await send(sA, { text: envelope });
    assert.equal(first.success, true, 'premier envoi accepté');
    assert.equal(countStored(), 1, 'une ligne stockée');
    assert.ok(first.id !== undefined && first.id !== null, 'accusé avec un id');
    await wait(150);
    assert.equal(received, 1, 'remis une fois');

    // 2) Renvoi (même mid) : idempotent → succès, même id, aucune nouvelle ligne, aucune rediffusion
    const second = await send(sA, { text: envelope });
    assert.equal(second.success, true, 'renvoi accepté (idempotent)');
    assert.equal(second.duplicate, true, 'accusé marqué duplicate');
    assert.equal(second.id, first.id, 'même id renvoyé');
    assert.equal(countStored(), 1, 'toujours une seule ligne');
    await wait(150);
    assert.equal(received, 1, 'aucune seconde remise au destinataire');
  } finally {
    sA.disconnect();
    if (sB) sB.disconnect();
    cleanup();
    db.close();
  }
});
