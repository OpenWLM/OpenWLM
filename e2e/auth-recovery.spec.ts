import { test, expect, type Page } from './test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * E2E — récupération après un changement de portée de la clé d'authentification (nouveau nom
 * de domaine, autre port…) : le compte ne peut plus se connecter ; l'administrateur ouvre une
 * fenêtre de récupération (scripts/auth-recovery.mjs) et remet un code à usage unique ;
 * l'utilisateur se reconnecte avec son mot de passe et ce code, et retrouve ses clés.
 * Serveur + base temporaires (jamais la prod).
 */

const PASSWORD = 'MotDePasseE2E-1234';
const fakeClientIp = () => `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
const PORT = process.env.E2E_PORT || '3100';
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');

const deriveAuthKey = (username: string, password: string, scope: string) => {
  const master = crypto.pbkdf2Sync(password, 'openwlm-salt:' + username.trim().toLowerCase(), 600000, 32, 'sha256');
  return Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(32), `openwlm-auth-key-v2:${scope}`, 32)).toString('hex');
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
const submitLogin = async (page: Page, username: string) => {
  await expect(page.locator('.wlm-auth-form')).toBeVisible();
  if ((await page.locator('.auth-captcha-container').count()) > 0) await page.locator('.auth-toggle').click();
  await page.locator('.auth-field input[type="text"]').first().fill(username);
  await page.locator('.auth-field input[type="password"]').fill(PASSWORD);
  await page.locator('button.wlm-btn-auth').click();
};
const logout = async (page: Page) => {
  await page.locator('.status-trigger').click();
  await page.locator('.dropdown-item', { hasText: /Sign out|Déconnexion/ }).first().click();
  await expect(page.locator('.wlm-auth-form')).toBeVisible({ timeout: 30000 });
};

test('changement de portée : connexion impossible, puis récupération ouverte par l\'administrateur', async ({ browser }) => {
  test.setTimeout(150000);
  const name = `rec_${Date.now()}`;
  const page = await (await browser.newContext({ locale: 'en-US', extraHTTPHeaders: { 'CF-Connecting-IP': fakeClientIp() } })).newPage();
  await register(page, name);
  await submitLogin(page, name);
  await expect(page.locator('.status-trigger')).toBeVisible({ timeout: 45000 });

  // Le serveur « déménage » : la clé du compte est celle de l'ancienne portée
  const scope = (await (await page.request.get('/api/auth/scope')).json()).scope || new URL(page.url()).host.toLowerCase().replace(/^www\./, '');
  const current = deriveAuthKey(name, PASSWORD, scope);
  const old = deriveAuthKey(name, PASSWORD, 'ancien-domaine.example');
  expect((await page.request.post('/api/user/migrate-auth-key', { data: { oldAuthKeyHex: current, newAuthKeyHex: old } })).status()).toBe(200);
  await logout(page);

  // Connexion impossible (ni la clé de la portée actuelle, ni l'ancienne dérivation)
  await submitLogin(page, name);
  await expect(page.locator('.auth-error')).toContainText(/invalid|incorrect|Identifiants/i, { timeout: 30000 });

  // L'administrateur ouvre la récupération pour ce compte et lui remet le code
  const dir = fs.readFileSync(path.join(os.tmpdir(), `openwlm-e2e-dir-${PORT}`), 'utf8').trim();
  const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'auth-recovery.mjs'), name, '--hours', '1'], {
    env: { ...process.env, OPENWLM_DB: path.join(dir, 'messenger.db') }, encoding: 'utf8'
  });
  expect(run.status, run.stderr).toBe(0);
  const code = (run.stdout.match(/[A-Z2-9]{5}(?:-[A-Z2-9]{5}){3}/) || [])[0];
  expect(code).toBeTruthy();

  // Sans le code, toujours impossible
  await page.reload();
  await submitLogin(page, name);
  await expect(page.locator('.auth-error')).toBeVisible({ timeout: 30000 });

  // Identifiant + mot de passe + code : l'app s'ouvre avec les clés du compte
  await page.getByRole('button', { name: /recovery code|code de récupération/i }).click();
  await page.locator('#auth-recovery-code').fill(code!);
  await page.locator('button.wlm-btn-auth').click();
  await expect(page.locator('.wlm-auth-container')).toHaveCount(0, { timeout: 45000 });
  await expect(page.locator('.status-trigger')).toBeVisible();
  // La nouvelle clé (portée actuelle) est enregistrée, la fenêtre est refermée
  expect((await page.request.post('/api/user/migrate-auth-key', { data: { oldAuthKeyHex: current, newAuthKeyHex: current } })).status()).toBe(200);
  expect((await page.request.post('/api/auth/recovery/challenge', { data: { username: name, code } })).status()).toBe(404);
});
