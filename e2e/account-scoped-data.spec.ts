import { test, expect, type Browser, type Page } from './test';
import sharp from 'sharp';

/**
 * E2E — données locales rattachées au compte (relecture d'octobre 2026) :
 *  - les clés des émoticônes personnalisées survivent à une déconnexion (copie chiffrée pour
 *    soi, sauvegardée sur le serveur et reprise à la reconnexion) ;
 *  - un contact « vérifié » par un compte ne l'est pas pour un autre compte du même navigateur ;
 *  - une clé d'émoticône d'avant le rattachement au compte n'est ni montrée, ni effacée pour un
 *    autre compte : elle revient à son propriétaire (reconnu par le serveur) à sa connexion.
 * Serveur + base temporaires (jamais la prod).
 */

const PASSWORD = 'MotDePasseE2E-1234';
const fakeClientIp = () => `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;

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
const befriend = async (a: Page, b: Page, nameB: string) => {
  expect((await a.request.post('/api/invite', { data: { receiverUsername: nameB } })).ok()).toBeTruthy();
  const meB = await (await b.request.get('/api/user/me')).json();
  const invites = await (await b.request.get(`/api/invitations/${meB.user.id}`)).json();
  expect((await b.request.post('/api/accept-invite', { data: { invitationId: invites[0].id } })).ok()).toBeTruthy();
};
const newPage = async (browser: Browser) => (await browser.newContext({ locale: 'en-US', extraHTTPHeaders: { 'CF-Connecting-IP': fakeClientIp() } })).newPage();

const openEmoticonManager = async (page: Page) => {
  await page.locator('.tool-icon[title="Emoticons"]').first().click();
  await page.locator('.emoticon-popup .tout-afficher', { hasText: /My emoticons|Mes émoticônes/ }).first().click();
  await expect(page.locator('.wlm-custom-emo-add-section')).toBeVisible();
};

/** Trousseau local des émoticônes (IndexedDB), lu ou modifié directement. */
const myEmoticonKeys = (page: Page, stripOwner = false) => page.evaluate((strip) => new Promise<{ id: string; shortcut: string; ownerId?: number }[]>((resolve, reject) => {
  const open = indexedDB.open('WLM_CustomEmoticons_v1');
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const tx = open.result.transaction(['my_keys'], 'readwrite');
    const store = tx.objectStore('my_keys');
    const req = store.getAll();
    req.onsuccess = () => {
      const records = req.result as { id: string; shortcut: string; ownerId?: number }[];
      // Enregistrement « d'avant la mise à jour » : sans compte propriétaire
      if (strip) for (const r of records) { delete r.ownerId; store.put(r); }
      tx.oncomplete = () => { open.result.close(); resolve(records.map(({ id, shortcut, ownerId }) => ({ id, shortcut, ownerId }))); };
    };
  };
}), stripOwner);

test('émoticônes personnalisées : la clé survit à une déconnexion', async ({ browser }) => {
  test.setTimeout(150000);
  const stamp = Date.now();
  const name = `emo_${stamp}`;
  const page = await newPage(browser);
  await register(page, name);
  await login(page, name);
  await page.locator('.contact-row', { hasText: 'OpenWLM' }).click();
  await expect(page.locator('.chat-input-rich')).toBeVisible();

  const png = await sharp({ create: { width: 32, height: 32, channels: 4, background: { r: 200, g: 40, b: 40, alpha: 1 } } }).png().toBuffer();
  await openEmoticonManager(page);
  await page.locator('.wlm-custom-emo-add-section input[type="file"]').setInputFiles({ name: 'rouge.png', mimeType: 'image/png', buffer: png });
  await page.locator('.wlm-custom-emo-add-section input[placeholder*="(cat)"]').fill('(rouge)');
  await page.locator('.wlm-custom-emo-add-section button.win-btn-primary').click();
  await expect(page.locator('.wlm-custom-emo-item', { hasText: '(rouge)' })).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.wlm-custom-emo-item', { hasText: '(rouge)' }).locator('img.wlm-custom-emo-thumb')).toBeVisible();
  await page.getByRole('button', { name: /^Close$|^Fermer$/ }).last().click();
  await expect(page.locator('.wlm-custom-emo-add-section')).toHaveCount(0);

  // Déconnexion (purge du trousseau local), reconnexion : l'image est de nouveau lisible
  await logout(page);
  await login(page, name);
  await page.locator('.contact-row', { hasText: 'OpenWLM' }).click();
  await openEmoticonManager(page);
  const item = page.locator('.wlm-custom-emo-item', { hasText: '(rouge)' });
  await expect(item).toBeVisible({ timeout: 20000 });
  await expect(item.locator('img.wlm-custom-emo-thumb')).toBeVisible({ timeout: 20000 });
});

test('contacts vérifiés : propres à chaque compte sur un même navigateur', async ({ browser }) => {
  test.setTimeout(150000);
  const stamp = Date.now();
  const nameA = `va_${stamp}`;
  const nameB = `vb_${stamp}`;
  const nameC = `vc_${stamp}`;
  const shared = await newPage(browser);   // A puis C, même navigateur
  const other = await newPage(browser);    // B
  await register(other, nameB);
  await login(other, nameB);
  await register(shared, nameA);
  await login(shared, nameA);
  await befriend(shared, other, nameB);
  await expect(shared.locator('.contact-row', { hasText: nameB })).toBeVisible({ timeout: 45000 });

  // A vérifie B
  await shared.locator('.contact-row', { hasText: nameB }).click();
  await shared.locator('.wlm-safety-badge').click();
  await shared.locator('button.btn-verify').click();
  await expect(shared.locator('.wlm-safety-badge.verified')).toBeVisible({ timeout: 10000 });
  await shared.locator('.modal-bg').getByRole('button', { name: /^Close$|^Fermer$/ }).last().click();
  await expect(shared.locator('.modal-bg')).toHaveCount(0);

  // C se connecte sur le même navigateur, ajoute B : B n'est pas vérifié pour C
  await logout(shared);
  await register(shared, nameC);
  await login(shared, nameC);
  await befriend(shared, other, nameB);
  await expect(shared.locator('.contact-row', { hasText: nameB })).toBeVisible({ timeout: 45000 });
  await shared.locator('.contact-row', { hasText: nameB }).click();
  await expect(shared.locator('.wlm-safety-badge.unverified')).toBeVisible({ timeout: 10000 });

  // A revient : sa vérification est toujours là
  await logout(shared);
  await login(shared, nameA);
  await shared.locator('.contact-row', { hasText: nameB }).click();
  await expect(shared.locator('.wlm-safety-badge.verified')).toBeVisible({ timeout: 10000 });
});

test('émoticônes d\'avant le rattachement au compte : ni montrées ni effacées pour un autre compte', async ({ browser }) => {
  test.setTimeout(180000);
  const stamp = Date.now();
  const nameA = `oa_${stamp}`;
  const nameC = `oc_${stamp}`;
  const shared = await newPage(browser);
  await register(shared, nameA);
  await login(shared, nameA);
  const idA = (await (await shared.request.get('/api/user/me')).json()).user.id;
  await shared.locator('.contact-row', { hasText: 'OpenWLM' }).click();
  const png = await sharp({ create: { width: 32, height: 32, channels: 4, background: { r: 40, g: 160, b: 40, alpha: 1 } } }).png().toBuffer();
  await openEmoticonManager(shared);
  await shared.locator('.wlm-custom-emo-add-section input[type="file"]').setInputFiles({ name: 'vert.png', mimeType: 'image/png', buffer: png });
  await shared.locator('.wlm-custom-emo-add-section input[placeholder*="(cat)"]').fill('(vert)');
  await shared.locator('.wlm-custom-emo-add-section button.win-btn-primary').click();
  await expect(shared.locator('.wlm-custom-emo-item', { hasText: '(vert)' })).toBeVisible({ timeout: 20000 });
  await shared.getByRole('button', { name: /^Close$|^Fermer$/ }).last().click();

  // La clé devient un enregistrement d'avant la mise à jour (sans propriétaire)
  const [legacy] = await myEmoticonKeys(shared, true);
  expect(legacy.shortcut).toBe('(vert)');
  expect((await myEmoticonKeys(shared))[0].ownerId).toBeUndefined();

  // Déconnexion de A : la clé sans propriétaire n'est pas purgée (elle n'est à personne)
  await logout(shared);
  expect((await myEmoticonKeys(shared)).map((r) => r.id)).toEqual([legacy.id]);

  // C, même navigateur : ne la voit pas, et sa synchronisation ne l'efface pas
  await register(shared, nameC);
  await login(shared, nameC);
  await shared.locator('.contact-row', { hasText: 'OpenWLM' }).click();
  await openEmoticonManager(shared);
  await expect(shared.locator('.wlm-custom-emo-item')).toHaveCount(0);
  await shared.waitForTimeout(1000);
  await shared.getByRole('button', { name: /^Close$|^Fermer$/ }).last().click();
  await logout(shared);
  expect(await myEmoticonKeys(shared)).toEqual([{ id: legacy.id, shortcut: '(vert)', ownerId: undefined }]);

  // A revient : le serveur la lui reconnaît, elle lui est rattachée
  await login(shared, nameA);
  await shared.locator('.contact-row', { hasText: 'OpenWLM' }).click();
  await openEmoticonManager(shared);
  await expect(shared.locator('.wlm-custom-emo-item', { hasText: '(vert)' }).locator('img.wlm-custom-emo-thumb')).toBeVisible({ timeout: 20000 });
  await expect.poll(async () => (await myEmoticonKeys(shared))[0]?.ownerId).toBe(idA);
});
