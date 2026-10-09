import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveMessageSide, isMessageFromSelf } from '../src/utils/MessageIdentity.ts';

/**
 * E1 — Non-régression : la propriété d'un message ("envoyé par moi") doit
 * dépendre UNIQUEMENT de sender_id / senderId comparé à user.id.
 * Aucun champ d'affichage (nickname, sender, sender_name, payload E2EE) ne doit
 * pouvoir influencer cette décision.
 */

const ME = 42;

test('message réellement envoyé par moi -> self', () => {
  assert.equal(resolveMessageSide({ sender_id: ME }, ME), 'self');
  assert.equal(resolveMessageSide({ senderId: ME }, ME), 'self');
  assert.equal(isMessageFromSelf({ sender_id: ME }, ME), true);
});

test("message d'un autre contact -> other", () => {
  assert.equal(resolveMessageSide({ sender_id: 7 }, ME), 'other');
  assert.equal(isMessageFromSelf({ senderId: 7 }, ME), false);
});

test('pseudo identique : un contact nommé comme moi reste "other"', () => {
  // Le contact choisit le même nickname que moi et un champ sender usurpé.
  const spoofed = {
    sender_id: 7,
    senderId: 7,
    sender: 'MonPseudo',
    sender_name: 'MonPseudo',
    nickname: 'MonPseudo'
  };
  assert.equal(resolveMessageSide(spoofed, ME), 'other');
  assert.equal(isMessageFromSelf(spoofed, ME), false);
});

test('sender_name / payload E2EE falsifié ne change pas la décision', () => {
  const payloadSpoof = {
    sender_id: 7,
    sender: 'Moi',
    sender_name: 'Moi',
    payloadSender: 'Moi',
    senderNickname: 'Moi'
  };
  assert.equal(resolveMessageSide(payloadSpoof, ME), 'other');
  assert.equal(isMessageFromSelf(payloadSpoof, ME), false);
});

test('sender_id absent -> état neutre "unknown" (on ne devine pas)', () => {
  assert.equal(resolveMessageSide({}, ME), 'unknown');
  assert.equal(resolveMessageSide({ sender: 'MonPseudo', sender_name: 'Moi' }, ME), 'unknown');
  assert.equal(resolveMessageSide(null, ME), 'unknown');
  assert.equal(resolveMessageSide(undefined, ME), 'unknown');
  // Jamais considéré comme "envoyé par moi" en cas d'identifiant manquant.
  assert.equal(isMessageFromSelf({ sender: 'MonPseudo' }, ME), false);
});

test('identifiants invalides -> unknown', () => {
  assert.equal(resolveMessageSide({ sender_id: 'abc' }, ME), 'unknown');
  assert.equal(resolveMessageSide({ sender_id: '' }, ME), 'unknown');
  assert.equal(resolveMessageSide({ sender_id: NaN }, ME), 'unknown');
  assert.equal(resolveMessageSide({ sender_id: null }, ME), 'unknown');
  // Utilisateur courant inconnu -> on ne peut pas trancher.
  assert.equal(resolveMessageSide({ sender_id: ME }, null), 'unknown');
  assert.equal(resolveMessageSide({ sender_id: ME }, undefined), 'unknown');
});

test('types différents : comparaison numérique string/number', () => {
  assert.equal(resolveMessageSide({ sender_id: '42' }, 42), 'self');
  assert.equal(resolveMessageSide({ sender_id: 42 }, '42'), 'self');
  assert.equal(resolveMessageSide({ senderId: '42' }, '42'), 'self');
  // senderId prioritaire sur sender_id si présent.
  assert.equal(resolveMessageSide({ senderId: '7', sender_id: '42' }, 42), 'other');
  // Un id numérique non-mien reste "other".
  assert.equal(resolveMessageSide({ sender_id: 43 }, 42), 'other');
});

test('bot système (-1) : ni self ni unknown', () => {
  assert.equal(resolveMessageSide({ senderId: -1 }, ME), 'other');
});
