import { test, expect, type Browser, type Page } from './test';
import sharp from 'sharp';

/**
 * E2E — visionneuse d'image : une grande capture d'écran reçue s'ouvre en grand, entière
 * (« ajustée »), et se zoome pour être lue sans l'enregistrer.
 * - Ordinateur : fenêtre presque plein écran, double-clic (taille réelle), molette, touche 0.
 * - Téléphone : plein écran sans barre (croix rouge flottante), pincement à deux doigts,
 *   double-tap, bouton Retour.
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

/** A envoie une capture 1200×2400 à B (ordinateur ou téléphone), conversation ouverte chez B. */
const receiveScreenshot = async (browser: Browser, mobile: boolean) => {
  const stamp = Date.now();
  const nameA = `iva_${stamp}`;
  const nameB = `ivb_${stamp}`;
  const ctxA = await browser.newContext({ locale: 'en-US', extraHTTPHeaders: { 'CF-Connecting-IP': fakeClientIp() } });
  const a = await ctxA.newPage();
  await registerAndLogin(a, nameA);
  const ctxB = await browser.newContext({
    locale: 'en-US',
    extraHTTPHeaders: { 'CF-Connecting-IP': fakeClientIp() },
    ...(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 800 } })
  });
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

  const png = await sharp({ create: { width: 1200, height: 2400, channels: 3, background: { r: 40, g: 110, b: 200 } } }).png().toBuffer();
  const fileName = `capture_${stamp}.png`;
  await a.locator('input[type="file"]').first().setInputFiles({ name: fileName, mimeType: 'image/png', buffer: png });
  const thumb = b.locator('.wlm-image-card', { hasText: fileName }).locator('.wlm-image-thumbnail-wrapper');
  await expect(thumb.locator('img')).toBeVisible({ timeout: 60000 });
  return { b, thumb };
};

const zoomPercent = async (page: Page) => Number(await page.getByTestId('image-viewer').getAttribute('data-zoom'));
const imageBox = async (page: Page) => (await page.locator('.wlm-viewer-image').boundingBox())!;
const stageBox = async (page: Page) => (await page.locator('.wlm-viewer-stage').boundingBox())!;

/** Image entière visible, centrée, aussi grande que la zone le permet. */
const expectFitted = async (page: Page) => {
  const stage = await stageBox(page);
  // Largeur ou hauteur de la zone entièrement occupée, l'autre dimension sans débordement
  await expect.poll(async () => {
    const img = await imageBox(page);
    return Math.min(Math.abs(img.width - stage.width), Math.abs(img.height - stage.height)) < 1.5;
  }).toBe(true);
  const img = await imageBox(page);
  expect(img.width).toBeLessThanOrEqual(stage.width + 1);
  expect(img.height).toBeLessThanOrEqual(stage.height + 1);
  expect(Math.abs(img.x + img.width / 2 - (stage.x + stage.width / 2))).toBeLessThan(2);
};

test('visionneuse sur ordinateur : en grand, double-clic taille réelle, molette, touche 0', async ({ browser }) => {
  test.setTimeout(150000);
  const { b, thumb } = await receiveScreenshot(browser, false);
  await thumb.click();
  const viewer = b.getByTestId('image-viewer');
  await expect(viewer).toBeVisible();
  // Fin de l'animation d'ouverture (léger agrandissement) avant de mesurer
  await viewer.evaluate((el) => Promise.all(el.getAnimations().map((an) => an.finished)));

  // Presque tout l'écran, pas une petite fenêtre ; barre d'outils, pas de croix flottante
  await expect(b.locator('.wlm-viewer-close-float')).toBeHidden();
  const vb = (await viewer.boundingBox())!;
  expect(vb.width).toBeGreaterThan(1280 * 0.9);
  expect(vb.height).toBeGreaterThan(800 * 0.9);
  await expectFitted(b);
  const fit = await zoomPercent(b);
  expect(fit).toBeLessThan(40);

  // Double-clic : taille réelle (1 pixel d'image = 1 pixel d'écran) sur le point visé
  const stage = await stageBox(b);
  await b.mouse.dblclick(stage.x + stage.width / 2, stage.y + 50);
  await expect.poll(() => zoomPercent(b)).toBe(100);
  expect(Math.round((await imageBox(b)).width)).toBe(1200);

  // Glisser : l'image se déplace, sans jamais quitter la zone
  const before = await imageBox(b);
  await b.mouse.move(stage.x + 300, stage.y + 300);
  await b.mouse.down();
  await b.mouse.move(stage.x + 250, stage.y + 100, { steps: 5 });
  await b.mouse.up();
  const after = await imageBox(b);
  expect(after.y).toBeLessThan(before.y - 100);
  expect(after.y + after.height).toBeGreaterThanOrEqual(stage.y + stage.height - 1);

  // Touche 0 : retour à la vue ajustée ; molette vers le haut : zoom avant
  await b.keyboard.press('0');
  await expect.poll(() => zoomPercent(b)).toBe(fit);
  await b.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
  await b.mouse.wheel(0, -400);
  await expect.poll(() => zoomPercent(b)).toBeGreaterThan(fit);

  // Échap ferme
  await b.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
});

test('visionneuse sur téléphone : plein écran, pincement, double-tap, bouton Retour', async ({ browser }) => {
  test.setTimeout(150000);
  const { b, thumb } = await receiveScreenshot(browser, true);
  await thumb.tap();
  const viewer = b.getByTestId('image-viewer');
  await expect(viewer).toBeVisible();
  // Fin de l'animation d'ouverture (léger agrandissement) avant de mesurer
  await viewer.evaluate((el) => Promise.all(el.getAnimations().map((an) => an.finished)));
  const vb = (await viewer.boundingBox())!;
  expect(Math.round(vb.width)).toBe(390);
  expect(Math.round(vb.height)).toBe(844);
  await expectFitted(b);
  const fit = await zoomPercent(b);

  // Pincement à deux doigts (écartement ×3 autour du centre)
  const stage = await stageBox(b);
  await b.locator('.wlm-viewer-stage').evaluate((el, { cx, cy }) => {
    const fire = (type: string, id: number, x: number, y: number) =>
      el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, isPrimary: id === 1 }));
    fire('pointerdown', 1, cx - 20, cy);
    fire('pointerdown', 2, cx + 20, cy);
    for (let i = 1; i <= 10; i++) {
      fire('pointermove', 1, cx - 20 - 4 * i, cy);
      fire('pointermove', 2, cx + 20 + 4 * i, cy);
    }
    fire('pointerup', 1, cx - 60, cy);
    fire('pointerup', 2, cx + 60, cy);
  }, { cx: stage.x + stage.width / 2, cy: stage.y + stage.height / 2 });
  await expect.poll(() => zoomPercent(b)).toBeGreaterThanOrEqual(Math.floor(fit * 2.9));
  expect((await imageBox(b)).width).toBeGreaterThan(stage.width);

  // Double-tap : retour à la vue ajustée, puis de nouveau zoomé
  const x = stage.x + stage.width / 2;
  const y = stage.y + stage.height / 3;
  await b.touchscreen.tap(x, y);
  await b.touchscreen.tap(x, y);
  await expect.poll(() => zoomPercent(b)).toBe(fit);
  await b.touchscreen.tap(x, y);
  await b.touchscreen.tap(x, y);
  await expect.poll(() => zoomPercent(b)).toBe(100);

  // Pas de barre d'outils sur téléphone : seulement la croix flottante
  await expect(b.locator('.wlm-viewer-bar')).toBeHidden();
  await expect(b.locator('.wlm-viewer-close-float')).toBeVisible();

  // Retour (Android) : ferme la visionneuse, la conversation reste ouverte
  await b.goBack();
  await expect(viewer).toHaveCount(0);
  await expect(b.locator('.chat-input-rich')).toBeVisible();

  // Croix rouge : ferme aussi
  await thumb.tap();
  await expect(viewer).toBeVisible();
  await b.locator('.wlm-viewer-close-float').tap();
  await expect(viewer).toHaveCount(0);
});
