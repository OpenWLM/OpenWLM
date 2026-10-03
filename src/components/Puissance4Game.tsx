import React, { useState, useEffect, useCallback } from 'react';
import { Socket } from 'socket.io-client';
import SoundManager from '../utils/SoundManager';
import { useI18n } from '../i18n';
import { formatNickname } from '../utils/NicknameFormatter';

interface Puissance4GameProps {
  socket: Socket | null;
  opponentId: number;
  opponentName: string;
  opponentAvatar?: string;
  myId: number;
  myName: string;
  myAvatar?: string;
  myColor?: 'red' | 'yellow';
  initialIsMyTurn: boolean;
  isBotOpponent?: boolean;
  onClose: () => void;
  onMinimize?: () => void;
  onGameStateChange?: (state: { isMyTurn: boolean; myScore: number; opponentScore: number; winner: 'me' | 'opponent' | 'draw' | null }) => void;
}

const ROWS = 6;
const COLS = 7;

type CellValue = 'R' | 'Y' | null;

// Vérification de victoire 4 alignés
function checkWinner(board: CellValue[][]): { winnerSymbol: 'R' | 'Y' | 'draw'; winningCells: [number, number][] | null } | null {
  // 1. Horizontale
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c <= COLS - 4; c++) {
      const p = board[r][c];
      if (p && p === board[r][c + 1] && p === board[r][c + 2] && p === board[r][c + 3]) {
        return { winnerSymbol: p, winningCells: [[r, c], [r, c + 1], [r, c + 2], [r, c + 3]] };
      }
    }
  }

  // 2. Verticale
  for (let r = 0; r <= ROWS - 4; r++) {
    for (let c = 0; c < COLS; c++) {
      const p = board[r][c];
      if (p && p === board[r + 1][c] && p === board[r + 2][c] && p === board[r + 3][c]) {
        return { winnerSymbol: p, winningCells: [[r, c], [r + 1, c], [r + 2, c], [r + 3, c]] };
      }
    }
  }

  // 3. Diagonale descendante (\)
  for (let r = 0; r <= ROWS - 4; r++) {
    for (let c = 0; c <= COLS - 4; c++) {
      const p = board[r][c];
      if (p && p === board[r + 1][c + 1] && p === board[r + 2][c + 2] && p === board[r + 3][c + 3]) {
        return { winnerSymbol: p, winningCells: [[r, c], [r + 1, c + 1], [r + 2, c + 2], [r + 3, c + 3]] };
      }
    }
  }

  // 4. Diagonale montante (/)
  for (let r = 3; r < ROWS; r++) {
    for (let c = 0; c <= COLS - 4; c++) {
      const p = board[r][c];
      if (p && p === board[r - 1][c + 1] && p === board[r - 2][c + 2] && p === board[r - 3][c + 3]) {
        return { winnerSymbol: p, winningCells: [[r, c], [r - 1, c + 1], [r - 2, c + 2], [r - 3, c + 3]] };
      }
    }
  }

  // 5. Match nul si grille pleine
  let isFull = true;
  for (let c = 0; c < COLS; c++) {
    if (board[0][c] === null) {
      isFull = false;
      break;
    }
  }

  if (isFull) {
    return { winnerSymbol: 'draw', winningCells: null };
  }

  return null;
}

export const Puissance4Game: React.FC<Puissance4GameProps> = ({
  socket,
  opponentId,
  opponentName,
  opponentAvatar = '/assets/usertiles/guest.png',
  myId: _myId,
  myName,
  myAvatar = '/assets/usertiles/chess.png',
  myColor = 'red',
  initialIsMyTurn,
  isBotOpponent = false,
  onClose,
  onMinimize,
  onGameStateChange
}) => {
  const { t } = useI18n();

  // Grille 6 lignes x 7 colonnes
  const [board, setBoard] = useState<CellValue[][]>(() =>
    Array.from({ length: ROWS }, () => Array(COLS).fill(null))
  );

  const isRed = myColor === 'red';
  const mySymbol: 'R' | 'Y' = isRed ? 'R' : 'Y';
  const opponentSymbol: 'R' | 'Y' = isRed ? 'Y' : 'R';

  const [isMyTurn, setIsMyTurn] = useState<boolean>(initialIsMyTurn);
  const [myScore, setMyScore] = useState(0);
  const [opponentScore, setOpponentScore] = useState(0);
  const [draws, setDraws] = useState(0);
  const [winner, setWinner] = useState<'me' | 'opponent' | 'draw' | null>(null);
  const [winningCells, setWinningCells] = useState<[number, number][] | null>(null);
  const [hoverCol, setHoverCol] = useState<number | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [lastMoveCell, setLastMoveCell] = useState<[number, number] | null>(null);

  // Trouver la ligne d'atterrissage pour une colonne donnée (gravité)
  const getLowestEmptyRow = (currentBoard: CellValue[][], col: number): number => {
    for (let r = ROWS - 1; r >= 0; r--) {
      if (currentBoard[r][col] === null) return r;
    }
    return -1;
  };

  // Jouer un coup dans la colonne
  const handleColumnClick = (col: number) => {
    if (!isMyTurn || winner !== null) return;

    const row = getLowestEmptyRow(board, col);
    if (row === -1) {
      // Colonne pleine
      return;
    }

    const nextBoard = board.map(r => [...r]);
    nextBoard[row][col] = mySymbol;

    setBoard(nextBoard);
    setIsMyTurn(false);
    setLastMoveCell([row, col]);

    try {
      SoundManager.play('TYPE');
    } catch {}

    // Notifier le serveur et l'adversaire
    if (socket && !isBotOpponent) {
      socket.emit('puissance4_move', {
        target: opponentId,
        col
      });
    }

    // Vérifier la victoire locale
    const result = checkWinner(nextBoard);
    if (result) {
      if (result.winnerSymbol === mySymbol) {
        setWinner('me');
        setWinningCells(result.winningCells);
        setMyScore(prev => prev + 1);
        try { SoundManager.play('ONLINE'); } catch {}
      } else if (result.winnerSymbol === 'draw') {
        setWinner('draw');
        setDraws(prev => prev + 1);
      }
    } else if (isBotOpponent) {
      // Tour du Bot OpenWLM en mode solo
      setTimeout(() => {
        setBoard(currentBoard => {
          // Trouver toutes les colonnes jouables
          const validCols: number[] = [];
          for (let c = 0; c < COLS; c++) {
            if (currentBoard[0][c] === null) validCols.push(c);
          }
          if (validCols.length === 0) return currentBoard;

          let chosenCol = -1;

          // 1. Coup gagnant pour le bot ?
          for (const c of validCols) {
            const r = getLowestEmptyRow(currentBoard, c);
            if (r !== -1) {
              const testB = currentBoard.map(rowArr => [...rowArr]);
              testB[r][c] = opponentSymbol;
              const w = checkWinner(testB);
              if (w && w.winnerSymbol === opponentSymbol) {
                chosenCol = c;
                break;
              }
            }
          }

          // 2. Bloquer le joueur s'il gagne au coup suivant ?
          if (chosenCol === -1) {
            for (const c of validCols) {
              const r = getLowestEmptyRow(currentBoard, c);
              if (r !== -1) {
                const testB = currentBoard.map(rowArr => [...rowArr]);
                testB[r][c] = mySymbol;
                const w = checkWinner(testB);
                if (w && w.winnerSymbol === mySymbol) {
                  chosenCol = c;
                  break;
                }
              }
            }
          }

          // 3. Préférence pour le centre (col 3, puis 2/4, 1/5, 0/6)
          if (chosenCol === -1) {
            const centerPreferences = [3, 2, 4, 1, 5, 0, 6];
            for (const prefCol of centerPreferences) {
              if (validCols.includes(prefCol)) {
                // Éviter si ce coup donne immédiatement la victoire au joueur au coup d'après
                const r = getLowestEmptyRow(currentBoard, prefCol);
                if (r > 0) {
                  const testB = currentBoard.map(rowArr => [...rowArr]);
                  testB[r][prefCol] = opponentSymbol;
                  testB[r - 1][prefCol] = mySymbol;
                  const w = checkWinner(testB);
                  if (w && w.winnerSymbol === mySymbol) {
                    continue; // Donnerait la gagne
                  }
                }
                chosenCol = prefCol;
                break;
              }
            }
          }

          // 4. Choix par défaut
          if (chosenCol === -1) {
            chosenCol = validCols[Math.floor(Math.random() * validCols.length)];
          }

          const botRow = getLowestEmptyRow(currentBoard, chosenCol);
          if (botRow === -1) return currentBoard;

          const botBoard = currentBoard.map(r => [...r]);
          botBoard[botRow][chosenCol] = opponentSymbol;
          setLastMoveCell([botRow, chosenCol]);

          try { SoundManager.play('TYPE'); } catch {}

          const botResult = checkWinner(botBoard);
          if (botResult) {
            if (botResult.winnerSymbol === opponentSymbol) {
              setWinner('opponent');
              setWinningCells(botResult.winningCells);
              setOpponentScore(prev => prev + 1);
              try { SoundManager.play('NUDGE'); } catch {}
            } else if (botResult.winnerSymbol === 'draw') {
              setWinner('draw');
              setDraws(prev => prev + 1);
            }
          } else {
            setIsMyTurn(true);
          }

          return botBoard;
        });
      }, 500);
    }
  };

  // Recommencer une nouvelle manche
  const handleRestart = useCallback((notifyOpponent: boolean = true) => {
    setBoard(Array.from({ length: ROWS }, () => Array(COLS).fill(null)));
    setWinner(null);
    setWinningCells(null);
    setLastMoveCell(null);
    setStatusMessage('');

    // Les Rouges commencent toujours la nouvelle manche
    setIsMyTurn(mySymbol === 'R');

    if (notifyOpponent && socket && !isBotOpponent) {
      socket.emit('game_restart', { target: opponentId, gameType: 'puissance4' });
    }
  }, [mySymbol, socket, opponentId, isBotOpponent]);

  // Quitter la partie
  const handleQuit = useCallback(() => {
    if (socket && !isBotOpponent) {
      socket.emit('game_quit', { target: opponentId });
    }
    onClose();
  }, [socket, opponentId, isBotOpponent, onClose]);

  // Écoute des événements WebSocket
  useEffect(() => {
    if (!socket || isBotOpponent) return;

    const onPuissance4Move = (data: { from: number; row: number; col: number; symbol: string; winner?: any; winningCells?: any }) => {
      if (data.from !== opponentId) return;

      const { row, col } = data;
      if (!Number.isInteger(col) || col < 0 || col >= COLS) return;

      setBoard(prev => {
        const nextBoard = prev.map(r => [...r]);
        // Déterminer la ligne si non transmise
        const actualRow = (typeof row === 'number' && row >= 0 && row < ROWS)
          ? row
          : getLowestEmptyRow(prev, col);

        if (actualRow === -1) return prev;

        nextBoard[actualRow][col] = opponentSymbol;
        setLastMoveCell([actualRow, col]);

        const result = checkWinner(nextBoard);
        if (result) {
          if (result.winnerSymbol === opponentSymbol) {
            setWinner('opponent');
            setWinningCells(result.winningCells);
            setOpponentScore(prevScore => prevScore + 1);
            try { SoundManager.play('NUDGE'); } catch {}
          } else if (result.winnerSymbol === 'draw') {
            setWinner('draw');
            setDraws(prevDraws => prevDraws + 1);
          }
        } else {
          setIsMyTurn(true);
        }

        return nextBoard;
      });

      try {
        SoundManager.play('TYPE');
      } catch {}
    };

    const onGameRestart = (data: { from: number }) => {
      if (data.from !== opponentId) return;
      handleRestart(false);
      setStatusMessage(t.games.opponentRestarted.replace('{name}', opponentName));
      setTimeout(() => setStatusMessage(''), 4000);
    };

    const onGameQuit = (data: { from: number }) => {
      if (data.from !== opponentId) return;
      setStatusMessage(t.games.opponentQuit.replace('{name}', opponentName));
      setTimeout(() => onClose(), 2500);
    };

    const onGameError = (data: { message: string }) => {
      if (data.message) alert(data.message);
    };

    socket.on('puissance4_move', onPuissance4Move);
    socket.on('game_restart', onGameRestart);
    socket.on('game_quit', onGameQuit);
    socket.on('game_error', onGameError);

    return () => {
      socket.off('puissance4_move', onPuissance4Move);
      socket.off('game_restart', onGameRestart);
      socket.off('game_quit', onGameQuit);
      socket.off('game_error', onGameError);
    };
  }, [socket, opponentId, opponentName, opponentSymbol, isBotOpponent, handleRestart, onClose, t]);

  // Synchronisation du dock résumé
  useEffect(() => {
    onGameStateChange?.({ isMyTurn, myScore, opponentScore, winner });
  }, [isMyTurn, myScore, opponentScore, winner, onGameStateChange]);

  const myColorLabel = isRed ? t.games.redLabel : t.games.yellowLabel;
  const opponentColorLabel = isRed ? t.games.yellowLabel : t.games.redLabel;

  return (
    <div className="wlm-game-side-panel">
      {/* En-tête de panneau Aero */}
      <div className="wlm-game-header">
        <div className="wlm-game-title">
          <span className="wlm-game-icon">🔴</span>
          <span>{formatNickname(t.games.puissance4Title.replace('{name}', opponentName))}</span>
        </div>
        <div className="wlm-game-header-controls">
          {onMinimize && (
            <button 
              className="win-title-control win-minimize-btn" 
              onClick={onMinimize} 
              title={t.games.minimizeTitle}
            >
              _
            </button>
          )}
          <button 
            className="win-title-control win-close-btn" 
            onClick={handleQuit} 
            title={t.games.quitGameTitle}
          >
            ✕
          </button>
        </div>
      </div>

      {/* Barre de retour rapide à la discussion */}
      {onMinimize && (
        <div className="wlm-game-quick-return-bar" onClick={onMinimize} title={t.games.minimizeTitle}>
          <span>{t.games.minimizeToChat}</span>
          <span className="quick-return-arrow">◀</span>
        </div>
      )}

      {/* Tableau des scores et avatars */}
      <div className="wlm-game-scoreboard">
        {/* Joueur 1 (Moi) */}
        <div className={`player-card ${isMyTurn && !winner ? 'active-turn' : ''}`}>
          <div className="player-avatar-wrap">
            <img src={myAvatar} alt={myName} className="player-avatar" />
          </div>
          <div className="player-details">
            <div className="p4-player-name-row" title={`${myName} ${t.games.meLabel} (${myColorLabel})`}>
              <span className={`p4-player-dot dot-${isRed ? 'red' : 'yellow'}`} title={myColorLabel} />
              <span className="player-name">{formatNickname(myName)} {t.games.meLabel}</span>
            </div>
            <span className="player-score-badge">{myScore} {myScore > 1 ? t.games.winPlural : t.games.winSingle}</span>
          </div>
        </div>

        {/* Versus et Score central */}
        <div className="game-vs-badge">
          <div className="vs-label">VS</div>
          <div className="score-numbers">{myScore} - {opponentScore}</div>
          {draws > 0 && <div className="draws-count">{draws} {draws > 1 ? t.games.drawPlural : t.games.drawSingle}</div>}
        </div>

        {/* Joueur 2 (Adversaire) */}
        <div className={`player-card ${!isMyTurn && !winner ? 'active-turn' : ''}`}>
          <div className="player-avatar-wrap">
            <img src={opponentAvatar} alt={opponentName} className="player-avatar" />
          </div>
          <div className="player-details">
            <div className="p4-player-name-row" title={`${opponentName} (${opponentColorLabel})`}>
              <span className={`p4-player-dot dot-${!isRed ? 'red' : 'yellow'}`} title={opponentColorLabel} />
              <span className="player-name">{formatNickname(opponentName)}</span>
            </div>
            <span className="player-score-badge">{opponentScore} {opponentScore > 1 ? t.games.winPlural : t.games.winSingle}</span>
          </div>
        </div>
      </div>

      {/* Bannière d'état de jeu traduite */}
      <div className={`game-turn-banner ${winner ? `banner-${winner}` : isMyTurn ? 'banner-my-turn' : 'banner-wait'}`}>
        {statusMessage ? (
          <span>{formatNickname(statusMessage)}</span>
        ) : winner === 'me' ? (
          <span>{t.games.bannerWin}</span>
        ) : winner === 'opponent' ? (
          <span>{formatNickname(t.games.bannerLoss.replace('{name}', opponentName))}</span>
        ) : winner === 'draw' ? (
          <span>{t.games.bannerDraw}</span>
        ) : isMyTurn ? (
          <span>{t.games.bannerYourTurnColor.replace('{color}', myColorLabel)}</span>
        ) : (
          <span>{formatNickname(t.games.bannerWaitOpponent.replace('{name}', opponentName))}</span>
        )}
      </div>

      {/* Plateau de jeu Puissance 4 (7 colonnes x 6 rangées) */}
      <div className="p4-board-wrapper">
        {/* Ligne d'indicateur de survol au-dessus des colonnes */}
        <div className="p4-hover-indicator-row">
          {Array.from({ length: COLS }).map((_, cIdx) => {
            const isColFull = board[0][cIdx] !== null;
            const isHovered = hoverCol === cIdx && isMyTurn && !winner && !isColFull;
            return (
              <div 
                key={cIdx} 
                className={`p4-hover-slot ${isHovered ? 'active' : ''}`}
                onClick={() => handleColumnClick(cIdx)}
              >
                {isHovered && (
                  <span className={`p4-ghost-disc disc-${isRed ? 'red' : 'yellow'}`}>▼</span>
                )}
              </div>
            );
          })}
        </div>

        {/* Grille bleue Hasbro Aero rétro */}
        <div className="p4-grid-frame">
          {Array.from({ length: COLS }).map((_, cIdx) => {
            const isColFull = board[0][cIdx] !== null;
            const isClickable = isMyTurn && !winner && !isColFull;

            return (
              <div
                key={cIdx}
                className={`p4-column ${isClickable ? 'col-clickable' : ''} ${isColFull ? 'col-full' : ''}`}
                onMouseEnter={() => setHoverCol(cIdx)}
                onMouseLeave={() => setHoverCol(null)}
                onClick={() => handleColumnClick(cIdx)}
                title={isClickable ? t.games.dropDisc.replace('{col}', (cIdx + 1).toString()) : isColFull ? t.games.columnFull : undefined}
              >
                {Array.from({ length: ROWS }).map((_, rIdx) => {
                  const cell = board[rIdx][cIdx];
                  const isWinning = winningCells?.some(([wr, wc]) => wr === rIdx && wc === cIdx);
                  const isLastMove = lastMoveCell?.[0] === rIdx && lastMoveCell?.[1] === cIdx;

                  return (
                    <div key={rIdx} className="p4-hole">
                      {cell ? (
                        <div
                          className={`p4-disc disc-${cell === 'R' ? 'red' : 'yellow'} ${isWinning ? 'disc-winning' : ''} ${isLastMove ? 'disc-last' : ''}`}
                        />
                      ) : (
                        <div className="p4-empty-slot" />
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {/* Barre d'actions inférieure (Rejouer / Quitter) */}
      <div className="wlm-game-footer">
        {winner && (
          <button className="win-btn primary-btn" onClick={() => handleRestart(true)}>
            {t.games.replayRound}
          </button>
        )}
        <button className="win-btn" onClick={handleQuit}>
          {t.games.quitGameBtn}
        </button>
      </div>
    </div>
  );
};

export default Puissance4Game;
