import { test, expect, type Browser, type Page } from '@playwright/test';

/**
 * E2E — messagerie chiffrée et signée entre deux comptes réels : un message signé est
 * affiché normalement, sans bandeau de rejet (seuls les messages vérifiés sont affichés).
 * Serveur + base temporaire lancés par playwright.config.ts (jamais la prod).
 */

const PASSWORD = 'MotDePasseE2E-1234';

const registerAndLogin = async (page: Page, username: string) => {
  page.on('dialog', (d) => d.accept());
  await page.goto('/');
  await expect(page.locator('.wlm-auth-form')).toBeVisible();
  if ((await page.locator('.auth-captcha-container').count()) === 0) {
    await page.locator('.auth-toggle').click();
  }
  const textInputs = page.locator('.auth-field input[type="text"]');
  await textInputs.nth(0).fill(username);
  await page.locator('.auth-field input[type="password"]').fill(PASSWORD);
  await textInputs.nth(1).fill(username);
  const question = await page.locator('.auth-captcha-text').innerText();
  const m = question.match(/(\d+)\s*\+\s*(\d+)/);
  expect(m, `captcha introuvable dans « ${question} »`).not.toBeNull();
  await page.locator('.auth-captcha-container input[type="number"]').fill(String(Number(m![1]) + Number(m![2])));
  await page.locator('button.wlm-btn-auth').click();
  await expect(page.locator('.auth-captcha-container')).toHaveCount(0, { timeout: 20000 });

  await page.locator('.auth-field input[type="text"]').first().fill(username);
  await page.locator('.auth-field input[type="password"]').fill(PASSWORD);
  await page.locator('button.wlm-btn-auth').click();
  await expect(page.locator('.wlm-auth-container')).toHaveCount(0, { timeout: 45000 });
};

// IP fictive par navigateur (cf. e2e/start-server.mjs) : les limiteurs par IP restent actifs,
// mais chaque compte de test a la sienne.
const fakeClientIp = () => `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;

const newUserPage = async (browser: Browser, username: string) => {
  const ctx = await browser.newContext({ locale: 'en-US', extraHTTPHeaders: { 'CF-Connecting-IP': fakeClientIp() } });
  const page = await ctx.newPage();
  await registerAndLogin(page, username);
  return page;
};

test('message signé : reçu et affiché normalement, sans bandeau de rejet', async ({ browser }) => {
  test.setTimeout(120000);
  const stamp = Date.now();
  const nameA = `msga_${stamp}`;
  const nameB = `msgb_${stamp}`;
  const a = await newUserPage(browser, nameA);
  const b = await newUserPage(browser, nameB);

  expect((await a.request.post('/api/invite', { data: { receiverUsername: nameB } })).ok()).toBeTruthy();
  const meB = await (await b.request.get('/api/user/me')).json();
  const invites = await (await b.request.get(`/api/invitations/${meB.user.id}`)).json();
  expect((await b.request.post('/api/accept-invite', { data: { invitationId: invites[0].id } })).ok()).toBeTruthy();
  await expect(a.locator('.contact-row', { hasText: nameB })).toBeVisible({ timeout: 45000 });

  await a.locator('.contact-row', { hasText: nameB }).click();
  const text = `bonjour ${stamp}`;
  await a.locator('.chat-input-rich').click();
  await a.keyboard.type(text);
  await a.keyboard.press('Enter');

  // B reçoit le message (onglet ouvert automatiquement) et l'affiche en clair
  await expect(b.locator('.contact-row', { hasText: nameA })).toBeVisible({ timeout: 45000 });
  await b.locator('.contact-row', { hasText: nameA }).click();
  await expect(b.locator('.msg-content', { hasText: text })).toBeVisible({ timeout: 20000 });
  await expect(b.locator('.msg-auth-badge')).toHaveCount(0);
  await expect(b.getByText('Message rejected', { exact: false })).toHaveCount(0);

  // Après rechargement de l'historique depuis le serveur, toujours affiché
  await b.locator('.contact-row', { hasText: nameA }).click();
  await expect(b.locator('.msg-content', { hasText: text })).toBeVisible();
});
