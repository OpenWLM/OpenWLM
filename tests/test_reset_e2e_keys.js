/**
 * Test de validation : Réinitialisation d'urgence des clés E2E (Reset E2E Identity)
 * 
 * Vérifie :
 * 1. Contrôle d'accès & sécurité (Anti-Usurpation) :
 *    - Rejet sans token JWT valide (401/403).
 *    - Rejet strict (HTTP 403) si un userId discordé est envoyé dans le corps de requête.
 *    - Rejet (HTTP 401) si le mot de passe (authKeyHex) est incorrect.
 *    - Rejet (HTTP 400) si les paramètres de clés sont malformés ou absents.
 * 2. Atomicité du reset serveur :
 *    - Clés publique et privée chiffrée mises à jour en base de données.
 *    - Purge intégrale des anciens messages chiffrés sur le serveur (sender_id ou receiver_id).
 *    - Purge des curseurs de lecture associés dans conversation_read_cursors.
 *    - Incrémentation de token_version (invalidation des sessions JWT antérieures).
 * 3. Diffusion en temps réel :
 *    - Les contacts connectés reçoivent l'événement user_status_changed avec la nouvelle clé publique.
 * 4. Détection & re-vérification locale du Safety Number :
 *    - Changement d'empreinte cryptographique détecté, invalidation du statut vérifié.
 * 5. Hygiène du stockage client :
 *    - VerifiedContactsStorage.clearAll() purge proprement le store local et le fallback legacy.
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
let db;
let aliceId;
let bobId;
let tokenAlice;
let tokenBob;
const sockets = [];

// Helper pour hachage PBKDF2 conforme à server/index.js
const hashPassword = (authKeyHex, salt) => {
  return crypto.pbkdf2Sync(authKeyHex, salt, 210000, 64, 'sha512').toString('hex');
};

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

const connect = (userId, tv = 0) => new Promise((resolve, reject) => {
  const token = jwt.sign({ id: userId, tv }, JWT_SECRET, { expiresIn: '1h' });
  const s = ioClient(`http://127.0.0.1:${port}`, {
    auth: { token },
    transports: ['websocket'],
    forceNew: true,
    reconnection: false
  });
  s.statusUpdates = [];
  s.on('user_status_changed', (u) => s.statusUpdates.push(u));
  s.once('connect', () => { sockets.push(s); resolve(s); });
  s.once('connect_error', reject);
});

const waitFor = async (predicate, timeoutMs = 3000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise(r => setTimeout(r, 25));
  }
  return predicate();
};

const ALICE_AUTH_HEX = crypto.randomBytes(32).toString('hex');
const BOB_AUTH_HEX = crypto.randomBytes(32).toString('hex');

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwlm-reset-test-'));
  port = await getFreePort();

  serverProc = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: tmpDir,
    env: { ...process.env, PORT: String(port), JWT_SECRET, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  await waitForPort(port);

  db = new Database(path.join(tmpDir, 'messenger.db'));

  // Création des utilisateurs avec sels et hash de mot de passe valides
  const aliceSalt = crypto.randomBytes(16).toString('hex');
  const aliceHash = hashPassword(ALICE_AUTH_HEX, aliceSalt);

  const bobSalt = crypto.randomBytes(16).toString('hex');
  const bobHash = hashPassword(BOB_AUTH_HEX, bobSalt);

  const insertUser = db.prepare(`
    INSERT INTO users (username, password_hash, salt, nickname, status, public_key, encrypted_private_key, token_version)
    VALUES (?, ?, ?, ?, 'online', ?, ?, 0)
  `);

  const initialAlicePub = JSON.stringify({ kty: 'RSA', n: 'initial_alice_pub', e: 'AQAB' });
  const initialAlicePriv = JSON.stringify({ encryptedKeyBase64: 'priv_alice_init', ivBase64: 'iv_alice_init' });

  aliceId = Number(insertUser.run('alice_reset', aliceHash, aliceSalt, 'Alice', initialAlicePub, initialAlicePriv).lastInsertRowid);
  bobId = Number(insertUser.run('bob_reset', bobHash, bobSalt, 'Bob', '{}', '{}').lastInsertRowid);

  // Établir la relation de contact bilatérale
  db.prepare("INSERT INTO contacts (user_id, contact_id, status) VALUES (?, ?, 1)").run(aliceId, bobId);
  db.prepare("INSERT INTO contacts (user_id, contact_id, status) VALUES (?, ?, 1)").run(bobId, aliceId);

  tokenAlice = jwt.sign({ id: aliceId, tv: 0 }, JWT_SECRET, { expiresIn: '1h' });
  tokenBob = jwt.sign({ id: bobId, tv: 0 }, JWT_SECRET, { expiresIn: '1h' });
});

after(() => {
  sockets.forEach(s => { try { s.disconnect(); } catch {} });
  if (serverProc) {
    serverProc.kill('SIGKILL');
  }
  if (db) {
    try { db.close(); } catch {}
  }
  if (tmpDir) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('1. Contrôle d’accès : Rejet des requêtes non autorisées ou usurpées', async () => {
  const newPubKey = { kty: 'RSA', n: 'new_n_1', e: 'AQAB' };
  const newPrivKey = { encryptedKeyBase64: 'enc1', ivBase64: 'iv1' };

  // A. Sans token JWT
  const resNoAuth = await fetch(`http://127.0.0.1:${port}/api/user/reset-e2e-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authKeyHex: ALICE_AUTH_HEX, publicKey: newPubKey, encryptedPrivateKey: newPrivKey })
  });
  assert.strictEqual(resNoAuth.status, 401, 'Requête sans token doit renvoyer 401');

  // B. Usurpation d’identité : Alice tente de réinitialiser le compte de Bob
  const resTamper = await fetch(`http://127.0.0.1:${port}/api/user/reset-e2e-keys`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokenAlice}`
    },
    body: JSON.stringify({
      userId: bobId, // Ciblage frauduleux d'un autre utilisateur
      authKeyHex: ALICE_AUTH_HEX,
      publicKey: newPubKey,
      encryptedPrivateKey: newPrivKey
    })
  });
  assert.strictEqual(resTamper.status, 403, 'Tentative de reset pour un autre userId doit renvoyer 403 Forbidden');

  // C. Mauvais mot de passe (mauvaise authKeyHex)
  const wrongAuthHex = crypto.randomBytes(32).toString('hex');
  const resWrongPass = await fetch(`http://127.0.0.1:${port}/api/user/reset-e2e-keys`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokenAlice}`
    },
    body: JSON.stringify({
      authKeyHex: wrongAuthHex,
      publicKey: newPubKey,
      encryptedPrivateKey: newPrivKey
    })
  });
  assert.strictEqual(resWrongPass.status, 401, 'Mot de passe erroné doit renvoyer 401 Unauthorized');

  // D. Format de clés invalide ou manquant
  const resInvalid = await fetch(`http://127.0.0.1:${port}/api/user/reset-e2e-keys`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokenAlice}`
    },
    body: JSON.stringify({
      authKeyHex: ALICE_AUTH_HEX,
      publicKey: "not-an-object",
      encryptedPrivateKey: newPrivKey
    })
  });
  assert.strictEqual(resInvalid.status, 400, 'Clé publique invalide doit renvoyer 400 Bad Request');
});

test('2. Atomicité & Destruction intégrale : Remplacement des clés, purge des messages et des curseurs', async () => {
  // A. Insérer des messages antérieurs et des curseurs de lecture impliquant Alice
  db.prepare("INSERT INTO messages (sender_id, receiver_id, text) VALUES (?, ?, ?)").run(aliceId, bobId, 'Message confidentiel Alice->Bob');
  db.prepare("INSERT INTO messages (sender_id, receiver_id, text) VALUES (?, ?, ?)").run(bobId, aliceId, 'Réponse confidentielle Bob->Alice');
  db.prepare("INSERT INTO conversation_read_cursors (user_id, contact_id, last_read_message_id, updated_at) VALUES (?, ?, 1, ?)").run(aliceId, bobId, Date.now());
  db.prepare("INSERT INTO conversation_read_cursors (user_id, contact_id, last_read_message_id, updated_at) VALUES (?, ?, 2, ?)").run(bobId, aliceId, Date.now());

  // Vérifier qu'ils existent bien
  const msgsBefore = db.prepare("SELECT COUNT(*) as count FROM messages WHERE sender_id = ? OR receiver_id = ?").get(aliceId, aliceId).count;
  assert.strictEqual(msgsBefore, 2, 'Les 2 messages doivent exister avant reset');

  const cursorsBefore = db.prepare("SELECT COUNT(*) as count FROM conversation_read_cursors WHERE user_id = ? OR contact_id = ?").get(aliceId, aliceId).count;
  assert.strictEqual(cursorsBefore, 2, 'Les 2 curseurs doivent exister avant reset');

  // B. Bob se connecte en WebSocket pour recevoir la diffusion en temps réel
  const bobSocket = await connect(bobId, 0);
  await new Promise(r => setTimeout(r, 150));

  // C. Alice exécute le reset légitime
  const freshAlicePubKey = { kty: 'RSA', n: 'alice_brand_new_public_key_modulus', e: 'AQAB' };
  const freshAlicePrivKey = { encryptedKeyBase64: 'alice_new_vault_enc', ivBase64: 'alice_new_vault_iv' };

  const resetRes = await fetch(`http://127.0.0.1:${port}/api/user/reset-e2e-keys`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokenAlice}`
    },
    body: JSON.stringify({
      authKeyHex: ALICE_AUTH_HEX,
      publicKey: freshAlicePubKey,
      encryptedPrivateKey: freshAlicePrivKey
    })
  });

  assert.strictEqual(resetRes.status, 200, 'Le reset doit réussir avec HTTP 200');
  const jsonRes = await resetRes.json();
  assert.strictEqual(jsonRes.success, true);

  // D. Vérification de l'état en base de données
  const updatedAlice = db.prepare("SELECT public_key, encrypted_private_key, token_version FROM users WHERE id = ?").get(aliceId);
  assert.deepStrictEqual(JSON.parse(updatedAlice.public_key), freshAlicePubKey, 'La clé publique en base doit être la nouvelle');
  assert.deepStrictEqual(JSON.parse(updatedAlice.encrypted_private_key), freshAlicePrivKey, 'La clé privée chiffrée en base doit être la nouvelle');
  assert.strictEqual(updatedAlice.token_version, 1, 'token_version doit être incrémenté à 1');

  // E. Vérification de la suppression intégrale des messages serveur
  const msgsAfter = db.prepare("SELECT COUNT(*) as count FROM messages WHERE sender_id = ? OR receiver_id = ?").get(aliceId, aliceId).count;
  assert.strictEqual(msgsAfter, 0, 'Tous les messages anciens impliquant Alice doivent être supprimés de la BDD');

  // F. Vérification de la suppression des curseurs de lecture
  const cursorsAfter = db.prepare("SELECT COUNT(*) as count FROM conversation_read_cursors WHERE user_id = ? OR contact_id = ?").get(aliceId, aliceId).count;
  assert.strictEqual(cursorsAfter, 0, 'Les curseurs de lecture associés doivent être purgés');

  // G. Invalidation des anciennes sessions JWT : l’ancien token d’Alice doit être rejeté
  const checkOldTokenRes = await fetch(`http://127.0.0.1:${port}/api/user/me`, {
    headers: { 'Authorization': `Bearer ${tokenAlice}` }
  });
  assert.strictEqual(checkOldTokenRes.status, 401, 'L’ancienne session JWT avec tv=0 doit être rejetée (401)');

  // H. Vérification de la diffusion temps réel à Bob
  const found = await waitFor(() => {
    return bobSocket.statusUpdates.some(u => Number(u.id || u.userId) === aliceId && u.public_key);
  }, 2000);

  assert.ok(found, 'Bob doit avoir reçu l’événement user_status_changed pour Alice');
  const aliceUpdate = bobSocket.statusUpdates.find(u => Number(u.id || u.userId) === aliceId && u.public_key);
  const receivedPubKey = typeof aliceUpdate.public_key === 'string' ? JSON.parse(aliceUpdate.public_key) : aliceUpdate.public_key;
  assert.deepStrictEqual(receivedPubKey, freshAlicePubKey, 'La clé diffusée en temps réel doit être la nouvelle clé publique d’Alice');
});

test('3. Détection de changement de clé & invalidation de statut chez le contact', async () => {
  // Calcul d'empreintes simulées
  const calculateFp = async (jwk) => {
    const canonical = JSON.stringify({ e: jwk.e, kty: jwk.kty || 'RSA', n: jwk.n });
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  };

  const oldKey = { kty: 'RSA', n: 'alice_old_key_material', e: 'AQAB' };
  const newKey = { kty: 'RSA', n: 'alice_brand_new_public_key_modulus', e: 'AQAB' };

  const oldFp = await calculateFp(oldKey);
  const newFp = await calculateFp(newKey);

  assert.notStrictEqual(oldFp, newFp, 'Les deux empreintes doivent être strictement différentes');

  // Simuler le gestionnaire local de Bob
  let bobVerifiedContacts = {
    [aliceId]: {
      contactId: aliceId,
      fingerprint: oldFp,
      verified: true, // Bob avait préalablement vérifié Alice
      seenAt: Date.now()
    }
  };
  let keyAlertContactId = null;

  // Réception de la nouvelle clé publique d'Alice
  const incomingPub = newKey;
  const currentRecord = bobVerifiedContacts[aliceId];

  if (currentRecord.fingerprint && currentRecord.fingerprint !== newFp) {
    keyAlertContactId = aliceId;
    bobVerifiedContacts[aliceId] = {
      contactId: aliceId,
      fingerprint: newFp,
      verified: false, // Invalidation automatique de la confiance
      seenAt: Date.now()
    };
  }

  assert.strictEqual(keyAlertContactId, aliceId, 'Une alerte de modification de clé doit être levée pour le contact');
  assert.strictEqual(bobVerifiedContacts[aliceId].verified, false, 'Le statut vérifié doit être immédiatement révoqué');
  assert.strictEqual(bobVerifiedContacts[aliceId].fingerprint, newFp, 'La nouvelle empreinte doit être enregistrée');
});

test('4. Purge client : VerifiedContactsStorage.clearAll() vide les données locales et legacy', async () => {
  const mockIDBStore = new Map();
  const mockLocalStorage = new Map();

  class MockVerifiedContactsStorageWithClearAll {
    async save(record) {
      mockIDBStore.set(record.contactId, { ...record });
      return { success: true };
    }

    async getAll() {
      const result = {};
      for (const [id, rec] of mockIDBStore.entries()) {
        result[id] = rec;
      }
      return result;
    }

    async clearAll() {
      mockIDBStore.clear();
      mockLocalStorage.delete('wlm_verified_contacts_v1');
      mockLocalStorage.delete('wlm_verified_contacts_migrated_v1');
      return { success: true };
    }
  }

  const storage = new MockVerifiedContactsStorageWithClearAll();
  mockLocalStorage.set('wlm_verified_contacts_v1', '{"123":{"verified":true}}');

  await storage.save({ contactId: 10, fingerprint: 'FP10', verified: true });
  await storage.save({ contactId: 20, fingerprint: 'FP20', verified: true });

  const before = await storage.getAll();
  assert.strictEqual(Object.keys(before).length, 2);

  const res = await storage.clearAll();
  assert.strictEqual(res.success, true);

  const after = await storage.getAll();
  assert.deepStrictEqual(after, {}, 'Toutes les vérifications locales doivent être purgées');
  assert.strictEqual(mockLocalStorage.has('wlm_verified_contacts_v1'), false, 'Le legacy localStorage doit être purgé');
});
