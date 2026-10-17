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
 * Démineur à deux (Minesweeper Flags) — anti-triche réseau et règles côté serveur.
 * Serveur de test dédié + base temporaire — jamais la prod.
 *
 * Une partie complète est jouée en cliquant les cases encore cachées : aucun message reçu
 * par un client ne doit révéler une mine non trouvée avant la fin de la partie.
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
const withDb = (fn) => {
  const db = new Database(path.join(tmpDir, 'messenger.db'));
  try { return fn(db); } finally { db.close(); }
};
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


const once = (s, ev, ms = 3000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`Timeout ${ev}`)), ms);
  s.once(ev, (d) => { clearTimeout(t); resolve(d); });
});
// Aucun champ ne doit trahir une mine non trouvée
const assertNoHiddenMines = (msg, where) => {
  const json = JSON.stringify(msg);
  assert.ok(!/adjacent|"mines":\s*\[/.test(json) || msg.state?.winner, `${where} : matrice ou liste de mines exposée avant la fin`);
};

test('partie complète : tours respectés, rien ne fuit avant la fin, mines dévoilées à la fin', { timeout: 60000 }, async () => {
  const a = await connect(aliceId);
  const b = await connect(bobId);
  try {
    a.emit('game_invite', { target: bobId, gameType: 'minesweeper' });
    const inv = await once(b, 'game_invite_received');
    assert.equal(inv.gameType, 'minesweeper');
    const startedA = once(a, 'game_started');
    b.emit('game_accept', { target: aliceId, gameType: 'minesweeper' });
    const sa = await startedA;
    assert.equal(sa.gameType, 'minesweeper');
    assert.equal(sa.isMyTurn, true, 'l\'initiateur commence');

    // Hors tour → refusé
    b.emit('minesweeper_move', { target: aliceId, index: 0 });
    assert.match((await once(b, 'game_error')).message, /tour/);
    // Index invalide / bombe sans retard → refusés
    a.emit('minesweeper_move', { target: bobId, index: 999 });
    assert.ok((await once(a, 'game_error')).message);
    a.emit('minesweeper_move', { target: bobId, index: 0, bomb: true });
    assert.match((await once(a, 'game_error')).message, /Bombe/);
    // Un coup de Morpion contre une partie de Démineur → refusé
    a.emit('game_move', { target: bobId, index: 0 });
    assert.ok((await once(a, 'game_error')).message);

    // Resync : état public seulement
    b.emit('game_resync', { target: aliceId });
    const rs = await once(b, 'game_resync_state');
    assert.equal(rs.gameType, 'minesweeper');
    assert.equal(rs.board, undefined, 'pas de plateau brut');
    assert.equal(rs.state.mines, undefined);
    assertNoHiddenMines(rs, 'resync');

    // Joue jusqu'à la fin : le joueur dont c'est le tour clique la première case cachée
    let state = rs.state;
    let moves = 0;
    while (state.winner === null) {
      const turnSock = state.turn === aliceId ? a : b;
      const target = state.turn === aliceId ? bobId : aliceId;
      const hidden = state.revealed.findIndex((v) => v === null);
      const updA = once(a, 'minesweeper_update');
      const updB = once(b, 'minesweeper_update');
      turnSock.emit('minesweeper_move', { target, index: hidden });
      const [ua, ub] = await Promise.all([updA, updB]);
      assert.deepEqual(ua, ub, 'les deux joueurs reçoivent le même état');
      if (ua.state.winner === null) assertNoHiddenMines(ua, `coup ${moves}`);
      // Cohérence : une mine trouvée garde la main, sinon elle passe
      const hitMine = ua.revealed.some((x) => x.f !== undefined);
      if (ua.state.winner === null) assert.equal(ua.state.turn === ua.from, hitMine, 'règle du tour');
      state = ua.state;
      moves++;
      assert.ok(moves < 300, 'la partie doit se terminer');
    }
    assert.ok(Object.values(state.found).some((n) => n === 26), 'victoire à 26');
    assert.equal(state.remaining, 51 - Object.values(state.found).reduce((x, y) => x + y, 0));
    assert.equal(state.mines.length, state.remaining, 'mines restantes dévoilées à la fin');

    // Nouvelle manche : nouvel état, l'autre joueur commence, rien de révélé
    const upd = once(b, 'minesweeper_update');
    a.emit('game_restart', { target: bobId });
    const r = await upd;
    assert.equal(r.restart, true);
    assert.ok(r.state.revealed.every((v) => v === null));
    assert.equal(r.state.turn, bobId);
    assert.equal(r.state.mines, undefined);
  } finally { a.disconnect(); b.disconnect(); }
});

test('un tiers ne peut ni jouer ni lire la partie', async () => {
  const c = await connect(charlieId);
  try {
    c.emit('minesweeper_move', { target: aliceId, index: 0 });
    assert.ok((await once(c, 'game_error')).message);
    c.emit('game_resync', { target: aliceId });
    const rs = await Promise.race([once(c, 'game_resync_state', 800).catch(() => null)]);
    assert.ok(!rs || rs.active === false, 'aucun état de partie pour un non-contact');
  } finally { c.disconnect(); }
});
