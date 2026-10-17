import { test, expect, type Browser, type Page } from '@playwright/test';

/**
 * E2E — Options → Disposition, Messages et Sons : chaque réglage a un effet réel.
 * Trois comptes (A observe et règle, B et C sont ses contacts). Serveur + base temporaire
 * lancés par playwright.config.ts (jamais la prod).
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

const befriend = async (a: Page, b: Page, nameB: string) => {
  expect((await a.request.post('/api/invite', { data: { receiverUsername: nameB } })).ok()).toBeTruthy();
  const meB = await (await b.request.get('/api/user/me')).json();
  const invites = await (await b.request.get(`/api/invitations/${meB.user.id}`)).json();
  const inv = invites.find((i: { username?: string }) => i.username) ?? invites[0];
  expect((await b.request.post('/api/accept-invite', { data: { invitationId: inv.id } })).ok()).toBeTruthy();
};
const openOptionsTab = async (p: Page, tab: string) => {
  await p.locator('.status-trigger').click();
  await p.locator('.dropdown-item', { hasText: 'Options' }).first().click();
  await p.locator('.options-nav-item', { hasText: tab }).click();
};
const closeOptions = (p: Page) => p.getByRole('button', { name: 'OK', exact: true }).click();
const setStatus = async (p: Page, label: string) => {
  await p.locator('.status-trigger').click();
  await p.locator('.dropdown-item', { hasText: label }).first().click();
};
const sendText = async (p: Page, text: string) => {
  await p.locator('.chat-input-rich').click();
  await p.keyboard.type(text);
  await p.keyboard.press('Enter');
};

test('options : disposition, messages et sons appliqués', async ({ browser }) => {
  test.setTimeout(240000);
  const stamp = Date.now();
  const nameA = `opta_${stamp}`;
  const nameB = `zzoptb_${stamp}`; // « zz… » : dernier par ordre alphabétique
  const nameC = `aaoptc_${stamp}`; // « aa… » : premier par ordre alphabétique
  const a = await newUserPage(browser, nameA);
  const soundLog: string[] = [];
  a.on('console', (m) => { if (m.text().includes('[SoundManager] Reproduction')) soundLog.push(m.text()); });
  const b = await newUserPage(browser, nameB);
  const c = await newUserPage(browser, nameC);
  await befriend(a, b, nameB);
  await befriend(a, c, nameC);
  const rowB = a.locator('.contact-row', { hasText: nameB });
  const rowC = a.locator('.contact-row', { hasText: nameC });
  await expect(rowB).toBeVisible({ timeout: 45000 });
  await expect(rowC).toBeVisible({ timeout: 45000 });

  // --- Disposition : tri par statut (B Disponible avant C Occupé) puis par nom (C « aa » avant B « zz »)
  await setStatus(c, 'Busy');
  await expect(rowC.locator('.status-square')).toHaveClass(/busy/, { timeout: 20000 });
  const order = async () => (await a.locator('.contact-row').allInnerTexts()).filter((t) => t.includes(nameB) || t.includes(nameC)).map((t) => (t.includes(nameB) ? 'B' : 'C')).join('');
  expect(await order()).toBe('BC');
  await openOptionsTab(a, 'Layout');
  await a.locator('#pref-sort-name').check();
  await closeOptions(a);
  expect(await order()).toBe('CB');

  // --- Disposition : messages perso, contact de test, contacts hors ligne
  await b.locator('.user-psm-display').click();
  await b.keyboard.press('Control+A');
  await b.keyboard.type(`psm_${stamp}`);
  await b.keyboard.press('Enter');
  await expect(rowB).toContainText(`psm_${stamp}`, { timeout: 20000 });
  await expect(a.locator('.wlm-bot-badge')).toHaveCount(1);
  await openOptionsTab(a, 'Layout');
  await a.locator('#pref-show-psm').uncheck();
  await a.locator('#pref-show-bot').uncheck();
  await closeOptions(a);
  await expect(rowB).not.toContainText(`psm_${stamp}`);
  await expect(a.locator('.wlm-bot-badge')).toHaveCount(0);

  await c.locator('.status-trigger').click();
  await c.getByText('Sign out', { exact: true }).click();
  await expect(rowC.locator('.status-square')).toHaveClass(/offline/, { timeout: 20000 });
  await openOptionsTab(a, 'Layout');
  await a.locator('#pref-show-offline').uncheck();
  await closeOptions(a);
  await expect(rowC).toHaveCount(0);

  // --- Messages : émoticônes et heure
  await b.locator('.contact-row', { hasText: nameA }).click();
  await sendText(b, `hello :) ${stamp}`);
  await rowB.click();
  const msg = a.locator('.msg-line', { hasText: `hello` });
  await expect(msg.locator('img.inline-emoticon')).toHaveCount(1, { timeout: 20000 });
  await expect(a.locator('.msg-time').first()).toBeVisible();
  await openOptionsTab(a, 'Messages');
  await a.locator('#pref-emoticons').uncheck();
  await a.locator('#pref-timestamps').uncheck();
  await closeOptions(a);
  await expect(msg.locator('img.inline-emoticon')).toHaveCount(0);
  await expect(msg).toContainText(':)');
  await expect(a.locator('.msg-time')).toHaveCount(0);

  // --- Sons : coupés → aucun son de message à la réception
  const before = soundLog.filter((l) => l.includes('NEW_MESSAGE')).length;
  expect(before, 'un son de message a bien été joué quand les sons étaient actifs').toBeGreaterThan(0);
  await openOptionsTab(a, 'Sounds');
  await a.locator('#pref-sounds').uncheck();
  await expect(a.locator('#pref-snd-message')).toBeDisabled();
  await closeOptions(a);
  await sendText(b, `silence ${stamp}`);
  await expect(a.locator('.msg-line', { hasText: `silence ${stamp}` })).toBeVisible({ timeout: 20000 });
  await a.waitForTimeout(500);
  expect(soundLog.filter((l) => l.includes('NEW_MESSAGE')).length).toBe(before);

  // --- Messages : Wizz sans secousse, clin d'œil non joué automatiquement
  await openOptionsTab(a, 'Messages');
  await a.locator('#pref-nudges').uncheck();
  await a.locator('#pref-winks').uncheck();
  await closeOptions(a);
  await b.getByTitle('Nudge!').click();
  await expect(a.locator('.msg-system', { hasText: 'secousse désactivée' })).toBeVisible({ timeout: 20000 });
  await expect(a.locator('.wlm-desktop.wlm-nudge')).toHaveCount(0);
  await b.getByTitle('Winks').click();
  await b.locator('.scene-thumb').first().click();
  const watch = a.getByRole('button', { name: '▶ Watch' });
  await expect(watch).toBeVisible({ timeout: 20000 });
  await expect(a.locator('.wink-overlay')).toHaveCount(0);
  await watch.click();
  await expect(a.locator('.wink-overlay')).toBeVisible();

  // --- Messages : plus de copie locale → base IndexedDB vidée
  await a.locator('.wink-overlay').click();
  await openOptionsTab(a, 'Messages');
  await a.locator('#pref-local-history').uncheck();
  await expect(a.getByText('Local copy deleted.')).toBeVisible({ timeout: 10000 });
  await closeOptions(a);
  const cached = await a.evaluate(() => new Promise<number>((resolve) => {
    const req = indexedDB.open('WLM_LocalHistory_v3');
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('messages')) { db.close(); resolve(0); return; }
      const count = db.transaction('messages', 'readonly').objectStore('messages').count();
      count.onsuccess = () => { db.close(); resolve(count.result); };
      count.onerror = () => { db.close(); resolve(-1); };
    };
    req.onerror = () => resolve(-1);
  }));
  expect(cached).toBe(0);

  // --- Sons : « couper les sons en Occupé »
  await openOptionsTab(a, 'Sounds');
  await a.locator('#pref-sounds').check();
  await a.locator('#pref-snd-busy').check();
  await closeOptions(a);
  await setStatus(a, 'Busy');
  const busyBefore = soundLog.filter((l) => l.includes('NEW_MESSAGE')).length;
  await sendText(b, `busy ${stamp}`);
  await expect(a.locator('.msg-line', { hasText: `busy ${stamp}` })).toBeVisible({ timeout: 20000 });
  await a.waitForTimeout(500);
  expect(soundLog.filter((l) => l.includes('NEW_MESSAGE')).length, 'muet en Occupé').toBe(busyBefore);
  await setStatus(a, 'Available');
  await sendText(b, `back ${stamp}`);
  await expect(a.locator('.msg-line', { hasText: `back ${stamp}` })).toBeVisible({ timeout: 20000 });
  await expect.poll(() => soundLog.filter((l) => l.includes('NEW_MESSAGE')).length, { timeout: 5000 }).toBeGreaterThan(busyBefore);

  // Préférences persistées sur l'appareil
  const saved = await a.evaluate(() => JSON.parse(localStorage.getItem('wlm_prefs') || '{}'));
  expect(saved.layout.sortBy).toBe('name');
  expect(saved.sounds.enabled).toBe(true);
  expect(saved.sounds.muteWhenBusy).toBe(true);
  expect(saved.messages.keepLocalHistory).toBe(false);
});
