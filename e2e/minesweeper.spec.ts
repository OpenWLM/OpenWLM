import { test, expect, type Browser, type Page } from '@playwright/test';

/**
 * E2E — Démineur à deux (Minesweeper Flags) entre deux navigateurs : invitation depuis le
 * menu Jeux, coups alternés selon le tour, plateaux identiques des deux côtés, et aucune
 * trame WebSocket ne contient l'emplacement des mines pendant la partie.
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

const newUserPage = async (browser: Browser, username: string, beforeLogin?: (page: Page) => void) => {
  const ctx = await browser.newContext({ locale: 'en-US', extraHTTPHeaders: { 'CF-Connecting-IP': fakeClientIp() } });
  const page = await ctx.newPage();
  beforeLogin?.(page);
  await registerAndLogin(page, username);
  return page;
};

// État visible d'un plateau : une lettre par case (cachée, chiffre, drapeau bleu/rouge)
const boardSignature = (page: Page) => page.locator('.ms-grid .ms-cell').evaluateAll((cells) =>
  cells.map((c) => (c.classList.contains('ms-hidden') ? '.' : c.classList.contains('ms-flagged-blue') ? 'B'
    : c.classList.contains('ms-flagged-red') ? 'R' : (c.textContent || '0'))).join(''));

test('démineur : invitation, coups alternés, plateaux synchronisés, pas de fuite des mines', async ({ browser }) => {
  test.setTimeout(180000);
  const stamp = Date.now();
  const nameA = `msa_${stamp}`;
  const nameB = `msb_${stamp}`;
  // Toute trame reçue par les navigateurs est inspectée : jamais de liste de mines avant la fin.
  // L'écouteur est posé AVANT la connexion (les sockets s'ouvrent dès le login).
  const leaks: string[] = [];
  let inspected = 0;
  const watch = (p: Page) => {
    p.on('websocket', (ws) => ws.on('framereceived', (f) => {
      const txt = typeof f.payload === 'string' ? f.payload : '';
      if (txt.includes('minesweeper') || txt.includes('"revealed"')) {
        inspected++;
        if (/"mines":\[/.test(txt) && !/"winner":\d/.test(txt)) leaks.push(txt.slice(0, 200));
        if (/adjacent/.test(txt)) leaks.push(txt.slice(0, 200));
      }
    }));
  };
  const a = await newUserPage(browser, nameA, watch);
  const b = await newUserPage(browser, nameB, watch);

  expect((await a.request.post('/api/invite', { data: { receiverUsername: nameB } })).ok()).toBeTruthy();
  const meB = await (await b.request.get('/api/user/me')).json();
  const invites = await (await b.request.get(`/api/invitations/${meB.user.id}`)).json();
  expect((await b.request.post('/api/accept-invite', { data: { invitationId: invites[0].id } })).ok()).toBeTruthy();
  await expect(a.locator('.contact-row', { hasText: nameB })).toBeVisible({ timeout: 45000 });
  await expect(b.locator('.contact-row', { hasText: nameA })).toBeVisible({ timeout: 45000 });

  // A invite B au Démineur depuis le menu Jeux ; B accepte
  await a.locator('.contact-row', { hasText: nameB }).click();
  await a.getByText('Games ▾').click();
  await a.locator('.wlm-game-menu-item', { hasText: 'Minesweeper Flags' }).click();
  await b.locator('.contact-row', { hasText: nameA }).click();
  await expect(b.getByText('Invitation to Minesweeper Flags!')).toBeVisible({ timeout: 20000 });
  await b.locator('.btn-game-accept').click();

  await expect(a.locator('.ms-grid .ms-cell')).toHaveCount(256, { timeout: 20000 });
  await expect(b.locator('.ms-grid .ms-cell')).toHaveCount(256, { timeout: 20000 });
  await expect(a.locator('.ms-grid')).toHaveClass(/ms-grid-active/, { timeout: 10000 });
  await expect(b.locator('.ms-grid')).not.toHaveClass(/ms-grid-active/);
  await expect(a.getByTestId('ms-remaining')).toHaveText('51');

  // Une vingtaine de coups : celui dont c'est le tour clique une case cachée
  for (let move = 0; move < 20; move++) {
    const aTurn = await a.locator('.ms-grid.ms-grid-active').count() > 0;
    const player = aTurn ? a : b;
    const before = await boardSignature(player);
    const hidden = player.locator('.ms-grid .ms-cell.ms-hidden');
    if (await hidden.count() === 0) break;
    await hidden.nth(Math.floor(Math.random() * await hidden.count())).click();
    await expect.poll(() => boardSignature(player), { timeout: 10000 }).not.toBe(before);
    // Les deux joueurs voient exactement le même plateau
    await expect.poll(async () => (await boardSignature(a)) === (await boardSignature(b)), { timeout: 10000 }).toBe(true);
    if (await a.locator('.banner-me, .banner-opponent').count() > 0) break;
  }

  // Compteur central cohérent : 51 − drapeaux posés
  const sig = await boardSignature(a);
  const flags = (sig.match(/[BR]/g) || []).length;
  await expect(a.getByTestId('ms-remaining')).toHaveText(String(51 - flags));
  await expect(b.getByTestId('ms-remaining')).toHaveText(String(51 - flags));
  // Exactement un des deux joueurs a la main
  const activeCount = (await a.locator('.ms-grid.ms-grid-active').count()) + (await b.locator('.ms-grid.ms-grid-active').count());
  expect(activeCount).toBe(1);
  expect(inspected, 'des trames de jeu ont bien été inspectées').toBeGreaterThan(5);
  expect(leaks, `fuite des mines : ${leaks[0] || ''}`).toHaveLength(0);
});
