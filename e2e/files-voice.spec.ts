import { test, expect, type Browser, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * E2E — transfert de fichier et message vocal, chiffrés de bout en bout.
 * Deux navigateurs, deux comptes, faux micro de Chromium. Serveur + base temporaires
 * (jamais la prod).
 */

const PASSWORD = 'MotDePasseE2E-1234';
// Fichiers chiffrés stockés par le serveur (server/routes/files.js → UPLOADS_DIR)
const UPLOADS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'uploads');

test.use({
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
});

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

const newUserPage = async (browser: Browser, username: string) => {
  const ctx = await browser.newContext({ permissions: ['microphone'], locale: 'en-US', acceptDownloads: true, extraHTTPHeaders: { 'CF-Connecting-IP': fakeClientIp() } });
  const page = await ctx.newPage();
  await registerAndLogin(page, username);
  return page;
};

const pair = async (browser: Browser, prefix: string) => {
  const stamp = Date.now();
  const nameA = `${prefix}a_${stamp}`;
  const nameB = `${prefix}b_${stamp}`;
  const a = await newUserPage(browser, nameA);
  const b = await newUserPage(browser, nameB);
  expect((await a.request.post('/api/invite', { data: { receiverUsername: nameB } })).ok()).toBeTruthy();
  const meB = await (await b.request.get('/api/user/me')).json();
  const invites = await (await b.request.get(`/api/invitations/${meB.user.id}`)).json();
  expect((await b.request.post('/api/accept-invite', { data: { invitationId: invites[0].id } })).ok()).toBeTruthy();
  await expect(a.locator('.contact-row', { hasText: nameB })).toBeVisible({ timeout: 45000 });
  await expect(b.locator('.contact-row', { hasText: nameA })).toBeVisible({ timeout: 45000 });
  await a.locator('.contact-row', { hasText: nameB }).click();
  await b.locator('.contact-row', { hasText: nameA }).click();
  return { a, b, stamp };
};

test('transfert de fichier : chiffré sur le serveur, identique une fois téléchargé par le destinataire', async ({ browser }) => {
  test.setTimeout(150000);
  const { a, b, stamp } = await pair(browser, 'file');
  const startedAt = Date.now();
  const plaintext = `Contenu secret OpenWLM ${stamp} — accents éèà et ligne 2\n`.repeat(20);
  const fileName = `rapport_${stamp}.txt`;

  // A envoie le fichier (champ fichier caché de la zone de saisie)
  await a.locator('input[type="file"]').first().setInputFiles({ name: fileName, mimeType: 'text/plain', buffer: Buffer.from(plaintext, 'utf8') });
  await expect(a.locator('.wlm-file-card', { hasText: fileName })).toBeVisible({ timeout: 30000 });

  // Côté serveur : un nouveau fichier stocké, chiffré (le texte n'y apparaît pas)
  const stored = fs.readdirSync(UPLOADS_DIR)
    .filter((f) => f.startsWith('enc_'))
    .map((f) => path.join(UPLOADS_DIR, f))
    .filter((f) => fs.statSync(f).mtimeMs >= startedAt - 1000);
  expect(stored.length).toBeGreaterThan(0);
  for (const f of stored) expect(fs.readFileSync(f).includes(Buffer.from(`Contenu secret OpenWLM ${stamp}`))).toBe(false);

  // B reçoit la carte de fichier (badge chiffré) et le télécharge : contenu identique
  const card = b.locator('.wlm-file-card', { hasText: fileName });
  await expect(card).toBeVisible({ timeout: 30000 });
  await expect(card.locator('.wlm-file-badge-e2ee')).toBeVisible();
  const [download] = await Promise.all([
    b.waitForEvent('download', { timeout: 30000 }),
    card.locator('.wlm-file-download-btn').last().click()
  ]);
  expect(download.suggestedFilename()).toBe(fileName);
  const received = fs.readFileSync((await download.path())!, 'utf8');
  expect(received).toBe(plaintext);

  // Nettoyage : fichiers chiffrés créés par ce test (uploads/ est ignoré par Git)
  for (const f of stored) fs.rmSync(f, { force: true });
});

test('message vocal : enregistré, chiffré, reçu et lu par le destinataire', async ({ browser }) => {
  test.setTimeout(150000);
  const { a, b } = await pair(browser, 'voice');

  // A enregistre ~2 s avec le faux micro, puis arrête et envoie
  await a.locator('[title="Voice clip"]').click();
  await expect(a.locator('[title="Stop and send"]')).toBeVisible({ timeout: 10000 });
  await a.waitForTimeout(2200);
  // Le bouton pulse pendant l'enregistrement (animation) : clic forcé
  await a.locator('[title="Stop and send"]').click({ force: true });

  // Les deux côtés affichent le lecteur ; le message transite chiffré (pas d'audio en clair
  // dans l'historique du serveur)
  await expect(a.locator('.wlm-voice-clip-player')).toBeVisible({ timeout: 30000 });
  const player = b.locator('.wlm-voice-clip-player');
  await expect(player).toBeVisible({ timeout: 30000 });
  const meA = await (await a.request.get('/api/user/me')).json();
  const meB = await (await b.request.get('/api/user/me')).json();
  const history = await (await b.request.get(`/api/messages/${meB.user.id}/${meA.user.id}`)).json();
  const voice = history.find((m: { type?: string }) => m.type === 'audio');
  expect(voice, 'message vocal présent dans l\'historique').toBeTruthy();
  expect(voice.audio ?? null).toBeNull();
  expect(String(voice.text)).not.toContain('data:audio');

  // B l'écoute : lecture en cours, minuteur qui avance
  await player.click();
  await expect(player).toContainText('Playing', { timeout: 10000 });
  const timer = player.locator('.voice-clip-timer');
  const t0 = await timer.innerText();
  await expect.poll(() => timer.innerText(), { timeout: 5000 }).not.toBe(t0);
});
