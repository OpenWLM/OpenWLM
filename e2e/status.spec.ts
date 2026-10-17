import { test, expect, type Browser, type Page } from '@playwright/test';

/**
 * E2E — statut restauré au redémarrage de l'app : un statut choisi à la main (Absent,
 * Apparaître hors ligne) est conservé après rechargement ; l'écran de connexion reprend le
 * dernier statut. Serveur + base temporaire lancés par playwright.config.ts (jamais la prod).
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
  // « Mémoriser » : la session survit au rechargement (redémarrage de l'app)
  await page.getByLabel('Remember my E2EE keys on this device').check();
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

const setStatus = async (page: Page, label: string) => {
  await page.locator('.status-trigger').click();
  await page.locator('.dropdown-item', { hasText: label }).first().click();
  await expect(page.locator('.status-label')).toContainText(label);
};

test('statut choisi conservé au redémarrage ; « Apparaître hors ligne » ne réapparaît pas', async ({ browser }) => {
  test.setTimeout(150000);
  const stamp = Date.now();
  const nameA = `sta_${stamp}`;
  const nameB = `stb_${stamp}`;
  const a = await newUserPage(browser, nameA);
  const b = await newUserPage(browser, nameB);

  expect((await a.request.post('/api/invite', { data: { receiverUsername: nameB } })).ok()).toBeTruthy();
  const meB = await (await b.request.get('/api/user/me')).json();
  const invites = await (await b.request.get(`/api/invitations/${meB.user.id}`)).json();
  expect((await b.request.post('/api/accept-invite', { data: { invitationId: invites[0].id } })).ok()).toBeTruthy();
  await expect(b.locator('.contact-row', { hasText: nameA })).toBeVisible({ timeout: 45000 });
  const aRowOnB = b.locator('.contact-row', { hasText: nameA }).locator('.status-square');

  // 1) Absent choisi à la main → conservé après redémarrage, et vu « away » par le contact
  await setStatus(a, 'Away');
  await a.reload();
  await expect(a.locator('.wlm-auth-container')).toHaveCount(0, { timeout: 45000 });
  await expect(a.locator('.status-label')).toContainText('Away', { timeout: 20000 });
  await expect(aRowOnB).toHaveClass(/away/, { timeout: 20000 });

  // 2) Apparaître hors ligne → après redémarrage, A reste hors ligne pour B
  await setStatus(a, 'Appear offline');
  await expect(aRowOnB).toHaveClass(/offline/, { timeout: 20000 });
  await a.reload();
  await expect(a.locator('.wlm-auth-container')).toHaveCount(0, { timeout: 45000 });
  await expect(a.locator('.status-label')).toContainText('Appear offline', { timeout: 20000 });
  // Laisser le temps à une éventuelle (mauvaise) diffusion « en ligne » d'arriver
  await b.waitForTimeout(3000);
  await expect(aRowOnB).toHaveClass(/offline/);
  await expect(b.locator('.wlm-desktop-toast', { hasText: nameA })).toHaveCount(0);

  // 3) Disponible → conservé, et l'écran de connexion reprend le dernier statut
  await setStatus(a, 'Available');
  await expect(aRowOnB).toHaveClass(/online/, { timeout: 20000 });
  await a.reload();
  await expect(a.locator('.status-label')).toContainText('Available', { timeout: 20000 });
  await setStatus(a, 'Busy');
  await a.locator('.status-trigger').click();
  await a.getByText('Sign out', { exact: true }).click();
  await expect(a.locator('.wlm-auth-form select')).toHaveValue('busy', { timeout: 15000 });
});

test('absence automatique (inactivité) → repasse « Disponible » au redémarrage', async ({ browser }) => {
  test.setTimeout(200000);
  const a = await newUserPage(browser, `stauto_${Date.now()}`);
  await expect(a.locator('.status-label')).toContainText('Available');

  // Délai d'inactivité minimal (1 min), puis aucune interaction
  await a.evaluate(() => localStorage.setItem('wlm_away_timeout', '1'));
  await a.reload();
  await expect(a.locator('.wlm-auth-container')).toHaveCount(0, { timeout: 45000 });
  await expect(a.locator('.status-label')).toContainText('Away', { timeout: 90000 });

  // Redémarrage pendant l'absence automatique : retour à « Disponible »
  await a.reload();
  await expect(a.locator('.wlm-auth-container')).toHaveCount(0, { timeout: 45000 });
  await expect(a.locator('.status-label')).toContainText('Available', { timeout: 20000 });
  const me = await (await a.request.get('/api/user/me')).json();
  expect(me.user.status).toBe('online');
});
