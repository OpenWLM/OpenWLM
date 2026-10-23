import { test, expect, type Browser, type BrowserContext, type Page } from './test';

/**
 * E2E — robustesse de session et de synchronisation (relecture d'octobre 2026) :
 *  - démarrage sans réseau : l'appareil mémorisé n'est pas oublié (seule une réponse du
 *    serveur peut invalider la session) ;
 *  - session expirée (connexion coupée par le serveur, puis 403) : retour à l'écran de
 *    connexion avec un message, au lieu d'une app figée ;
 *  - message reçu en direct pendant le chargement d'un historique : il reste affiché ;
 *  - accusé de lecture seulement fenêtre visible et au premier plan.
 * Serveur + base temporaires (jamais la prod).
 */

const PASSWORD = 'MotDePasseE2E-1234';
const fakeClientIp = () => `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;

const registerAndLogin = async (page: Page, username: string, remember = false) => {
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
  if (remember) await page.locator('#remember-me, input[type="checkbox"]').first().check();
  await page.locator('button.wlm-btn-auth').click();
  await expect(page.locator('.wlm-auth-container')).toHaveCount(0, { timeout: 45000 });
};

const newCtx = (browser: Browser) => browser.newContext({ locale: 'en-US', extraHTTPHeaders: { 'CF-Connecting-IP': fakeClientIp() } });

const pair = async (browser: Browser) => {
  const stamp = Date.now();
  const nameA = `sra_${stamp}`;
  const nameB = `srb_${stamp}`;
  const a = await (await newCtx(browser)).newPage();
  await registerAndLogin(a, nameA);
  const b = await (await newCtx(browser)).newPage();
  await registerAndLogin(b, nameB);
  expect((await a.request.post('/api/invite', { data: { receiverUsername: nameB } })).ok()).toBeTruthy();
  const meB = await (await b.request.get('/api/user/me')).json();
  const invites = await (await b.request.get(`/api/invitations/${meB.user.id}`)).json();
  expect((await b.request.post('/api/accept-invite', { data: { invitationId: invites[0].id } })).ok()).toBeTruthy();
  await expect(a.locator('.contact-row', { hasText: nameB })).toBeVisible({ timeout: 45000 });
  await expect(b.locator('.contact-row', { hasText: nameA })).toBeVisible({ timeout: 45000 });
  return { a, b, nameA, nameB, stamp };
};

const send = async (page: Page, text: string) => {
  await page.locator('.chat-input-rich').click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
};

test('démarrage sans réseau : l\'appareil mémorisé n\'est pas oublié', async ({ browser }) => {
  test.setTimeout(120000);
  const ctx = await newCtx(browser);
  const page = await ctx.newPage();
  await registerAndLogin(page, `off_${Date.now()}`, true);
  await expect.poll(() => page.evaluate(() => !!localStorage.getItem('wlm_user'))).toBe(true);

  // Serveur injoignable au prochain démarrage
  await ctx.route('**/api/user/me', (route) => route.abort('connectionfailed'));
  await page.reload();
  await expect(page.locator('.wlm-auth-form')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.wlm-auth-container')).toContainText(/cannot be reached|injoignable/i);
  expect(await page.evaluate(() => !!localStorage.getItem('wlm_user'))).toBe(true);

  // Réseau revenu : connexion automatique, sans mot de passe
  await ctx.unroute('**/api/user/me');
  await page.reload();
  await expect(page.locator('.wlm-auth-container')).toHaveCount(0, { timeout: 45000 });
  await expect(page.locator('.status-trigger')).toBeVisible();
});

test('session expirée : connexion coupée par le serveur puis 403 → écran de connexion', async ({ browser }) => {
  test.setTimeout(120000);
  const ctx = await newCtx(browser);
  // Le WebSocket est relayé : on pourra envoyer au client un « disconnect » venant du serveur
  const links: Array<{ ws: { send: (m: string | Buffer) => void } }> = [];
  await ctx.routeWebSocket(/\/socket\.io\//, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((msg) => server.send(msg));
    server.onMessage((msg) => ws.send(msg));
    links.push({ ws });
  });
  const page = await ctx.newPage();
  await registerAndLogin(page, `exp_${Date.now()}`);
  await expect(page.locator('.status-trigger')).toBeVisible();
  await expect.poll(() => links.length).toBeGreaterThan(0);

  // Le jeton a expiré : le serveur répond désormais 403 sans code, et coupe la connexion
  await ctx.route('**/api/user/me', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Token invalide ou expiré.' }) }));
  links[links.length - 1].ws.send('41'); // paquet Socket.IO DISCONNECT (raison « io server disconnect »)
  await expect(page.locator('.wlm-auth-form')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.wlm-auth-container')).toContainText(/expired|expiré/i);
});

test('message reçu pendant le chargement de l\'historique : il reste affiché', async ({ browser }) => {
  test.setTimeout(150000);
  const { a, b, nameA, nameB, stamp } = await pair(browser);
  // La RÉPONSE de l'historique de B met 2,5 s à arriver (le serveur a répondu tout de suite,
  // donc sans le message que A envoie pendant ce temps)
  await b.context().route('**/api/messages/**', async (route) => {
    const response = await route.fetch();
    const body = await response.body();
    await new Promise((r) => setTimeout(r, 2500));
    await route.fulfill({ response, body });
  });
  await a.locator('.contact-row', { hasText: nameB }).click();
  await b.locator('.contact-row', { hasText: nameA }).click();
  await b.waitForTimeout(300);
  const text = `pendant le chargement ${stamp}`;
  await send(a, text);
  await expect(b.locator('.msg-content', { hasText: text })).toBeVisible({ timeout: 20000 });
  // Après la fin du chargement (réponse serveur sans ce message), il est toujours là
  await b.waitForTimeout(3500);
  await expect(b.locator('.msg-content', { hasText: text })).toHaveCount(1);
});

test('accusé de lecture : pas en arrière-plan, envoyé au retour au premier plan', async ({ browser }) => {
  test.setTimeout(150000);
  const { a, b, nameA, nameB, stamp } = await pair(browser);
  await a.locator('.contact-row', { hasText: nameB }).click();
  await b.locator('.contact-row', { hasText: nameA }).click();
  await send(a, `avant ${stamp}`);
  await expect(b.locator('.msg-content', { hasText: `avant ${stamp}` })).toBeVisible({ timeout: 20000 });

  // B passe en arrière-plan (fenêtre réduite / autre onglet)
  await b.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    (document as unknown as { hasFocus: () => boolean }).hasFocus = () => false;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const text = `en arrière-plan ${stamp}`;
  await send(a, text);
  await expect(b.locator('.msg-content', { hasText: text })).toBeVisible({ timeout: 20000 });
  const line = a.locator('.msg-line', { hasText: text });
  await expect(line.locator('.msg-status-badge.status-delivered')).toBeVisible({ timeout: 15000 });
  await a.waitForTimeout(2000);
  await expect(line.locator('.msg-status-badge.status-read')).toHaveCount(0);

  // B revient au premier plan : lu
  await b.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    (document as unknown as { hasFocus: () => boolean }).hasFocus = () => true;
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  });
  await expect(line.locator('.msg-status-badge.status-read')).toBeVisible({ timeout: 15000 });
});

export type { BrowserContext };
