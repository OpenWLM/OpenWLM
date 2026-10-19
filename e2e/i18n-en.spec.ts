import { test, expect, type Browser, type Page } from '@playwright/test';

/**
 * E2E — interface en anglais : alertes, lignes système, contact de test et erreurs du serveur
 * ne doivent plus apparaître en français. Serveur + base temporaire (jamais la prod).
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
  page.once('dialog', (d) => { d.accept().catch(() => {}); }); // « inscription réussie »
  await page.locator('button.wlm-btn-auth').click();
  await expect(page.locator('.auth-captcha-container')).toHaveCount(0, { timeout: 20000 });
  await page.locator('.auth-field input[type="text"]').first().fill(username);
  await page.locator('.auth-field input[type="password"]').fill(PASSWORD);
  await page.locator('button.wlm-btn-auth').click();
  await expect(page.locator('.wlm-auth-container')).toHaveCount(0, { timeout: 45000 });
};

const newUserPage = async (browser: Browser, username: string) => {
  const ctx = await browser.newContext({ locale: 'en-US', extraHTTPHeaders: { 'CF-Connecting-IP': fakeClientIp() } });
  const page = await ctx.newPage();
  await registerAndLogin(page, username);
  return page;
};

// Texte d'une alerte déclenchée par `action`
// (l'alerte est fermée dès son ouverture : sinon elle bloque la page et le clic qui l'a ouverte)
const alertText = async (page: Page, action: () => Promise<void>) => {
  const shown = new Promise<string>((resolve) => {
    page.once('dialog', (d) => { resolve(d.message()); d.accept().catch(() => {}); });
  });
  await action();
  return shown;
};

test('interface anglaise : alertes, lignes système, contact de test et erreurs serveur en anglais', async ({ browser }) => {
  test.setTimeout(150000);
  const stamp = Date.now();
  const nameA = `i18na_${stamp}`;
  const nameB = `i18nb_${stamp}`;

  // Erreur serveur traduite (code) : mauvais mot de passe à la connexion
  const ctx = await browser.newContext({ locale: 'en-US', extraHTTPHeaders: { 'CF-Connecting-IP': fakeClientIp() } });
  const anon = await ctx.newPage();
  await anon.goto('/');
  await anon.locator('.auth-field input[type="text"]').first().fill(`nobody_${stamp}`);
  await anon.locator('.auth-field input[type="password"]').fill('wrong password 123');
  await anon.locator('button.wlm-btn-auth').click();
  await expect(anon.locator('.auth-error')).toHaveText('Invalid sign-in address or password.', { timeout: 30000 });
  await ctx.close();

  const a = await newUserPage(browser, nameA);
  const b = await newUserPage(browser, nameB);

  // Contact de test : accueil et en-tête en anglais
  await a.locator('.contact-row', { hasText: 'OpenWLM' }).click();
  await expect(a.locator('.msg-line', { hasText: 'Send a message to test the echo' })).toBeVisible({ timeout: 10000 });
  await expect(a.locator('.conv-psm')).toHaveText('Online for testing');
  expect(await alertText(a, () => a.getByText('Private Mode', { exact: true }).click())).toBe('The conversation with OpenWLM is local and is not stored on the server.');

  // Erreur serveur d'invitation traduite (code) : s'ajouter soi-même
  await a.locator('[title="Add a contact"]').click();
  await a.locator('.modal-box input[type="email"]').fill(nameA);
  expect(await alertText(a, () => a.locator('.modal-box').getByRole('button', { name: 'OK', exact: true }).click())).toBe('You cannot add yourself.');
  await a.locator('.modal-box .win-close-btn').click();

  // Mise en contact
  expect((await a.request.post('/api/invite', { data: { receiverUsername: nameB } })).ok()).toBeTruthy();
  const meB = await (await b.request.get('/api/user/me')).json();
  const invites = await (await b.request.get(`/api/invitations/${meB.user.id}`)).json();
  expect((await b.request.post('/api/accept-invite', { data: { invitationId: invites[0].id } })).ok()).toBeTruthy();
  await expect(a.locator('.contact-row', { hasText: nameB })).toBeVisible({ timeout: 45000 });
  await expect(b.locator('.contact-row', { hasText: nameA })).toBeVisible({ timeout: 45000 });
  await a.locator('.contact-row', { hasText: nameB }).click();
  await b.locator('.contact-row', { hasText: nameA }).click();

  // Lignes système (mode privé, Wizz) en anglais, des deux côtés
  await a.getByText('Private Mode', { exact: true }).click();
  await expect(a.locator('.msg-system', { hasText: 'You turned private mode on. Messages will no longer be stored.' })).toBeVisible();
  await expect(b.locator('.msg-system', { hasText: `${nameA} turned private mode on. Messages will not be stored.` })).toBeVisible({ timeout: 15000 });
  await a.locator('[title="Nudge!"]').first().click();
  await expect(a.locator('.msg-system', { hasText: 'You just sent a nudge!' })).toBeVisible();
  await expect(b.locator('.msg-system', { hasText: 'You just received a nudge!' })).toBeVisible({ timeout: 15000 });

  // Aucune trace de français dans les lignes système
  const systemTexts = (await a.locator('.msg-system').allInnerTexts()).concat(await b.locator('.msg-system').allInnerTexts());
  for (const text of systemTexts) expect(text).not.toMatch(/Vous|activé|Wizz|Système/);
});
