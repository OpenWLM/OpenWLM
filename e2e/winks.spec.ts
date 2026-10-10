import { test, expect } from '@playwright/test';

/**
 * Vérifie que les winks pré-rendus (WebP animés depuis les .swf d'origine) sont bien servis.
 * (Le rendu de l'animation elle-même est validé visuellement ; ici on garantit le contrat HTTP.)
 */
const WINKS = [
  'bouncy_ball', 'bow', 'dancing_pig', 'eyeball', 'frog', 'guitar_smash', 'heart', 'kiss',
  'knock', 'lipstick_girl', 'love_letter', 'notes', 'silly_face', 'stars', 'water_balloon'
];

test('winks : les WebP pré-rendus sont servis (image/webp)', async ({ request }) => {
  for (const id of WINKS) {
    const r = await request.get(`/assets/winks/${id}/${id}.webp`);
    expect(r.status(), `${id} status`).toBe(200);
    expect(r.headers()['content-type'], `${id} type`).toContain('image/webp');
  }
});
