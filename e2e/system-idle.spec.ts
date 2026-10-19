import { test, expect } from './test';
import type { Page } from '@playwright/test';

/**
 * E2E — inactivité de tout l'ordinateur (API Idle Detection), avec un faux IdleDetector :
 * un démarrage refusé par le navigateur alors que la permission est accordée (PWA ouverte au
 * démarrage de Windows, sortie de veille…) n'est plus définitif ni présenté comme une
 * permission retirée : la détection repart quand la fenêtre revient au premier plan.
 */

const PASSWORD = 'MotDePasseE2E-1234';
const fakeClientIp = () => `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;

const registerAndLogin = async (page: Page, username: string) => {
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
};

test('inactivité système : démarrage refusé puis repris au retour au premier plan', async ({ browser }) => {
  test.setTimeout(120000);
  const ctx = await browser.newContext({ locale: 'en-US', extraHTTPHeaders: { 'CF-Connecting-IP': fakeClientIp() } });
  await ctx.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    // Un seul objet d'état, comme dans Chrome : son évènement « change » signale un retrait
    const status = Object.assign(new EventTarget(), { state: 'granted', name: 'idle-detection', onchange: null });
    w.__idlePermissionStatus = status;
    w.__idleStartFails = true;
    localStorage.setItem('wlm_system_idle', 'true');
    const query = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = ((desc: PermissionDescriptor) =>
      (desc.name as string) === 'idle-detection'
        ? Promise.resolve(status as unknown as PermissionStatus)
        : query(desc)) as typeof navigator.permissions.query;
    class FakeIdleDetector extends EventTarget {
      userState = 'active'; screenState = 'unlocked';
      static requestPermission() { return Promise.resolve('granted'); }
      start() {
        return w.__idleStartFails
          ? Promise.reject(new DOMException('Idle detection refused', 'NotAllowedError'))
          : Promise.resolve();
      }
    }
    w.IdleDetector = FakeIdleDetector;
  });
  const page = await ctx.newPage();
  const warnings: string[] = [];
  page.on('console', (msg) => { if (msg.type() === 'warning') warnings.push(msg.text()); });
  await registerAndLogin(page, `si_${Date.now()}`);

  await page.locator('.status-trigger').click();
  await page.locator('.dropdown-item', { hasText: 'Options' }).first().click();
  await page.locator('.options-nav-item', { hasText: 'Personal' }).click();
  const hint = page.locator('#system-idle-hint');

  // Permission accordée, démarrage refusé : message dédié (pas « permission retirée ») et erreur en console
  await expect(hint).toContainText('the browser refused to start the detection');
  expect(warnings.some((w) => w.includes('IdleDetector.start()'))).toBeTruthy();

  // Le navigateur accepte de nouveau : la fenêtre revient au premier plan → la détection repart
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__idleStartFails = false;
    window.dispatchEvent(new Event('focus'));
  });
  await expect(hint).toContainText('Active: OpenWLM follows the computer');

  // Permission réellement retirée en cours de session : elle garde son propre message
  await page.evaluate(() => {
    const status = (window as unknown as Record<string, EventTarget & { state: string }>).__idlePermissionStatus;
    status.state = 'denied';
    status.dispatchEvent(new Event('change'));
  });
  await expect(hint).toContainText('the permission was withdrawn');
});
