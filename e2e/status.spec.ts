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

  // 3) Disponible → conservé ; puis « Occupé », déconnexion et reconnexion SANS toucher au
  //    sélecteur de l'écran de connexion : la préférence du compte (Occupé) s'applique
  await setStatus(a, 'Available');
  await expect(aRowOnB).toHaveClass(/online/, { timeout: 20000 });
  await a.reload();
  await expect(a.locator('.status-label')).toContainText('Available', { timeout: 20000 });
  await setStatus(a, 'Busy');
  await a.locator('.status-trigger').click();
  await a.getByText('Sign out', { exact: true }).click();
  // Après déconnexion, rien ne trahit le compte précédent : pas de présélection héritée
  await expect(a.locator('.wlm-auth-form select')).toHaveValue('online', { timeout: 15000 });
  await a.locator('.auth-field input[type="text"]').first().fill(nameA);
  await a.locator('.auth-field input[type="password"]').fill(PASSWORD);
  await a.locator('button.wlm-btn-auth').click();
  await expect(a.locator('.wlm-auth-container')).toHaveCount(0, { timeout: 45000 });
  await expect(a.locator('.status-label')).toContainText('Busy', { timeout: 20000 });

  // 4) Second appareil sans préférence locale : il garde le statut choisi ailleurs (Occupé),
  //    au lieu d'imposer « Disponible »
  const a2ctx = await browser.newContext({ locale: 'en-US', extraHTTPHeaders: { 'CF-Connecting-IP': fakeClientIp() } });
  const a2 = await a2ctx.newPage();
  await a2.goto('/');
  if ((await a2.locator('.auth-captcha-container').count()) > 0) await a2.locator('.auth-toggle').click();
  await a2.locator('.auth-field input[type="text"]').first().fill(nameA);
  await a2.locator('.auth-field input[type="password"]').fill(PASSWORD);
  await a2.locator('button.wlm-btn-auth').click();
  await expect(a2.locator('.wlm-auth-container')).toHaveCount(0, { timeout: 45000 });
  await expect(a2.locator('.status-label')).toContainText('Busy', { timeout: 20000 });
  await expect(a.locator('.status-label')).toContainText('Busy');
  await expect(aRowOnB).toHaveClass(/busy/);
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

test('options : délai d\'inactivité modifiable, borné, et désactivé quand la case est décochée', async ({ browser }) => {
  test.setTimeout(120000);
  const a = await newUserPage(browser, `stopt_${Date.now()}`);
  await a.locator('.status-trigger').click();
  await a.locator('.dropdown-item', { hasText: 'Options' }).first().click();
  const field = a.locator('#away-timeout');
  await expect(field).toHaveValue('5');

  // Effacer puis retaper : on obtient bien la valeur tapée (avant : « 15 » ou « 110 »)
  await field.fill('');
  await field.pressSequentially('10');
  await expect(field).toHaveValue('10');
  expect(await a.evaluate(() => localStorage.getItem('wlm_away_timeout'))).toBe('10');

  // Valeur négative ou nulle : ramenée au minimum (1) en quittant le champ
  await field.fill('-5');
  await field.blur();
  await expect(field).toHaveValue('1');
  expect(await a.evaluate(() => localStorage.getItem('wlm_away_timeout'))).toBe('1');

  // Case décochée : champ désactivé, préférence enregistrée
  await a.locator('#check-away').uncheck();
  await expect(field).toBeDisabled();
  expect(await a.evaluate(() => localStorage.getItem('wlm_enable_auto_away'))).toBe('false');
});

test('inactivité de tout l\'ordinateur (API Idle Detection) : Absent si inactif ou écran verrouillé, Disponible au retour', async ({ browser }) => {
  test.setTimeout(150000);
  const a = await newUserPage(browser, `stidle_${Date.now()}`);
  // Autorisation et état d'inactivité simulés par Chromium (protocole DevTools)
  const cdp = await a.context().newCDPSession(a);
  const { targetInfo } = await cdp.send('Target.getTargetInfo');
  await cdp.send('Browser.grantPermissions', {
    permissions: ['idleDetection'],
    origin: new URL(a.url()).origin,
    browserContextId: targetInfo.browserContextId
  });
  await cdp.send('Emulation.setIdleOverride', { isUserActive: true, isScreenUnlocked: true });

  await a.locator('.status-trigger').click();
  await a.locator('.dropdown-item', { hasText: 'Options' }).first().click();
  await expect(a.locator('#check-system-idle')).toBeEnabled();
  // La case n'est cochée qu'après la réponse (asynchrone) de la demande d'autorisation
  await a.locator('#check-system-idle').click();
  await expect(a.locator('#check-system-idle')).toBeChecked({ timeout: 10000 });
  await expect(a.locator('#system-idle-hint')).toContainText('Active', { timeout: 10000 });
  expect(await a.evaluate(() => localStorage.getItem('wlm_system_idle'))).toBe('true');
  await a.getByRole('button', { name: 'OK', exact: true }).click();

  // Utilisateur inactif sur tout l'ordinateur → Absent
  await cdp.send('Emulation.setIdleOverride', { isUserActive: false, isScreenUnlocked: true });
  await expect(a.locator('.status-label')).toContainText('Away', { timeout: 15000 });
  // Retour d'activité → Disponible
  await cdp.send('Emulation.setIdleOverride', { isUserActive: true, isScreenUnlocked: true });
  await expect(a.locator('.status-label')).toContainText('Available', { timeout: 15000 });
  // Écran verrouillé → Absent
  await cdp.send('Emulation.setIdleOverride', { isUserActive: true, isScreenUnlocked: false });
  await expect(a.locator('.status-label')).toContainText('Away', { timeout: 15000 });
  await cdp.send('Emulation.setIdleOverride', { isUserActive: true, isScreenUnlocked: true });
  await expect(a.locator('.status-label')).toContainText('Available', { timeout: 15000 });

  // Un statut choisi à la main n'est jamais modifié par la détection
  await a.locator('.status-trigger').click();
  await a.locator('.dropdown-item', { hasText: 'Busy' }).first().click();
  await cdp.send('Emulation.setIdleOverride', { isUserActive: false, isScreenUnlocked: true });
  await a.waitForTimeout(2000);
  await expect(a.locator('.status-label')).toContainText('Busy');

  // Permission retirée en cours de session : la détection s'arrête et OpenWLM revient à
  // l'activité dans la page (sans rechargement)
  await cdp.send('Browser.setPermission', {
    permission: { name: 'idle-detection' },
    setting: 'denied',
    origin: new URL(a.url()).origin,
    browserContextId: targetInfo.browserContextId
  });
  await a.locator('.status-trigger').click();
  await a.locator('.dropdown-item', { hasText: 'Options' }).first().click();
  await expect(a.locator('#system-idle-hint')).not.toContainText('Active', { timeout: 10000 });
  // Permission rendue : la détection reprend d'elle-même
  await cdp.send('Browser.setPermission', {
    permission: { name: 'idle-detection' },
    setting: 'granted',
    origin: new URL(a.url()).origin,
    browserContextId: targetInfo.browserContextId
  });
  await expect(a.locator('#system-idle-hint')).toContainText('Active', { timeout: 10000 });
});
