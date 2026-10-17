import { test, expect, type Browser, type Page } from '@playwright/test';

/**
 * E2E — notification de connexion : quand un contact se connecte, un toast Aero
 * « Pseudo has just signed in » s'affiche (comme pour un message reçu).
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

test('connexion d\'un contact → toast « has just signed in »', async ({ browser }) => {
  test.setTimeout(150000);
  const stamp = Date.now();
  const nameA = `sia_${stamp}`;
  const nameB = `sib_${stamp}`;
  const a = await newUserPage(browser, nameA);
  const aConnectedAt = Date.now();
  const b = await newUserPage(browser, nameB);

  expect((await a.request.post('/api/invite', { data: { receiverUsername: nameB } })).ok()).toBeTruthy();
  const meB = await (await b.request.get('/api/user/me')).json();
  const invites = await (await b.request.get(`/api/invitations/${meB.user.id}`)).json();
  expect((await b.request.post('/api/accept-invite', { data: { invitationId: invites[0].id } })).ok()).toBeTruthy();
  await expect(a.locator('.contact-row', { hasText: nameB })).toBeVisible({ timeout: 45000 });

  // B se déconnecte (passe hors ligne immédiatement chez A)
  await b.locator('.status-trigger').click();
  await b.getByText('Sign out', { exact: true }).click();
  await expect(b.locator('.wlm-auth-form')).toBeVisible({ timeout: 15000 });

  // Laisser passer la fenêtre de silence qui suit la connexion de A (10 s)
  const wait = 11000 - (Date.now() - aConnectedAt);
  if (wait > 0) await a.waitForTimeout(wait);
  await a.waitForTimeout(1500);
  await expect(a.locator('.wlm-desktop-toast')).toHaveCount(0);

  // B se reconnecte → A reçoit le toast
  await b.locator('.auth-field input[type="text"]').first().fill(nameB);
  await b.locator('.auth-field input[type="password"]').fill(PASSWORD);
  await b.locator('button.wlm-btn-auth').click();

  // Le toast arrive dès la connexion du socket de B (il disparaît seul après 4,5 s) :
  // on le guette tout de suite et on le survole pour le garder affiché.
  const toast = a.locator('.wlm-desktop-toast', { hasText: nameB });
  await expect(toast).toBeVisible({ timeout: 30000 });
  await toast.hover();
  await expect(toast).toContainText('has just signed in');
  await expect(b.locator('.wlm-auth-container')).toHaveCount(0, { timeout: 45000 });
  await expect(toast.locator('.wlm-desktop-toast-message')).toHaveCount(0);
  await toast.locator('.wlm-desktop-toast-close-btn').click();
  await a.mouse.move(0, 0);
  await expect(a.locator('.wlm-desktop-toast')).toHaveCount(0);

  // « Apparaître hors ligne » puis « Disponible » : même notification (comme sur MSN)
  await b.locator('.status-trigger').click();
  await b.locator('.dropdown-item', { hasText: 'Appear offline' }).click();
  await a.waitForTimeout(1500);
  await expect(a.locator('.wlm-desktop-toast')).toHaveCount(0);
  await b.locator('.status-trigger').click();
  await b.locator('.dropdown-item', { hasText: 'Available' }).click();
  await expect(a.locator('.wlm-desktop-toast', { hasText: nameB })).toBeVisible({ timeout: 20000 });
});
