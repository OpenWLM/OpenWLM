// Garde-fou des tests « live » chargé ici aussi, pas seulement par `npm test` (--import) :
// lancé à la main, ce fichier s'arrête si le serveur sur :3001 n'est pas le serveur de test
// de ce checkout (la prod, par exemple)
import '../scripts/live_server_guard.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import {
  verifyPow,
  leadingZeroBits,
  getPowDifficulty,
  createSuccessCounter,
  getSignupIpDailyLimit
} from '../server/utils/signupGuard.js';
import { solvePow } from './helpers/pow.js';

/**
 * Anti-inscription de masse : preuve de travail liée au captcha + plafond par IP.
 * Les tests unitaires tournent toujours ; les tests HTTP nécessitent le serveur
 * sur http://localhost:3001 (skip sinon).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------- unitaires

test('leadingZeroBits compte correctement les bits à zéro', () => {
  assert.equal(leadingZeroBits(Buffer.from([0xff])), 0);
  assert.equal(leadingZeroBits(Buffer.from([0x01])), 7);
  assert.equal(leadingZeroBits(Buffer.from([0x00, 0x80])), 8);
  assert.equal(leadingZeroBits(Buffer.from([0x00, 0x00, 0x10])), 19);
});

test('verifyPow : solution valide acceptée, invalide/malformée rejetée', () => {
  const challenge = { salt: crypto.randomBytes(16).toString('hex'), difficulty: 12 };
  const nonce = solvePow(challenge);
  assert.equal(verifyPow(challenge, nonce), true);
  assert.equal(verifyPow(challenge, Number(nonce)), true, 'nonce numérique accepté');

  // Un nonce quelconque n'a qu'environ 1 chance sur 4096 d'être valide : on en cherche un faux.
  let bad = 0;
  while (verifyPow(challenge, String(bad))) bad++;
  assert.equal(verifyPow(challenge, String(bad)), false);

  for (const malformed of [undefined, null, '', 'abc', '-1', '1e5', '1'.repeat(17), {}, []]) {
    assert.equal(verifyPow(challenge, malformed), false, `nonce malformé rejeté: ${JSON.stringify(malformed)}`);
  }
  assert.equal(verifyPow(null, nonce), false, 'défi absent rejeté');
});

test('getPowDifficulty : défaut 17, bornes 0..24, valeurs invalides → défaut', () => {
  assert.equal(getPowDifficulty(undefined), 17);
  assert.equal(getPowDifficulty(''), 17);
  assert.equal(getPowDifficulty('abc'), 17);
  assert.equal(getPowDifficulty('10'), 10);
  assert.equal(getPowDifficulty('99'), 24);
  assert.equal(getPowDifficulty('-3'), 0);
});

test('createSuccessCounter : plafond par clé sur fenêtre glissante', () => {
  let t = 0;
  const counter = createSuccessCounter({ windowMs: 1000, limit: 2, now: () => t });
  assert.equal(counter.check('1.2.3.4').allowed, true);
  counter.record('1.2.3.4');
  counter.record('1.2.3.4');
  assert.equal(counter.check('1.2.3.4').allowed, false, 'plafond atteint');
  assert.equal(counter.check('5.6.7.8').allowed, true, 'autre IP non affectée');
  assert.equal(counter.check(null).allowed, false, 'IP inconnue refusée');
  t = 1001;
  assert.equal(counter.check('1.2.3.4').allowed, true, 'fenêtre expirée');
  counter.cleanup();
});

test('getSignupIpDailyLimit : défaut 10, entier positif sinon', () => {
  assert.equal(getSignupIpDailyLimit(undefined), 10);
  assert.equal(getSignupIpDailyLimit('0'), 10);
  assert.equal(getSignupIpDailyLimit('25'), 25);
});

// ---------------------------------------------------------------- HTTP

const httpJson = (apiPath, method, body) => new Promise((resolve) => {
  const data = body ? JSON.stringify(body) : null;
  const req = http.request({
    hostname: 'localhost', port: 3001, path: apiPath, method,
    headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
  }, (res) => {
    let raw = '';
    res.on('data', (c) => { raw += c; });
    res.on('end', () => { let d; try { d = JSON.parse(raw); } catch { d = raw; } resolve({ status: res.statusCode, data: d }); });
  });
  req.on('error', () => resolve({ status: 0 }));
  if (data) req.write(data);
  req.end();
});

const serverUp = (await httpJson('/api/push/status', 'GET')).status === 200;

test('signup : PoW absente ou fausse → 400 ; PoW valide → 200', { skip: serverUp ? false : 'Serveur non démarré' }, async (t) => {
  const db = new Database(path.join(PROJECT_ROOT, 'messenger.db'));
  const prefix = 'powtest_' + crypto.randomBytes(3).toString('hex');
  try {
    const signup = async (powNonceFor) => {
      const cap = await httpJson('/api/captcha', 'GET');
      assert.equal(cap.status, 200);
      assert.ok(cap.data.pow && typeof cap.data.pow.salt === 'string', 'défi PoW fourni avec le captcha');
      return httpJson('/api/signup', 'POST', {
        username: `${prefix}_${crypto.randomBytes(3).toString('hex')}`,
        password: crypto.randomBytes(32).toString('hex'),
        captchaId: cap.data.id,
        captchaAnswer: cap.data.num1 + cap.data.num2,
        powNonce: powNonceFor(cap.data.pow)
      });
    };

    const missing = await signup(() => undefined);
    if (missing.status === 429) {
      t.skip('Plafond d\'inscriptions par IP atteint sur ce serveur (SIGNUP_IP_DAILY_LIMIT)');
      return;
    }
    // Avec POW_DIFFICULTY=0 la PoW est désactivée : on ne teste alors que le cas valide.
    const difficulty = (await httpJson('/api/captcha', 'GET')).data.pow.difficulty;
    if (difficulty > 0) {
      assert.equal(missing.status, 400, 'PoW absente refusée');
      const wrong = await signup((pow) => {
        let n = 0;
        while (verifyPow(pow, String(n))) n++;
        return String(n);
      });
      assert.equal(wrong.status, 400, 'PoW fausse refusée');
    }
    const ok = await signup((pow) => solvePow(pow));
    assert.equal(ok.status, 200, 'PoW valide acceptée');
  } finally {
    try { db.prepare('DELETE FROM users WHERE username LIKE ?').run(`${prefix}_%`); } catch { /* ignore */ }
    db.close();
  }
});
