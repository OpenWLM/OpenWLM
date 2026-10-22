import { test, expect, type Browser, type Page } from './test';

/**
 * E2E — app Android simulée : les réglages Sons de l'app (Options → Sons, « Occupé ») sont
 * transmis au code natif (setSoundPrefs, APK v7+), qui joue le son de message ou de Wizz de
 * l'app sur les notifications reçues app fermée, ou les rend silencieuses. Un APK plus ancien
 * (sans la méthode) n'est pas appelé. Serveur + base temporaires (jamais la prod).
 */

const PASSWORD = 'MotDePasseE2E-1234';
const fakeClientIp = () => `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;

type SoundPrefs = { message: boolean; nudge: boolean };

/** Faux plugin natif (cf. e2e/android-save.spec.ts) ; `legacy` : APK v6, sans setSoundPrefs. */
const fakeAndroidBridge = ({ legacy }: { legacy: boolean }) => {
  const w = window as unknown as Record<string, unknown> & { __soundPrefs: unknown[] };
  w.__soundPrefs = [];
  const promise = (name: string) => ({ name, rtype: 'promise' });
  const impl: Record<string, (o: Record<string, unknown>) => unknown> = {
    getInfo: () => ({ server: location.host, defaultServer: location.host, versionName: 'e2e', versionCode: 0, appLock: true, push: false }),
    getFcmToken: () => ({ token: null }),
    getNotificationPermission: () => ({ state: 'granted' }),
    getCallPermissions: () => ({ notifications: 'granted', fullScreen: 'granted', microphone: 'granted', camera: 'granted' }),
    setSoundPrefs: (o) => { w.__soundPrefs.push({ message: o.message, nudge: o.nudge }); }
  };
  w.CapacitorCustomPlatform = { name: 'android', plugins: {} };
  let nextCallback = 1;
  w.Capacitor = {
    PluginHeaders: [{
      name: 'OpenWLMNative',
      methods: [
        ...['getInfo', 'getFcmToken', 'getNotificationPermission', 'requestNotificationPermission', 'getCallPermissions', 'requestCallPermission',
          'setLanguage', 'dismissIncomingCall', 'startOngoingCall', 'updateOngoingCall', 'stopOngoingCall', 'setKeepScreenOn',
          'changeServer', 'openNotificationSettings', 'removeListener', 'beginSave', 'appendChunk', 'finishSave', 'abortSave',
          'saveFile', 'isAppLocked', 'resetPushToken', ...(legacy ? [] : ['setSoundPrefs'])].map(promise),
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

const androidPage = async (browser: Browser, legacy: boolean) => {
  const ctx = await browser.newContext({ locale: 'en-US', extraHTTPHeaders: { 'CF-Connecting-IP': fakeClientIp() } });
  await ctx.addInitScript(fakeAndroidBridge, { legacy });
  const page = await ctx.newPage();
  await registerAndLogin(page, `snd${legacy ? 'l' : 'n'}_${Date.now()}`);
  return page;
};

const lastPrefs = (p: Page) => p.evaluate(() => {
  const all = (window as unknown as { __soundPrefs: SoundPrefs[] }).__soundPrefs;
  return all.length ? all[all.length - 1] : null;
});
const openOptionsTab = async (p: Page, tab: string) => {
  await p.locator('.status-trigger').click();
  await p.locator('.dropdown-item', { hasText: 'Options' }).first().click();
  await p.locator('.options-nav-item', { hasText: tab }).click();
};
const closeOptions = (p: Page) => p.getByRole('dialog', { name: 'Options' }).getByRole('button', { name: 'Close' }).click();
const setStatus = async (p: Page, label: string) => {
  await p.locator('.status-trigger').click();
  await p.locator('.dropdown-item', { hasText: label }).first().click();
};

test('app Android : réglages Sons transmis aux notifications natives (message, Wizz, Occupé)', async ({ browser }) => {
  test.setTimeout(120000);
  const page = await androidPage(browser, false);
  await expect.poll(() => lastPrefs(page)).toEqual({ message: true, nudge: true });

  await openOptionsTab(page, 'Sounds');
  await page.locator('#pref-snd-nudge').uncheck();
  await expect.poll(() => lastPrefs(page)).toEqual({ message: true, nudge: false });
  await page.locator('#pref-sounds').uncheck();
  await expect.poll(() => lastPrefs(page)).toEqual({ message: false, nudge: false });
  await page.locator('#pref-sounds').check();
  await page.locator('#pref-snd-nudge').check();
  await page.locator('#pref-snd-busy').check();
  await closeOptions(page);
  await expect.poll(() => lastPrefs(page)).toEqual({ message: true, nudge: true });

  // « Couper les sons en Occupé » : notifications silencieuses tant que le statut est Occupé
  await setStatus(page, 'Busy');
  await expect.poll(() => lastPrefs(page)).toEqual({ message: false, nudge: false });
  await setStatus(page, 'Available');
  await expect.poll(() => lastPrefs(page)).toEqual({ message: true, nudge: true });
});

test('app Android v6 (sans setSoundPrefs) : la méthode n\'est pas appelée', async ({ browser }) => {
  test.setTimeout(120000);
  const page = await androidPage(browser, true);
  await expect(page.locator('.status-trigger')).toBeVisible();
  await page.waitForTimeout(1000);
  expect(await lastPrefs(page)).toBeNull();
});
