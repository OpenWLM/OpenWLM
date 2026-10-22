import crypto from 'crypto';

/**
 * DÉMINEUR À DEUX (« Minesweeper Flags ») — logique pure, côté serveur uniquement.
 *
 * Le but est de TROUVER les mines : 16 × 16 cases, 51 mines, le premier à 26 gagne
 * (51 étant impair, le match nul est impossible).
 * - Mine cliquée : drapeau du joueur, +1 point, il rejoue.
 * - Chiffre : la case se révèle, la main passe.
 * - Case vide : remplissage par diffusion (cases vides + bordure de chiffres), la main passe.
 * - Bombe (une par joueur et par manche — une partie est une manche —,
 *   seulement avec au moins 3 points de retard) :
 *   ouvre un carré 5 × 5 centré sur la case ; +1 point par mine ; le joueur garde la main
 *   s'il a trouvé au moins une mine.
 *
 * ANTI-TRICHE : la matrice des mines ne quitte jamais le serveur. Les clients ne reçoivent
 * que les cases révélées (`publicView`, `revealed` des coups) ; la position des mines restantes
 * n'est envoyée qu'une fois la partie terminée.
 */

export const MS_SIZE = 16;
export const MS_CELLS = MS_SIZE * MS_SIZE;
export const MS_MINES = 51;
export const MS_WIN_SCORE = 26;
export const MS_BOMB_RADIUS = 2; // carré 5 × 5
export const MS_BOMB_MIN_DEFICIT = 3;

const neighbors = (index) => {
  const r = Math.floor(index / MS_SIZE);
  const c = index % MS_SIZE;
  const out = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr;
      const nc = c + dc;
      if (nr >= 0 && nr < MS_SIZE && nc >= 0 && nc < MS_SIZE) out.push(nr * MS_SIZE + nc);
    }
  }
  return out;
};

/** Plateau aléatoire (tirage cryptographique) : mines + nombre de mines adjacentes. */
export const createMinesweeperBoard = (randomInt = crypto.randomInt) => {
  const mines = new Array(MS_CELLS).fill(false);
  let placed = 0;
  while (placed < MS_MINES) {
    const i = randomInt(MS_CELLS);
    if (!mines[i]) { mines[i] = true; placed++; }
  }
  const adjacent = mines.map((_, i) => neighbors(i).reduce((n, j) => n + (mines[j] ? 1 : 0), 0));
  return { mines, adjacent };
};

/**
 * Nouvelle manche entre deux joueurs. `revealed[i]` vaut null (cachée), un nombre 0–8
 * (case sûre révélée) ou la couleur du joueur qui a trouvé la mine : 'B' (bleu) ou 'R'
 * (rouge) — jamais un identifiant, qui pourrait valoir 1 à 8 et se confondre avec un chiffre.
 */
export const createMinesweeperRound = (playerBlue, playerRed, firstTurn, board = createMinesweeperBoard()) => ({
  mines: board.mines,
  adjacent: board.adjacent,
  revealed: new Array(MS_CELLS).fill(null),
  found: { [playerBlue]: 0, [playerRed]: 0 },
  bombUsed: { [playerBlue]: false, [playerRed]: false },
  turn: firstTurn,
  winner: null,
  lastMove: null
});

const colorOf = (game, userId) => (userId === game.playerBlue ? 'B' : 'R');
const opponentOf = (game, userId) => (userId === game.playerBlue ? game.playerRed : game.playerBlue);
const remainingMines = (round) => MS_MINES - Object.values(round.found).reduce((a, b) => a + b, 0);

/** La bombe est-elle utilisable par ce joueur maintenant ? */
export const canUseBomb = (game, userId) => {
  const round = game.round;
  if (!round || round.winner !== null || round.turn !== userId || round.bombUsed[userId]) return false;
  const opp = opponentOf(game, userId);
  return round.found[opp] - round.found[userId] >= MS_BOMB_MIN_DEFICIT;
};

const finishIfWon = (game, userId) => {
  const round = game.round;
  if (round.found[userId] >= MS_WIN_SCORE) {
    round.winner = userId;
    game.status = 'finished';
    game.wins[userId] = (game.wins[userId] || 0) + 1;
    return true;
  }
  return false;
};

/**
 * Joue un coup. Renvoie `{ error }` (coup refusé, rien n'est modifié) ou
 * `{ revealed: [{ i, n } | { i, f }], keepTurn }`.
 */
export const playMinesweeperMove = (game, userId, rawIndex, useBomb = false) => {
  const round = game.round;
  if (!round || game.status !== 'playing' || round.winner !== null) return { error: 'Aucune partie de Démineur en cours.' };
  if (round.turn !== userId) return { error: "Ce n'est pas votre tour de jouer !" };
  // Un nombre entier strict : Number(null) vaudrait 0 et jouerait la première case
  const index = rawIndex;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= MS_CELLS) return { error: 'Coup invalide : case hors du plateau.' };

  const revealed = [];
  const reveal = (i) => {
    if (round.mines[i]) {
      const color = colorOf(game, userId);
      round.revealed[i] = color;
      round.found[userId]++;
      revealed.push({ i, f: color });
    } else {
      round.revealed[i] = round.adjacent[i];
      revealed.push({ i, n: round.adjacent[i] });
    }
  };

  let keepTurn;
  if (useBomb) {
    if (!canUseBomb(game, userId)) return { error: 'Bombe indisponible (une par manche, avec au moins 3 points de retard).' };
    round.bombUsed[userId] = true;
    const r0 = Math.floor(index / MS_SIZE);
    const c0 = index % MS_SIZE;
    let minesHit = 0;
    for (let r = r0 - MS_BOMB_RADIUS; r <= r0 + MS_BOMB_RADIUS; r++) {
      for (let c = c0 - MS_BOMB_RADIUS; c <= c0 + MS_BOMB_RADIUS; c++) {
        if (r < 0 || r >= MS_SIZE || c < 0 || c >= MS_SIZE) continue;
        const i = r * MS_SIZE + c;
        if (round.revealed[i] !== null) continue;
        if (round.mines[i]) minesHit++;
        reveal(i);
      }
    }
    keepTurn = minesHit > 0;
  } else {
    if (round.revealed[index] !== null) return { error: 'Cette case est déjà révélée.' };
    if (round.mines[index]) {
      reveal(index);
      keepTurn = true;
    } else if (round.adjacent[index] > 0) {
      reveal(index);
      keepTurn = false;
    } else {
      // Remplissage par diffusion : cases vides et leur bordure de chiffres (jamais une mine)
      const queue = [index];
      reveal(index);
      while (queue.length > 0) {
        const cur = queue.shift();
        if (round.adjacent[cur] !== 0) continue;
        for (const j of neighbors(cur)) {
          if (round.revealed[j] !== null || round.mines[j]) continue;
          reveal(j);
          queue.push(j);
        }
      }
      keepTurn = false;
    }
  }

  round.lastMove = { by: userId, index, bomb: !!useBomb };
  if (!finishIfWon(game, userId) && !keepTurn) round.turn = opponentOf(game, userId);
  return { revealed, keepTurn };
};

/** État transmissible à un client : jamais l'emplacement des mines non trouvées (sauf fin de partie). */
export const minesweeperPublicState = (game) => {
  const round = game.round;
  const finished = round.winner !== null;
  return {
    // Règles transmises au client (une seule source de vérité : le serveur)
    config: { size: MS_SIZE, mines: MS_MINES, winScore: MS_WIN_SCORE, bombRadius: MS_BOMB_RADIUS, bombMinDeficit: MS_BOMB_MIN_DEFICIT },
    players: { blue: game.playerBlue, red: game.playerRed },
    revealed: round.revealed,
    found: round.found,
    wins: game.wins,
    bombUsed: round.bombUsed,
    turn: round.turn,
    winner: round.winner,
    remaining: remainingMines(round),
    lastMove: round.lastMove,
    mines: finished ? round.mines.map((m, i) => (m && round.revealed[i] === null ? i : -1)).filter((i) => i >= 0) : undefined
  };
};

/** Crée la partie (le joueur Bleu, l'initiateur, ouvre la première manche). */
export const createMinesweeperGame = (playerBlue, playerRed) => ({
  gameType: 'minesweeper',
  playerBlue,
  playerRed,
  status: 'playing',
  wins: { [playerBlue]: 0, [playerRed]: 0 },
  firstPlayer: playerBlue,
  round: createMinesweeperRound(playerBlue, playerRed, playerBlue),
  get turn() { return this.round.turn; },
  // Compatibilité avec les autres jeux (scores des manches)
  get scores() { return this.wins; }
});

/** Nouvelle manche : nouveau plateau, l'autre joueur commence. */
export const restartMinesweeperGame = (game) => {
  game.firstPlayer = opponentOf(game, game.firstPlayer);
  game.round = createMinesweeperRound(game.playerBlue, game.playerRed, game.firstPlayer);
  game.status = 'playing';
};
