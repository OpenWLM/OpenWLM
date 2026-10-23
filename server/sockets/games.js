import { db } from '../db.js';
import { getUserRoom, isUserOnline } from '../sessionStore.js';
import { canInteract } from '../middleware/auth.js';
import { 
  activeGames, 
  pendingGameInvites, 
  GAME_INVITE_TTL_MS, 
  getGameKey, 
  createInitialCheckersBoard, 
  createEmptyPuissance4Board, 
  isPuissance4BoardFull, 
  checkPuissance4Winner 
} from '../routes/games.js';
import { isAllowed } from '../utils/rateWindow.js';
import {
  createMinesweeperGame,
  restartMinesweeperGame,
  playMinesweeperMove,
  minesweeperPublicState
} from '../games/minesweeper.js';

const GAME_TYPES = ['checkers', 'puissance4', 'minesweeper'];

// Coups de jeu : 40 par 10 s et par utilisateur (largement au-dessus d'un jeu humain, y
// compris les enchaînements de mines du Démineur ; borne l'amplification par un client).
export const gameMoveLimits = new Map();
export const GAME_MOVE_LIMIT = 40;
export const GAME_MOVE_WINDOW_MS = 10000;
// Autres événements de jeu (invitation, acceptation, refus, rejouer, quitter, resync) :
// 15 par 10 s. Une invitation en boucle affichait une fenêtre chez le contact à chaque appel.
export const gameEventLimits = new Map();
export const GAME_EVENT_LIMIT = 15;

const asId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export const registerGameHandlers = (io, socket) => {
  /**
   * Contrôles communs à tout coup de jeu : débit, et relation toujours valide (un contact
   * bloqué ou supprimé en cours de partie ne peut plus jouer — comme pour resync/restart/quit).
   */
  const guardMove = (userId, target) => {
    if (!isAllowed(gameMoveLimits, userId, GAME_MOVE_LIMIT, GAME_MOVE_WINDOW_MS)) {
      socket.emit('game_error', { message: 'Trop de coups envoyés. Patientez un instant.' });
      return false;
    }
    const check = canInteract(userId, target);
    if (!check.allowed) {
      socket.emit('game_error', { message: check.reason });
      return false;
    }
    return true;
  };

  /** Débit des événements de jeu hors coups ; cible normalisée en entier (sinon ignoré). */
  const guardEvent = (data) => {
    if (!socket.user || !socket.user.id) return null;
    const target = asId(data?.target);
    if (!target) return null;
    if (!isAllowed(gameEventLimits, socket.user.id, GAME_EVENT_LIMIT, GAME_MOVE_WINDOW_MS)) {
      socket.emit('game_error', { message: 'Trop de demandes. Patientez un instant.' });
      return null;
    }
    return target;
  };

  // 1. Envoi d'une invitation à jouer
  socket.on('game_invite', (data) => {
    const target = guardEvent(data);
    if (!target) return;
    const { gameType } = data || {};
    
    const check = canInteract(socket.user.id, target);
    if (!check.allowed) {
      return socket.emit('game_error', { message: check.reason });
    }

    if (isUserOnline(target)) {
      const senderUser = db.prepare('SELECT id, nickname, username FROM users WHERE id = ?').get(socket.user.id);
      if (!senderUser) return;

      const safeGameType = GAME_TYPES.includes(gameType) ? gameType : 'morpion';
      
      // SÉCURITÉ : Enregistrer l'invitation avec expiration (60 secondes)
      const inviteKey = `${socket.user.id}_${target}`;
      pendingGameInvites.set(inviteKey, {
        gameType: safeGameType,
        expiresAt: Date.now() + GAME_INVITE_TTL_MS
      });

      io.to(getUserRoom(target)).emit('game_invite_received', {
        from: socket.user.id,
        fromName: senderUser.nickname || senderUser.username,
        gameType: safeGameType
      });
    } else {
      socket.emit('game_user_offline', { target });
    }
  });

  // 2. Acceptation de l'invitation (Création sécurisée de la session de jeu)
  socket.on('game_accept', (data) => {
    const target = guardEvent(data);
    if (!target) return;
    const { gameType } = data || {};

    const check = canInteract(socket.user.id, target);
    if (!check.allowed) {
      return socket.emit('game_error', { message: check.reason });
    }

    // SÉCURITÉ : Exiger une invitation préalable valide et non expirée
    const inviteKey = `${target}_${socket.user.id}`;
    const invite = pendingGameInvites.get(inviteKey);
    if (!invite || Date.now() > invite.expiresAt) {
      if (invite) pendingGameInvites.delete(inviteKey);
      return socket.emit('game_error', { message: "Aucune invitation valide ou expirée." });
    }
    // Consommation unique de l'invitation
    pendingGameInvites.delete(inviteKey);

    const acceptorUser = db.prepare('SELECT id, nickname, username FROM users WHERE id = ?').get(socket.user.id);
    const targetUser = db.prepare('SELECT id, nickname, username FROM users WHERE id = ?').get(target);

    if (isUserOnline(target) && acceptorUser && targetUser) {
      const gameKey = getGameKey(target, socket.user.id);
      const chosenGameType = invite.gameType || (GAME_TYPES.includes(gameType) ? gameType : 'morpion');

      if (chosenGameType === 'minesweeper') {
        // L'initiateur joue Bleu et ouvre la première manche ; l'accepteur joue Rouge
        const game = createMinesweeperGame(Number(target), socket.user.id);
        activeGames.set(gameKey, game);
        io.to(getUserRoom(target)).emit('game_started', {
          opponentId: socket.user.id,
          opponentName: acceptorUser.nickname || acceptorUser.username,
          myColor: 'blue',
          isMyTurn: true,
          gameType: 'minesweeper'
        });
        socket.emit('game_started', {
          opponentId: target,
          opponentName: targetUser.nickname || targetUser.username,
          myColor: 'red',
          isMyTurn: false,
          gameType: 'minesweeper'
        });
      } else if (chosenGameType === 'checkers') {
        const initialBoard = createInitialCheckersBoard();
        activeGames.set(gameKey, {
          gameType: 'checkers',
          playerWhite: target,         // L'initiateur a les Blancs
          playerBlack: socket.user.id, // L'accepteur a les Noirs
          turn: target,                // Les Blancs commencent
          board: initialBoard,
          status: 'playing',
          scores: { [target]: 0, [socket.user.id]: 0 }
        });

        // L'initiateur a les Blancs et a le premier tour
        io.to(getUserRoom(target)).emit('game_started', {
          opponentId: socket.user.id,
          opponentName: acceptorUser.nickname || acceptorUser.username,
          myColor: 'white',
          mySymbol: 'W',
          isMyTurn: true,
          gameType: 'checkers'
        });

        // L'accepteur a les Noirs et attend son tour
        socket.emit('game_started', {
          opponentId: target,
          opponentName: targetUser.nickname || targetUser.username,
          myColor: 'black',
          mySymbol: 'B',
          isMyTurn: false,
          gameType: 'checkers'
        });
      } else if (chosenGameType === 'puissance4') {
        const initialBoard = createEmptyPuissance4Board();
        activeGames.set(gameKey, {
          gameType: 'puissance4',
          playerRed: target,             // L'initiateur a les Rouges
          playerYellow: socket.user.id,  // L'accepteur a les Jaunes
          turn: target,                  // Les Rouges commencent
          board: initialBoard,
          status: 'playing',
          scores: { [target]: 0, [socket.user.id]: 0 }
        });

        // L'initiateur a les Rouges et a le premier tour
        io.to(getUserRoom(target)).emit('game_started', {
          opponentId: socket.user.id,
          opponentName: acceptorUser.nickname || acceptorUser.username,
          myColor: 'red',
          mySymbol: 'R',
          isMyTurn: true,
          gameType: 'puissance4'
        });

        // L'accepteur a les Jaunes et attend son tour
        socket.emit('game_started', {
          opponentId: target,
          opponentName: targetUser.nickname || targetUser.username,
          myColor: 'yellow',
          mySymbol: 'Y',
          isMyTurn: false,
          gameType: 'puissance4'
        });
      } else {
        // Morpion
        activeGames.set(gameKey, {
          gameType: 'morpion',
          playerX: target,         // L'initiateur joue 'X'
          playerO: socket.user.id, // L'accepteur joue 'O'
          turn: target,            // 'X' commence toujours
          board: Array(9).fill(null),
          status: 'playing',
          scores: { [target]: 0, [socket.user.id]: 0 }
        });

        // L'initiateur joue 'X' et a le premier tour
        io.to(getUserRoom(target)).emit('game_started', {
          opponentId: socket.user.id,
          opponentName: acceptorUser.nickname || acceptorUser.username,
          mySymbol: 'X',
          isMyTurn: true,
          gameType: 'morpion'
        });

        // L'accepteur joue 'O' et attend son tour
        socket.emit('game_started', {
          opponentId: target,
          opponentName: targetUser.nickname || targetUser.username,
          mySymbol: 'O',
          isMyTurn: false,
          gameType: 'morpion'
        });
      }
    } else {
      // L'initiateur s'est déconnecté entre-temps : l'invitation est consommée, on le dit
      socket.emit('game_user_offline', { target });
    }
  });

  // 3. Refus de l'invitation
  socket.on('game_decline', (data) => {
    const target = guardEvent(data);
    if (!target) return;
    const check = canInteract(socket.user.id, target);
    if (!check.allowed) return;

    // SÉCURITÉ : Nettoyer l'invitation refusée
    const inviteKey = `${target}_${socket.user.id}`;
    pendingGameInvites.delete(inviteKey);

    if (isUserOnline(target)) {
      const user = db.prepare('SELECT nickname, username FROM users WHERE id = ?').get(socket.user.id);
      io.to(getUserRoom(target)).emit('game_declined', {
        from: socket.user.id,
        fromName: user?.nickname || user?.username || 'Le contact'
      });
    }
  });

  // 4a. Transmission et validation d'un coup de Morpion
  socket.on('game_move', (data) => {
    if (!socket.user || !socket.user.id) return;
    const userId = socket.user.id;
    const { target, index } = data || {};
    if (!guardMove(userId, target)) return;

    const gameKey = getGameKey(userId, target);
    const game = activeGames.get(gameKey);

    // SÉCURITÉ 1 : Vérifier qu'une session de jeu active existe (et que c'est bien un Morpion)
    if (!game || game.status !== 'playing' || game.gameType !== 'morpion') {
      return socket.emit('game_error', { message: "Aucune partie active trouvée avec ce contact." });
    }

    // SÉCURITÉ 2 : Vérifier que c'est bien le tour du joueur connecté
    if (game.turn !== userId) {
      return socket.emit('game_error', { message: "Ce n'est pas votre tour de jouer !" });
    }

    // SÉCURITÉ 3 : Vérifier la validité arithmétique de la case (entier entre 0 et 8)
    const cellIndex = parseInt(index, 10);
    if (isNaN(cellIndex) || cellIndex < 0 || cellIndex > 8) {
      return socket.emit('game_error', { message: "Coup invalide : case hors limites." });
    }

    // SÉCURITÉ 4 (ANTI-USURPATION) : Vérifier que la case N'EST PAS DÉJÀ OCCUPÉE !
    if (game.board[cellIndex] !== null) {
      return socket.emit('game_error', { message: "Coup invalide : cette case est déjà occupée !" });
    }

    // SÉCURITÉ 5 : Déterminer le symbole légitime depuis l'état du serveur
    const legitSymbol = (game.playerX === userId) ? 'X' : 'O';
    const nextTurnUserId = (userId === game.playerX) ? game.playerO : game.playerX;

    // Enregistrement autoritaire sur la grille serveur
    game.board[cellIndex] = legitSymbol;
    game.turn = nextTurnUserId;

    // Vérification des conditions de victoire côté serveur
    const WINNING_COMBOS = [
      [0, 1, 2], [3, 4, 5], [6, 7, 8],
      [0, 3, 6], [1, 4, 7], [2, 5, 8],
      [0, 4, 8], [2, 4, 6]
    ];
    let winner = null;
    let winningCombo = null;

    for (const combo of WINNING_COMBOS) {
      const [a, b, c] = combo;
      if (game.board[a] && game.board[a] === game.board[b] && game.board[a] === game.board[c]) {
        winner = game.board[a];
        winningCombo = combo;
        break;
      }
    }

    if (!winner && game.board.every(cell => cell !== null)) {
      winner = 'draw';
    }

    if (winner) {
      game.status = 'finished';
      game.lastWinner = winner;
      if (winner === 'X') game.scores[game.playerX]++;
      if (winner === 'O') game.scores[game.playerO]++;
    }

    // Transmission du coup validé à l'adversaire (avec 'from' pour que le client sache qui a joué)
    io.to(getUserRoom(target)).emit('game_move', {
      from: userId,
      index: cellIndex,
      symbol: legitSymbol,
      winner,
      winningCombo
    });

    // Confirmation au joueur qui a joué
    socket.emit('game_move_confirmed', {
      from: userId,
      index: cellIndex,
      symbol: legitSymbol,
      winner,
      winningCombo
    });
  });

  // 4b. Transmission et validation d'un coup de Dames
  socket.on('checkers_move', (data) => {
    if (!socket.user || !socket.user.id) return;
    const userId = socket.user.id;
    const { target, from, to } = data || {};
    if (!guardMove(userId, target)) return;

    const gameKey = getGameKey(userId, target);
    const game = activeGames.get(gameKey);

    if (!game || game.status !== 'playing' || game.gameType !== 'checkers') {
      return socket.emit('game_error', { message: "Aucune partie de dames active avec ce contact." });
    }

    if (game.turn !== userId) {
      return socket.emit('game_error', { message: "Ce n'est pas votre tour de jouer !" });
    }

    const isValidCoord = (c) => c && Number.isInteger(c.row) && Number.isInteger(c.col) &&
                                c.row >= 0 && c.row < 8 && c.col >= 0 && c.col < 8;

    if (!isValidCoord(from) || !isValidCoord(to)) {
      return socket.emit('game_error', { message: "Coordonnées de coup invalides." });
    }

    const board = game.board;
    const currentPiece = board[from.row][from.col];
    if (!currentPiece) {
      return socket.emit('game_error', { message: "Aucune pièce sur la case de départ." });
    }

    const isWhite = userId === game.playerWhite;
    const ownsPiece = isWhite ? (currentPiece === 'w' || currentPiece === 'W') : (currentPiece === 'b' || currentPiece === 'B');
    if (!ownsPiece) {
      return socket.emit('game_error', { message: "Cette pièce ne vous appartient pas." });
    }

    if (board[to.row][to.col] !== null) {
      return socket.emit('game_error', { message: "La case d'arrivée est déjà occupée." });
    }

    const isKing = currentPiece === 'W' || currentPiece === 'B';
    const dr = to.row - from.row;
    const dc = to.col - from.col;
    const adr = Math.abs(dr);
    const adc = Math.abs(dc);

    const forwardDir = isWhite ? -1 : 1;
    const allowedRowDirs = isKing ? [-1, 1] : [forwardDir];

    let isJump = false;
    let captured = null;

    if (adr === 1 && adc === 1) {
      if (!allowedRowDirs.includes(Math.sign(dr))) {
        return socket.emit('game_error', { message: "Déplacement diagonal invalide." });
      }
    } else if (adr === 2 && adc === 2) {
      if (!allowedRowDirs.includes(Math.sign(dr))) {
        return socket.emit('game_error', { message: "Saut diagonal invalide." });
      }
      const midR = from.row + Math.sign(dr);
      const midC = from.col + Math.sign(dc);
      const midPiece = board[midR][midC];
      const isEnemy = midPiece && (isWhite ? (midPiece === 'b' || midPiece === 'B') : (midPiece === 'w' || midPiece === 'W'));
      if (!isEnemy) {
        return socket.emit('game_error', { message: "Saut invalide : aucune pièce adverse à capturer." });
      }
      isJump = true;
      captured = { row: midR, col: midC };
    } else {
      return socket.emit('game_error', { message: "Coup invalide : une case en diagonale (ou deux pour capturer)." });
    }

    board[from.row][from.col] = null;
    if (isJump && captured) {
      board[captured.row][captured.col] = null;
    }

    const isPromotion = (isWhite && to.row === 0) || (!isWhite && to.row === 7);
    const finalPiece = isPromotion ? (isWhite ? 'W' : 'B') : currentPiece;
    board[to.row][to.col] = finalPiece;

    const nextTurnUserId = (userId === game.playerWhite) ? game.playerBlack : game.playerWhite;
    game.turn = nextTurnUserId;

    const oppPrefix = isWhite ? 'b' : 'w';
    let oppCount = 0;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = board[r][c];
        if (p && p.toLowerCase() === oppPrefix) oppCount++;
      }
    }
    let winner = null;
    if (oppCount === 0) {
      winner = isWhite ? 'white' : 'black';
      game.status = 'finished';
      game.scores[userId] = (game.scores[userId] || 0) + 1;
    }

    const validatedMove = { from, to, isJump, captured, isPromotion, winner };
    io.to(getUserRoom(target)).emit('checkers_move', validatedMove);
    socket.emit('checkers_move_confirmed', validatedMove);
  });

  // 4c. Transmission et validation d'un coup de Puissance 4 (Connect Four)
  socket.on('puissance4_move', (data) => {
    if (!socket.user || !socket.user.id) return;
    const userId = socket.user.id;
    const { target, col } = data || {};
    if (!guardMove(userId, target)) return;

    const gameKey = getGameKey(userId, target);
    const game = activeGames.get(gameKey);

    if (!game || game.status !== 'playing' || game.gameType !== 'puissance4') {
      return socket.emit('game_error', { message: "Aucune partie de Puissance 4 active avec ce contact." });
    }

    if (game.turn !== userId) {
      return socket.emit('game_error', { message: "Ce n'est pas votre tour de jouer !" });
    }

    const colIndex = parseInt(col, 10);
    if (isNaN(colIndex) || colIndex < 0 || colIndex > 6) {
      return socket.emit('game_error', { message: "Coup invalide : colonne hors limites." });
    }

    let targetRow = -1;
    for (let r = 5; r >= 0; r--) {
      if (game.board[r][colIndex] === null) {
        targetRow = r;
        break;
      }
    }

    if (targetRow === -1) {
      return socket.emit('game_error', { message: "Coup invalide : cette colonne est déjà pleine !" });
    }

    const legitSymbol = (game.playerRed === userId) ? 'R' : 'Y';
    const nextTurnUserId = (userId === game.playerRed) ? game.playerYellow : game.playerRed;

    game.board[targetRow][colIndex] = legitSymbol;
    game.turn = nextTurnUserId;

    const winResult = checkPuissance4Winner(game.board);
    let winner = null;
    let winningCells = null;

    if (winResult) {
      winner = winResult.winner;
      winningCells = winResult.winningCells;
      game.status = 'finished';
      if (winner === 'R') game.scores[game.playerRed]++;
      if (winner === 'Y') game.scores[game.playerYellow]++;
    } else if (isPuissance4BoardFull(game.board)) {
      winner = 'draw';
      game.status = 'finished';
    }

    // Transmission du coup validé à l'adversaire (avec 'from')
    io.to(getUserRoom(target)).emit('puissance4_move', {
      from: userId,
      row: targetRow,
      col: colIndex,
      symbol: legitSymbol,
      winner,
      winningCells
    });

    // Confirmation au joueur
    socket.emit('puissance4_move_confirmed', {
      from: userId,
      row: targetRow,
      col: colIndex,
      symbol: legitSymbol,
      winner,
      winningCells
    });
  });

  // 4d. Démineur à deux : clic ou bombe. Le serveur seul connaît les mines ; les deux
  // joueurs (toutes leurs sessions) reçoivent les cases révélées et l'état public.
  socket.on('minesweeper_move', (data) => {
    if (!socket.user || !socket.user.id) return;
    const userId = socket.user.id;
    const { index, bomb } = data || {};
    const target = Number(data?.target);
    if (!guardMove(userId, target)) return;

    const gameKey = getGameKey(userId, target);
    const game = activeGames.get(gameKey);
    if (!game || game.gameType !== 'minesweeper' || ![game.playerBlue, game.playerRed].includes(userId)) {
      return socket.emit('game_error', { message: "Aucune partie de Démineur active avec ce contact." });
    }

    const result = playMinesweeperMove(game, userId, index, bomb === true);
    if (result.error) return socket.emit('game_error', { message: result.error });

    const payload = { from: userId, revealed: result.revealed, bomb: bomb === true, state: minesweeperPublicState(game) };
    io.to(getUserRoom(game.playerBlue)).emit('minesweeper_update', payload);
    io.to(getUserRoom(game.playerRed)).emit('minesweeper_update', payload);
  });

  // 5. Demande de redémarrage de la partie
  socket.on('game_restart', (data) => {
    const target = guardEvent(data);
    if (!target) return;
    const userId = socket.user.id;

    const check = canInteract(userId, target);
    if (!check.allowed) return;

    const gameKey = getGameKey(userId, target);
    const game = activeGames.get(gameKey);
    if (!game) return;
    // Rejouer n'est possible qu'une partie terminée : sinon un joueur en difficulté
    // effaçait le plateau de l'adversaire en pleine partie.
    if (game.status !== 'finished') {
      return socket.emit('game_error', { message: 'La partie est encore en cours.' });
    }

    // SÉCURITÉ : la grille suit le TYPE ENREGISTRÉ de la partie (jamais le type fourni par le client).
    if (game.gameType === 'minesweeper') {
      restartMinesweeperGame(game);
      const state = minesweeperPublicState(game);
      io.to(getUserRoom(game.playerBlue)).emit('minesweeper_update', { from: userId, revealed: [], restart: true, state });
      io.to(getUserRoom(game.playerRed)).emit('minesweeper_update', { from: userId, revealed: [], restart: true, state });
    } else if (game.gameType === 'checkers') {
      game.board = createInitialCheckersBoard();
      game.status = 'playing';
      game.turn = game.playerWhite;
    } else if (game.gameType === 'puissance4') {
      game.board = createEmptyPuissance4Board();
      game.status = 'playing';
      game.turn = game.playerRed;
    } else {
      // Morpion : même règle que l'interface (le perdant commence ; nul → X). Avant, le serveur
      // donnait le tour à celui qui cliquait « Rejouer » : si le gagnant cliquait, aucun des
      // deux ne pouvait jouer.
      const lastWinner = game.lastWinner || 'draw';
      game.board = Array(9).fill(null);
      game.status = 'playing';
      game.turn = lastWinner === 'X' ? game.playerO : lastWinner === 'O' ? game.playerX : game.playerX;
    }

    io.to(getUserRoom(target)).emit('game_restart', {
      from: userId,
      gameType: game.gameType
    });
  });

  // 6. Quitter / Abandonner la partie
  socket.on('game_quit', (data) => {
    const target = guardEvent(data);
    if (!target) return;
    const userId = socket.user.id;

    const check = canInteract(userId, target);
    if (!check.allowed) return;

    const gameKey = getGameKey(userId, target);
    const hadGame = activeGames.delete(gameKey);
    if (!hadGame) return;

    io.to(getUserRoom(target)).emit('game_quit', {
      from: userId
    });
  });

  // 6bis. Re-synchronisation de l'état de la partie
  socket.on('game_resync', (data) => {
    const target = guardEvent(data);
    if (!target) return;
    const userId = socket.user.id;

    const check = canInteract(userId, target);
    if (!check.allowed) return;

    const gameKey = getGameKey(userId, target);
    const game = activeGames.get(gameKey);
    if (!game) {
      return socket.emit('game_resync_state', { active: false });
    }

    if (game.gameType === 'minesweeper') {
      // Jamais la matrice des mines : uniquement l'état public (cases révélées)
      return socket.emit('game_resync_state', {
        active: true,
        gameType: 'minesweeper',
        isMyTurn: game.turn === userId,
        status: game.status,
        state: minesweeperPublicState(game)
      });
    }

    socket.emit('game_resync_state', {
      active: true,
      gameType: game.gameType,
      board: game.board,
      isMyTurn: game.turn === userId,
      status: game.status
    });
  });
};
