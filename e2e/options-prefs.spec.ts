import { test, expect, type Browser, type Page } from '@playwright/test';

/**
 * E2E — Options → Disposition, Messages et Sons : chaque réglage a un effet réel.
 * Trois comptes (A observe et règle, B et C sont ses contacts). Serveur + base temporaire
 * lancés par playwright.config.ts (jamais la prod).
 */

const PASSWORD = 'MotDePasseE2E-1234';
const REMEMBER_LABEL = 'Remember my E2EE keys on this device';

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

// IP fictive par navigateur (cf. e2e/start-server.mjs) : les limiteurs par IP restent actifs,
// mais chaque compte de test a la sienne.
const fakeClientIp = () => `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;

const newUserPage = async (browser: Browser, username: string) => {
  const ctx = await browser.newContext({ locale: 'en-US', extraHTTPHeaders: { 'CF-Connecting-IP': fakeClientIp() } });
  const page = await ctx.newPage();
  await registerAndLogin(page, username);
  return page;
};

const befriend = async (a: Page, b: Page, nameB: string) => {
  expect((await a.request.post('/api/invite', { data: { receiverUsername: nameB } })).ok()).toBeTruthy();
  const meB = await (await b.request.get('/api/user/me')).json();
  const invites = await (await b.request.get(`/api/invitations/${meB.user.id}`)).json();
  const inv = invites.find((i: { username?: string }) => i.username) ?? invites[0];
  expect((await b.request.post('/api/accept-invite', { data: { invitationId: inv.id } })).ok()).toBeTruthy();
};
const openOptionsTab = async (p: Page, tab: string) => {
  await p.locator('.status-trigger').click();
  await p.locator('.dropdown-item', { hasText: 'Options' }).first().click();
  await p.locator('.options-nav-item', { hasText: tab }).click();
};
const closeOptions = (p: Page) => p.getByRole('button', { name: 'OK', exact: true }).click();
const setStatus = async (p: Page, label: string) => {
  await p.locator('.status-trigger').click();
  await p.locator('.dropdown-item', { hasText: label }).first().click();
};
const sendText = async (p: Page, text: string) => {
  await p.locator('.chat-input-rich').click();
  await p.keyboard.type(text);
  await p.keyboard.press('Enter');
};

test('options : disposition, messages et sons appliqués', async ({ browser }) => {
  test.setTimeout(240000);
  const stamp = Date.now();
  const nameA = `opta_${stamp}`;
  const nameB = `zzoptb_${stamp}`; // « zz… » : dernier par ordre alphabétique
  const nameC = `aaoptc_${stamp}`; // « aa… » : premier par ordre alphabétique
  const a = await newUserPage(browser, nameA);
  const soundLog: string[] = [];
  a.on('console', (m) => { if (m.text().includes('[SoundManager] Reproduction')) soundLog.push(m.text()); });
  const b = await newUserPage(browser, nameB);
  const c = await newUserPage(browser, nameC);
  await befriend(a, b, nameB);
  await befriend(a, c, nameC);
  const rowB = a.locator('.contact-row', { hasText: nameB });
  const rowC = a.locator('.contact-row', { hasText: nameC });
  await expect(rowB).toBeVisible({ timeout: 45000 });
  await expect(rowC).toBeVisible({ timeout: 45000 });

  // --- Disposition : tri par statut (B Disponible avant C Occupé) puis par nom (C « aa » avant B « zz »)
  await setStatus(c, 'Busy');
  await expect(rowC.locator('.status-square')).toHaveClass(/busy/, { timeout: 20000 });
  const order = async () => (await a.locator('.contact-row').allInnerTexts()).filter((t) => t.includes(nameB) || t.includes(nameC)).map((t) => (t.includes(nameB) ? 'B' : 'C')).join('');
  expect(await order()).toBe('BC');
  await openOptionsTab(a, 'Layout');
  await a.locator('#pref-sort-name').check();
  await closeOptions(a);
  expect(await order()).toBe('CB');

  // --- Disposition : messages perso, contact de test, contacts hors ligne
  await b.locator('.user-psm-display').click();
  await b.keyboard.press('Control+A');
  await b.keyboard.type(`psm_${stamp}`);
  await b.keyboard.press('Enter');
  await expect(rowB).toContainText(`psm_${stamp}`, { timeout: 20000 });
  await expect(a.locator('.wlm-bot-badge')).toHaveCount(1);
  await openOptionsTab(a, 'Layout');
  await a.locator('#pref-show-psm').uncheck();
  await a.locator('#pref-show-bot').uncheck();
  await closeOptions(a);
  await expect(rowB).not.toContainText(`psm_${stamp}`);
  await expect(a.locator('.wlm-bot-badge')).toHaveCount(0);

  await c.locator('.status-trigger').click();
  await c.getByText('Sign out', { exact: true }).click();
  await expect(rowC.locator('.status-square')).toHaveClass(/offline/, { timeout: 20000 });
  await openOptionsTab(a, 'Layout');
  await a.locator('#pref-show-offline').uncheck();
  await closeOptions(a);
  await expect(rowC).toHaveCount(0);

  // --- Messages : émoticônes et heure
  await b.locator('.contact-row', { hasText: nameA }).click();
  await sendText(b, `hello :) ${stamp}`);
  await rowB.click();
  const msg = a.locator('.msg-line', { hasText: `hello` });
  await expect(msg.locator('img.inline-emoticon')).toHaveCount(1, { timeout: 20000 });
  await expect(a.locator('.msg-time').first()).toBeVisible();
  await openOptionsTab(a, 'Messages');
  await a.locator('#pref-emoticons').uncheck();
  await a.locator('#pref-timestamps').uncheck();
  await closeOptions(a);
  await expect(msg.locator('img.inline-emoticon')).toHaveCount(0);
  await expect(msg).toContainText(':)');
  await expect(a.locator('.msg-time')).toHaveCount(0);

  // --- Sons : coupés → aucun son de message à la réception
  const before = soundLog.filter((l) => l.includes('NEW_MESSAGE')).length;
  expect(before, 'un son de message a bien été joué quand les sons étaient actifs').toBeGreaterThan(0);
  await openOptionsTab(a, 'Sounds');
  await a.locator('#pref-sounds').uncheck();
  await expect(a.locator('#pref-snd-message')).toBeDisabled();
  await closeOptions(a);
  await sendText(b, `silence ${stamp}`);
  await expect(a.locator('.msg-line', { hasText: `silence ${stamp}` })).toBeVisible({ timeout: 20000 });
  await a.waitForTimeout(500);
  expect(soundLog.filter((l) => l.includes('NEW_MESSAGE')).length).toBe(before);

  // --- Messages : Wizz sans secousse, clin d'œil non joué automatiquement
  await openOptionsTab(a, 'Messages');
  await a.locator('#pref-nudges').uncheck();
  await a.locator('#pref-winks').uncheck();
  await closeOptions(a);
  await b.getByTitle('Nudge!').click();
  await expect(a.locator('.msg-system', { hasText: 'secousse désactivée' })).toBeVisible({ timeout: 20000 });
  await expect(a.locator('.wlm-desktop.wlm-nudge')).toHaveCount(0);
  await b.getByTitle('Winks').click();
  await b.locator('.scene-thumb').first().click();
  const watch = a.getByRole('button', { name: '▶ Watch' });
  await expect(watch).toBeVisible({ timeout: 20000 });
  await expect(a.locator('.wink-overlay')).toHaveCount(0);
  await watch.click();
  await expect(a.locator('.wink-overlay')).toBeVisible();

  // --- Messages : plus de copie locale → base IndexedDB vidée
  await a.locator('.wink-overlay').click();
  await openOptionsTab(a, 'Messages');
  // Copie d'un AUTRE compte du même navigateur : elle doit survivre à l'effacement
  await a.evaluate(() => new Promise<void>((resolve) => {
    const req = indexedDB.open('WLM_LocalHistory_v3');
    req.onsuccess = () => {
      const tx = req.result.transaction('messages', 'readwrite');
      tx.objectStore('messages').add({ chatId: '999999_1', encryptedData: 'autre-compte' });
      tx.oncomplete = () => { req.result.close(); resolve(); };
    };
  }));
  await a.locator('#pref-local-history').click();
  await a.getByTestId('clear-local-confirm').getByRole('button', { name: 'Yes, delete' }).click();
  await expect(a.getByText('Local copy deleted.')).toBeVisible({ timeout: 10000 });
  await closeOptions(a);
  const cached = await a.evaluate(() => new Promise<number>((resolve) => {
    const req = indexedDB.open('WLM_LocalHistory_v3');
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('messages')) { db.close(); resolve(0); return; }
      const all = db.transaction('messages', 'readonly').objectStore('messages').getAll();
      all.onsuccess = () => { db.close(); resolve(all.result.filter((r: { chatId: string }) => r.chatId !== '999999_1').length * 1000 + all.result.length); };
      all.onerror = () => { db.close(); resolve(-1); };
    };
    req.onerror = () => resolve(-1);
  }));
  // Rien de ce compte (milliers = 0), seule la copie de l'autre compte reste (unités = 1)
  expect(cached).toBe(1);

  // --- Sons : « couper les sons en Occupé »
  await openOptionsTab(a, 'Sounds');
  await a.locator('#pref-sounds').check();
  await a.locator('#pref-snd-busy').check();
  await closeOptions(a);
  await setStatus(a, 'Busy');
  const busyBefore = soundLog.filter((l) => l.includes('NEW_MESSAGE')).length;
  await sendText(b, `busy ${stamp}`);
  await expect(a.locator('.msg-line', { hasText: `busy ${stamp}` })).toBeVisible({ timeout: 20000 });
  await a.waitForTimeout(500);
  expect(soundLog.filter((l) => l.includes('NEW_MESSAGE')).length, 'muet en Occupé').toBe(busyBefore);
  // Bouton « Tester » : joue quand même (aperçu du volume), malgré « Occupé » et la catégorie
  await openOptionsTab(a, 'Sounds');
  await a.locator('#pref-snd-message').uncheck();
  await a.getByRole('button', { name: 'Test', exact: true }).click();
  await expect.poll(() => soundLog.filter((l) => l.includes('NEW_MESSAGE')).length, { timeout: 5000 }).toBe(busyBefore + 1);
  await a.locator('#pref-snd-message').check();
  await closeOptions(a);
  await setStatus(a, 'Available');
  await sendText(b, `back ${stamp}`);
  await expect(a.locator('.msg-line', { hasText: `back ${stamp}` })).toBeVisible({ timeout: 20000 });
  await expect.poll(() => soundLog.filter((l) => l.includes('NEW_MESSAGE')).length, { timeout: 5000 }).toBeGreaterThan(busyBefore);

  // Préférences persistées sur l'appareil
  const saved = await a.evaluate(() => JSON.parse(localStorage.getItem('wlm_prefs') || '{}'));
  expect(saved.layout.sortBy).toBe('name');
  expect(saved.sounds.enabled).toBe(true);
  expect(saved.sounds.muteWhenBusy).toBe(true);
  expect(saved.messages.keepLocalHistory).toBe(false);
});

test('Options → Sécurité : bloqués (débloquer), mode privé global, code de sécurité, raccourcis', async ({ browser }) => {
  test.setTimeout(120000);
  const stamp = Date.now();
  const nameA = `seca_${stamp}`;
  const nameB = `secb_${stamp}`;
  const a = await newUserPage(browser, nameA);
  const b = await newUserPage(browser, nameB);
  await befriend(a, b, nameB);
  const meA = (await (await a.request.get('/api/user/me')).json()).user;
  const contactsOfA = async () => (await (await a.request.get(`/api/contacts/${meA.id}`)).json()) as { username: string; id: number; blocked: number }[];
  const idB = (await contactsOfA()).find((c) => c.username === nameB)!.id;

  // Aucun bloqué au départ
  await expect(a.locator('.contact-row', { hasText: nameB })).toBeVisible({ timeout: 45000 });
  await openOptionsTab(a, 'Security');
  const sec = a.getByTestId('options-security');
  await expect(sec).toContainText('No blocked contacts.');
  // Code de sécurité affiché (clés chargées)
  await expect(a.getByTestId('my-safety-number')).not.toHaveText('…');
  await closeOptions(a);

  // A bloque B (menu clic droit) → B apparaît dans la liste ; « Débloquer » le retire
  await a.locator('.contact-row', { hasText: nameB }).click({ button: 'right' });
  await a.locator('.dropdown-item', { hasText: 'Block' }).first().click();
  await expect.poll(async () => (await contactsOfA()).find((c) => c.id === idB)?.blocked, { timeout: 10000 }).toBe(1);
  await openOptionsTab(a, 'Security');
  await expect(a.getByTestId('blocked-list')).toContainText(nameB);
  await a.getByTestId('blocked-list').getByRole('button', { name: 'Unblock' }).click();
  await expect(sec).toContainText('No blocked contacts.', { timeout: 10000 });
  expect((await contactsOfA()).find((c) => c.id === idB)?.blocked).toBe(0);

  // Mode privé global : la case pilote le même réglage que le menu (persisté côté serveur)
  const meGlobal = async () => (await (await a.request.get('/api/user/me')).json()).user.global_private;
  await a.locator('#pref-sec-global-private').click();
  await expect(a.locator('#pref-sec-global-private')).toBeChecked();
  await expect.poll(meGlobal, { timeout: 10000 }).toBe(1);
  await a.locator('#pref-sec-global-private').click();
  await expect(a.locator('#pref-sec-global-private')).not.toBeChecked();
  await expect.poll(meGlobal, { timeout: 10000 }).toBe(0);

  // Raccourcis : changer de mot de passe ferme les Options et ouvre sa fenêtre
  await sec.getByRole('button', { name: 'Change password…' }).click();
  await expect(a.locator('.wlm-options-modal')).toHaveCount(0);
  await expect(a.locator('#old-password')).toBeVisible();
  await a.locator('.modal-box .win-close-btn').click();

  // Réinitialiser mes clés : ouvre la fenêtre de confirmation (rien n'est réinitialisé ici)
  await openOptionsTab(a, 'Security');
  await sec.getByRole('button', { name: 'Reset my keys…' }).click();
  await expect(a.locator('.wlm-reset-modal')).toBeVisible();
});

test('Options → Sécurité : « Déconnecter mes autres sessions » (autre appareil coupé, onglets de cet appareil conservés)', async ({ browser }) => {
  test.setTimeout(150000);
  const name = `rvk_${Date.now()}`;
  // « Téléphone » : la session ouverte à l'inscription
  const phone = await newUserPage(browser, name);

  // « PC » : même compte, autre navigateur, clés mémorisées (un 2e onglet s'ouvre déjà connecté)
  const pcCtx = await browser.newContext({ locale: 'en-US', extraHTTPHeaders: { 'CF-Connecting-IP': fakeClientIp() } });
  const pc = await pcCtx.newPage();
  pc.on('dialog', (d) => d.accept());
  await pc.goto('/');
  await pc.locator('.auth-field input[type="text"]').first().fill(name);
  await pc.locator('.auth-field input[type="password"]').fill(PASSWORD);
  await pc.getByLabel(REMEMBER_LABEL).check();
  await pc.locator('button.wlm-btn-auth').click();
  await expect(pc.locator('.wlm-auth-container')).toHaveCount(0, { timeout: 45000 });
  await expect(pc.locator('.status-trigger')).toBeVisible();

  // Second onglet du PC (même cookie) : doit rester connecté
  const pcTab2 = await pcCtx.newPage();
  await pcTab2.goto('/');
  await expect(pcTab2.locator('.status-trigger')).toBeVisible({ timeout: 45000 });

  // Confirmation intégrée (Annuler puis Oui), puis déconnexion des autres sessions
  await openOptionsTab(pc, 'Security');
  const box = pc.getByTestId('revoke-sessions');
  await box.getByRole('button', { name: 'Sign out my other sessions' }).click();
  await box.getByRole('button', { name: 'Cancel' }).click();
  await box.getByRole('button', { name: 'Sign out my other sessions' }).click();
  await box.getByRole('button', { name: 'Yes, sign them out' }).click();
  await expect(box).toContainText('Your other sessions have been signed out.', { timeout: 10000 });

  // Le téléphone revient à l'écran de connexion, avec l'explication
  await expect(phone.locator('.wlm-auth-form')).toBeVisible({ timeout: 20000 });
  await expect(phone.locator('.wlm-auth-form')).toContainText('your session was closed from another device');

  // Le PC (les deux onglets) reste connecté, y compris après rechargement
  await pc.waitForTimeout(2000);
  await expect(pc.locator('.wlm-auth-form')).toHaveCount(0);
  await expect(pcTab2.locator('.wlm-auth-form')).toHaveCount(0);
  expect((await pc.request.get('/api/user/me')).status()).toBe(200);
  await pcTab2.reload();
  await expect(pcTab2.locator('.status-trigger')).toBeVisible({ timeout: 45000 });
  await expect(pcTab2.locator('.wlm-auth-form')).toHaveCount(0);
  await pcCtx.close();
});

test('Options → Connexion : diagnostic (temps réel, reconnexion, test réseau des appels, rapport)', async ({ browser }) => {
  test.setTimeout(120000);
  const name = `diag_${Date.now()}`;
  const ctx = await browser.newContext({ locale: 'en-US', permissions: ['clipboard-read', 'clipboard-write'], extraHTTPHeaders: { 'CF-Connecting-IP': fakeClientIp() } });
  const p = await ctx.newPage();
  await registerAndLogin(p, name);
  await openOptionsTab(p, 'Connection');

  const rt = p.getByTestId('diag-realtime');
  await expect(rt).toContainText('Connected');
  await expect(rt).toContainText('WebSocket');
  await expect(rt).toContainText(/\d+ ms/, { timeout: 10000 });

  // Se reconnecter : retour à l'état connecté
  await p.getByRole('button', { name: 'Reconnect' }).click();
  await expect(rt).toContainText('Connected', { timeout: 15000 });
  await expect(rt).toContainText(/\d+ ms/, { timeout: 15000 });

  await expect(p.getByTestId('diag-browser')).toContainText('OpenWLM v');
  // Langue de l'app transmise au service worker (textes des notifications Push)
  expect(await p.evaluate(async () => (await (await caches.open('openwlm-prefs')).match('/__openwlm/lang'))?.text())).toBe('en');

  // Test réseau des appels (ne contacte personne) : un résultat s'affiche
  await p.getByRole('button', { name: 'Test the network for calls' }).click();
  await expect(p.getByTestId('diag-calls')).toContainText('Result', { timeout: 20000 });
  await expect(p.getByTestId('diag-calls')).toContainText('Relay (TURN) configured on the server');

  // Rapport copié : sections présentes, aucun identifiant TURN ni adresse Push
  await p.getByRole('button', { name: 'Copy report' }).click();
  await expect(p.getByText('Report copied to the clipboard.')).toBeVisible();
  const report = await p.evaluate(() => navigator.clipboard.readText());
  expect(report).toContain('[Real-time connection]');
  expect(report).toContain('[Calls]');
  expect(report).not.toMatch(/credential|https:\/\/fcm|turn:/i);
  await ctx.close();
});

test('Réinitialiser mes clés : seules les données de CE compte sont effacées de l\'appareil', async ({ browser }) => {
  test.setTimeout(120000);
  const name = `rst_${Date.now()}`;
  const ctx = await browser.newContext({ locale: 'en-US', extraHTTPHeaders: { 'CF-Connecting-IP': fakeClientIp() } });
  const p = await ctx.newPage();
  await registerAndLogin(p, name);

  // Données d'un AUTRE compte utilisé dans ce navigateur : clés mémorisées + copie locale
  await p.evaluate(() => Promise.all([
    new Promise<void>((resolve) => {
      // Même schéma que l'app (src/utils/E2EEKeyStorage.ts, version 2)
      const req = indexedDB.open('WLM_DeviceVault_v1', 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('e2ee_keys')) db.createObjectStore('e2ee_keys', { keyPath: 'userId' });
        if (!db.objectStoreNames.contains('verified_contacts')) db.createObjectStore('verified_contacts', { keyPath: 'contactId' });
      };
      req.onsuccess = () => {
        const tx = req.result.transaction('e2ee_keys', 'readwrite');
        tx.objectStore('e2ee_keys').put({ userId: 999999, autre: 'compte' });
        tx.oncomplete = () => { req.result.close(); resolve(); };
      };
    }),
    new Promise<void>((resolve) => {
      // Même schéma que l'app (src/utils/LocalDB.ts, version 1)
      const req = indexedDB.open('WLM_LocalHistory_v3', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('messages')) {
          db.createObjectStore('messages', { keyPath: 'id', autoIncrement: true }).createIndex('chatId', 'chatId', { unique: false });
        }
      };
      req.onsuccess = () => {
        const tx = req.result.transaction('messages', 'readwrite');
        tx.objectStore('messages').add({ chatId: '999999_1', encryptedData: 'autre-compte' });
        tx.oncomplete = () => { req.result.close(); resolve(); };
      };
    })
  ]));

  await openOptionsTab(p, 'Security');
  await p.getByTestId('options-security').getByRole('button', { name: 'Reset my keys…' }).click();
  await p.locator('#reset-e2e-password-input').fill(PASSWORD);
  await p.getByRole('button', { name: 'Permanently reset my keys' }).click();
  // Réinitialisation terminée : déconnexion, retour à l'écran de connexion
  await expect(p.locator('.wlm-auth-form')).toBeVisible({ timeout: 45000 });

  const other = await p.evaluate(() => Promise.all([
    new Promise<boolean>((resolve) => {
      const req = indexedDB.open('WLM_DeviceVault_v1');
      req.onsuccess = () => {
        const get = req.result.transaction('e2ee_keys', 'readonly').objectStore('e2ee_keys').get(999999);
        get.onsuccess = () => { req.result.close(); resolve(!!get.result); };
      };
    }),
    new Promise<boolean>((resolve) => {
      const req = indexedDB.open('WLM_LocalHistory_v3');
      req.onsuccess = () => {
        const all = req.result.transaction('messages', 'readonly').objectStore('messages').getAll();
        all.onsuccess = () => { req.result.close(); resolve(all.result.some((r: { chatId: string }) => r.chatId === '999999_1')); };
      };
    })
  ]));
  expect(other, 'clés et copie locale de l\'autre compte conservées').toEqual([true, true]);
  await ctx.close();
});
