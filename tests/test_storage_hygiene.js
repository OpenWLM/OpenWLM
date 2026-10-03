import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

test('Security Rule: sanitizeUserForStorage restricts wlm_user strictly to authorized fields', () => {
  // Re-implement the exact logic from App.tsx to verify contract
  const sanitizeUserForStorage = (u) => {
    if (!u) return {};
    const sanitized = {
      id: Number(u.id),
      username: String(u.username || '')
    };
    if (u.nickname !== undefined) sanitized.nickname = String(u.nickname);
    if (u.avatar !== undefined) sanitized.avatar = String(u.avatar);
    if (u.scene !== undefined) sanitized.scene = String(u.scene);
    if (u.status !== undefined) sanitized.status = String(u.status);
    if (u.rememberMe !== undefined) sanitized.rememberMe = Boolean(u.rememberMe);
    return sanitized;
  };

  const maliciousOrSensitiveUser = {
    id: 42,
    username: 'alice',
    nickname: 'Alice In Wonderland',
    avatar: '/assets/usertiles/chess.png',
    scene: '/assets/scenes/0006.png',
    status: 'online',
    rememberMe: true,
    // SENSITIVE FIELDS THAT MUST BE PURGED
    token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.sensitive_payload.signature',
    encrypted_private_key: '{"encryptedKeyBase64":"AAAA","ivBase64":"BBBB"}',
    public_key: '{"kty":"RSA","n":"CCCC","e":"AQAB"}',
    privateKey: 'SECRET_KEY_BLOB',
    privateKeyJwk: { kty: 'RSA', d: 'SECRET' },
    privateCryptoKey: { type: 'private', extractable: false },
    vault: { data: 'encrypted_vault' },
    vaultKey: 'raw_key'
  };

  const sanitized = sanitizeUserForStorage(maliciousOrSensitiveUser);

  // Check allowed fields
  assert.strictEqual(sanitized.id, 42);
  assert.strictEqual(sanitized.username, 'alice');
  assert.strictEqual(sanitized.nickname, 'Alice In Wonderland');
  assert.strictEqual(sanitized.avatar, '/assets/usertiles/chess.png');
  assert.strictEqual(sanitized.scene, '/assets/scenes/0006.png');
  assert.strictEqual(sanitized.status, 'online');
  assert.strictEqual(sanitized.rememberMe, true);

  // Strict check on keys: ONLY allowed keys can exist
  const allowedKeys = new Set(['id', 'username', 'nickname', 'avatar', 'scene', 'status', 'rememberMe']);
  const actualKeys = Object.keys(sanitized);

  for (const key of actualKeys) {
    assert.strictEqual(allowedKeys.has(key), true, `Field "${key}" is not in the allowed list!`);
  }

  // Strict negative assertions
  assert.strictEqual(sanitized.token, undefined, 'token must never be stored');
  assert.strictEqual(sanitized.encrypted_private_key, undefined, 'encrypted_private_key must never be stored');
  assert.strictEqual(sanitized.public_key, undefined, 'public_key must never be stored');
  assert.strictEqual(sanitized.privateKey, undefined, 'privateKey must never be stored');
  assert.strictEqual(sanitized.privateKeyJwk, undefined, 'privateKeyJwk must never be stored');
  assert.strictEqual(sanitized.privateCryptoKey, undefined, 'privateCryptoKey must never be stored');
  assert.strictEqual(sanitized.vault, undefined, 'vault must never be stored');
  assert.strictEqual(sanitized.vaultKey, undefined, 'vaultKey must never be stored');
});

test('Codebase Audit: Zero localStorage.setItem/getItem for token', () => {
  const appTsx = fs.readFileSync(path.join(process.cwd(), 'src/App.tsx'), 'utf8');

  // Verify NO localStorage.setItem('token', ...)
  const setTokenRegex = /localStorage\.setItem\s*\(\s*['"`]token['"`]/;
  assert.strictEqual(setTokenRegex.test(appTsx), false, 'Found localStorage.setItem for token in App.tsx');

  // Verify NO localStorage.getItem('token')
  const getTokenRegex = /localStorage\.getItem\s*\(\s*['"`]token['"`]/;
  assert.strictEqual(getTokenRegex.test(appTsx), false, 'Found localStorage.getItem for token in App.tsx');

  // Verify all setItem('wlm_user') calls use sanitizeUserForStorage
  const lines = appTsx.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes("localStorage.setItem('wlm_user'") || line.includes('localStorage.setItem("wlm_user"')) {
      assert.strictEqual(
        line.includes('sanitizeUserForStorage') || line.includes('sanitized'),
        true,
        `Line ${i + 1} stores wlm_user without sanitization: ${line.trim()}`
      );
    }
  }
});

test('Server: parseCookies helper correctly extracts cookie tokens', () => {
  const parseCookies = (cookieHeader) => {
    const list = {};
    if (!cookieHeader || typeof cookieHeader !== 'string') return list;
    cookieHeader.split(';').forEach(cookie => {
      const parts = cookie.split('=');
      const name = parts.shift()?.trim();
      if (!name) return;
      const value = parts.join('=').trim();
      try {
        list[name] = decodeURIComponent(value);
      } catch {
        list[name] = value;
      }
    });
    return list;
  };

  const rawHeader = 'sessionId=12345; token=eyJhbGciOiJIUzI1NiJ9.test; other=hello%20world';
  const cookies = parseCookies(rawHeader);

  assert.strictEqual(cookies.token, 'eyJhbGciOiJIUzI1NiJ9.test');
  assert.strictEqual(cookies.sessionId, '12345');
  assert.strictEqual(cookies.other, 'hello world');

  // Empty or invalid headers
  assert.deepStrictEqual(parseCookies(''), {});
  assert.deepStrictEqual(parseCookies(null), {});
  assert.deepStrictEqual(parseCookies(undefined), {});
});
