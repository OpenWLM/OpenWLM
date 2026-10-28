import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  sealPrivateJwk, openPrivateJwk, deriveWrapKey, randomBytes, isProtectedKeyBlob, bytesToBase64
} from '../src/utils/deviceLockCrypto.ts';

/**
 * Verrouillage des clés par l'appareil (src/utils/DeviceLock.ts) : primitives de scellement de
 * la clé privée avec le secret rendu par Windows Hello (PRF) ou le Keystore Android.
 *  - la clé privée scellée s'ouvre avec le bon secret, jamais avec un autre ;
 *  - le scellé ne contient pas la clé en clair ;
 *  - un scellé altéré ou mal formé est refusé.
 * Web Crypto seulement : aucun serveur.
 */

const samplePrivateJwk = async () => {
  const pair = await webcrypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
  return webcrypto.subtle.exportKey('jwk', pair.privateKey);
};

test('scellement : la clé privée s\'ouvre avec le bon secret, pas avec un autre', async () => {
  const jwk = await samplePrivateJwk();
  const secret = randomBytes(32);
  const sealed = await sealPrivateJwk(jwk, secret, randomBytes(32));
  const opened = await openPrivateJwk(sealed, secret);
  assert.deepEqual(opened, jwk);
  assert.equal(await openPrivateJwk(sealed, randomBytes(32)), null, 'autre secret');
  const flipped = new Uint8Array(secret);
  flipped[0] ^= 1;
  assert.equal(await openPrivateJwk(sealed, flipped), null, 'secret altéré d\'un bit');
});

test('scellement : rien de la clé en clair, sels et IV différents à chaque fois', async () => {
  const jwk = await samplePrivateJwk();
  const secret = randomBytes(32);
  const a = await sealPrivateJwk(jwk, secret, randomBytes(32));
  const b = await sealPrivateJwk(jwk, secret, randomBytes(32));
  for (const sealed of [a, b]) {
    const raw = Buffer.from(sealed.ciphertext, 'base64').toString('latin1');
    assert.ok(!raw.includes(jwk.d.slice(0, 16)), 'exposant privé absent du scellé');
    assert.ok(!raw.includes('"kty"'), 'JWK absent du scellé');
  }
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.ciphertext, b.ciphertext);
});

test('scellement : scellé altéré refusé, clé de scellement non exportable', async () => {
  const jwk = await samplePrivateJwk();
  const secret = randomBytes(32);
  const sealed = await sealPrivateJwk(jwk, secret, randomBytes(32));
  const bytes = Buffer.from(sealed.ciphertext, 'base64');
  bytes[bytes.length - 1] ^= 1;
  assert.equal(await openPrivateJwk({ ...sealed, ciphertext: bytes.toString('base64') }, secret), null);
  assert.equal(await openPrivateJwk({ ...sealed, iv: bytesToBase64(randomBytes(12)) }, secret), null);
  const key = await deriveWrapKey(secret, randomBytes(32));
  assert.equal(key.extractable, false);
  await assert.rejects(webcrypto.subtle.exportKey('raw', key));
});

test('isProtectedKeyBlob : forme attendue seulement', async () => {
  const sealed = await sealPrivateJwk(await samplePrivateJwk(), randomBytes(32), randomBytes(32));
  const blob = { version: 1, method: 'webauthn', handle: bytesToBase64(randomBytes(16)), ...sealed };
  assert.equal(isProtectedKeyBlob(blob), true);
  assert.equal(isProtectedKeyBlob({ ...blob, method: 'android' }), true);
  assert.equal(isProtectedKeyBlob({ ...blob, method: 'other' }), false);
  assert.equal(isProtectedKeyBlob({ ...blob, version: 2 }), false);
  assert.equal(isProtectedKeyBlob({ ...blob, handle: '' }), false);
  assert.equal(isProtectedKeyBlob({ ...blob, ciphertext: 'pas du base64 !' }), false);
  assert.equal(isProtectedKeyBlob(null), false);
});
