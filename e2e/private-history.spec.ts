import { test, expect, type Browser, type Page } from '@playwright/test';

/**
 * E2E — messages en mode privé : jamais perdus à l'ouverture d'un onglet (le message reçu
 * alors que l'onglet n'était pas ouvert reste affiché après le chargement de l'historique
 * serveur), et conservés après un rechargement grâce à la copie locale chiffrée.
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

test('mode privé : message reçu onglet fermé affiché, puis retrouvé après rechargement', async ({ browser }) => {
  test.setTimeout(180000);
  const stamp = Date.now();
  const nameA = `pha_${stamp}`;
  const nameB = `phb_${stamp}`;
  const a = await newUserPage(browser, nameA);
  const b = await newUserPage(browser, nameB);
  expect((await a.request.post('/api/invite', { data: { receiverUsername: nameB } })).ok()).toBeTruthy();
  const meB = await (await b.request.get('/api/user/me')).json();
  const invites = await (await b.request.get(`/api/invitations/${meB.user.id}`)).json();
  expect((await b.request.post('/api/accept-invite', { data: { invitationId: invites[0].id } })).ok()).toBeTruthy();
  await expect(b.locator('.contact-row', { hasText: nameA })).toBeVisible({ timeout: 45000 });
  await expect(a.locator('.contact-row', { hasText: nameB })).toBeVisible({ timeout: 45000 });

  // Un message normal d'abord (historique serveur), puis B passe la conversation en privé
  await b.locator('.contact-row', { hasText: nameA }).click();
  const send = async (text: string) => {
    await b.locator('.chat-input-rich').click();
    await b.keyboard.type(text);
    await b.keyboard.press('Enter');
  };
  await send(`normal ${stamp}`);
  await b.getByText('Private Mode', { exact: true }).click();
  await expect(b.locator('.padlock-badge')).toBeVisible({ timeout: 10000 });

  // A n'a PAS ouvert l'onglet : le message privé l'ouvre et doit rester affiché
  await send(`secret ${stamp}`);
  await a.locator('.contact-row', { hasText: nameB }).click();
  await expect(a.locator('.msg-line', { hasText: `normal ${stamp}` })).toBeVisible({ timeout: 20000 });
  await expect(a.locator('.msg-line', { hasText: `secret ${stamp}` })).toBeVisible({ timeout: 20000 });
  // Laisser le chargement de l'historique serveur se terminer : le message privé reste là
  await a.waitForTimeout(2500);
  await expect(a.locator('.msg-line', { hasText: `secret ${stamp}` })).toBeVisible();

  // Rechargement de l'app : retrouvé grâce à la copie locale chiffrée (option par défaut)
  await a.reload();
  await expect(a.locator('.wlm-auth-container')).toHaveCount(0, { timeout: 45000 });
  await a.locator('.contact-row', { hasText: nameB }).click();
  await expect(a.locator('.msg-line', { hasText: `normal ${stamp}` })).toBeVisible({ timeout: 20000 });
  await expect(a.locator('.msg-line', { hasText: `secret ${stamp}` })).toBeVisible({ timeout: 20000 });
  // Ordre chronologique conservé
  const lines = await a.locator('.msg-line').allInnerTexts();
  expect(lines.findIndex((l) => l.includes(`normal ${stamp}`))).toBeLessThan(lines.findIndex((l) => l.includes(`secret ${stamp}`)));
  // Le serveur, lui, n'a jamais stocké le message privé
  const meA = await (await a.request.get('/api/user/me')).json();
  const hist = await (await a.request.get(`/api/messages/${meA.user.id}/${meB.user.id}`)).json();
  expect(hist.length).toBe(1);

  // Sans copie locale : le message privé n'est pas conservé après rechargement
  await a.locator('.status-trigger').click();
  await a.locator('.dropdown-item', { hasText: 'Options' }).first().click();
  await a.locator('.options-nav-item', { hasText: 'Messages' }).click();
  // Désactiver efface la copie : confirmation dans l'onglet (Annuler la garde intacte)
  await a.locator('#pref-local-history').click();
  await a.getByTestId('clear-local-confirm').getByRole('button', { name: 'Cancel' }).click();
  await expect(a.locator('#pref-local-history')).toBeChecked();
  await a.locator('#pref-local-history').click();
  await a.getByTestId('clear-local-confirm').getByRole('button', { name: 'Yes, delete' }).click();
  await expect(a.locator('#pref-local-history')).not.toBeChecked();
  await a.getByRole('button', { name: 'OK', exact: true }).click();
  await a.reload();
  await expect(a.locator('.wlm-auth-container')).toHaveCount(0, { timeout: 45000 });
  await a.locator('.contact-row', { hasText: nameB }).click();
  await expect(a.locator('.msg-line', { hasText: `normal ${stamp}` })).toBeVisible({ timeout: 20000 });
  await expect(a.locator('.msg-line', { hasText: `secret ${stamp}` })).toHaveCount(0);
});
