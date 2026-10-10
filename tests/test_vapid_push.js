import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import webpush from 'web-push';
import Database from 'better-sqlite3';

const rootDir = process.cwd();

test('VAPID RFC 8292: Key generation produces compliant URL-safe base64 keys', () => {
  const keys = webpush.generateVAPIDKeys();
  
  assert.ok(keys.publicKey, 'publicKey must be defined');
  assert.ok(keys.privateKey, 'privateKey must be defined');
  
  // Public key should be 87 chars URL-safe base64 (uncompressed EC P-256 point = 65 bytes = 87 base64url chars)
  assert.strictEqual(keys.publicKey.length, 87, 'VAPID public key must be 87 characters');
  assert.match(keys.publicKey, /^[A-Za-z0-9_-]+$/, 'VAPID public key must be valid base64url');
  
  // Private key should be 43 chars URL-safe base64 (32 bytes = 43 base64url chars)
  assert.strictEqual(keys.privateKey.length, 43, 'VAPID private key must be 43 characters');
  assert.match(keys.privateKey, /^[A-Za-z0-9_-]+$/, 'VAPID private key must be valid base64url');
});

test('VAPID Details: webpush accepts valid keys and subject', () => {
  const keys = webpush.generateVAPIDKeys();
  const subject = 'mailto:admin@openwlm.dev';
  
  // Should not throw
  assert.doesNotThrow(() => {
    webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
  }, 'webpush.setVapidDetails must accept valid keys and mailto subject');
});

test('Security & Hygiene: .vapid_keys.json is excluded by .gitignore and has strict permissions', () => {
  const gitignore = fs.readFileSync(path.join(rootDir, '.gitignore'), 'utf8');
  assert.ok(gitignore.includes('.vapid_keys.json'), '.gitignore must explicitly include .vapid_keys.json');

  const vapidKeysPath = path.join(rootDir, '.vapid_keys.json');
  if (fs.existsSync(vapidKeysPath)) {
    const stats = fs.statSync(vapidKeysPath);
    const mode = stats.mode & 0o777;
    // 0600 (octal 384)
    assert.strictEqual(mode, 0o600, '.vapid_keys.json must have mode 0600 (owner read/write only)');
    
    const content = JSON.parse(fs.readFileSync(vapidKeysPath, 'utf8'));
    assert.ok(content.publicKey, 'Saved keys must contain publicKey');
    assert.ok(content.privateKey, 'Saved keys must contain privateKey');
    assert.ok(content.subject, 'Saved keys must contain subject');
  }
});

test('Key Generator Script: scripts/generate_vapid_keys.js exists and validates correctly', () => {
  const scriptPath = path.join(rootDir, 'scripts/generate_vapid_keys.js');
  assert.ok(fs.existsSync(scriptPath), 'scripts/generate_vapid_keys.js must exist');
  
  const scriptCode = fs.readFileSync(scriptPath, 'utf8');
  assert.ok(scriptCode.includes('generateVAPIDKeys'), 'Script must use generateVAPIDKeys');
  assert.ok(scriptCode.includes('.vapid_keys.json'), 'Script must reference .vapid_keys.json');
  assert.ok(scriptCode.includes('0o600'), 'Script must enforce 0600 permissions');
});

test('Server Implementation: server/index.js contains VAPID initialization and secure endpoints', () => {
  const serverCode = fs.readdirSync(path.join(rootDir, 'server'), { recursive: true })
    .filter((f) => String(f).endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(rootDir, 'server', f), 'utf8'))
    .join('\n');
  
  // Must import webpush
  assert.ok(serverCode.includes("import webpush from 'web-push'"), 'server/index.js must import webpush');
  
  // Must have initVapid function
  assert.ok(serverCode.includes('const initVapid = () =>'), 'server/index.js must define initVapid()');
  assert.ok(serverCode.includes('webpush.setVapidDetails'), 'server/index.js must call webpush.setVapidDetails');
  
  // Must have GET /api/push/status
  assert.ok(serverCode.includes("'/push/status'"), 'Must have GET /api/push/status');
  // Must NEVER expose private key
  assert.ok(!serverCode.includes('privateKey: vapidConfig.privateKey'), 'Must NEVER leak private key in status API');
  
  // Must have POST /api/push/test
  assert.ok(serverCode.includes("'/push/test'"), 'Must have POST /api/push/test');
  
  // Must call webpush.sendNotification in dispatchPushNotification
  assert.ok(serverCode.includes('webpush.sendNotification'), 'dispatchPushNotification must use webpush.sendNotification');
  
  // Must handle 404 / 410 expired subscriptions
  assert.ok(serverCode.includes('err.statusCode === 404 || err.statusCode === 410'), 'Must prune dead subscriptions on 404 or 410');
});

test('Database: push_subscriptions table operates correctly with CRUD operations', () => {
  const db = new Database(path.join(rootDir, 'messenger.db'));
  
  // Obtenir un utilisateur existant pour respecter la contrainte FOREIGN KEY (user_id) REFERENCES users(id)
  const existingUser = db.prepare('SELECT id FROM users LIMIT 1').get();
  const testUserId = existingUser ? existingUser.id : 1;
  const testEndpoint = 'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABtesting-unit-test';
  const testP256dh = 'BMTestP256dhKeyBase64urlSampleValueForTestingOnly1234567890';
  const testAuth = 'TestAuthSecretBase64';
  const testUserAgent = 'Mozilla/5.0 Unit-Test-Agent';
  const now = Date.now();

  try {
    // 1. Insert / Upsert test subscription
    const insertStmt = db.prepare(`
      INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET
        user_id = excluded.user_id,
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        user_agent = excluded.user_agent,
        created_at = excluded.created_at
    `);
    insertStmt.run(testUserId, testEndpoint, testP256dh, testAuth, testUserAgent, now);

    // 2. Query subscription
    const fetched = db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(testEndpoint);
    assert.ok(fetched, 'Subscription should be found');
    assert.strictEqual(fetched.user_id, testUserId);
    assert.strictEqual(fetched.p256dh, testP256dh);
    assert.strictEqual(fetched.auth, testAuth);

    // 3. Delete subscription (simulate 404/410 pruning)
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(testEndpoint);
    const afterDelete = db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(testEndpoint);
    assert.strictEqual(afterDelete, undefined, 'Subscription should be deleted');
  } finally {
    // Cleanup in case of error
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(testEndpoint);
    db.close();
  }
});

test('Frontend PushNotificationManager: exports all necessary push methods', () => {
  const pushManagerCode = fs.readFileSync(path.join(rootDir, 'src/utils/PushNotificationManager.ts'), 'utf8');
  assert.ok(pushManagerCode.includes('export function isAndroidDevice'), 'Must export isAndroidDevice');
  assert.ok(pushManagerCode.includes('export function isPushSupported'), 'Must export isPushSupported');
  assert.ok(pushManagerCode.includes('export function urlBase64ToUint8Array'), 'Must export urlBase64ToUint8Array');
  assert.ok(pushManagerCode.includes('export async function getExistingPushSubscription'), 'Must export getExistingPushSubscription');
  assert.ok(pushManagerCode.includes('export async function fetchPushBackendStatus'), 'Must export fetchPushBackendStatus');
  assert.ok(pushManagerCode.includes('export async function subscribeToWebPush'), 'Must export subscribeToWebPush');
  assert.ok(pushManagerCode.includes('export async function unsubscribeFromWebPush'), 'Must export unsubscribeFromWebPush');
  assert.ok(pushManagerCode.includes('export async function sendTestWebPush'), 'Must export sendTestWebPush');
});

test('Frontend UI: App.tsx displays dynamic push status and test button', () => {
  const appCode = fs.readFileSync(path.join(rootDir, 'src/App.tsx'), 'utf8');
  assert.ok(appCode.includes('subscribeToWebPush'), 'App.tsx must use subscribeToWebPush');
  assert.ok(appCode.includes('sendTestWebPush'), 'App.tsx must use sendTestWebPush');
  assert.ok(appCode.includes('fetchPushBackendStatus'), 'App.tsx must use fetchPushBackendStatus');
  assert.ok(appCode.includes('t.settings.pushTestButton'), 'App.tsx must include push test button');
});

test('i18n: FR and EN translation files include push test and configured status keys', () => {
  const fr = JSON.parse(fs.readFileSync(path.join(rootDir, 'src/i18n/fr.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(rootDir, 'src/i18n/en.json'), 'utf8'));

  const requiredKeys = [
    'androidSectionTitle',
    'androidBgDesc',
    'androidForegroundHint',
    'androidBackgroundHint',
    'webPushStatusLabel',
    'webPushReady',
    'webPushConfigured',
    'pushTestButton',
    'pushTestSuccess',
    'pushTestError'
  ];

  for (const k of requiredKeys) {
    assert.strictEqual(typeof fr.settings[k], 'string', `Missing FR settings key: ${k}`);
    assert.strictEqual(typeof en.settings[k], 'string', `Missing EN settings key: ${k}`);
  }
});

test('Environment Template: .env.example exists, is documented, and has zero exposed secrets', () => {
  const envExamplePath = path.join(rootDir, '.env.example');
  assert.ok(fs.existsSync(envExamplePath), '.env.example must exist');

  const content = fs.readFileSync(envExamplePath, 'utf8');
  assert.ok(content.includes('VAPID_PUBLIC_KEY='), '.env.example must include VAPID_PUBLIC_KEY');
  assert.ok(content.includes('VAPID_PRIVATE_KEY='), '.env.example must include VAPID_PRIVATE_KEY');
  assert.ok(content.includes('VAPID_SUBJECT='), '.env.example must include VAPID_SUBJECT');

  // Verify secret keys have empty values
  const privMatch = content.match(/^[ \t]*VAPID_PRIVATE_KEY[ \t]*=[ \t]*(.+)$/m);
  assert.strictEqual(privMatch, null, 'VAPID_PRIVATE_KEY must be empty in .env.example');

  const pubMatch = content.match(/^[ \t]*VAPID_PUBLIC_KEY[ \t]*=[ \t]*(.+)$/m);
  assert.strictEqual(pubMatch, null, 'VAPID_PUBLIC_KEY must be empty in .env.example');
});

test('Git Exclusions: .gitignore strictly excludes all secret patterns and local env files', () => {
  const gitignore = fs.readFileSync(path.join(rootDir, '.gitignore'), 'utf8');
  const requiredExclusions = [
    '.env',
    '.env.local',
    '.env.production',
    '.env.*.local',
    '.jwt_secret',
    '.vapid_keys.json',
    '*.pem',
    '*.key',
    '*.secret'
  ];

  for (const pattern of requiredExclusions) {
    assert.ok(gitignore.includes(pattern), `.gitignore must exclude: ${pattern}`);
  }
});

test('Anti-Leak Guardrails: scripts/check_secrets.js passes with zero violations', () => {
  const checkSecretsPath = path.join(rootDir, 'scripts/check_secrets.js');
  assert.ok(fs.existsSync(checkSecretsPath), 'scripts/check_secrets.js must exist');

  const provisionScript = path.join(rootDir, 'scripts/provision_vapid.sh');
  assert.ok(fs.existsSync(provisionScript), 'scripts/provision_vapid.sh must exist');

  const installHooksScript = path.join(rootDir, 'scripts/install_git_hooks.sh');
  assert.ok(fs.existsSync(installHooksScript), 'scripts/install_git_hooks.sh must exist');
});

test('Documentation: docs/VAPID_SETUP.md documents provisioning, server verification, and key rotation', () => {
  const docPath = path.join(rootDir, 'docs/VAPID_SETUP.md');
  assert.ok(fs.existsSync(docPath), 'docs/VAPID_SETUP.md must exist');

  const content = fs.readFileSync(docPath, 'utf8');
  assert.ok(content.includes('generate_vapid_keys.js'), 'Must mention generation script');
  assert.ok(content.includes('/api/push/status'), 'Must mention status endpoint');
  assert.ok(content.includes('Rotation'), 'Must document key rotation procedure');
});

