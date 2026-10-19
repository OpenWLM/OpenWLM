import { test as base } from '@playwright/test';

/**
 * `test` commun aux scénarios E2E : après chaque test, ferme les sessions de navigateur
 * (`browser.newContext()`) que le scénario a ouvertes pour ses comptes.
 *
 * Les tests partagent un seul navigateur (workers: 1). Sans cette fermeture, les sessions
 * s'accumulent au fil de la suite — chacune garde l'app connectée (socket temps réel, minuteurs) —
 * jusqu'à ce que les pages ne répondent plus (clic bloqué vers le 20e test sur une machine à 4 Go).
 */
export const test = base.extend<{ closeOpenedContexts: void }>({
  closeOpenedContexts: [async ({ browser }, use) => {
    await use();
    for (const ctx of browser.contexts()) await ctx.close().catch(() => { /* déjà fermée */ });
  }, { auto: true }]
});

export { expect } from '@playwright/test';
export type { Browser, Page } from '@playwright/test';
