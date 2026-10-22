import { test, expect, type Browser, type Page } from './test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * E2E — app Android simulée : enregistrement d'un fichier reçu par morceaux.
 * Le pont natif de Capacitor est remplacé par une fausse implémentation du plugin
 * OpenWLMNative (window.CapacitorCustomPlatform + PluginHeaders) : le vrai code de l'app
 * (@capacitor/core, src/utils/platform.ts) découpe le fichier déchiffré, la fausse
 * implémentation garde les morceaux, recollés ici et comparés à l'original.
 * Serveur + base temporaires (jamais la prod).
 */

const PASSWORD = 'MotDePasseE2E-1234';
const UPLOADS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'uploads');
// Taille des morceaux de src/utils/platform.ts (SAVE_CHUNK_BYTES)
const CHUNK = 3 * 512 * 1024;

const fakeClientIp = () => `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;

/**
 * Faux plugin natif, injecté avant le chargement de l'app. `legacy` : APK v3 (méthode saveFile,
 * pas d'enregistrement par morceaux), pour vérifier que l'interface s'adapte à l'APK installé.
 */
const fakeAndroidBridge = ({ legacy, refuse }: { legacy: boolean; refuse?: boolean }) => {
  type Saved = { id: string; fileName: string; mimeType: string; size: number; chunks: string[]; finished: boolean; aborted: boolean; legacy?: boolean };
  const w = window as unknown as Record<string, unknown> & { __saves: Saved[] };
  w.__saves = [];
  const promise = (name: string) => ({ name, rtype: 'promise' });
  const impl: Record<string, (o: Record<string, unknown>) => unknown> = {
    getInfo: () => ({ server: location.host, defaultServer: location.host, versionName: 'e2e', versionCode: 0, appLock: true, push: false }),
    getFcmToken: () => ({ token: null }),
    getNotificationPermission: () => ({ state: 'granted' }),
    getCallPermissions: () => ({ notifications: 'granted', fullScreen: 'granted', microphone: 'granted', camera: 'granted' }),
    beginSave: (o) => {
      // APK v6 : l'utilisateur refuse la fenêtre de confirmation native
      if (refuse) return { cancelled: true };
      const s: Saved = { id: `save-${w.__saves.length + 1}`, fileName: String(o.fileName), mimeType: String(o.mimeType), size: Number(o.size), chunks: [], finished: false, aborted: false };
      w.__saves.push(s);
      return { id: s.id, maxChunkBytes: 4 * 1024 * 1024 };
    },
    appendChunk: (o) => { w.__saves.find((s) => s.id === o.id)!.chunks.push(String(o.data)); },
    finishSave: (o) => { w.__saves.find((s) => s.id === o.id)!.finished = true; return { saved: true, location: 'downloads' }; },
    abortSave: (o) => { const s = w.__saves.find((x) => x.id === o.id); if (s) s.aborted = true; },
    saveFile: (o) => {
      w.__saves.push({ id: 'legacy', fileName: String(o.fileName), mimeType: String(o.mimeType), size: -1, chunks: [String(o.data)], finished: true, aborted: false, legacy: true });
      return { saved: true, location: 'downloads' };
    }
  };
  const chunked = ['beginSave', 'appendChunk', 'finishSave', 'abortSave', 'isAppLocked', 'resetPushToken'];
  w.CapacitorCustomPlatform = { name: 'android', plugins: {} };
  let nextCallback = 1;
  w.Capacitor = {
    PluginHeaders: [{
      name: 'OpenWLMNative',
      methods: [
        ...['getInfo', 'getFcmToken', 'getNotificationPermission', 'requestNotificationPermission', 'getCallPermissions', 'requestCallPermission',
          'setLanguage', 'dismissIncomingCall', 'startOngoingCall', 'updateOngoingCall', 'stopOngoingCall', 'setKeepScreenOn',
          'changeServer', 'openNotificationSettings', 'removeListener',
          ...(legacy ? ['saveFile'] : [...chunked, 'saveFile'])].map(promise),
        { name: 'addListener', rtype: 'callback' }
      ]
    }],
    nativePromise: async (_plugin: string, method: string, options: Record<string, unknown>) => (impl[method] ? impl[method](options || {}) : {}),
    nativeCallback: () => String(nextCallback++)
  };
};

const registerAndLogin = async (page: Page, username: string) => {
  await page.goto('/');
  await expect(page.locator('.wlm-auth-form')).toBeVisible();
  if ((await page.locator('.auth-captcha-container').count()) === 0) await page.locator('.auth-toggle').click();
  const textInputs = page.locator('.auth-field input[type="text"]');
  await textInputs.nth(0).fill(username);
  await page.locator('.auth-field input[type="password"]').fill(PASSWORD);
  await textInputs.nth(1).fill(username);
  const question = await page.locator('.auth-captcha-text').innerText();
  const m = question.match(/(\d+)\s*\+\s*(\d+)/);
  expect(m).not.toBeNull();
  await page.locator('.auth-captcha-container input[type="number"]').fill(String(Number(m![1]) + Number(m![2])));
  await page.locator('button.wlm-btn-auth').click();
  await expect(page.locator('.auth-captcha-container')).toHaveCount(0, { timeout: 20000 });
  await page.locator('.auth-field input[type="text"]').first().fill(username);
  await page.locator('.auth-field input[type="password"]').fill(PASSWORD);
  await page.locator('button.wlm-btn-auth').click();
  await expect(page.locator('.wlm-auth-container')).toHaveCount(0, { timeout: 45000 });
};

const newUserPage = async (browser: Browser, username: string, android: false | 'v4' | 'v3' | 'refuse') => {
  const ctx = await browser.newContext({ locale: 'en-US', extraHTTPHeaders: { 'CF-Connecting-IP': fakeClientIp() } });
  if (android) await ctx.addInitScript(fakeAndroidBridge, { legacy: android === 'v3', refuse: android === 'refuse' });
  const page = await ctx.newPage();
  await registerAndLogin(page, username);
  return page;
};

/** A (navigateur) et B (app Android simulée), contacts, conversation ouverte des deux côtés. */
const pair = async (browser: Browser, apk: 'v4' | 'v3' | 'refuse') => {
  const stamp = Date.now();
  const nameA = `andsa_${stamp}`;
  const nameB = `andsb_${stamp}`;
  const a = await newUserPage(browser, nameA, false);
  const b = await newUserPage(browser, nameB, apk);
  expect(await b.evaluate(() => (window as unknown as { Capacitor: { isNativePlatform(): boolean } }).Capacitor.isNativePlatform())).toBe(true);

  expect((await a.request.post('/api/invite', { data: { receiverUsername: nameB } })).ok()).toBeTruthy();
  const meB = await (await b.request.get('/api/user/me')).json();
  const invites = await (await b.request.get(`/api/invitations/${meB.user.id}`)).json();
  expect((await b.request.post('/api/accept-invite', { data: { invitationId: invites[0].id } })).ok()).toBeTruthy();
  await expect(a.locator('.contact-row', { hasText: nameB })).toBeVisible({ timeout: 45000 });
  await expect(b.locator('.contact-row', { hasText: nameA })).toBeVisible({ timeout: 45000 });
  await a.locator('.contact-row', { hasText: nameB }).click();
  await b.locator('.contact-row', { hasText: nameA }).click();
  return { a, b, stamp };
};

const cleanUploads = (since: number) => {
  for (const f of fs.readdirSync(UPLOADS_DIR).filter((f) => f.startsWith('enc_'))) {
    const full = path.join(UPLOADS_DIR, f);
    if (fs.statSync(full).mtimeMs >= since - 1000) fs.rmSync(full, { force: true });
  }
};

test('app Android : un fichier reçu est enregistré par morceaux, identique à l\'original', async ({ browser }) => {
  test.setTimeout(180000);
  const { a, b, stamp } = await pair(browser, 'v4');

  // ~4,6 Mo aléatoires : 4 morceaux (3 pleins + 1 partiel)
  const startedAt = Date.now();
  const original = crypto.randomBytes(3 * CHUNK + 123_457);
  const fileName = `archive_${stamp}.bin`;
  await a.locator('input[type="file"]').first().setInputFiles({ name: fileName, mimeType: 'application/octet-stream', buffer: original });
  const card = b.locator('.wlm-file-card', { hasText: fileName });
  await expect(card).toBeVisible({ timeout: 60000 });
  await card.locator('.wlm-file-download-btn').last().click();

  // Confirmation traduite (« Téléchargements ») affichée par l'app
  await expect(b.locator('.wlm-aero-dialog', { hasText: 'Downloads' })).toBeVisible({ timeout: 60000 });
  const saves = await b.evaluate(() => (window as unknown as { __saves: unknown[] }).__saves) as Array<{ fileName: string; size: number; chunks: string[]; finished: boolean; aborted: boolean }>;
  expect(saves).toHaveLength(1);
  const [save] = saves;
  expect(save.fileName).toBe(fileName);
  expect(save.finished).toBe(true);
  expect(save.aborted).toBe(false);
  expect(save.size).toBe(original.length);
  expect(save.chunks).toHaveLength(4);
  const parts = save.chunks.map((c) => Buffer.from(c, 'base64'));
  for (const p of parts.slice(0, -1)) expect(p.length).toBe(CHUNK);
  const received = Buffer.concat(parts);
  expect(crypto.createHash('sha256').update(received).digest('hex')).toBe(crypto.createHash('sha256').update(original).digest('hex'));

  cleanUploads(startedAt);
});

test('APK v3 (sans enregistrement par morceaux) : l\'interface se replie sur saveFile', async ({ browser }) => {
  test.setTimeout(180000);
  const { a, b, stamp } = await pair(browser, 'v3');
  const startedAt = Date.now();
  const original = crypto.randomBytes(200_000);
  const fileName = `ancien_${stamp}.bin`;
  await a.locator('input[type="file"]').first().setInputFiles({ name: fileName, mimeType: 'application/octet-stream', buffer: original });
  const card = b.locator('.wlm-file-card', { hasText: fileName });
  await expect(card).toBeVisible({ timeout: 60000 });
  await card.locator('.wlm-file-download-btn').last().click();
  await expect(b.locator('.wlm-aero-dialog', { hasText: 'Downloads' })).toBeVisible({ timeout: 60000 });
  const saves = await b.evaluate(() => (window as unknown as { __saves: unknown[] }).__saves) as Array<{ fileName: string; chunks: string[]; legacy?: boolean }>;
  expect(saves).toHaveLength(1);
  expect(saves[0].legacy).toBe(true);
  expect(saves[0].fileName).toBe(fileName);
  expect(Buffer.from(saves[0].chunks[0], 'base64').equals(original)).toBe(true);
  cleanUploads(startedAt);
});

test('confirmation native refusée : rien n\'est enregistré, sans message d\'erreur', async ({ browser }) => {
  test.setTimeout(180000);
  const { a, b, stamp } = await pair(browser, 'refuse');
  const startedAt = Date.now();
  const fileName = `refus_${stamp}.bin`;
  await a.locator('input[type="file"]').first().setInputFiles({ name: fileName, mimeType: 'application/octet-stream', buffer: crypto.randomBytes(50_000) });
  const card = b.locator('.wlm-file-card', { hasText: fileName });
  await expect(card).toBeVisible({ timeout: 60000 });
  await card.locator('.wlm-file-download-btn').last().click();
  await b.waitForTimeout(2000);
  await expect(b.locator('.wlm-aero-dialog')).toHaveCount(0);
  expect(await b.evaluate(() => (window as unknown as { __saves: unknown[] }).__saves)).toHaveLength(0);
  cleanUploads(startedAt);
});
