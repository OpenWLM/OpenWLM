import { test, expect, type Browser, type Page } from '@playwright/test';

/**
 * E2E — appel audio qui passe en vidéo en cours d'appel (caméra activée à la demande).
 * Deux navigateurs, deux comptes, médias factices de Chromium. Serveur + base temporaire
 * lancés par playwright.config.ts (jamais la prod).
 */

const PASSWORD = 'MotDePasseE2E-1234';

test.use({
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--auto-accept-this-tab-capture', '--auto-select-desktop-capture-source=Entire screen'] },
});

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

const newUserPage = async (browser: Browser, username: string) => {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'], locale: 'en-US' });
  const page = await ctx.newPage();
  await registerAndLogin(page, username);
  return page;
};

// Le pair reçoit-il réellement des images (dimensions > 0, élément visible) ?
const remoteVideoPlaying = (page: Page) => page.locator('.wlm-video-remote').evaluate((el) => {
  const v = el as HTMLVideoElement;
  return !v.classList.contains('wlm-video-remote-audio') && v.videoWidth > 0;
});

test('appel audio → activation de la caméra en cours d\'appel → le pair reçoit la vidéo', async ({ browser }) => {
  test.setTimeout(150000);
  const stamp = Date.now();
  const nameA = `calla_${stamp}`;
  const nameB = `callb_${stamp}`;
  const a = await newUserPage(browser, nameA);
  const b = await newUserPage(browser, nameB);

  // Mise en contact via l'API (cookies de session des deux navigateurs)
  expect((await a.request.post('/api/invite', { data: { receiverUsername: nameB } })).ok()).toBeTruthy();
  const meB = await (await b.request.get('/api/user/me')).json();
  const invites = await (await b.request.get(`/api/invitations/${meB.user.id}`)).json();
  expect(invites.length).toBeGreaterThan(0);
  expect((await b.request.post('/api/accept-invite', { data: { invitationId: invites[0].id } })).ok()).toBeTruthy();

  // Les rosters se mettent à jour seuls (événement contact_accepted / rafraîchissement 15 s)
  await expect(a.locator('.contact-row', { hasText: nameB })).toBeVisible({ timeout: 45000 });
  await expect(b.locator('.contact-row', { hasText: nameA })).toBeVisible({ timeout: 45000 });

  // A ouvre la conversation et lance un appel AUDIO
  await a.locator('.contact-row', { hasText: nameB }).click();
  await a.getByText('Call', { exact: true }).click();

  // B accepte
  await b.getByRole('button', { name: 'Accept' }).click({ timeout: 30000 });
  await expect(b.locator('.wlm-call-timer').first()).toBeVisible({ timeout: 30000 });
  await expect(a.locator('.wlm-call-timer').first()).toBeVisible({ timeout: 30000 });

  // Appel audio : pas de vidéo chez B
  expect(await remoteVideoPlaying(b)).toBe(false);

  // A active sa caméra pendant l'appel audio
  await a.getByRole('button', { name: 'Turn camera on' }).click();
  await expect.poll(() => remoteVideoPlaying(b), { timeout: 20000 }).toBe(true);
  await expect(b.locator('.wlm-call-titlebar')).toContainText('Video');

  // B active aussi la sienne : vidéo dans les deux sens
  await b.getByRole('button', { name: 'Turn camera on' }).click();
  await expect.poll(() => remoteVideoPlaying(a), { timeout: 20000 }).toBe(true);

  // A coupe sa caméra : B repasse en affichage audio
  await a.getByRole('button', { name: 'Turn camera off' }).click();
  await expect.poll(() => remoteVideoPlaying(b), { timeout: 20000 }).toBe(false);
  await expect(b.locator('.wlm-video-status')).toContainText('Voice call in progress');

  // B coupe sa caméra puis partage son écran depuis l'appel : A reçoit l'écran
  await b.getByRole('button', { name: 'Turn camera off' }).click();
  await expect.poll(() => remoteVideoPlaying(a), { timeout: 20000 }).toBe(false);
  await b.getByRole('button', { name: 'Share screen' }).click();
  await expect(b.getByRole('button', { name: 'Stop screen sharing' })).toBeVisible({ timeout: 15000 });
  await expect.poll(() => remoteVideoPlaying(a), { timeout: 20000 }).toBe(true);
  await b.getByRole('button', { name: 'Stop screen sharing' }).click();
  await expect.poll(() => remoteVideoPlaying(a), { timeout: 20000 }).toBe(false);

  await a.getByRole('button', { name: 'Hang up' }).first().click();
});
