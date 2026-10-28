import { test, expect, type Page } from './test';

/**
 * E2E — verrouillage des clés par l'appareil (src/utils/DeviceLock.ts) :
 *  - ordinateur : passkey Windows Hello / Touch ID simulée (authentificateur virtuel Chromium
 *    avec l'extension PRF) : activation dans Options → Sécurité avec le mot de passe, clé
 *    privée scellée en IndexedDB (plus de CryptoKey), écran de déverrouillage au rechargement,
 *    « Verrouiller maintenant », refus de l'authentification → mot de passe (clés retirées),
 *    reconnexion avec « Mémoriser » → de nouveau scellées ;
 *  - app Android simulée : secret rendu par le pont natif (Keystore), pas de délai de
 *    re-verrouillage (verrou natif), secret changé → « Se connecter avec le mot de passe ».
 * Serveur + base temporaires (jamais la prod).
 */

const PASSWORD = 'MotDePasseE2E-1234';
const fakeClientIp = () => `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;

const register = async (page: Page, username: string) => {
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
};
/** Connexion avec « Mémoriser mes clés E2EE sur cet appareil ». */
const loginRemembered = async (page: Page, username: string) => {
  await expect(page.locator('.wlm-auth-form')).toBeVisible();
  if ((await page.locator('.auth-captcha-container').count()) > 0) await page.locator('.auth-toggle').click();
  await page.locator('.auth-field input[type="text"]').first().fill(username);
  await page.locator('.auth-field input[type="password"]').fill(PASSWORD);
  await page.locator('.auth-field-checkbox input[type="checkbox"]').check();
  await page.locator('button.wlm-btn-auth').click();
  await expect(page.locator('.status-trigger')).toBeVisible({ timeout: 45000 });
};
const openSecurityTab = async (page: Page) => {
  await page.locator('.status-trigger').click();
  await page.locator('.dropdown-item', { hasText: 'Options' }).first().click();
  await page.locator('.options-nav-item', { hasText: 'Security' }).click();
  await expect(page.getByTestId('device-lock')).toBeVisible();
};
const closeOptions = (page: Page) => page.getByRole('dialog', { name: 'Options' }).getByRole('button', { name: 'Close' }).click();
/** Active (ou désactive) le verrouillage des clés avec le mot de passe donné. */
const toggleDeviceLock = async (page: Page, password: string) => {
  await page.locator('#pref-device-lock').click();
  await page.locator('#device-lock-password').fill(password);
  await page.getByTestId('device-lock').locator('button[type="submit"]').click();
  await expect(page.getByTestId('device-lock-outcome')).toBeVisible({ timeout: 30000 });
  return page.getByTestId('device-lock-outcome').innerText();
};
/** Enregistrement du coffre d'appareil (IndexedDB) pour ce compte. */
const deviceRecord = (page: Page, userId: number) => page.evaluate((id) => new Promise<{ exists: boolean; hasPrivateKey: boolean; method: string | null } | null>((resolve, reject) => {
  const open = indexedDB.open('WLM_DeviceVault_v1');
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains('e2ee_keys')) { db.close(); resolve(null); return; }
    const req = db.transaction('e2ee_keys', 'readonly').objectStore('e2ee_keys').get(id);
    req.onsuccess = () => {
      const r = req.result;
      db.close();
      resolve({ exists: !!r, hasPrivateKey: !!r?.privateCryptoKey, method: r?.protectedKey?.method ?? null });
    };
    req.onerror = () => reject(req.error);
  };
}), userId);
const myId = async (page: Page) => Number((await (await page.request.get('/api/user/me')).json()).user.id);

test('ordinateur : clés scellées par Windows Hello (PRF), déverrouillage, refus → mot de passe', async ({ browser }) => {
  test.setTimeout(180000);
  const ctx = await browser.newContext({ locale: 'en-US', extraHTTPHeaders: { 'CF-Connecting-IP': fakeClientIp() } });
  // Hello simulé répond instantanément : pour observer l'écran de déverrouillage, le test
  // retient la demande WebAuthn tant que « __e2e_hold_webauthn » est posé
  await ctx.addInitScript(() => {
    const original = navigator.credentials.get.bind(navigator.credentials);
    navigator.credentials.get = async (options?: CredentialRequestOptions) => {
      while (localStorage.getItem('__e2e_hold_webauthn')) await new Promise((r) => setTimeout(r, 100));
      return original(options);
    };
  });
  const page = await ctx.newPage();
  const holdWebauthn = (hold: boolean) => page.evaluate((h) => { if (h) localStorage.setItem('__e2e_hold_webauthn', '1'); else localStorage.removeItem('__e2e_hold_webauthn'); }, hold);
  // Windows Hello simulé : authentificateur de la plateforme, vérifie l'utilisateur, extension PRF
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, hasPrf: true, isUserVerified: true, automaticPresenceSimulation: true }
  });
  const name = `dl_${Date.now()}`;
  await register(page, name);
  await loginRemembered(page, name);
  const id = await myId(page);
  expect(await deviceRecord(page, id)).toEqual({ exists: true, hasPrivateKey: true, method: null });

  // Activation : mauvais mot de passe refusé, puis le bon → clé privée scellée, plus de CryptoKey
  await openSecurityTab(page);
  await expect(page.locator('#pref-device-lock')).not.toBeChecked();
  expect(await toggleDeviceLock(page, 'MauvaisMotDePasse-1')).toContain('Wrong password');
  await page.locator('#device-lock-password').fill(PASSWORD);
  await page.getByTestId('device-lock').locator('button[type="submit"]').click();
  await expect(page.getByTestId('device-lock-outcome')).toContainText('On:', { timeout: 30000 });
  await expect(page.locator('#pref-device-lock')).toBeChecked();
  await expect(page.locator('#pref-relock')).toBeVisible();
  expect(await deviceRecord(page, id)).toEqual({ exists: true, hasPrivateKey: false, method: 'webauthn' });

  // Rechargement : écran de déverrouillage (demande retenue), puis Hello accepte → conversation accessible, clés toujours scellées
  const unlockScreen = page.getByTestId('device-unlock');
  const addAuthenticator = async (isUserVerified: boolean) => (await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, hasPrf: true, isUserVerified, automaticPresenceSimulation: true }
  })).authenticatorId;
  await holdWebauthn(true);
  await page.reload();
  await expect(unlockScreen).toBeVisible({ timeout: 20000 });
  await expect(unlockScreen).toContainText(name);
  await expect(unlockScreen).toContainText('Checking');
  await expect(page.locator('.status-trigger')).toHaveCount(0);
  await holdWebauthn(false);
  await expect(page.locator('.status-trigger')).toBeVisible({ timeout: 30000 });
  await expect(unlockScreen).toHaveCount(0);
  expect(await deviceRecord(page, id)).toEqual({ exists: true, hasPrivateKey: false, method: 'webauthn' });

  // « Verrouiller maintenant » : la page se recharge sur l'écran de déverrouillage, et les autres
  // onglets du navigateur reçoivent l'ordre de se verrouiller aussi
  const otherTab = await ctx.newPage();
  await otherTab.goto('/');
  await otherTab.evaluate(() => {
    const w = window as unknown as { __lockMessages: unknown[] };
    w.__lockMessages = [];
    new BroadcastChannel('openwlm-device-lock').onmessage = (ev) => { w.__lockMessages.push(ev.data); };
  });
  await openSecurityTab(page);
  await holdWebauthn(true);
  await page.getByTestId('device-lock').getByRole('button', { name: /Lock now/ }).click();
  await expect.poll(() => otherTab.evaluate(() => (window as unknown as { __lockMessages: unknown[] }).__lockMessages), { timeout: 10000 })
    .toEqual([{ type: 'lock', userId: id }]);
  await otherTab.close();
  await expect(unlockScreen).toBeVisible({ timeout: 20000 });
  await holdWebauthn(false);
  await expect(page.locator('.status-trigger')).toBeVisible({ timeout: 30000 });

  // Hello refusé (l'authentificateur ne vérifie plus l'utilisateur) : erreur, « Déverrouiller »
  // pour réessayer, puis mot de passe → clés scellées retirées de l'appareil
  await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false });
  await page.reload();
  await expect(unlockScreen).toBeVisible({ timeout: 20000 });
  await expect(unlockScreen.getByRole('alert')).toContainText('cancelled', { timeout: 20000 });
  await expect(unlockScreen.getByRole('button', { name: 'Unlock' })).toBeVisible();
  await expect(page.locator('.status-trigger')).toHaveCount(0);
  // Verrou des CLÉS, pas de la session : derrière l'écran de déverrouillage, l'API répond
  // (profil), mais sans le coffre de clés, remis seulement avec le mot de passe
  const meLocked = await page.request.get('/api/user/me');
  expect(meLocked.status()).toBe(200);
  expect((await meLocked.json()).user.encrypted_private_key).toBeUndefined();
  expect((await page.request.post('/api/user/vault', { data: { authKeyHex: 'a'.repeat(64) } })).status()).toBe(401);
  await unlockScreen.getByRole('button', { name: /Sign in with the password/ }).click();
  await expect(page.locator('.wlm-auth-form')).toBeVisible();
  expect(await deviceRecord(page, id)).toEqual({ exists: false, hasPrivateKey: false, method: null });
  // La session de ce navigateur est fermée aussi : plus de cookie valable derrière l'écran de connexion
  await expect.poll(async () => (await page.request.get('/api/user/me')).status(), { timeout: 10000 }).toBe(401);
  expect((await ctx.cookies()).some((c) => c.name === 'token')).toBe(false);

  // Reconnexion avec « Mémoriser » : le réglage de l'appareil scelle de nouveau (Hello demandé,
  // ici un authentificateur neuf : une passkey neuve est créée)
  await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
  const authenticatorId2 = await addAuthenticator(true);
  await page.locator('.auth-field-checkbox input[type="checkbox"]').check();
  await expect(page.getByTestId('remember-device-lock')).toBeVisible();
  await loginRemembered(page, name);
  await expect.poll(() => deviceRecord(page, id), { timeout: 30000 }).toEqual({ exists: true, hasPrivateKey: false, method: 'webauthn' });
  await openSecurityTab(page);
  await expect(page.locator('#pref-device-lock')).toBeChecked();

  // Session restaurée (déverrouillée par Hello) : le profil ne contient plus le coffre, il est
  // demandé au serveur avec la preuve du mot de passe pour désactiver le verrouillage
  await page.reload();
  await expect(page.locator('.status-trigger')).toBeVisible({ timeout: 30000 });
  const me = await (await page.request.get('/api/user/me')).json();
  expect(me.user.encrypted_private_key).toBeUndefined();
  await openSecurityTab(page);
  expect(await toggleDeviceLock(page, 'MauvaisMotDePasse-2')).toContain('Wrong password');
  await page.locator('#device-lock-password').fill(PASSWORD);
  await page.getByTestId('device-lock').locator('button[type="submit"]').click();
  await expect(page.getByTestId('device-lock-outcome')).toContainText('Off', { timeout: 30000 });
  await expect(page.locator('#pref-device-lock')).not.toBeChecked();
  expect(await deviceRecord(page, id)).toEqual({ exists: true, hasPrivateKey: true, method: null });

  // Réactivation : la passkey existante est réutilisée, aucune nouvelle dans « Windows »
  const passkeys = async () => (await cdp.send('WebAuthn.getCredentials', { authenticatorId: authenticatorId2 })).credentials.length;
  expect(await passkeys()).toBe(1);
  expect(await toggleDeviceLock(page, PASSWORD)).toContain('On:');
  expect(await deviceRecord(page, id)).toEqual({ exists: true, hasPrivateKey: false, method: 'webauthn' });
  expect(await passkeys()).toBe(1);
});

/** Faux pont natif Android (cf. e2e/android-sounds.spec.ts) avec le secret du Keystore simulé. */
const fakeAndroidBridge = () => {
  const w = window as unknown as Record<string, unknown>;
  const promise = (name: string) => ({ name, rtype: 'promise' });
  const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
  const impl: Record<string, (o: Record<string, unknown>) => unknown> = {
    getInfo: () => ({ server: location.host, defaultServer: location.host, versionName: 'e2e', versionCode: 11, appLock: true, push: false }),
    getFcmToken: () => ({ token: null }),
    getNotificationPermission: () => ({ state: 'granted' }),
    getCallPermissions: () => ({ notifications: 'granted', fullScreen: 'granted', microphone: 'granted', camera: 'granted' }),
    isAppLocked: () => ({ locked: false }),
    deviceSecretCreate: () => {
      const secret = toB64(crypto.getRandomValues(new Uint8Array(32)));
      localStorage.setItem('__e2e_keystore', secret);
      return { secret, blob: toB64(crypto.getRandomValues(new Uint8Array(44))) };
    },
    deviceSecretUnlock: () => {
      // « Keystore » remplacé par le test : autre secret
      if (localStorage.getItem('__e2e_keystore_reset')) return { secret: toB64(crypto.getRandomValues(new Uint8Array(32))) };
      return { secret: localStorage.getItem('__e2e_keystore') };
    }
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
          'saveFile', 'isAppLocked', 'resetPushToken', 'setSoundPrefs', 'deviceSecretCreate', 'deviceSecretUnlock'].map(promise),
        { name: 'addListener', rtype: 'callback' }
      ]
    }],
    nativePromise: async (_plugin: string, method: string, options: Record<string, unknown>) => (impl[method] ? impl[method](options || {}) : {}),
    nativeCallback: () => String(nextCallback++)
  };
};

test('app Android : clés scellées par le Keystore, déverrouillage, secret changé → mot de passe', async ({ browser }) => {
  test.setTimeout(150000);
  const ctx = await browser.newContext({ locale: 'en-US', extraHTTPHeaders: { 'CF-Connecting-IP': fakeClientIp() } });
  await ctx.addInitScript(fakeAndroidBridge);
  const page = await ctx.newPage();
  const name = `dla_${Date.now()}`;
  await register(page, name);
  await loginRemembered(page, name);
  const id = await myId(page);

  await openSecurityTab(page);
  await expect(page.locator('label[for="pref-device-lock"]')).toContainText('fingerprint');
  expect(await toggleDeviceLock(page, PASSWORD)).toContain('On:');
  // Le verrou natif de l'app gère le re-verrouillage : pas de délai à régler
  await expect(page.locator('#pref-relock')).toHaveCount(0);
  expect(await deviceRecord(page, id)).toEqual({ exists: true, hasPrivateKey: false, method: 'android' });
  await closeOptions(page);

  await page.reload();
  await expect(page.locator('.status-trigger')).toBeVisible({ timeout: 30000 });
  expect(await deviceRecord(page, id)).toEqual({ exists: true, hasPrivateKey: false, method: 'android' });

  // Clé du Keystore remplacée (réinstallation, verrouillage d'écran retiré) : plus d'issue que le mot de passe
  await page.evaluate(() => localStorage.setItem('__e2e_keystore_reset', '1'));
  await page.reload();
  await expect(page.getByTestId('device-unlock').getByRole('alert')).toContainText('no longer open your keys', { timeout: 20000 });
  await expect(page.getByTestId('device-unlock').getByRole('button', { name: 'Unlock' })).toHaveCount(0);
  await page.getByTestId('device-unlock').getByRole('button', { name: /Sign in with the password/ }).click();
  await expect(page.locator('.wlm-auth-form')).toBeVisible();
  expect(await deviceRecord(page, id)).toEqual({ exists: false, hasPrivateKey: false, method: null });
});

test('verrouillage réglé mais plus disponible : clés non mémorisées, avertissement, réglage retirable', async ({ browser }) => {
  test.setTimeout(120000);
  const ctx = await browser.newContext({ locale: 'en-US', extraHTTPHeaders: { 'CF-Connecting-IP': fakeClientIp() } });
  // Aucun authentificateur de plateforme (Hello désactivé, autre navigateur…)
  await ctx.addInitScript(() => {
    if (typeof PublicKeyCredential !== 'undefined') {
      Object.defineProperty(PublicKeyCredential, 'isUserVerifyingPlatformAuthenticatorAvailable', { value: () => Promise.resolve(false), configurable: true });
    }
  });
  const page = await ctx.newPage();
  const username = `e2e_lock_off_${Date.now()}`;
  await register(page, username);
  // Verrouillage réglé sur ce navigateur (activé auparavant, quand Hello était là)
  await page.evaluate(() => localStorage.setItem('wlm_prefs', JSON.stringify({ security: { deviceLock: true, relockMinutes: 5 } })));
  await page.reload();
  await loginRemembered(page, username);
  await expect(page.locator('.wlm-toast-persistence')).toContainText('Key lock is on but unavailable', { timeout: 30000 });
  const id = await myId(page);
  // Jamais de repli silencieux sur des clés mémorisées sans scellé
  expect(await deviceRecord(page, id)).toEqual({ exists: false, hasPrivateKey: false, method: null });
  await openSecurityTab(page);
  const unavailable = page.getByTestId('device-lock-unavailable');
  await expect(unavailable).toBeVisible();
  await unavailable.getByRole('button', { name: /Remove the key lock/ }).click();
  await expect(unavailable).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('wlm_prefs') || '{}').security?.deviceLock)).toBe(false);
  await closeOptions(page);
  await ctx.close();
});
