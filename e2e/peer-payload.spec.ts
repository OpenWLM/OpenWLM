import { test, expect, type Page } from './test';

/**
 * E2E — relecture d'octobre 2026, derniers points :
 *  - Entrée pendant une composition IME ne part pas ;
 *  - historique paginé : « Messages précédents » charge la page d'avant ;
 *  - mise en place des clés impossible : le cookie de session est retiré de ce navigateur.
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
const fillLogin = async (page: Page, username: string) => {
  await page.locator('.auth-field input[type="text"]').first().fill(username);
  await page.locator('.auth-field input[type="password"]').fill(PASSWORD);
  await page.locator('button.wlm-btn-auth').click();
};
const newPage = async (browser: import('@playwright/test').Browser) =>
  (await browser.newContext({ locale: 'en-US', extraHTTPHeaders: { 'CF-Connecting-IP': fakeClientIp() } })).newPage();

test('Entrée pendant une composition IME : le message ne part pas', async ({ browser }) => {
  test.setTimeout(120000);
  const page = await newPage(browser);
  const name = `ime_${Date.now()}`;
  await register(page, name);
  await fillLogin(page, name);
  await expect(page.locator('.wlm-auth-container')).toHaveCount(0, { timeout: 45000 });
  await page.locator('.contact-row', { hasText: 'OpenWLM' }).click();
  const input = page.locator('.chat-input-rich');
  await input.click();
  await page.keyboard.type('こんにち');
  const before = await page.locator('.msg-line').count();
  // Entrée qui valide un candidat IME (isComposing, keyCode 229)
  await input.evaluate((el) => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(500);
  expect(await page.locator('.msg-line').count()).toBe(before);
  await expect(input).toContainText('こんにち');
  // Entrée normale : envoyé
  await page.keyboard.press('Enter');
  await expect(page.locator('.msg-content', { hasText: 'こんにち' })).toBeVisible({ timeout: 10000 });
});

test('mise en place des clés impossible : le cookie de session de ce navigateur est retiré', async ({ browser }) => {
  test.setTimeout(120000);
  const page = await newPage(browser);
  const name = `kf_${Date.now()}`;
  await register(page, name);
  // Enregistrement des clés refusé par le « serveur » : la connexion échoue côté app
  await page.context().route('**/api/user/keys', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' }));
  await fillLogin(page, name);
  await expect(page.locator('.wlm-aero-dialog', { hasText: /security keys|clés/i })).toBeVisible({ timeout: 30000 });
  // Plus de session dans ce navigateur
  await expect.poll(async () => (await page.request.get('/api/user/me')).status(), { timeout: 10000 }).toBe(401);
});

test('historique paginé : « Messages précédents » charge la page d\'avant', async ({ browser }) => {
  test.setTimeout(150000);
  const stamp = Date.now();
  const nameA = `pga_${stamp}`;
  const nameB = `pgb_${stamp}`;
  const a = await newPage(browser);
  await register(a, nameA);
  await fillLogin(a, nameA);
  await expect(a.locator('.wlm-auth-container')).toHaveCount(0, { timeout: 45000 });
  const b = await newPage(browser);
  await register(b, nameB);
  await fillLogin(b, nameB);
  await expect(b.locator('.wlm-auth-container')).toHaveCount(0, { timeout: 45000 });
  expect((await a.request.post('/api/invite', { data: { receiverUsername: nameB } })).ok()).toBeTruthy();
  const meB = await (await b.request.get('/api/user/me')).json();
  const invites = await (await b.request.get(`/api/invitations/${meB.user.id}`)).json();
  expect((await b.request.post('/api/accept-invite', { data: { invitationId: invites[0].id } })).ok()).toBeTruthy();
  await expect(a.locator('.contact-row', { hasText: nameB })).toBeVisible({ timeout: 45000 });

  // B ferme sa session ; A envoie 5 messages pendant ce temps
  await b.context().close();
  await a.locator('.contact-row', { hasText: nameB }).click();
  for (let i = 1; i <= 5; i++) {
    await a.locator('.chat-input-rich').click();
    await a.keyboard.type(`page ${i} ${stamp}`);
    await a.keyboard.press('Enter');
    await expect(a.locator('.msg-content', { hasText: `page ${i} ${stamp}` })).toBeVisible({ timeout: 10000 });
  }

  // B revient et charge la conversation avec des pages de 3 messages (au lieu de 300)
  const b2 = await newPage(browser);
  await b2.context().route('**/api/messages/**', (route) => {
    const url = new URL(route.request().url());
    url.searchParams.set('limit', '3');
    return route.continue({ url: url.toString() });
  });
  await b2.goto('/');
  await fillLogin(b2, nameB);
  await expect(b2.locator('.contact-row', { hasText: nameA })).toBeVisible({ timeout: 45000 });
  await b2.locator('.contact-row', { hasText: nameA }).click();
  await expect(b2.locator('.msg-content', { hasText: `page 5 ${stamp}` })).toBeVisible({ timeout: 20000 });
  await expect(b2.locator('.msg-content', { hasText: `page 1 ${stamp}` })).toHaveCount(0);
  await b2.getByTestId('load-older').click();
  await expect(b2.locator('.msg-content', { hasText: `page 1 ${stamp}` })).toBeVisible({ timeout: 15000 });
  await expect(b2.getByTestId('load-older')).toHaveCount(0);
  // Ordre chronologique conservé
  const texts = await b2.locator('.msg-content').allInnerTexts();
  const order = texts.filter((x) => x.includes(String(stamp))).map((x) => Number(x.match(/page (\d)/)?.[1]));
  expect(order).toEqual([1, 2, 3, 4, 5]);
});
