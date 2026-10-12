import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Enveloppe de message signée (src/utils/MessageEnvelope.ts) — tests sans serveur.
 * Modèle de menace : le SERVEUR est l'attaquant. Il connaît toutes les clés publiques,
 * relaie et stocke les messages, et peut en fabriquer. Il ne possède aucune clé privée.
 *
 * Importe directement le module TypeScript : nécessite Node ≥ 22.18 (suppression native
 * des types). Sur une version plus ancienne, le fichier est ignoré avec un message clair.
 */

let mod = null;
try {
  mod = await import('../src/utils/MessageEnvelope.ts');
} catch (err) {
  test('enveloppe de message signée', { skip: `Node ${process.version} ne charge pas les modules .ts (Node ≥ 22.18 requis) : ${err.code || err.message}` }, () => {});
}
if (!mod) {
  // Rien d'autre à exécuter dans ce fichier.
} else {
const {
  sealMessage, openMessage, parseEnvelope, sanitizeDecryptedPayload, canonicalSigningString
} = mod;

const { subtle } = globalThis.crypto;

// Même procédé que l'application : une paire RSA-OAEP, réimportée en RSA-PSS pour signer.
const makeUser = async (id) => {
  const kp = await subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['encrypt', 'decrypt']
  );
  const publicKeyJwk = await subtle.exportKey('jwk', kp.publicKey);
  const privJwk = await subtle.exportKey('jwk', kp.privateKey);
  const { alg, key_ops, use, ext, ...bare } = privJwk; // eslint-disable-line no-unused-vars
  const signingKey = await subtle.importKey('jwk', bare, { name: 'RSA-PSS', hash: 'SHA-256' }, false, ['sign']);
  const privateKey = await subtle.importKey('jwk', privJwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
  return { id, publicKeyJwk, privateKey, signingKey };
};

const alice = await makeUser(1);
const bob = await makeUser(2);
const mallory = await makeUser(3);   // utilisateur malveillant OU clé fabriquée par le serveur

const seal = (from, to, payload, extra = {}) => sealMessage(payload, {
  from: from.id, to: to.id,
  receiverPublicKeyJwk: to.publicKeyJwk,
  senderPublicKeyJwk: from.publicKeyJwk,
  signingKey: from.signingKey,
  ...extra
});
const openAs = (me, env, { serverFrom, serverTo, senderPub } = {}) => openMessage(
  typeof env === 'string' ? env : JSON.stringify(env),
  {
    serverSenderId: serverFrom ?? env.from,
    serverReceiverId: serverTo ?? env.to,
    myId: me.id,
    myPrivateKey: me.privateKey,
    senderPublicKeyJwk: senderPub === undefined ? (serverFrom === mallory.id ? mallory : alice).publicKeyJwk : senderPub
  }
);

// Ancien format v1 (chiffré, non signé) tel que le produisait encryptMessagePayload.
const sealV1 = async (payload, receiverPub, senderPub) => {
  const aes = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, aes, new TextEncoder().encode(JSON.stringify(payload)));
  const raw = await subtle.exportKey('raw', aes);
  const wrap = async (jwk) => subtle.encrypt({ name: 'RSA-OAEP' }, await subtle.importKey('jwk', jwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']), raw);
  const b64 = (b) => Buffer.from(b).toString('base64');
  return { iv: b64(iv), payload: b64(ct), keyReceiver: b64(await wrap(receiverPub)), keySender: b64(await wrap(senderPub)) };
};

// ---------------------------------------------------------------- fonctionnement normal

test('message signé : vérifié côté destinataire', async () => {
  const env = await seal(alice, bob, { type: 'text', text: 'salut Bob' });
  assert.equal(env.v, 2);
  const r = await openAs(bob, env);
  assert.equal(r.status, 'verified');
  assert.deepEqual(r.payload, { type: 'text', text: 'salut Bob' });
  assert.equal(r.mid, env.mid);
});

test('message signé : vérifié côté émetteur (autre session / historique)', async () => {
  const env = await seal(alice, bob, { type: 'text', text: 'copie' });
  const r = await openAs(alice, env, { senderPub: alice.publicKeyJwk });
  assert.equal(r.status, 'verified');
  assert.equal(r.payload.text, 'copie');
});

test('chaque message a un mid unique', async () => {
  const a = await seal(alice, bob, { text: 'a' });
  const b = await seal(alice, bob, { text: 'a' });
  assert.notEqual(a.mid, b.mid);
});

// ---------------------------------------------------------------- attaques du serveur

test('ATTAQUE : le serveur fabrique un message v2 signé avec une autre clé → invalide', async () => {
  // Le serveur chiffre pour Bob (il a sa clé publique) et signe avec une clé à lui,
  // en annonçant Alice comme émettrice.
  const forged = await sealMessage({ type: 'text', text: 'virement urgent' }, {
    from: alice.id, to: bob.id,
    receiverPublicKeyJwk: bob.publicKeyJwk, senderPublicKeyJwk: mallory.publicKeyJwk,
    signingKey: mallory.signingKey
  });
  const r = await openAs(bob, forged);
  assert.equal(r.status, 'invalid');
  assert.equal(r.payload, null, 'aucun contenu exposé');
});

test('ATTAQUE : le serveur fabrique un message à l\'ancien format v1 → signalé non signé', async () => {
  const forgedV1 = await sealV1({ type: 'text', text: 'faux' }, bob.publicKeyJwk, mallory.publicKeyJwk);
  const r = await openAs(bob, forgedV1, { serverFrom: alice.id, serverTo: bob.id });
  assert.equal(r.status, 'unsigned-legacy', 'jamais présenté comme vérifié');
});

test('ATTAQUE : le serveur envoie du texte en clair → rejeté', async () => {
  const r = await openAs(bob, 'Bonjour, clique ici', { serverFrom: alice.id, serverTo: bob.id });
  assert.equal(r.status, 'plaintext');
  assert.equal(r.payload, null);
});

test('ATTAQUE : modification d\'un champ signé → invalide', async () => {
  const env = await seal(alice, bob, { type: 'text', text: 'original' });
  const flip = (s) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
  for (const field of ['payload', 'iv', 'keyReceiver', 'keySender', 'mid', 'sig']) {
    const r = await openAs(bob, { ...env, [field]: flip(env[field]) });
    assert.equal(r.status, 'invalid', `champ altéré: ${field}`);
  }
  assert.equal((await openAs(bob, { ...env, ts: env.ts + 1 })).status, 'invalid', 'ts altéré');
});

test('ATTAQUE : réacheminement (le serveur annonce un autre émetteur/destinataire) → invalide', async () => {
  const env = await seal(alice, bob, { text: 'pour Bob' });
  // Annoncé comme venant de Mallory
  assert.equal((await openAs(bob, env, { serverFrom: mallory.id, serverTo: bob.id, senderPub: mallory.publicKeyJwk })).status, 'invalid');
  // Livré à un autre destinataire
  assert.equal((await openAs(mallory, env, { serverFrom: alice.id, serverTo: mallory.id, senderPub: alice.publicKeyJwk })).status, 'invalid');
});

test('ATTAQUE : retrait de signature + re-signature par un tiers (signature stripping) → invalide', async () => {
  // Mallory intercepte Alice→Bob, se déclare émettrice et re-signe avec SA clé.
  const env = await seal(alice, bob, { text: 'écrit par Alice' });
  const { sig, ...rest } = env; // eslint-disable-line no-unused-vars
  const restamped = { ...rest, from: mallory.id };
  const sig2 = await subtle.sign({ name: 'RSA-PSS', saltLength: 32 }, mallory.signingKey, new TextEncoder().encode(canonicalSigningString(restamped)));
  const r = await openAs(bob, { ...restamped, sig: Buffer.from(sig2).toString('base64') }, { serverFrom: mallory.id, serverTo: bob.id, senderPub: mallory.publicKeyJwk });
  assert.equal(r.status, 'invalid', 'from interne (Alice) ≠ from signé (Mallory)');
});

test('message qui ne concerne pas l\'utilisateur courant → invalide', async () => {
  const env = await seal(alice, bob, { text: 'x' });
  const r = await openMessage(JSON.stringify(env), {
    serverSenderId: alice.id, serverReceiverId: bob.id, myId: mallory.id,
    myPrivateKey: mallory.privateKey, senderPublicKeyJwk: alice.publicKeyJwk
  });
  assert.equal(r.status, 'invalid');
});

test('clé publique de l\'émetteur indisponible → déchiffré mais « non vérifiable »', async () => {
  const env = await seal(alice, bob, { text: 'x' });
  const r = await openAs(bob, env, { senderPub: null });
  assert.equal(r.status, 'unverifiable');
  assert.equal(r.payload.text, 'x');
});

test('enveloppes malformées → invalides, sans exception', async () => {
  const env = await seal(alice, bob, { text: 'x' });
  for (const bad of [
    { ...env, from: '1' }, { ...env, to: 0 }, { ...env, ts: 'now' }, { ...env, sig: '' },
    { ...env, mid: 'pas du base64!' }, { ...env, payload: null }
  ]) {
    const r = await openAs(bob, bad, { serverFrom: alice.id, serverTo: bob.id });
    assert.equal(r.status, 'invalid');
  }
});

// ---------------------------------------------------------------- utilitaires

test('parseEnvelope distingue v2, v1 et texte clair', () => {
  assert.equal(parseEnvelope('{"v":2}').kind, 'v2');
  assert.equal(parseEnvelope('{"keyReceiver":"a"}').kind, 'v1');
  assert.equal(parseEnvelope('bonjour').kind, 'plaintext');
  assert.equal(parseEnvelope('{"a":1}').kind, 'plaintext');
  assert.equal(parseEnvelope(null).kind, 'plaintext');
});

test('sanitizeDecryptedPayload ne garde que les champs de contenu', () => {
  const out = sanitizeDecryptedPayload({
    type: 'text', text: 'hi', style: { color: 'red' },
    id: 999, senderId: 42, sender: 'Admin', timestamp: 0, delivery_status: 'read', _isPending: false,
    fileSize: 10, customEmoticons: { ':x:': {} }, audio: 123
  });
  assert.deepEqual(out, { type: 'text', text: 'hi', style: { color: 'red' }, fileSize: 10, customEmoticons: { ':x:': {} } });
  assert.deepEqual(sanitizeDecryptedPayload({ type: 'admin' }), {}, 'type inconnu ignoré');
  assert.deepEqual(sanitizeDecryptedPayload(null), {});
});
} // fin du bloc exécuté si le module .ts est chargeable
