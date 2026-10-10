import { test, expect } from '@playwright/test';

/**
 * Vérifie que Ruffle (self-hosted) charge et joue réellement un .swf d'origine.
 * Le serveur + base temporaire sont lancés par playwright.config.ts.
 */
test('winks : Ruffle joue un SWF d’origine', async ({ page }) => {
  await page.goto('/');

  const result = await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/ruffle/ruffle.js';
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Échec chargement ruffle.js'));
      document.head.appendChild(s);
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const RP = (window as any).RufflePlayer;
    if (!RP || typeof RP.newest !== 'function') return { ok: false, reason: 'RufflePlayer absent' };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const player: any = RP.newest().createPlayer();
    player.style.width = '400px';
    player.style.height = '300px';
    document.body.appendChild(player);

    const loaded = await new Promise<boolean>((resolve) => {
      player.addEventListener('loadedmetadata', () => resolve(true));
      player.addEventListener('loadeddata', () => resolve(true));
      setTimeout(() => resolve(false), 25000);
      try { player.ruffle().load('/assets/winks/heart/heart.swf'); } catch { resolve(false); }
    });

    return { ok: loaded, version: RP.newest().version || 'n/a' };
  });

  expect(result.ok, JSON.stringify(result)).toBe(true);
});
