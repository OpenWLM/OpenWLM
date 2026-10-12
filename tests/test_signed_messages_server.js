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
 * Messages signés de bout en bout À TRAVERS LE SERVEUR RÉEL :
 * - le serveur relaie et stocke l'enveloppe v2 sans l'altérer (direct + historique) ;
 * - un « serveur compromis » qui insère des messages directement en base ne peut produire
 *   que des messages rejetés (texte clair, fausse signature) ou signalés non signés (v1).
 *
 * Nécessite le serveur sur http://localhost:3001 et Node ≥ 22.18 (import du module .ts).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const jwtSecretPath = path.join(PROJECT_ROOT, '.jwt_secret');
const JWT_SECRET = fs.existsSync(jwtSecretPath) ? fs.readFileSync(jwtSecretPath, 'utf8').trim() : null;

let mod = null;
try { mod = await import('../src/utils/MessageEnvelope.ts'); } catch { /* Node trop ancien */ }

const probe = () => new Promise((resolve) => {
  if (!JWT_SECRET) return resolve(false);
  const req = http.request({ hostname: 'localhost', port: 3001, path: '/api/push/status', method: 'GET' }, (res) => { res.resume(); resolve(res.statusCode === 200); });
  req.on('error', () => resolve(false));
  req.end();
});
const serverUp = await probe();
const skip = !serverUp ? 'Serveur non démarré' : (!mod ? 'Node ≥ 22.18 requis (module .ts)' : false);

const IDS = { alice: 9971, bob: 9972 };
const { subtle } = globalThis.crypto;
const tok = (id, username) => jwt.sign({ id, username, tv: 0 }, JWT_SECRET);
const getJson = (apiPath, token) => new Promise((resolve) => {
  const req = http.request({ hostname: 'localhost', port: 3001, path: apiPath, method: 'GET', headers: { Authorization: `Bearer ${token}` } }, (res) => {
    let raw = ''; res.on('data', (c) => { raw += c; }); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(raw) }));
  });
  req.on('error', () => resolve({ status: 0 }));
  req.end();
});
const connect = (token) => new Promise((resolve, reject) => {
  const s = ClientIO('http://localhost:3001', { auth: { token }, transports: ['websocket'], reconnection: false });
  s.once('connect', () => resolve(s));
  s.once('connect_error', reject);
  setTimeout(() => reject(new Error('Timeout socket')), 3000);
});

const makeUser = async (id) => {
  const kp = await subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
  const publicKeyJwk = await subtle.exportKey('jwk', kp.publicKey);
  const privJwk = await subtle.exportKey('jwk', kp.privateKey);
  const { alg, key_ops, use, ext, ...bare } = privJwk; // eslint-disable-line no-unused-vars
  return {
    id, publicKeyJwk,
    privateKey: await subtle.importKey('jwk', privJwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']),
    signingKey: await subtle.importKey('jwk', bare, { name: 'RSA-PSS', hash: 'SHA-256' }, false, ['sign'])
  };
};

test('messages signés : relais, historique et falsification serveur', { skip }, async () => {
  const db = new Database(path.join(PROJECT_ROOT, 'messenger.db'));
  const cleanup = () => {
    try { db.prepare('DELETE FROM messages WHERE sender_id IN (9971,9972) OR receiver_id IN (9971,9972)').run(); } catch { /* ignore */ }
    try { db.prepare('DELETE FROM contacts WHERE user_id IN (9971,9972) OR contact_id IN (9971,9972)').run(); } catch { /* ignore */ }
    try { db.prepare('DELETE FROM users WHERE id IN (9971,9972)').run(); } catch { /* ignore */ }
  };
  cleanup();
  const alice = await makeUser(IDS.alice);
  const bob = await makeUser(IDS.bob);
  const insertUser = db.prepare(`INSERT INTO users (id, username, password_hash, salt, nickname, status, token_version, global_private, public_key)
    VALUES (?, ?, 'hash', 'salt', ?, 'online', 0, 0, ?)`);
  insertUser.run(IDS.alice, 'sig_alice', 'Alice', JSON.stringify(alice.publicKeyJwk));
  insertUser.run(IDS.bob, 'sig_bob', 'Bob', JSON.stringify(bob.publicKeyJwk));
  db.prepare('INSERT INTO contacts (user_id, contact_id, status, blocked) VALUES (?, ?, 1, 0)').run(IDS.alice, IDS.bob);
  db.prepare('INSERT INTO contacts (user_id, contact_id, status, blocked) VALUES (?, ?, 1, 0)').run(IDS.bob, IDS.alice);

  const bobToken = tok(IDS.bob, 'sig_bob');
  const sA = await connect(tok(IDS.alice, 'sig_alice'));
  const sB = await connect(bobToken);
  try {
    // Bob récupère la clé publique d'Alice comme le ferait le client
    const keyRes = await getJson(`/api/user/${IDS.alice}/public-key`, bobToken);
    assert.equal(keyRes.status, 200);
    const alicePubAsSeenByBob = keyRes.data.publicKey;

    const openForBob = (text, from, to) => mod.openMessage(text, {
      serverSenderId: from, serverReceiverId: to, myId: IDS.bob,
      myPrivateKey: bob.privateKey, senderPublicKeyJwk: alicePubAsSeenByBob
    });

    // 1) Envoi d'un message signé via le serveur réel
    const env = await mod.sealMessage({ type: 'text', text: 'Bonjour Bob' }, {
      from: IDS.alice, to: IDS.bob, receiverPublicKeyJwk: bob.publicKeyJwk,
      senderPublicKeyJwk: alice.publicKeyJwk, signingKey: alice.signingKey
    });
    const received = new Promise((resolve) => sB.once('receive_message', resolve));
    const ack = await new Promise((resolve) => sA.emit('send_message', {
      senderId: IDS.alice, receiverId: IDS.bob, text: JSON.stringify(env), style: null, audio: null, type: 'text', isPrivate: false
    }, resolve));
    assert.equal(ack.success, true, 'le serveur accepte l\'enveloppe v2');

    const live = await received;
    const liveOpened = await openForBob(live.text, live.senderId, live.receiverId);
    assert.equal(liveOpened.status, 'verified', 'message direct vérifié après relais');
    assert.equal(liveOpened.payload.text, 'Bonjour Bob');

    // 2) Historique : l'enveloppe stockée est intacte
    let hist = await getJson(`/api/messages/${IDS.bob}/${IDS.alice}`, bobToken);
    assert.equal(hist.status, 200);
    const stored = hist.data.find((m) => m.id === ack.id);
    assert.ok(stored, 'message présent dans l\'historique');
    assert.equal((await openForBob(stored.text, stored.sender_id, stored.receiver_id)).status, 'verified', 'historique vérifié');

    // 3) Serveur compromis : insertions directes en base au nom d'Alice
    const insertMsg = db.prepare("INSERT INTO messages (sender_id, receiver_id, text, type, delivery_status) VALUES (?, ?, ?, 'text', 'sent')");
    // a) texte en clair
    insertMsg.run(IDS.alice, IDS.bob, 'Clique sur ce lien');
    // b) enveloppe v2 chiffrée pour Bob mais signée par une clé du serveur
    const mallory = await makeUser(9999);
    const forged = await mod.sealMessage({ type: 'text', text: 'faux' }, {
      from: IDS.alice, to: IDS.bob, receiverPublicKeyJwk: bob.publicKeyJwk,
      senderPublicKeyJwk: mallory.publicKeyJwk, signingKey: mallory.signingKey
    });
    insertMsg.run(IDS.alice, IDS.bob, JSON.stringify(forged));
    // c) rejeu du message légitime (même enveloppe, nouvel id)
    insertMsg.run(IDS.alice, IDS.bob, stored.text);

    hist = await getJson(`/api/messages/${IDS.bob}/${IDS.alice}`, bobToken);
    const verdicts = [];
    const seen = new Set();
    // Tri par id (ordre d'insertion) : les lignes insérées à la main ont un format d'horodatage différent
    for (const m of [...hist.data].sort((a, b) => a.id - b.id)) {
      const o = await openForBob(m.text, m.sender_id, m.receiver_id);
      if (o.mid && seen.has(o.mid)) { verdicts.push('replay'); continue; }
      if (o.mid) seen.add(o.mid);
      verdicts.push(o.status);
    }
    assert.deepEqual(verdicts, ['verified', 'plaintext', 'invalid', 'replay'],
      'seul le message réellement signé par Alice est accepté');
  } finally {
    sA.disconnect();
    sB.disconnect();
    cleanup();
    db.close();
  }
});
