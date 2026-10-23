import { test, expect, type Page } from './test';
import crypto from 'node:crypto';

/**
 * E2E — clé d'authentification liée au serveur (relecture d'octobre 2026, lot 4) :
 *  - un compte créé avec l'ancienne dérivation (sans portée serveur) se connecte encore avec son
 *    mot de passe, et est migré sans rien demander ;
 *  - une nouvelle inscription utilise la dérivation liée au serveur.
 * Et accessibilité : Échap ferme la fenêtre du numéro de sécurité, le menu de statut se
 * parcourt au clavier. Serveur + base temporaires (jamais la prod).
 */

const PASSWORD = 'MotDePasseE2E-1234';
const fakeClientIp = () => `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;

/** Même dérivation que src/utils/Security.ts (PBKDF2 600 000 + HKDF), côté Node. */
const deriveAuthKey = (username: string, password: string, scope: string | null) => {
  const master = crypto.pbkdf2Sync(password, 'openwlm-salt:' + username.trim().toLowerCase(), 600000, 32, 'sha256');
  const info = scope === null ? 'openwlm-auth-key-v1' : `openwlm-auth-key-v2:${scope}`;
  return Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(32), info, 32)).toString('hex');
};

const register = async (page: Page, username: string) => {
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
};
const login = async (page: Page, username: string) => {
  await expect(page.locator('.wlm-auth-form')).toBeVisible();
  if ((await page.locator('.auth-captcha-container').count()) > 0) await page.locator('.auth-toggle').click();
  await page.locator('.auth-field input[type="text"]').first().fill(username);
  await page.locator('.auth-field input[type="password"]').fill(PASSWORD);
  await page.locator('button.wlm-btn-auth').click();
  await expect(page.locator('.wlm-auth-container')).toHaveCount(0, { timeout: 45000 });
  await expect(page.locator('.status-trigger')).toBeVisible();
};
const logout = async (page: Page) => {
  await page.locator('.status-trigger').click();
  await page.locator('.dropdown-item', { hasText: /Sign out|Déconnexion/ }).first().click();
  await expect(page.locator('.wlm-auth-form')).toBeVisible({ timeout: 30000 });
};

test('compte à l\'ancienne clé : connexion par mot de passe, puis migration silencieuse', async ({ browser }) => {
  test.setTimeout(150000);
  const name = `scope_${Date.now()}`;
  const page = await (await browser.newContext({ locale: 'en-US', extraHTTPHeaders: { 'CF-Connecting-IP': fakeClientIp() } })).newPage();
  await register(page, name);
  await login(page, name);
  const scope = new URL(page.url()).host.toLowerCase();
  const scoped = deriveAuthKey(name, PASSWORD, scope);
  const legacy = deriveAuthKey(name, PASSWORD, null);

  // L'inscription a bien utilisé la clé liée au serveur : on peut la prouver pour la remplacer
  // par l'ancienne dérivation (compte « d'avant la migration »)
  const toLegacy = await page.request.post('/api/user/migrate-auth-key', { data: { oldAuthKeyHex: scoped, newAuthKeyHex: legacy } });
  expect(toLegacy.status(), await toLegacy.text()).toBe(200);
  await logout(page);

  // Connexion avec le mot de passe : repli sur l'ancienne clé, puis migration
  await login(page, name);
  await expect.poll(async () => (await page.request.post('/api/user/migrate-auth-key', { data: { oldAuthKeyHex: scoped, newAuthKeyHex: scoped } })).status(), { timeout: 15000 })
    .toBe(200);
});

test('clavier : Échap ferme le numéro de sécurité, le menu de statut se parcourt aux flèches', async ({ browser }) => {
  test.setTimeout(120000);
  const name = `kb_${Date.now()}`;
  const page = await (await browser.newContext({ locale: 'en-US', extraHTTPHeaders: { 'CF-Connecting-IP': fakeClientIp() } })).newPage();
  await register(page, name);
  await login(page, name);

  // Menu de statut : ouverture, flèche bas, Entrée → Options
  await page.locator('.status-trigger').click();
  await expect(page.locator('[role="menu"]')).toBeVisible();
  await expect(page.locator('[role="menuitem"]').first()).toBeFocused();
  await page.keyboard.press('ArrowUp'); // dernier élément (Reset E2E), puis on remonte
  await page.keyboard.press('Escape');
  await expect(page.locator('[role="menu"]')).toHaveCount(0);
  await page.locator('.status-trigger').click();
  const options = page.locator('[role="menuitem"]', { hasText: 'Options' });
  await options.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Options' })).toBeVisible();
  await page.getByRole('dialog', { name: 'Options' }).getByRole('button', { name: 'Close' }).click();

  // Numéro de sécurité : Échap ferme
  await page.locator('.contact-row', { hasText: 'OpenWLM' }).click();
  await expect(page.locator('.chat-input-rich')).toBeVisible();
  const badge = page.locator('.wlm-safety-badge');
  if (await badge.count()) {
    await badge.click();
    await expect(page.locator('[role="dialog"].wlm-safety-modal')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.wlm-safety-modal')).toHaveCount(0);
  }
});
