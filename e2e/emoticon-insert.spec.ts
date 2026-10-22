import { test, expect, type Browser, type Page } from './test';

/**
 * E2E — une émoticône choisie dans le menu s'insère là où était le curseur, pas au début du
 * message. Ouvrir le menu fait perdre au champ de saisie son focus et sa sélection ; en
 * reprenant le focus, le navigateur (et la WebView Android) replaçait le curseur au début.
 * Format ordinateur et format téléphone. Serveur + base temporaires (jamais la prod).
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

const openBotChat = async (browser: Browser, mobile: boolean) => {
  const ctx = await browser.newContext({
    locale: 'en-US',
    extraHTTPHeaders: { 'CF-Connecting-IP': fakeClientIp() },
    ...(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {})
  });
  const page = await ctx.newPage();
  await registerAndLogin(page, `emo${mobile ? 'm' : 'd'}_${Date.now()}`);
  await page.locator('.contact-row', { hasText: 'OpenWLM' }).click();
  await expect(page.locator('.chat-input-rich')).toBeVisible();
  return page;
};

/** Texte du champ, émoticônes (images) remplacées par « [emo] ». */
const inputText = (page: Page) => page.locator('.chat-input-rich').evaluate((root) => {
  const parts: string[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) parts.push((n.nodeValue || '').replace(/\u200b/g, ''));
    else if (n.nodeName === 'IMG') parts.push('[emo]');
    else n.childNodes.forEach(walk);
  };
  walk(root);
  return parts.join('');
});

const pickFirstEmoticon = async (page: Page, mobile: boolean) => {
  // Comme sur Android : en quittant le champ (clavier fermé, toucher du menu), la sélection
  // est perdue — ce que Chromium sur ordinateur ne fait pas de lui-même
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.getSelection()?.removeAllRanges();
  });
  const toggle = page.locator('.tool-icon[title="Emoticons"]').first();
  if (mobile) await toggle.tap(); else await toggle.click();
  const item = page.locator('.emoticon-item').first();
  if (mobile) await item.tap(); else await item.click();
};

for (const mobile of [false, true]) {
  test(`émoticône insérée au curseur, pas au début (${mobile ? 'téléphone' : 'ordinateur'})`, async ({ browser }) => {
    test.setTimeout(120000);
    const page = await openBotChat(browser, mobile);
    await page.locator('.chat-input-rich').click();
    await page.keyboard.type('Bonjour monde');

    // Curseur en fin de texte
    await pickFirstEmoticon(page, mobile);
    await expect.poll(() => inputText(page)).toBe('Bonjour monde[emo]');

    // Curseur au milieu (après « Bonjour ») : l'émoticône s'y insère
    await page.locator('.chat-input-rich').click();
    await page.keyboard.press('End');
    for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowLeft');
    await pickFirstEmoticon(page, mobile);
    await expect.poll(() => inputText(page)).toBe('Bonjour [emo]monde[emo]');
  });
}
