import { test, expect, type Browser, type Page } from './test';

/**
 * E2E — connexion temps réel « muette » (téléphone sorti de veille, changement de réseau) :
 * la connexion paraît ouverte mais plus rien ne passe. Simulée en interceptant le WebSocket
 * de Socket.IO et en laissant tomber les trames, sans fermer la connexion.
 * - Retour au premier plan : la connexion est contrôlée et rétablie tout de suite, un message
 *   envoyé ensuite part normalement.
 * - Accusé perdu (le serveur a reçu le message, la réponse ne revient pas) : nouvel envoi
 *   automatique après reconnexion, sans « Non envoyé » ni doublon chez le destinataire.
 * Serveur + base temporaires (jamais la prod).
 */

const PASSWORD = 'MotDePasseE2E-1234';
const fakeClientIp = () => `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;

type Link = { up: boolean; down: boolean };

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

/**
 * A : WebSocket de Socket.IO relayé par le test, chaque sens pouvant être coupé en silence
 * (`up` : du navigateur vers le serveur, `down` : retour). B : connexion normale.
 */
const pair = async (browser: Browser) => {
  const stamp = Date.now();
  const nameA = `sra_${stamp}`;
  const nameB = `srb_${stamp}`;
  const links: Link[] = [];
  const ctxA = await browser.newContext({ locale: 'en-US', extraHTTPHeaders: { 'CF-Connecting-IP': fakeClientIp() } });
  await ctxA.routeWebSocket(/\/socket\.io\//, (ws) => {
    const server = ws.connectToServer();
    const link: Link = { up: true, down: true };
    links.push(link);
    ws.onMessage((msg) => { if (link.up) server.send(msg); });
    server.onMessage((msg) => { if (link.down) ws.send(msg); });
  });
  const a = await ctxA.newPage();
  await registerAndLogin(a, nameA);
  const ctxB = await browser.newContext({ locale: 'en-US', extraHTTPHeaders: { 'CF-Connecting-IP': fakeClientIp() } });
  const b = await ctxB.newPage();
  await registerAndLogin(b, nameB);

  expect((await a.request.post('/api/invite', { data: { receiverUsername: nameB } })).ok()).toBeTruthy();
  const meB = await (await b.request.get('/api/user/me')).json();
  const invites = await (await b.request.get(`/api/invitations/${meB.user.id}`)).json();
  expect((await b.request.post('/api/accept-invite', { data: { invitationId: invites[0].id } })).ok()).toBeTruthy();
  await expect(a.locator('.contact-row', { hasText: nameB })).toBeVisible({ timeout: 45000 });
  await expect(b.locator('.contact-row', { hasText: nameA })).toBeVisible({ timeout: 45000 });
  await a.locator('.contact-row', { hasText: nameB }).click();
  await b.locator('.contact-row', { hasText: nameA }).click();
  await expect.poll(() => links.length, { timeout: 20000 }).toBeGreaterThan(0);
  return { a, b, links, stamp };
};

const send = async (page: Page, text: string) => {
  await page.locator('.chat-input-rich').click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
};

test('retour au premier plan avec une connexion muette : reconnexion immédiate, message envoyé', async ({ browser }) => {
  test.setTimeout(120000);
  const { a, b, links, stamp } = await pair(browser);

  // La connexion devient muette (rien ne passe, dans aucun sens), puis l'app revient au premier plan
  const before = links.length;
  links.forEach((l) => { l.up = false; l.down = false; });
  await a.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  // Contrôle (3 s) sans réponse → nouvelle connexion, bien avant les 85 s de Socket.IO
  await expect.poll(() => links.length, { timeout: 15000 }).toBeGreaterThan(before);

  const text = `après veille ${stamp}`;
  await send(a, text);
  await expect(b.locator('.msg-content', { hasText: text })).toBeVisible({ timeout: 20000 });
  await expect(a.locator('.msg-send-failed')).toHaveCount(0);
});

test('accusé perdu : nouvel envoi automatique après reconnexion, sans doublon', async ({ browser }) => {
  test.setTimeout(150000);
  const { a, b, links, stamp } = await pair(browser);

  // Le serveur reçoit, mais plus rien ne revient (accusé perdu)
  links.forEach((l) => { l.down = false; });
  const text = `accusé perdu ${stamp}`;
  await send(a, text);
  await expect(b.locator('.msg-content', { hasText: text })).toBeVisible({ timeout: 20000 });

  // 15 s sans accusé → reconnexion forcée → renvoi (même mid, dédupliqué) → confirmé
  const line = a.locator('.msg-line', { hasText: text });
  await expect(line.locator('.msg-status-badge.status-sent, .msg-status-badge.status-delivered, .msg-status-badge.status-read')).toBeVisible({ timeout: 45000 });
  await expect(a.locator('.msg-send-failed')).toHaveCount(0);
  // Une seule copie chez le destinataire
  await b.waitForTimeout(1500);
  await expect(b.locator('.msg-content', { hasText: text })).toHaveCount(1);
});
