import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowed, cleanupWindow } from '../server/utils/rateWindow.js';

// Fenêtres glissantes : Wizz (3/60 s) et Winks (7/60 s) doivent être INDÉPENDANTS
// et le nettoyage périodique doit utiliser la MÊME fenêtre que la vérification.

test('isAllowed applique la limite sur la fenêtre', () => {
  const m = new Map();
  const t = 1_000_000;
  for (let i = 0; i < 3; i++) assert.equal(isAllowed(m, 1, 3, 60000, t + i), true);
  assert.equal(isAllowed(m, 1, 3, 60000, t + 3), false, 'au-delà de la limite → bloqué');
  // 61 s plus tard, la fenêtre est purgée → de nouveau autorisé
  assert.equal(isAllowed(m, 1, 3, 60000, t + 61000), true);
});

test('Wizz et Winks : compteurs indépendants (pas de quota partagé)', () => {
  const wizz = new Map();
  const wink = new Map();
  const t = 2_000_000;

  // 3 Wizz autorisés, le 4e bloqué
  for (let i = 0; i < 3; i++) assert.equal(isAllowed(wizz, 42, 3, 60000, t + i), true);
  assert.equal(isAllowed(wizz, 42, 3, 60000, t + 10), false, '4e Wizz bloqué');

  // Après 3 Wizz, un Wink doit RESTER autorisé (compteur distinct)
  assert.equal(isAllowed(wink, 42, 7, 60000, t + 20), true);

  // 7 Winks autorisés, le 8e bloqué
  for (let i = 0; i < 6; i++) assert.equal(isAllowed(wink, 42, 7, 60000, t + 30 + i), true);
  assert.equal(isAllowed(wink, 42, 7, 60000, t + 100), false, '8e Wink bloqué');

  // Le Wizz reste bloqué (3 déjà comptés) puis repasse après 60 s
  assert.equal(isAllowed(wizz, 42, 3, 60000, t + 40), false);
  assert.equal(isAllowed(wizz, 42, 3, 60000, t + 61000), true);
});

test('cleanupWindow doit utiliser la fenêtre du limiteur (sinon permissif)', () => {
  const T = 3_000_000;
  const make = () => new Map([[1, [T - 30000, T - 5000]]]); // 30 s et 5 s avant T

  // Fenêtre 10 s (le bug) : l'événement de 30 s, encore pertinent pour un 60 s, est jeté
  const bug = make();
  cleanupWindow(bug, 10000, T);
  assert.equal(bug.get(1).length, 1);

  // Fenêtre 60 s (correct) : les deux sont conservés
  const ok = make();
  cleanupWindow(ok, 60000, T);
  assert.equal(ok.get(1).length, 2);

  // Purge totale : la clé vide est supprimée
  const emptied = make();
  cleanupWindow(emptied, 1000, T);
  assert.equal(emptied.has(1), false);
});
