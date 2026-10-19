import { test, expect } from '@playwright/test';

/**
 * E2E — nouveautés de mise en forme et aide sur un téléphone (390×844, tactile) :
 * le panneau 🎨 de la conversation s'affiche en entier, au premier plan (la barre d'outils, qui
 * défile sur mobile, le coupait), et le menu de l'aide se replie pour laisser la place au texte.
 */

const PASSWORD = 'MotDePasseE2E-1234';
const fakeClientIp = () => `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
const PHONE = { locale: 'en-US', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

test('mobile : panneau 🎨 visible, menu de l\'aide repliable', async ({ browser }) => {
  test.setTimeout(120000);
  const ctx = await browser.newContext({ ...PHONE, extraHTTPHeaders: { 'CF-Connecting-IP': fakeClientIp() } });
  const page = await ctx.newPage();
  const username = `xm_${Date.now()}`;

  await page.goto('/');
  if ((await page.locator('.auth-captcha-container').count()) === 0) await page.locator('.auth-toggle').click();
  const textInputs = page.locator('.auth-field input[type="text"]');
  await textInputs.nth(0).fill(username);
  await page.locator('.auth-field input[type="password"]').fill(PASSWORD);
  await textInputs.nth(1).fill(username);
  const m = (await page.locator('.auth-captcha-text').innerText()).match(/(\d+)\s*\+\s*(\d+)/);
  expect(m).not.toBeNull();
  await page.locator('.auth-captcha-container input[type="number"]').fill(String(Number(m![1]) + Number(m![2])));
  await page.locator('button.wlm-btn-auth').click();
  await expect(page.locator('.auth-captcha-container')).toHaveCount(0, { timeout: 20000 });
  await page.locator('.auth-field input[type="text"]').first().fill(username);
  await page.locator('.auth-field input[type="password"]').fill(PASSWORD);
  await page.locator('button.wlm-btn-auth').click();
  await expect(page.locator('.wlm-auth-container')).toHaveCount(0, { timeout: 45000 });

  // --- Panneau 🎨 de la conversation : entièrement à l'écran et au premier plan
  await page.locator('.contact-row', { hasText: 'OpenWLM' }).click();
  await page.getByTestId('chat-format-picker').click();
  const panel = page.locator('.fmt-picker-panel');
  await expect(panel).toBeVisible();
  const box = (await panel.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.y + box.height).toBeLessThanOrEqual(844);
  const onTop = await panel.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
  });
  expect(onTop).toBe(true);
  // Une couleur s'applique bien depuis le panneau
  await page.getByRole('button', { name: '4 #FF0000' }).click();
  await expect(page.locator('.chat-input-rich')).toHaveText('[c=4][/c]');
  await expect(panel).toHaveCount(0);

  // --- Aide (écran de connexion) : menu repliable, repli automatique après un choix
  const anonCtx = await browser.newContext({ ...PHONE, extraHTTPHeaders: { 'CF-Connecting-IP': fakeClientIp() } });
  const anon = await anonCtx.newPage();
  await anon.goto('/');
  await anon.getByRole('button', { name: 'Help' }).click();
  const help = anon.getByTestId('help-modal');
  const tabs = help.getByRole('tab');
  await expect(tabs.first()).toBeVisible();
  await help.getByRole('tab', { name: 'Formatting' }).click();
  await expect(tabs.first()).toBeHidden();
  await expect(help.locator('.fmt-gradient-text')).toBeVisible();
  const content = (await help.locator('.options-content').boundingBox())!;
  expect(content.width).toBeGreaterThan(280);
  await anon.getByTestId('help-nav-toggle').click();
  await expect(tabs.first()).toBeVisible();
  await anon.getByTestId('help-nav-toggle').click();
  await expect(tabs.first()).toBeHidden();
  await anonCtx.close();
  await ctx.close();
});
