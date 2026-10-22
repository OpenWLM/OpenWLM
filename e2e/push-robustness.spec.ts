import { test, expect, type Browser, type Page } from './test';

/**
 * E2E — robustesse des notifications (revue du 2026-10-21) :
 * - une déconnexion n'attend jamais indéfiniment le service worker (navigator.serviceWorker.ready
 *   qui ne se résout pas : enregistrement échoué, navigation privée…) avant de purger la session ;
 * - app Android simulée : un échec d'enregistrement du jeton FCM n'est pas mémorisé comme un
 *   succès, il est réessayé au retour du réseau, et pas réenvoyé une fois réussi.
 * Serveur + base temporaires (jamais la prod).
 */

const PASSWORD = 'MotDePasseE2E-1234';
const fakeClientIp = () => `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;

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

const newPage = async (browser: Browser, init?: () => void) => {
  const ctx = await browser.newContext({ locale: 'en-US', extraHTTPHeaders: { 'CF-Connecting-IP': fakeClientIp() } });
  if (init) await ctx.addInitScript(init);
  return ctx.newPage();
};

test('déconnexion : jamais bloquée par un service worker qui ne s\'active pas', async ({ browser }) => {
  test.setTimeout(120000);
  // navigator.serviceWorker.ready ne se résout jamais
  const page = await newPage(browser, () => {
    if (navigator.serviceWorker) Object.defineProperty(navigator.serviceWorker, 'ready', { get: () => new Promise(() => { /* jamais */ }) });
  });
  await registerAndLogin(page, `swhang_${Date.now()}`);

  const started = Date.now();
  await page.locator('.status-trigger').click();
  await page.locator('.dropdown-item', { hasText: 'Sign out everywhere' }).click();
  // Écran de connexion après purge et rechargement, en quelques secondes (délais bornés à 3-5 s)
  await expect(page.locator('.wlm-auth-form')).toBeVisible({ timeout: 20000 });
  expect(Date.now() - started).toBeLessThan(15000);
  expect(await page.evaluate(() => localStorage.getItem('wlm_user'))).toBeNull();
  // La session est bien révoquée côté serveur
  expect((await page.request.get('/api/user/me')).status()).toBe(401);
});

test('app Android : un échec d\'enregistrement du jeton FCM est réessayé au retour du réseau', async ({ browser }) => {
  test.setTimeout(120000);
  const page = await newPage(browser, () => {
    const promise = (name: string) => ({ name, rtype: 'promise' });
    const impl: Record<string, () => unknown> = {
      getInfo: () => ({ server: location.host, defaultServer: location.host, appLock: false, push: true }),
      getFcmToken: () => ({ token: 'e2e-device:APA91b-robustesse-0123456789' }),
      getNotificationPermission: () => ({ state: 'granted' }),
      // Explication des autorisations d'appel déjà vue : pas de fenêtre pendant le test
      getCallPermissions: () => ({ notifications: 'granted', fullScreen: 'granted', microphone: 'granted', camera: 'granted' })
    };
    const w = window as unknown as Record<string, unknown>;
    w.CapacitorCustomPlatform = { name: 'android', plugins: {} };
    let nextCallback = 1;
    w.Capacitor = {
      PluginHeaders: [{
        name: 'OpenWLMNative',
        methods: [
          ...['getInfo', 'getFcmToken', 'getNotificationPermission', 'requestNotificationPermission', 'getCallPermissions',
            'requestCallPermission', 'setLanguage', 'dismissIncomingCall', 'isAppLocked', 'beginSave', 'appendChunk',
            'finishSave', 'abortSave', 'saveFile', 'resetPushToken', 'changeServer', 'removeListener'].map(promise),
          { name: 'addListener', rtype: 'callback' }
        ]
      }],
      nativePromise: async (_p: string, method: string) => (impl[method] ? impl[method]() : {}),
      nativeCallback: () => String(nextCallback++)
    };
  });

  // Premier enregistrement : serveur indisponible (503) ; ensuite, laissé passer
  let calls = 0;
  await page.route('**/api/push/fcm/register', async (route) => {
    calls += 1;
    if (calls === 1) await route.fulfill({ status: 503, body: '{}', contentType: 'application/json' });
    else await route.continue();
  });

  await registerAndLogin(page, `fcmsync_${Date.now()}`);
  await expect.poll(() => calls, { timeout: 20000 }).toBe(1);

  // Retour du réseau : nouvel essai, réussi
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => calls, { timeout: 20000 }).toBe(2);

  // Une fois enregistré, rien n'est renvoyé
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(1500);
  expect(calls).toBe(2);
});
