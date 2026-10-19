import { test, expect, type Browser, type Page } from './test';

/**
 * E2E — message reçu alors qu'aucune conversation n'est ouverte : l'onglet apparaît et
 * clignote (non lu), le contact est mis en avant, le titre de la page compte les non lus ;
 * tout s'efface à l'ouverture de la conversation.
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

test('non lus : onglet visible et clignotant sans conversation ouverte, effacé à la lecture', async ({ browser }) => {
  test.setTimeout(150000);
  const stamp = Date.now();
  const nameA = `unra_${stamp}`;
  const nameB = `unrb_${stamp}`;
  const a = await newUserPage(browser, nameA);
  const b = await newUserPage(browser, nameB);
  expect((await a.request.post('/api/invite', { data: { receiverUsername: nameB } })).ok()).toBeTruthy();
  const meB = await (await b.request.get('/api/user/me')).json();
  const invites = await (await b.request.get(`/api/invitations/${meB.user.id}`)).json();
  expect((await b.request.post('/api/accept-invite', { data: { invitationId: invites[0].id } })).ok()).toBeTruthy();
  await expect(b.locator('.contact-row', { hasText: nameA })).toBeVisible({ timeout: 45000 });
  await expect(a.locator('.contact-row', { hasText: nameB })).toBeVisible({ timeout: 45000 });

  // A n'a aucune conversation ouverte (écran d'accueil)
  await expect(a.locator('.empty-chat-state')).toBeVisible();
  await b.locator('.contact-row', { hasText: nameA }).click();
  for (const n of [1, 2]) {
    await b.locator('.chat-input-rich').click();
    await b.keyboard.type(`unread ${n} ${stamp}`);
    await b.keyboard.press('Enter');
  }

  const tab = a.locator('.chat-tab', { hasText: nameB });
  await expect(tab).toBeVisible({ timeout: 20000 });
  // Flèche normale sur un onglet (pas de main), main seulement sur le ✕ de fermeture
  expect(await tab.evaluate((el) => getComputedStyle(el).cursor)).toBe('default');
  expect(await tab.locator('.chat-tab-close').evaluate((el) => getComputedStyle(el).cursor)).toBe('pointer');
  await expect(tab).toHaveClass(/unread/);
  await expect(tab.locator('.chat-tab-unread')).toHaveText('2', { timeout: 20000 });
  await expect(a.locator('.contact-row.contact-unread', { hasText: nameB })).toBeVisible();
  await expect(a).toHaveTitle('(2) OpenWLM');
  await expect(a.locator('.wlm-desktop-toast', { hasText: nameB }).first()).toBeVisible();

  // Ouverture de la conversation : lue, plus rien ne clignote
  await tab.click();
  await expect(a.locator('.msg-line', { hasText: `unread 2 ${stamp}` })).toBeVisible({ timeout: 20000 });
  await expect(tab).not.toHaveClass(/unread/);
  await expect(a.locator('.contact-row.contact-unread')).toHaveCount(0);
  await expect(a).toHaveTitle('OpenWLM');

  // Conversation affichée et fenêtre au premier plan : un nouveau message n'est pas « non lu »
  await b.locator('.chat-input-rich').click();
  await b.keyboard.type(`live ${stamp}`);
  await b.keyboard.press('Enter');
  await expect(a.locator('.msg-line', { hasText: `live ${stamp}` })).toBeVisible({ timeout: 20000 });
  await expect(tab).not.toHaveClass(/unread/);
  await expect(a).toHaveTitle('OpenWLM');
});
