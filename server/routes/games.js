import { Router } from 'express';
import { db } from '../db.js';
import { authenticateToken, sensitiveRateLimiter } from '../middleware/auth.js';

export const activeGames = new Map();
export const pendingGameInvites = new Map();
export const GAME_INVITE_TTL_MS = 60 * 1000;

export const getGameKey = (id1, id2) => {
  const [min, max] = Number(id1) < Number(id2) ? [id1, id2] : [id2, id1];
  return `${min}_${max}`;
};

export const getGamePlayers = (game) => {
  if (!game) return [];
  if (game.gameType === 'checkers') return [game.playerWhite, game.playerBlack];
  if (game.gameType === 'puissance4') return [game.playerRed, game.playerYellow];
  return [game.playerX, game.playerO];
};

export const createInitialCheckersBoard = () => {
  const b = Array(8).fill(null).map(() => Array(8).fill(null));
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 8; c++) {
      if ((r + c) % 2 === 1) b[r][c] = 'b';
    }
  }
  for (let r = 5; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if ((r + c) % 2 === 1) b[r][c] = 'w';
    }
  }
  return b;
};

export const createEmptyPuissance4Board = () => {
  return Array.from({ length: 6 }, () => Array(7).fill(null));
};

export const isPuissance4BoardFull = (board) => {
  for (let c = 0; c < 7; c++) {
    if (board[0][c] === null) return false;
  }
  return true;
};

export const checkPuissance4Winner = (board) => {
  const ROWS = 6;
  const COLS = 7;

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c <= COLS - 4; c++) {
      const p = board[r][c];
      if (p && p === board[r][c + 1] && p === board[r][c + 2] && p === board[r][c + 3]) {
        return { winner: p, winningCells: [[r, c], [r, c + 1], [r, c + 2], [r, c + 3]] };
      }
    }
  }

  for (let r = 0; r <= ROWS - 4; r++) {
    for (let c = 0; c < COLS; c++) {
      const p = board[r][c];
      if (p && p === board[r + 1][c] && p === board[r + 2][c] && p === board[r + 3][c]) {
        return { winner: p, winningCells: [[r, c], [r + 1, c], [r + 2, c], [r + 3, c]] };
      }
    }
  }

  for (let r = 0; r <= ROWS - 4; r++) {
    for (let c = 0; c <= COLS - 4; c++) {
      const p = board[r][c];
      if (p && p === board[r + 1][c + 1] && p === board[r + 2][c + 2] && p === board[r + 3][c + 3]) {
        return { winner: p, winningCells: [[r, c], [r + 1, c + 1], [r + 2, c + 2], [r + 3, c + 3]] };
      }
    }
  }

  for (let r = 3; r < ROWS; r++) {
    for (let c = 0; c <= COLS - 4; c++) {
      const p = board[r][c];
      if (p && p === board[r - 1][c + 1] && p === board[r - 2][c + 2] && p === board[r - 3][c + 3]) {
        return { winner: p, winningCells: [[r, c], [r - 1, c + 1], [r - 2, c + 2], [r - 3, c + 3]] };
      }
    }
  }

  return null;
};

export const createGamesRouter = () => {
  const router = Router();

  router.get('/games/active', authenticateToken, sensitiveRateLimiter, (req, res) => {
    const userId = req.user.id;
    const games = [];
    for (const game of activeGames.values()) {
      if (game.status !== 'playing') continue;
      const players = getGamePlayers(game);
      if (!players.includes(userId)) continue;
      const opponentId = players.find(p => p !== userId);
      const opp = db.prepare('SELECT id, nickname, username FROM users WHERE id = ?').get(opponentId);
      const entry = {
        opponentId,
        opponentName: opp ? (opp.nickname || opp.username) : 'Contact',
        gameType: game.gameType,
        isMyTurn: game.turn === userId,
        status: game.status
      };
      if (game.gameType === 'checkers') {
        entry.myColor = (game.playerWhite === userId) ? 'white' : 'black';
      } else if (game.gameType === 'puissance4') {
        entry.myColor = (game.playerRed === userId) ? 'red' : 'yellow';
      } else {
        entry.mySymbol = (game.playerX === userId) ? 'X' : 'O';
      }
      games.push(entry);
    }
    res.json({ games });
  });

  return router;
};
