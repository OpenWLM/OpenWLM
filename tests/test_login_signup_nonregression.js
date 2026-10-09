import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import Database from 'better-sqlite3';

/**
 * E2 — Non-régression : inscription et connexion toujours fonctionnelles,
 * malgré l'ajout du rate limiting par compte.
 *
 * Ce test nécessite le serveur démarré sur http://localhost:3001.
 * Il est ignoré (skip) automatiquement si le serveur est absent.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');

const httpRequest = (apiPath, method, body, headers = {}) => {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : '';
    const req = http.request({
      hostname: 'localhost',
      port: 3001,
      path: apiPath,
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) } : {}),
        ...headers
      }
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode, data: parsed, setCookie: res.headers['set-cookie'] });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    if (postData) req.write(postData);
    req.end();
  });
};

const probeServer = async () => {
  try {
    const res = await httpRequest('/api/push/status', 'GET');
    return res.status === 200;
  } catch {
    return false;
  }
};

const serverUp = await probeServer();

test(
  'signup puis login restent fonctionnels (rate limiting par compte inclus)',
  { skip: serverUp ? false : 'Serveur non démarré sur http://localhost:3001' },
  async () => {
    const username = 'nr_' + crypto.randomBytes(6).toString('hex');
    const authKeyHex = crypto.randomBytes(32).toString('hex');
    const wrongKeyHex = crypto.randomBytes(32).toString('hex');

    const captchaRes = await httpRequest('/api/captcha', 'GET');
    assert.equal(captchaRes.status, 200, 'GET /api/captcha doit répondre 200');
    const captcha = captchaRes.data;
    assert.ok(captcha && captcha.id, 'captcha.id présent');

    const signupRes = await httpRequest('/api/signup', 'POST', {
      username,
      password: authKeyHex,
      nickname: 'NonRegression',
      captchaId: captcha.id,
      captchaAnswer: captcha.num1 + captcha.num2
    });
    assert.equal(signupRes.status, 200, 'POST /api/signup doit répondre 200');
    assert.equal(signupRes.data.success, true);

    const loginRes = await httpRequest('/api/login', 'POST', { username, password: authKeyHex });
    assert.equal(loginRes.status, 200, 'POST /api/login (valide) doit répondre 200');
    assert.equal(loginRes.data.success, true);
    assert.equal(loginRes.data.token, undefined, 'M2 : le token ne doit plus être renvoyé dans le corps');
    assert.ok(
      Array.isArray(loginRes.setCookie) && loginRes.setCookie.some((c) => c.startsWith('token=')),
      'login définit le cookie de session HttpOnly'
    );

    const badLoginRes = await httpRequest('/api/login', 'POST', { username, password: wrongKeyHex });
    assert.equal(badLoginRes.status, 401, 'POST /api/login (mauvais mot de passe) doit répondre 401');

    // Nettoyage
    try {
      const db = new Database(path.join(PROJECT_ROOT, 'messenger.db'));
      db.prepare('DELETE FROM users WHERE username = ?').run(username);
      db.close();
    } catch (err) {
      console.warn('[non-regression] Nettoyage impossible:', err.message);
    }
  }
);
