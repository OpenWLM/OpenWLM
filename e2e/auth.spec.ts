import { test, expect } from '@playwright/test';
import fs from 'node:fs';

/**
 * E2E — parcours d'authentification réel (navigateur).
 * Couvre la régression « Réponse du serveur invalide » (login) et le démarrage de l'app.
 * Serveur + base temporaire lancés par playwright.config.ts (jamais la prod).
 */

const PASSWORD = 'MotDePasseE2E-1234';

test('auth : inscription puis connexion → l’application se charge', async ({ page }) => {
  const username = `e2e_${Date.now()}`;
  page.on('dialog', (d) => d.accept()); // accepte les alert() natifs (ex. succès inscription)

  await page.goto('/');
  await expect(page.locator('.wlm-auth-form')).toBeVisible();

  // Version (depuis package.json) et lien vers le dépôt en pied de page
  const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  await expect(page.locator('.auth-footer')).toContainText(`OpenWLM v${version}`);
  await expect(page.locator('.auth-footer a')).toHaveAttribute('href', 'https://github.com/OpenWLM/OpenWLM');

  // Basculer en inscription si on est sur le login (le captcha n'existe qu'à l'inscription)
  if ((await page.locator('.auth-captcha-container').count()) === 0) {
    await page.locator('.auth-toggle').click();
  }

  const textInputs = page.locator('.auth-field input[type="text"]');
  await textInputs.nth(0).fill(username);
  await page.locator('.auth-field input[type="password"]').fill(PASSWORD);
  await textInputs.nth(1).fill('E2E');

  await expect(page.locator('.auth-captcha-text')).toBeVisible();
  const question = await page.locator('.auth-captcha-text').innerText();
  const m = question.match(/(\d+)\s*\+\s*(\d+)/);
  expect(m, `captcha introuvable dans « ${question} »`).not.toBeNull();
  await page.locator('.auth-captcha-container input[type="number"]').fill(String(Number(m![1]) + Number(m![2])));

  await page.locator('button.wlm-btn-auth').click();

  // Retour au login après inscription
  await expect(page.locator('.auth-captcha-container')).toHaveCount(0, { timeout: 20000 });

  // Connexion
  await page.locator('.auth-field input[type="text"]').first().fill(username);
  await page.locator('.auth-field input[type="password"]').fill(PASSWORD);
  await page.locator('button.wlm-btn-auth').click();

  // L'app se charge (dérivation PBKDF2 + login ~1-2 s)
  await expect(page.locator('.wlm-auth-container')).toHaveCount(0, { timeout: 45000 });
  await expect(page.locator('.auth-error')).toHaveCount(0);
});
