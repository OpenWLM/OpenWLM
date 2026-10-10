import { test, expect } from '@playwright/test';

/**
 * Vérifie que les winks pré-rendus (WebP animés depuis les .swf d'origine) sont bien servis.
 * (Le rendu de l'animation elle-même est validé visuellement ; ici on garantit le contrat HTTP.)
 */
const WINKS = [
  'bouncy_ball', 'bow', 'dancing_pig', 'eyeball', 'frog', 'guitar_smash', 'heart', 'kiss',
  'knock', 'lipstick_girl', 'love_letter', 'notes', 'silly_face', 'stars', 'water_balloon'
];

test('winks : WebP (anim) + WebM (audio) pré-rendus servis', async ({ request }) => {
  for (const id of WINKS) {
    const w = await request.get(`/assets/winks/${id}/${id}.webp`);
    expect(w.status(), `${id} webp status`).toBe(200);
    expect(w.headers()['content-type'], `${id} webp type`).toContain('image/webp');
    const a = await request.get(`/assets/winks/${id}/${id}.webm`);
    expect(a.status(), `${id} audio status`).toBe(200);
  }
});
