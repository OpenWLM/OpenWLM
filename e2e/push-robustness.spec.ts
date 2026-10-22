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

/** App Android simulée (plugin OpenWLMNative), avec un jeton FCM et les notifications autorisées. */
const fakeAndroidBridge = () => {
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
  const page = await newPage(browser, fakeAndroidBridge);

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

test('déconnexion refusée par le serveur : la session reste ouverte, avec un nouvel essai proposé', async ({ browser }) => {
  test.setTimeout(120000);
  const page = await newPage(browser);
  await registerAndLogin(page, `logoutko_${Date.now()}`);
  let logoutCalls = 0;
  await page.route('**/api/logout', async (route) => {
    logoutCalls += 1;
    if (logoutCalls === 1) await route.fulfill({ status: 500, contentType: 'application/json', body: '{"code":"logout_failed"}' });
    else await route.continue();
  });

  await page.locator('.status-trigger').click();
  await page.locator('.dropdown-item', { hasText: 'Sign out everywhere' }).click();
  // Échec : message, toujours connecté (rien de purgé)
  const dialog = page.getByTestId('aero-dialog');
  await expect(dialog).toContainText('could not be recorded');
  await expect(page.locator('.wlm-auth-form')).toHaveCount(0);
  await expect(page.locator('.status-trigger')).toBeVisible();
  expect((await page.request.get('/api/user/me')).status()).toBe(200);

  // Nouvel essai : cette fois accepté → déconnexion
  await dialog.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('.wlm-auth-form')).toBeVisible({ timeout: 20000 });
  expect(logoutCalls).toBe(2);
  expect((await page.request.get('/api/user/me')).status()).toBe(401);
});

test('app Android : après « Déconnecter mes autres sessions », le jeton de cet appareil est réenregistré', async ({ browser }) => {
  test.setTimeout(120000);
  const page = await newPage(browser, fakeAndroidBridge);
  let registers = 0;
  await page.route('**/api/push/fcm/register', async (route) => { registers += 1; await route.continue(); });
  await registerAndLogin(page, `revresync_${Date.now()}`);
  await expect.poll(() => registers, { timeout: 20000 }).toBe(1);

  await page.locator('.status-trigger').click();
  await page.locator('.dropdown-item', { hasText: 'Options' }).first().click();
  await page.locator('.options-nav-item', { hasText: 'Security' }).click();
  await page.getByTestId('revoke-sessions').getByRole('button', { name: 'Sign out my other devices' }).click();
  await page.getByTestId('revoke-sessions').getByRole('button', { name: 'Yes, sign them out' }).click();
  // Même si la lecture du jeton avait échoué, il est renvoyé au serveur
  await expect.poll(() => registers, { timeout: 20000 }).toBe(2);
});

test('déconnexion refusée puis annulée : le temps réel fonctionne toujours', async ({ browser }) => {
  test.setTimeout(150000);
  const stamp = Date.now();
  const a = await newPage(browser);
  const b = await newPage(browser);
  await registerAndLogin(a, `lka_${stamp}`);
  await registerAndLogin(b, `lkb_${stamp}`);
  expect((await a.request.post('/api/invite', { data: { receiverUsername: `lkb_${stamp}` } })).ok()).toBeTruthy();
  const meB = await (await b.request.get('/api/user/me')).json();
  const invites = await (await b.request.get(`/api/invitations/${meB.user.id}`)).json();
  expect((await b.request.post('/api/accept-invite', { data: { invitationId: invites[0].id } })).ok()).toBeTruthy();
  await expect(b.locator('.contact-row', { hasText: `lka_${stamp}` })).toBeVisible({ timeout: 45000 });
  await expect(a.locator('.contact-row', { hasText: `lkb_${stamp}` })).toBeVisible({ timeout: 45000 });
  // Conversation ouverte AVANT : ensuite, seul le temps réel peut y faire apparaître un message
  // (pas de rechargement de l'historique par un clic)
  await a.locator('.contact-row', { hasText: `lkb_${stamp}` }).click();

  // Réponse lente (réseau mobile) : la connexion temps réel est fermée par manual_disconnect
  // pendant que la déconnexion est encore en cours
  await a.route('**/api/logout', async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
  });
  await a.locator('.status-trigger').click();
  await a.locator('.dropdown-item', { hasText: 'Sign out everywhere' }).click();
  const dialog = a.getByTestId('aero-dialog');
  await expect(dialog).toContainText('could not be recorded');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(a.locator('.wlm-auth-form')).toHaveCount(0);

  // La connexion temps réel a été rétablie : A reçoit un message de B
  await b.locator('.contact-row', { hasText: `lka_${stamp}` }).click();
  const text = `toujours là ${stamp}`;
  await b.locator('.chat-input-rich').click();
  await b.keyboard.type(text);
  await b.keyboard.press('Enter');
  await expect(a.locator('.msg-content', { hasText: text })).toBeVisible({ timeout: 20000 });
});

test('déconnexion avec une session déjà terminée (401) : la déconnexion locale va à son terme', async ({ browser }) => {
  test.setTimeout(120000);
  const page = await newPage(browser);
  await registerAndLogin(page, `logout401_${Date.now()}`);
  await page.route('**/api/logout', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{"code":"session_revoked"}' }));
  await page.locator('.status-trigger').click();
  await page.locator('.dropdown-item', { hasText: 'Sign out everywhere' }).click();
  await expect(page.locator('.wlm-auth-form')).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('aero-dialog')).toHaveCount(0);
});
