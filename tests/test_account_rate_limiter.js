import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAccountRateLimiter } from '../server/accountRateLimiter.js';

/**
 * E2 — Non-régression : rate limiting par compte.
 * Vérifie la fenêtre glissante, le blocage au-delà de la limite,
 * l'indépendance des clés et la réinitialisation sur succès.
 */

test('autorise jusqu\'à la limite puis bloque', () => {
  let t = 1000;
  const limiter = createAccountRateLimiter({ windowMs: 1000, limit: 3, now: () => t });

  assert.equal(limiter.attempt('alice').allowed, true);
  assert.equal(limiter.attempt('alice').allowed, true);
  assert.equal(limiter.attempt('alice').allowed, true);

  const blocked = limiter.attempt('alice');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 1000);
});

test('les clés sont indépendantes et insensibles à la casse/espaces', () => {
  let t = 0;
  const limiter = createAccountRateLimiter({ windowMs: 1000, limit: 1, now: () => t });
  assert.equal(limiter.attempt('alice').allowed, true);
  assert.equal(limiter.attempt('bob').allowed, true);
  // Normalisation : " Alice " == "alice" -> déjà consommé
  assert.equal(limiter.attempt(' Alice ').allowed, false);
});

test('la fenêtre glissante libère le quota après expiration', () => {
  let t = 0;
  const limiter = createAccountRateLimiter({ windowMs: 1000, limit: 1, now: () => t });
  assert.equal(limiter.attempt('alice').allowed, true);
  assert.equal(limiter.attempt('alice').allowed, false);
  t = 1000; // fenêtre écoulée
  assert.equal(limiter.attempt('alice').allowed, true);
});

test('reset rétablit le quota', () => {
  let t = 0;
  const limiter = createAccountRateLimiter({ windowMs: 60000, limit: 1, now: () => t });
  assert.equal(limiter.attempt('alice').allowed, true);
  assert.equal(limiter.attempt('alice').allowed, false);
  limiter.reset('alice');
  assert.equal(limiter.attempt('alice').allowed, true);
});

test('clé vide -> jamais bloquée (pas de verrouillage global)', () => {
  const limiter = createAccountRateLimiter({ windowMs: 1000, limit: 1 });
  assert.equal(limiter.attempt(undefined).allowed, true);
  assert.equal(limiter.attempt('').allowed, true);
  assert.equal(limiter.attempt(null).allowed, true);
});

test('cleanup purge les entrées inactives', () => {
  let t = 0;
  const limiter = createAccountRateLimiter({ windowMs: 1000, limit: 5, now: () => t });
  limiter.attempt('alice');
  assert.equal(limiter._storage.size, 1);
  t = 5000;
  limiter.cleanup();
  assert.equal(limiter._storage.size, 0);
});
