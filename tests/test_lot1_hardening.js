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
 * Durcissements de la relecture d'octobre 2026 (serveur isolé : dossier temporaire, port libre).
 *  - Upload multipart : nombre de champs borné (épuisement mémoire).
 *  - Présence : un contact bloqué ou retiré ne reçoit plus les changements de statut/profil.
 *  - Invitation : blocage respecté, pas de doublon ni d'énumération par « déjà en attente ».
 *  - Messages : destinataire entier, tailles bornées, mid borné, type/style assainis,
 *    budget de volume par expéditeur.
 *  - Accusé « remis » : le drapeau isPrivate du client ne contourne plus la vérification.
 *  - Jeux : « Rejouer » seulement en fin de partie, le perdant commence ; débit des événements.
 *  - Appels : pas de double sonnerie, délai après refus ; la chute d'UNE socket ne raccroche
 *    pas l'appel d'un utilisateur multi-sessions.
 *  - Erreurs HTTP : JSON malformé → réponse JSON 400, jamais une page HTML.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, '../server/index.js');
const JWT_SECRET = crypto.randomBytes(32).toString('hex');
const TEST_BYTE_BUDGET = 200 * 1024; // budget de volume réduit pour le test (24 Mo en vrai)

let serverProc;
let tmpDir;
let port;
let db;
let alice;
let bob;
let carol;

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
const request = (apiPath, method, token, body, headers = {}) => new Promise((resolve) => {
  const payload = body === undefined ? '' : (Buffer.isBuffer(body) ? body : (typeof body === 'string' ? body : JSON.stringify(body)));
  const h = { ...headers };
  if (body !== undefined) {
    if (!h['Content-Type']) h['Content-Type'] = 'application/json';
    h['Content-Length'] = Buffer.byteLength(payload);
  }
  if (token) h['Authorization'] = `Bearer ${token}`;
  const req = http.request({ hostname: '127.0.0.1', port, path: apiPath, method, headers: h }, (res) => {
    let raw = '';
    res.on('data', (c) => { raw += c; });
    res.on('end', () => { let d; try { d = JSON.parse(raw); } catch { d = raw; } resolve({ status: res.statusCode, data: d, headers: res.headers }); });
  });
  req.on('error', () => resolve({ status: 0 }));
  if (payload) req.write(payload);
  req.end();
});
const connect = (token) => new Promise((resolve, reject) => {
  const s = ClientIO(`http://127.0.0.1:${port}`, { auth: { token }, transports: ['websocket'], forceNew: true, reconnection: false });
  s.once('connect', () => resolve(s));
  s.once('connect_error', reject);
  setTimeout(() => reject(new Error('Timeout socket')), 3000);
});
const tok = (id) => jwt.sign({ id, tv: 0 }, JWT_SECRET, { expiresIn: '1h' });
const emitAck = (s, event, data) => new Promise((resolve) => s.emit(event, data, resolve));
const waitEvent = (s, event, ms = 1500) => new Promise((resolve) => {
  const timer = setTimeout(() => { s.off(event, handler); resolve(null); }, ms);
  const handler = (d) => { clearTimeout(timer); resolve(d); };
  s.once(event, handler);
});
const envelope = (mid, pad = 0) => JSON.stringify({ v: 2, mid, from: 1, to: 2, iv: 'AAAA', body: 'x'.repeat(pad), sig: 'AA' });
const befriend = (a, b) => {
  const ins = db.prepare('INSERT OR IGNORE INTO contacts (user_id, contact_id, status, blocked) VALUES (?, ?, 1, 0)');
  ins.run(a, b);
  ins.run(b, a);
};

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwlm-lot1-'));
  port = await getFreePort();
  serverProc = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: tmpDir,
    env: { ...process.env, PORT: String(port), JWT_SECRET, NODE_ENV: 'test', OPENWLM_TEST_MESSAGE_BYTES_MAX: String(TEST_BYTE_BUDGET) },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  await waitForPort(port);
  db = new Database(path.join(tmpDir, 'messenger.db'));
  const insert = db.prepare("INSERT INTO users (username, nickname, status, password_hash, salt, token_version) VALUES (?, ?, 'online', 'h', 's', 0)");
  alice = Number(insert.run('l1_alice', 'Alice').lastInsertRowid);
  bob = Number(insert.run('l1_bob', 'Bob').lastInsertRowid);
  carol = Number(insert.run('l1_carol', 'Carol').lastInsertRowid);
  befriend(alice, bob);
  befriend(alice, carol);
  befriend(bob, carol);
});

after(async () => {
  try { db?.close(); } catch { /* ignore */ }
  if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM');
  await sleep(200);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------------------
test('upload multipart : des milliers de champs texte sont refusés (400) au lieu d’être accumulés en mémoire', async () => {
  const boundary = 'lot1boundary';
  const parts = [];
  for (let i = 0; i < 3000; i++) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="f${i}"\r\n\r\n${'x'.repeat(2000)}\r\n`);
  parts.push(`--${boundary}--\r\n`);
  const body = Buffer.from(parts.join(''));
  const before = process.memoryUsage().rss;
  const r = await request('/api/files/upload', 'POST', tok(alice), body, { 'Content-Type': `multipart/form-data; boundary=${boundary}` });
  assert.equal(r.status, 400, JSON.stringify(r.data));
  assert.match(String(r.data?.error || ''), /champs|fields|Unexpected|Too many/i);
  assert.ok(process.memoryUsage().rss - before < 50 * 1024 * 1024);
  const e = await request('/api/emoticons/custom/upload', 'POST', tok(alice), body, { 'Content-Type': `multipart/form-data; boundary=${boundary}` });
  assert.equal(e.status, 400);
});

test('erreur de corps JSON : réponse JSON 400, pas de page HTML', async () => {
  const r = await request('/api/invite', 'POST', tok(alice), '{"receiverUsername": ', {});
  assert.equal(r.status, 400);
  assert.equal(typeof r.data, 'object', `réponse non JSON : ${String(r.data).slice(0, 80)}`);
  assert.ok(r.data.error);
});

// ---------------------------------------------------------------------------------------
test('présence : un contact bloqué ou retiré ne reçoit plus les changements de statut', async () => {
  const sBob = await connect(tok(bob));
  const sCarol = await connect(tok(carol));
  await sleep(200);
  // Alice bloque Bob
  assert.equal((await request('/api/contacts/block', 'POST', tok(alice), { contactId: bob, block: true })).status, 200);
  const pBob = waitEvent(sBob, 'user_status_changed', 1200);
  const pCarol = waitEvent(sCarol, 'user_status_changed', 1200);
  assert.equal((await request('/api/user/update', 'POST', tok(alice), { psm: `secret ${Date.now()}` })).status, 200);
  const [evBob, evCarol] = await Promise.all([pBob, pCarol]);
  assert.ok(evCarol && (evCarol.userId === alice || evCarol.id === alice), 'Carol (contact normal) est prévenue');
  assert.equal(evBob, null, 'Bob (bloqué par Alice) ne reçoit rien');
  // Alice débloque puis retire Bob de sa liste : toujours rien
  await request('/api/contacts/block', 'POST', tok(alice), { contactId: bob, block: false });
  await request('/api/contacts/delete', 'POST', tok(alice), { contactId: bob });
  const pBob2 = waitEvent(sBob, 'user_status_changed', 1200);
  await request('/api/user/update', 'POST', tok(alice), { psm: `secret2 ${Date.now()}` });
  assert.equal(await pBob2, null, 'Bob (retiré de la liste d’Alice) ne reçoit rien');
  befriend(alice, bob);
  sBob.disconnect(); sCarol.disconnect();
});

test('invitation : bloqué par le destinataire → « succès » silencieux, aucune invitation créée ; pas de doublon', async () => {
  // Bob bloque Alice ; Alice retire Bob puis le réinvite
  db.prepare('UPDATE contacts SET blocked = 1 WHERE user_id = ? AND contact_id = ?').run(bob, alice);
  db.prepare('DELETE FROM contacts WHERE user_id = ? AND contact_id = ?').run(alice, bob);
  try {
    const r = await request('/api/invite', 'POST', tok(alice), { receiverUsername: 'l1_bob' });
    assert.equal(r.status, 200);
    assert.equal(r.data.success, true, 'même réponse qu’un compte inexistant');
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM invitations WHERE sender_id = ? AND receiver_id = ?").get(alice, bob).c, 0, 'aucune invitation vers quelqu’un qui a bloqué');
  } finally {
    // État restauré même en cas d'échec (les tests suivants comptent sur la relation Alice–Bob)
    db.prepare('DELETE FROM invitations WHERE sender_id = ? AND receiver_id = ?').run(alice, bob);
    db.prepare('UPDATE contacts SET blocked = 0 WHERE user_id = ? AND contact_id = ?').run(bob, alice);
    befriend(alice, bob);
  }

  // Invitation en attente : seconde demande = même « succès », une seule ligne
  const dave = Number(db.prepare("INSERT INTO users (username, nickname, status, password_hash, salt, token_version) VALUES ('l1_dave', 'Dave', 'online', 'h', 's', 0)").run().lastInsertRowid);
  assert.equal((await request('/api/invite', 'POST', tok(alice), { receiverUsername: 'l1_dave' })).data.success, true);
  const second = await request('/api/invite', 'POST', tok(alice), { receiverUsername: 'l1_dave' });
  assert.equal(second.status, 200);
  assert.equal(second.data.success, true);
  assert.equal(second.data.code, undefined, 'pas de code révélant l’existence du compte');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM invitations WHERE sender_id = ? AND receiver_id = ?').get(alice, dave).c, 1);
});

// ---------------------------------------------------------------------------------------
test('send_message : destinataire non entier refusé, texte trop long refusé, mid trop long refusé', async () => {
  const s = await connect(tok(alice));
  await sleep(100);
  const bad = await emitAck(s, 'send_message', { senderId: alice, receiverId: `${bob}abc`, text: envelope('m1'), type: 'text' });
  assert.equal(bad.success, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM messages WHERE receiver_id = ?").get(`${bob}abc`).c, 0, 'rien de persisté avec un id non entier');
  const big = await emitAck(s, 'send_message', { senderId: alice, receiverId: bob, text: envelope('m2', 70 * 1024), type: 'text' });
  assert.equal(big.success, false);
  assert.equal(big.code, 'too_large');
  const longMid = await emitAck(s, 'send_message', { senderId: alice, receiverId: bob, text: envelope('m'.repeat(200)), type: 'text' });
  assert.equal(longMid.success, false);
  // Type inconnu et style aberrant assainis, message accepté
  const ok = await emitAck(s, 'send_message', { senderId: alice, receiverId: bob, text: envelope('m3'), type: 'évasion', style: { color: 'red', nested: { a: 1 } } });
  assert.equal(ok.success, true, JSON.stringify(ok));
  const row = db.prepare('SELECT type, style FROM messages WHERE id = ?').get(ok.id);
  assert.equal(row.type, 'text');
  assert.equal(row.style, 'null');
  s.disconnect();
});

test('send_message : budget de volume glissant par expéditeur', async () => {
  const s = await connect(tok(carol));
  await sleep(100);
  // Messages vocaux de 60 Ko : le budget de test (200 Ko) en laisse passer 3, le 4e est refusé
  let refused = null;
  for (let i = 0; i < 5; i++) {
    const r = await emitAck(s, 'send_message', { senderId: carol, receiverId: bob, text: envelope(`v${i}`, 60 * 1024), type: 'audio' });
    if (!r.success) { refused = r; break; }
  }
  assert.ok(refused, 'le budget doit finir par refuser');
  assert.equal(refused.code, 'quota');
  s.disconnect();
});

test('message_delivered : le drapeau isPrivate du client ne fabrique pas un faux « remis »', async () => {
  const sAlice = await connect(tok(alice));
  const sBob = await connect(tok(bob));
  await sleep(100);
  const p = waitEvent(sAlice, 'message_status_updated', 1000);
  sBob.emit('message_delivered', { messageId: 987654321, senderId: alice, isPrivate: true });
  assert.equal(await p, null, 'aucun accusé pour un message inexistant');
  sAlice.disconnect(); sBob.disconnect();
});

// ---------------------------------------------------------------------------------------
test('morpion : « Rejouer » refusé en cours de partie ; après la fin, le perdant commence', async () => {
  const sAlice = await connect(tok(alice));
  const sBob = await connect(tok(bob));
  await sleep(100);
  const inv = waitEvent(sBob, 'game_invite_received');
  sAlice.emit('game_invite', { target: bob, gameType: 'morpion' });
  assert.ok(await inv);
  const started = waitEvent(sAlice, 'game_started');
  sBob.emit('game_accept', { target: alice });
  assert.ok(await started, 'partie démarrée (Alice = X, commence)');

  // Restart en pleine partie → refusé
  const err = waitEvent(sBob, 'game_error', 800);
  sBob.emit('game_restart', { target: alice });
  const e = await err;
  assert.ok(e && /en cours/i.test(e.message), `refus attendu, reçu ${JSON.stringify(e)}`);

  // Alice gagne : X en 0,1,2 ; Bob joue 3,4
  const move = async (s, target, index) => { const p = waitEvent(s, 'game_move_ack', 50); s.emit('game_move', { target, index }); await p; await sleep(80); };
  await move(sAlice, bob, 0); await move(sBob, alice, 3);
  await move(sAlice, bob, 1); await move(sBob, alice, 4);
  await move(sAlice, bob, 2);
  // Le gagnant (Alice) clique Rejouer : c'est Bob (perdant) qui doit avoir le tour
  const restarted = waitEvent(sBob, 'game_restart');
  sAlice.emit('game_restart', { target: bob });
  assert.ok(await restarted);
  const resync = waitEvent(sBob, 'game_resync_state');
  sBob.emit('game_resync', { target: alice });
  const st = await resync;
  assert.equal(st?.isMyTurn, true, 'le perdant commence la manche suivante');
  sAlice.disconnect(); sBob.disconnect();
});

test('jeux : débit des invitations borné (15 / 10 s)', async () => {
  const sAlice = await connect(tok(alice));
  const sBob = await connect(tok(bob));
  await sleep(100);
  let received = 0;
  sBob.on('game_invite_received', () => { received++; });
  let errors = 0;
  sAlice.on('game_error', (d) => { if (/Trop de demandes/.test(d?.message || '')) errors++; });
  for (let i = 0; i < 30; i++) sAlice.emit('game_invite', { target: bob, gameType: 'morpion' });
  await sleep(600);
  assert.ok(received <= 15, `Bob a reçu ${received} invitations`);
  assert.ok(errors >= 1, 'l’émetteur est prévenu');
  sAlice.disconnect(); sBob.disconnect();
});

// ---------------------------------------------------------------------------------------
test('appels : pas de double sonnerie pour le même appelant, délai après refus', async () => {
  const sAlice = await connect(tok(alice));
  const sBob = await connect(tok(bob));
  await sleep(100);
  let incoming = 0;
  sBob.on('incoming_call', (d, ack) => { incoming++; if (typeof ack === 'function') ack({ ok: true }); });
  const signal = { type: 'offer', sdp: 'v=0' };
  sAlice.emit('call_request', { target: bob, signal, audioOnly: true });
  const busy = waitEvent(sAlice, 'call_busy', 800);
  sAlice.emit('call_request', { target: bob, signal, audioOnly: true });
  assert.ok(await busy, 'second call_request pendant la sonnerie → occupé');
  await sleep(200);
  assert.equal(incoming, 1, 'Bob n’a sonné qu’une fois');
  // Bob refuse : Alice ne peut pas rappeler tout de suite
  const rejected = waitEvent(sAlice, 'call_rejected');
  sBob.emit('call_reject', { target: alice });
  assert.ok(await rejected);
  const busy2 = waitEvent(sAlice, 'call_busy', 800);
  sAlice.emit('call_request', { target: bob, signal, audioOnly: true });
  assert.ok(await busy2, 'rappel immédiat après refus → occupé');
  assert.equal(incoming, 1);
  sAlice.disconnect(); sBob.disconnect();
});

test('appels multi-sessions : la chute d’une socket secondaire ne raccroche pas ; la dernière, si', async () => {
  const sAlicePc = await connect(tok(alice));
  const sAlicePhone = await connect(tok(alice));
  const sCarol = await connect(tok(carol)); // Carol : Bob vient de refuser Alice (délai de 10 s)
  await sleep(100);
  sCarol.on('incoming_call', (d, ack) => { if (typeof ack === 'function') ack({ ok: true }); });
  sAlicePhone.on('incoming_call', (d, ack) => { if (typeof ack === 'function') ack({ ok: true }); });
  const accepted = waitEvent(sAlicePc, 'call_accepted');
  sAlicePc.emit('call_request', { target: carol, signal: { type: 'offer', sdp: 'v=0' }, audioOnly: true });
  await sleep(300);
  sCarol.emit('call_accept', { target: alice });
  assert.ok(await accepted, 'appel établi');

  const ended1 = waitEvent(sCarol, 'call_ended', 1200);
  sAlicePhone.disconnect();
  assert.equal(await ended1, null, 'le téléphone d’Alice tombe : l’appel du PC continue');
  const ended2 = waitEvent(sCarol, 'call_ended', 1500);
  sAlicePc.disconnect();
  assert.ok(await ended2, 'dernière socket d’Alice partie : Carol est prévenue');
  sCarol.disconnect();
});
