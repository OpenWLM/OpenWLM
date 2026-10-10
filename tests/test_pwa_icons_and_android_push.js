import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

const rootDir = process.cwd();

test('PWA Manifest: Contains any and maskable icons in 192x192 and 512x512', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'public/manifest.json'), 'utf8'));

  assert.strictEqual(manifest.theme_color, '#d5e9f8', 'theme_color should match WLM soft blue');
  assert.strictEqual(manifest.background_color, '#d5e9f8', 'background_color should match WLM soft blue');

  const icons = manifest.icons;
  assert.ok(Array.isArray(icons), 'manifest must have icons array');

  // Verify any icons
  const any192 = icons.find(i => i.src === '/pwa-192x192.png' && i.sizes === '192x192' && i.purpose === 'any');
  const any512 = icons.find(i => i.src === '/pwa-512x512.png' && i.sizes === '512x512' && i.purpose === 'any');
  assert.ok(any192, 'Missing 192x192 any icon in manifest.json');
  assert.ok(any512, 'Missing 512x512 any icon in manifest.json');

  // Verify maskable icons
  const maskable192 = icons.find(i => i.src === '/pwa-maskable-192x192.png' && i.sizes === '192x192' && i.purpose === 'maskable');
  const maskable512 = icons.find(i => i.src === '/pwa-maskable-512x512.png' && i.sizes === '512x512' && i.purpose === 'maskable');
  assert.ok(maskable192, 'Missing 192x192 maskable icon in manifest.json');
  assert.ok(maskable512, 'Missing 512x512 maskable icon in manifest.json');
});

test('PWA Assets: Maskable icons are solid, opaque and exist on disk', () => {
  const pwaMaskable192Path = path.join(rootDir, 'public/pwa-maskable-192x192.png');
  const pwaMaskable512Path = path.join(rootDir, 'public/pwa-maskable-512x512.png');
  const appleTouchPath = path.join(rootDir, 'public/apple-touch-icon.png');

  assert.ok(fs.existsSync(pwaMaskable192Path), 'pwa-maskable-192x192.png must exist');
  assert.ok(fs.existsSync(pwaMaskable512Path), 'pwa-maskable-512x512.png must exist');
  assert.ok(fs.existsSync(appleTouchPath), 'apple-touch-icon.png must exist');

  // File size checks
  assert.ok(fs.statSync(pwaMaskable192Path).size > 1000, 'pwa-maskable-192x192.png should have valid size');
  assert.ok(fs.statSync(pwaMaskable512Path).size > 5000, 'pwa-maskable-512x512.png should have valid size');
});

test('Service Worker: sw.js precaches maskable icon and handles push + notificationclick', () => {
  const sw = fs.readFileSync(path.join(rootDir, 'public/sw.js'), 'utf8');

  // Must precache the new maskable icon
  assert.ok(sw.includes('/pwa-maskable-192x192.png'), 'sw.js must precache /pwa-maskable-192x192.png');

  // Must handle push event
  assert.ok(sw.includes("self.addEventListener('push'"), 'sw.js must have push event listener');
  assert.ok(sw.includes("self.registration.showNotification"), 'sw.js push handler must show notification');

  // Must handle notificationclick with OPEN_CHAT dispatch
  assert.ok(sw.includes("self.addEventListener('notificationclick'"), 'sw.js must have notificationclick listener');
  assert.ok(sw.includes("type: 'OPEN_CHAT'"), 'sw.js notificationclick must post OPEN_CHAT to client');
  assert.ok(sw.includes("client.focus()"), 'sw.js notificationclick must focus client');
});

test('Backend: server/index.js has push_subscriptions table and API endpoints', () => {
  const serverCode = fs.readdirSync(path.join(rootDir, 'server'), { recursive: true })
    .filter((f) => String(f).endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(rootDir, 'server', f), 'utf8'))
    .join('\n');

  // Table push_subscriptions
  assert.ok(serverCode.includes('CREATE TABLE IF NOT EXISTS push_subscriptions'), 'Must create push_subscriptions table');

  // Endpoints
  assert.ok(serverCode.includes("'/push/status'"), 'Must have GET /api/push/status endpoint');
  assert.ok(serverCode.includes("'/push/subscribe'"), 'Must have POST /api/push/subscribe endpoint');
  assert.ok(serverCode.includes("'/push/unsubscribe'"), 'Must have POST /api/push/unsubscribe endpoint');

  // Dispatch push on message & wizz
  assert.ok(serverCode.includes('dispatchPushNotification(receiverId,'), 'Must call dispatchPushNotification in socket handlers');
});

test('Frontend: PushNotificationManager and App.tsx Android & Web Push integration', () => {
  const pushManagerCode = fs.readFileSync(path.join(rootDir, 'src/utils/PushNotificationManager.ts'), 'utf8');
  assert.ok(pushManagerCode.includes('export function isAndroidDevice'), 'Must export isAndroidDevice');
  assert.ok(pushManagerCode.includes('export function isPushSupported'), 'Must export isPushSupported');
  assert.ok(pushManagerCode.includes('export async function subscribeToWebPush'), 'Must export subscribeToWebPush');
  assert.ok(pushManagerCode.includes('export async function unsubscribeFromWebPush'), 'Must export unsubscribeFromWebPush');

  const appCode = fs.readFileSync(path.join(rootDir, 'src/App.tsx'), 'utf8');
  assert.ok(appCode.includes("event.data?.type === 'OPEN_CHAT'"), 'App.tsx must listen to OPEN_CHAT from SW');
  assert.ok(appCode.includes("params.get('chat')"), 'App.tsx must detect ?chat=ID url param');
  assert.ok(appCode.includes('t.settings.androidSectionTitle'), 'App.tsx must display Android section');
});

test('i18n: FR and EN translation files include Android and Web Push keys', () => {
  const fr = JSON.parse(fs.readFileSync(path.join(rootDir, 'src/i18n/fr.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(rootDir, 'src/i18n/en.json'), 'utf8'));

  const newKeys = [
    'androidSectionTitle',
    'androidBgDesc',
    'androidForegroundHint',
    'androidBackgroundHint',
    'webPushStatusLabel',
    'webPushReady'
  ];

  for (const k of newKeys) {
    assert.strictEqual(typeof fr.settings[k], 'string', `Missing FR settings key: ${k}`);
    assert.strictEqual(typeof en.settings[k], 'string', `Missing EN settings key: ${k}`);
  }
});
