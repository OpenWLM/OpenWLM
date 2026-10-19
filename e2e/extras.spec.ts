import { test, expect, type Browser, type Page } from '@playwright/test';

/**
 * E2E — mise en forme (couleurs, dégradés), commandes « / », rappel des messages (Ctrl+↑),
 * textes rapides, recherche (Ctrl+F) et aide. Deux comptes, interface anglaise.
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

const newUserPage = async (browser: Browser, username: string) => {
  const ctx = await browser.newContext({ locale: 'en-US', extraHTTPHeaders: { 'CF-Connecting-IP': fakeClientIp() } });
  const page = await ctx.newPage();
  await registerAndLogin(page, username);
  return page;
};

const input = (p: Page) => p.locator('.chat-input-rich');
const typeAndSend = async (p: Page, text: string) => {
  await input(p).click();
  await p.keyboard.type(text);
  await p.keyboard.press('Enter');
};
const lastMessage = (p: Page) => p.locator('.chat-log-scroll .msg-line').last();
const dialogText = (p: Page) => p.getByTestId('aero-dialog-message');
const closeDialog = async (p: Page) => {
  await p.getByTestId('aero-dialog').getByRole('button', { name: 'OK', exact: true }).click();
  await expect(p.getByTestId('aero-dialog')).toHaveCount(0);
};

test('mise en forme, commandes, rappel, textes rapides, recherche et aide', async ({ browser }) => {
  test.setTimeout(180000);
  const stamp = Date.now();
  const nameA = `xa_${stamp}`;
  const nameB = `xb_${stamp}`;
  const a = await newUserPage(browser, nameA);
  const b = await newUserPage(browser, nameB);
  expect((await a.request.post('/api/invite', { data: { receiverUsername: nameB } })).ok()).toBeTruthy();
  const meB = await (await b.request.get('/api/user/me')).json();
  const invites = await (await b.request.get(`/api/invitations/${meB.user.id}`)).json();
  expect((await b.request.post('/api/accept-invite', { data: { invitationId: invites[0].id } })).ok()).toBeTruthy();
  await expect(a.locator('.contact-row', { hasText: nameB })).toBeVisible({ timeout: 45000 });
  await expect(b.locator('.contact-row', { hasText: nameA })).toBeVisible({ timeout: 45000 });
  await a.locator('.contact-row', { hasText: nameB }).click();
  await b.locator('.contact-row', { hasText: nameA }).click();

  // --- Liste d'aide des commandes + complétion (Tab) + changement de statut
  await input(a).click();
  await a.keyboard.type('/');
  await expect(a.getByTestId('command-helper')).toContainText('/me');
  await a.keyboard.type('bu');
  await expect(a.getByTestId('command-helper')).toContainText('/busy');
  await a.keyboard.press('Tab');
  await expect(input(a)).toHaveText('/busy ');
  await a.keyboard.press('Enter');
  await expect(a.locator('.status-label')).toContainText('Busy', { timeout: 10000 });
  await expect(a.getByTestId('command-helper')).toHaveCount(0);

  // --- Pseudo mis en forme : chez le contact, rouge et gras dans la liste
  await typeAndSend(a, `/nick [c=4][b]Rouge[/b][/c] ${nameA}`);
  const rowA = b.locator('.contact-row', { hasText: nameA });
  await expect(rowA.locator('span[style*="color: rgb(255, 0, 0)"]', { hasText: 'Rouge' })).toBeVisible({ timeout: 20000 });
  await expect(rowA).not.toContainText('[c=4]');
  // Longueur visible limitée à 50 (les balises ne comptent pas)
  await typeAndSend(a, `/nick [c=4]${'x'.repeat(51)}[/c]`);
  await expect(dialogText(a)).toHaveText('Nickname too long: 50 visible characters at most.');
  await closeDialog(a);
  await input(a).press('Control+a');
  await input(a).press('Delete');

  // --- Message en couleur et en dégradé
  await typeAndSend(a, `[c=#00AA00]vert[/c] et [c=4]degrade[/c=12] ${stamp}`);
  const msg = b.locator('.chat-log-scroll .msg-line', { hasText: String(stamp) }).last();
  await expect(msg.locator('span[style*="color: rgb(0, 170, 0)"]', { hasText: 'vert' })).toBeVisible({ timeout: 20000 });
  await expect(msg.locator('.fmt-gradient-text', { hasText: 'degrade' })).toBeVisible();
  // Option désactivée : texte simple, sans balises ni couleurs
  await b.locator('.status-trigger').click();
  await b.locator('.dropdown-item', { hasText: 'Options' }).first().click();
  await b.locator('.options-nav-item', { hasText: 'Messages' }).click();
  await b.locator('#pref-formatting').click();
  await b.keyboard.press('Escape');
  await expect(msg).toContainText(`vert et degrade ${stamp}`);
  await expect(msg.locator('.fmt-gradient-text')).toHaveCount(0);
  await b.locator('.status-trigger').click();
  await b.locator('.dropdown-item', { hasText: 'Options' }).first().click();
  await b.locator('.options-nav-item', { hasText: 'Messages' }).click();
  await b.locator('#pref-formatting').click();
  await b.keyboard.press('Escape');

  // --- /me, « // », commande inconnue
  await typeAndSend(a, `/me danse ${stamp}`);
  await expect(b.getByTestId('msg-action').last()).toContainText(`danse ${stamp}`, { timeout: 20000 });
  await expect(b.getByTestId('msg-action').last()).toContainText('* Rouge');
  await typeAndSend(a, `//slash ${stamp}`);
  await expect(lastMessage(b)).toContainText(`/slash ${stamp}`, { timeout: 20000 });
  await typeAndSend(a, '/inconnue');
  await expect(dialogText(a)).toContainText('Unknown command: /inconnue');
  await closeDialog(a);

  // --- Rappel des messages envoyés (Ctrl+↑ / Ctrl+↓)
  await input(a).press('Control+a');
  await input(a).press('Delete');
  await input(a).press('Control+ArrowUp');
  await expect(input(a)).toHaveText('/inconnue');
  await input(a).press('Control+ArrowUp');
  await expect(input(a)).toHaveText(`//slash ${stamp}`);
  await input(a).press('Control+ArrowDown');
  await expect(input(a)).toHaveText('/inconnue');
  await input(a).press('Control+ArrowDown');
  await expect(input(a)).toHaveText('');

  // --- 🎨 sans sélection : balises insérées, curseur entre les deux
  await a.getByTestId('chat-format-picker').click();
  await a.getByRole('button', { name: '4 #FF0000' }).click();
  await expect(input(a)).toHaveText('[c=4][/c]');
  await a.keyboard.type('rouge');
  await expect(input(a)).toHaveText('[c=4]rouge[/c]');
  await input(a).press('Control+a');
  await input(a).press('Delete');

  // --- Texte rapide : créé dans Options → Messages, « /salut » envoie le texte avec (!N)
  await a.locator('.status-trigger').click();
  await a.locator('.dropdown-item', { hasText: 'Options' }).first().click();
  // Le panneau 🎨 du pseudo (haut de l'onglet Personnel) reste entièrement visible
  await a.locator('.options-nav-item', { hasText: 'Personal' }).click();
  await a.getByTestId('nickname-format-picker').click();
  const panel = await a.locator('.fmt-picker-panel').boundingBox();
  const area = await a.locator('.options-content').boundingBox();
  expect(panel!.y).toBeGreaterThanOrEqual(area!.y);
  await a.getByTestId('nickname-format-picker').click();
  await expect(a.locator('.fmt-picker-panel')).toHaveCount(0);
  await a.locator('.options-nav-item', { hasText: 'Messages' }).click();
  await a.locator('#qt-shortcut').fill('me');
  await a.locator('#qt-text').fill('reserved');
  await a.getByTestId('quick-texts').getByRole('button', { name: 'Add' }).click();
  await expect(a.getByTestId('quick-texts')).toContainText('This shortcut is already a command.');
  await a.locator('#qt-shortcut').fill('salut');
  await a.locator('#qt-text').fill('Salut (!N) !');
  await a.getByTestId('quick-texts').getByRole('button', { name: 'Add' }).click();
  await expect(a.getByTestId('quick-texts')).toContainText('/salut');
  await a.keyboard.press('Escape');
  await input(a).click();
  await a.keyboard.type('/sal');
  await expect(a.getByTestId('command-helper')).toContainText('Salut (!N) !');
  await a.keyboard.press('Tab');
  await a.keyboard.press('Enter');
  await expect(lastMessage(b)).toContainText(`Salut ${nameB} !`, { timeout: 20000 });

  // --- /all : envoyé à toutes les conversations ouvertes
  await typeAndSend(a, `/all a tous ${stamp}`);
  await expect(dialogText(a)).toHaveText('Message sent to 1 conversation(s).');
  await closeDialog(a);
  await expect(lastMessage(b)).toContainText(`a tous ${stamp}`, { timeout: 20000 });

  // --- Recherche (Ctrl+F) chez B
  await b.locator('.chat-log-scroll').click();
  await b.keyboard.press('Control+f');
  const search = b.getByTestId('conversation-search');
  await expect(search).toBeVisible();
  await search.getByRole('searchbox').or(search.locator('input')).fill(String(stamp));
  await expect(b.getByTestId('search-count')).toHaveText(/^\d+\/\d+$/);
  expect(await b.evaluate(() => (CSS as unknown as { highlights: Map<string, unknown> }).highlights.has('wlm-search'))).toBe(true);
  await search.locator('input').fill('introuvable-xyz');
  await expect(b.getByTestId('search-count')).toHaveText('No results');
  await search.locator('input').press('Escape');
  await expect(search).toHaveCount(0);

  // --- /clear : vide l'affichage de la conversation
  await typeAndSend(a, '/clear');
  await expect(a.locator('.chat-log-scroll .msg-line')).toHaveCount(0);

  // --- Aide : depuis le menu, puis depuis l'écran de connexion
  await a.locator('.status-trigger').click();
  await a.locator('.dropdown-item', { hasText: 'Help' }).first().click();
  const help = a.getByTestId('help-modal');
  await expect(help).toBeVisible();
  await help.getByRole('tab', { name: 'Commands' }).click();
  await expect(help).toContainText('/me <text>');
  await help.getByRole('tab', { name: 'Formatting' }).click();
  await expect(help.locator('.fmt-gradient-text')).toBeVisible();
  await a.keyboard.press('Escape');
  await expect(help).toHaveCount(0);

  const ctx = await browser.newContext({ locale: 'en-US', extraHTTPHeaders: { 'CF-Connecting-IP': fakeClientIp() } });
  const anon = await ctx.newPage();
  await anon.goto('/');
  await anon.getByRole('button', { name: 'Help' }).click();
  await expect(anon.getByTestId('help-modal')).toBeVisible();
  await ctx.close();
});
