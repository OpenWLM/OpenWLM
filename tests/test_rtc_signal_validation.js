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
 * Durcissement — le serveur borne et valide la FORME du signal WebRTC relayé :
 * un signal trop volumineux ou de type invalide est rejeté (non relayé).
 *
 * Nécessite le serveur sur http://localhost:3001 (skip sinon).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const jwtSecretPath = path.join(PROJECT_ROOT, '.jwt_secret');
const JWT_SECRET = fs.existsSync(jwtSecretPath) ? fs.readFileSync(jwtSecretPath, 'utf8').trim() : null;
const db = new Database(path.join(PROJECT_ROOT, 'messenger.db'));

const IDS = { a: 9901, b: 9902 };
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
  const s = ClientIO('http://localhost:3001', { auth: { token }, transports: ['websocket'] });
  s.once('connect', () => resolve(s));
  s.once('connect_error', reject);
  setTimeout(() => reject(new Error('Timeout socket')), 3000);
});
const onceOrNull = (socket, event, ms) => new Promise((resolve) => {
  const handler = (payload) => { socket.off(event, handler); resolve(payload); };
  socket.on(event, handler);
  setTimeout(() => { socket.off(event, handler); resolve(null); }, ms);
});

function cleanup() {
  try { db.prepare('DELETE FROM contacts WHERE user_id IN (9901,9902) OR contact_id IN (9901,9902)').run(); } catch {}
  try { db.prepare('DELETE FROM users WHERE id IN (9901,9902)').run(); } catch {}
}
function seed() {
  cleanup();
  const insertUser = db.prepare(`
    INSERT INTO users (id, username, password_hash, salt, nickname, psm, avatar, scene, status, token_version, global_private)
    VALUES (?, ?, 'hash', 'salt', ?, 'PSM', '/assets/usertiles/chess.png', '/assets/scenes/0006.png', 'online', 0, 0)
  `);
  insertUser.run(IDS.a, 'rtc_a', 'A');
  insertUser.run(IDS.b, 'rtc_b', 'B');
  db.prepare('INSERT INTO contacts (user_id, contact_id, status, blocked) VALUES (?, ?, 1, 0)').run(IDS.a, IDS.b);
  db.prepare('INSERT INTO contacts (user_id, contact_id, status, blocked) VALUES (?, ?, 1, 0)').run(IDS.b, IDS.a);
}

test('webrtc_signal/call_request : signal invalide ou trop gros rejeté, signal valide relayé', { skip: serverUp ? false : 'Serveur non démarré' }, async () => {
  seed();
  const s1 = await connect(tok(IDS.a, 'rtc_a'));
  const s2 = await connect(tok(IDS.b, 'rtc_b'));
  try {
    await wait(200);

    // 1) Signal trop volumineux -> rejeté
    let p = onceOrNull(s2, 'webrtc_signal', 400);
    s1.emit('webrtc_signal', { target: IDS.b, signal: 'x'.repeat(70000) });
    assert.equal(await p, null, 'un signal hors borne doit être rejeté');

    // 2) Signal valide (chaîne bornée) -> relayé
    p = onceOrNull(s2, 'webrtc_signal', 700);
    s1.emit('webrtc_signal', { target: IDS.b, signal: 'eyJ0eXBlIjoiaWNlLWNhbmRpZGF0ZSJ9' });
    const got = await p;
    assert.ok(got && got.signal, 'un signal valide doit être relayé');

    // 3) call_request trop volumineux -> non relayé
    p = onceOrNull(s2, 'incoming_call', 400);
    s1.emit('call_request', { target: IDS.b, signal: 'y'.repeat(70000) });
    assert.equal(await p, null, 'un call_request hors borne ne doit pas être relayé');

    // 4) call_request valide -> relayé
    p = onceOrNull(s2, 'incoming_call', 700);
    s1.emit('call_request', { target: IDS.b, signal: 'eyJ0eXBlIjoib2ZmZXIifQ==' });
    const call = await p;
    assert.ok(call && call.caller === IDS.a, 'un call_request valide doit être relayé');
  } finally {
    s1.disconnect();
    s2.disconnect();
    cleanup();
  }
});
