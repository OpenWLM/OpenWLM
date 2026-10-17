import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MS_SIZE, MS_CELLS, MS_MINES, MS_WIN_SCORE,
  createMinesweeperBoard, createMinesweeperRound, createMinesweeperGame, restartMinesweeperGame,
  playMinesweeperMove, canUseBomb, minesweeperPublicState
} from '../server/games/minesweeper.js';

/**
 * Démineur à deux (Minesweeper Flags) — logique serveur pure.
 */

const A = 1;
const B = 2;
const idx = (r, c) => r * MS_SIZE + c;

// Plateau déterministe : mines aux positions données
const boardWith = (mineIdx) => {
  const mines = new Array(MS_CELLS).fill(false);
  mineIdx.forEach((i) => { mines[i] = true; });
  const adjacent = mines.map((_, i) => {
    const r = Math.floor(i / MS_SIZE); const c = i % MS_SIZE; let n = 0;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const nr = r + dr; const nc = c + dc;
      if (nr >= 0 && nr < MS_SIZE && nc >= 0 && nc < MS_SIZE && mines[nr * MS_SIZE + nc]) n++;
    }
    return n;
  });
  return { mines, adjacent };
};
const gameWith = (mineIdx) => {
  const g = createMinesweeperGame(A, B);
  g.round = createMinesweeperRound(A, B, A, boardWith(mineIdx));
  return g;
};

test('plateau : 16×16, exactement 51 mines, compteurs cohérents', () => {
  const { mines, adjacent } = createMinesweeperBoard();
  assert.equal(mines.length, 256);
  assert.equal(mines.filter(Boolean).length, MS_MINES);
  assert.ok(adjacent.every((n) => n >= 0 && n <= 8));
});

test('mine trouvée : drapeau du joueur, +1, il rejoue', () => {
  const g = gameWith([idx(0, 0)]);
  const r = playMinesweeperMove(g, A, idx(0, 0));
  assert.deepEqual(r.revealed, [{ i: 0, f: 'B' }], 'drapeau à la couleur du joueur (A = bleu)');
  assert.equal(g.round.revealed[0], 'B');
  assert.equal(r.keepTurn, true);
  assert.equal(g.round.found[A], 1);
  assert.equal(g.round.turn, A);
});

test('chiffre : révélé, pas de point, la main passe', () => {
  const g = gameWith([idx(0, 0)]);
  const r = playMinesweeperMove(g, A, idx(1, 1));
  assert.deepEqual(r.revealed, [{ i: idx(1, 1), n: 1 }]);
  assert.equal(g.round.turn, B);
  assert.equal(g.round.found[A], 0);
});

test('case vide : remplissage par diffusion jusqu\'à la bordure de chiffres, jamais une mine', () => {
  const g = gameWith([idx(0, 0), idx(15, 15)]);
  const r = playMinesweeperMove(g, A, idx(8, 8));
  const opened = new Set(r.revealed.map((x) => x.i));
  assert.equal(opened.size, MS_CELLS - 2, 'tout sauf les deux mines');
  assert.ok(r.revealed.every((x) => x.f === undefined), 'aucune mine ouverte par la diffusion');
  assert.equal(g.round.turn, B);
});

test('tour et validité : hors tour, case révélée, index invalide → refusés sans effet', () => {
  const g = gameWith([idx(0, 0)]);
  assert.ok(playMinesweeperMove(g, B, 5).error, 'pas le tour de B');
  playMinesweeperMove(g, A, idx(1, 1));
  assert.ok(playMinesweeperMove(g, B, idx(1, 1)).error, 'case déjà révélée');
  for (const bad of [-1, 256, 1.5, 'x', null, '0', undefined, {}]) assert.ok(playMinesweeperMove(g, B, bad).error, `index ${bad}`);
  assert.equal(g.round.turn, B, 'la main reste à B');
});

test('victoire au 26e drapeau, partie terminée, manche comptée', () => {
  const mineIdx = Array.from({ length: MS_MINES }, (_, k) => k); // 51 premières cases
  const g = gameWith(mineIdx);
  for (let k = 0; k < MS_WIN_SCORE; k++) {
    const r = playMinesweeperMove(g, A, k);
    assert.ok(!r.error);
  }
  assert.equal(g.round.winner, A);
  assert.equal(g.status, 'finished');
  assert.equal(g.wins[A], 1);
  assert.ok(playMinesweeperMove(g, A, MS_WIN_SCORE).error, 'plus de coup après la victoire');
});

test('bombe : refusée sans 3 points de retard, puis 5×5, une seule fois, garde la main si mine', () => {
  // A trouve 3 mines (rejoue), puis rate ; B est mené de 3
  const g = gameWith([idx(0, 0), idx(0, 1), idx(0, 2), idx(10, 10), idx(12, 12)]);
  playMinesweeperMove(g, A, idx(0, 0));
  playMinesweeperMove(g, A, idx(0, 1));
  assert.equal(canUseBomb(g, A), false, 'le joueur en tête n\'a pas la bombe');
  playMinesweeperMove(g, A, idx(0, 2));
  assert.equal(playMinesweeperMove(g, A, idx(1, 3)).keepTurn, false); // chiffre → main à B
  assert.equal(g.round.turn, B);
  assert.equal(canUseBomb(g, B), true, 'B a 3 points de retard');

  const r = playMinesweeperMove(g, B, idx(11, 11), true);
  const opened = r.revealed.map((x) => x.i);
  assert.equal(opened.length, 25, 'carré 5 × 5 entièrement ouvert');
  assert.ok(opened.every((i) => Math.abs(Math.floor(i / 16) - 11) <= 2 && Math.abs((i % 16) - 11) <= 2));
  assert.equal(g.round.found[B], 2, 'deux mines dans la zone');
  assert.equal(r.keepTurn, true);
  assert.equal(g.round.turn, B);
  assert.ok(playMinesweeperMove(g, B, idx(5, 5), true).error, 'une seule bombe par partie');
});

test('bombe sans mine : la main passe ; bord du plateau : zone tronquée', () => {
  const g = gameWith([idx(0, 0), idx(0, 1), idx(0, 2)]);
  playMinesweeperMove(g, A, idx(0, 0)); playMinesweeperMove(g, A, idx(0, 1)); playMinesweeperMove(g, A, idx(0, 2));
  playMinesweeperMove(g, A, idx(1, 3));
  const r = playMinesweeperMove(g, B, idx(15, 15), true);
  assert.equal(r.revealed.length, 9, 'coin : 3 × 3 cases dans le plateau');
  assert.equal(r.keepTurn, false);
  assert.equal(g.round.turn, A);
});

test('état public : aucune mine non trouvée exposée avant la fin, dévoilées après', () => {
  const g = gameWith(Array.from({ length: MS_MINES }, (_, k) => k));
  const before = minesweeperPublicState(g);
  assert.equal(before.mines, undefined);
  assert.ok(before.revealed.every((v) => v === null));
  assert.equal(before.remaining, MS_MINES);
  assert.ok(!JSON.stringify(before).includes('adjacent'));
  for (let k = 0; k < MS_WIN_SCORE; k++) playMinesweeperMove(g, A, k);
  const after = minesweeperPublicState(g);
  assert.equal(after.winner, A);
  assert.equal(after.mines.length, MS_MINES - MS_WIN_SCORE);
});

test('nouvelle manche : nouveau plateau, l\'autre joueur commence, manches gagnées conservées', () => {
  const g = gameWith(Array.from({ length: MS_MINES }, (_, k) => k));
  for (let k = 0; k < MS_WIN_SCORE; k++) playMinesweeperMove(g, A, k);
  restartMinesweeperGame(g);
  assert.equal(g.status, 'playing');
  assert.equal(g.round.turn, B);
  assert.equal(g.wins[A], 1);
  assert.equal(g.round.found[A], 0);
  assert.equal(g.round.bombUsed[A], false, 'une bombe par manche : réarmée à la nouvelle manche');
  assert.deepEqual(minesweeperPublicState(g).config, { size: 16, mines: 51, winScore: 26, bombRadius: 2, bombMinDeficit: 3 });
});
