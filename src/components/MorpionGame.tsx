import React, { useState, useEffect, useCallback } from 'react';
import { Socket } from 'socket.io-client';
import SoundManager from '../utils/SoundManager';
import { useI18n } from '../i18n';
import { formatNickname } from '../utils/NicknameFormatter';

interface MorpionGameProps {
  socket: Socket | null;
  opponentId: number;
  opponentName: string;
  opponentAvatar?: string;
  myId: number;
  myName: string;
  myAvatar?: string;
  initialSymbol: 'X' | 'O';
  initialIsMyTurn: boolean;
  isBotOpponent?: boolean;
  onClose: () => void;
  onMinimize?: () => void;
  onGameStateChange?: (state: { isMyTurn: boolean; myScore: number; opponentScore: number; winner: 'me' | 'opponent' | 'draw' | null }) => void;
}

const WINNING_COMBOS = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8], // Lignes
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8], // Colonnes
  [0, 4, 8],
  [2, 4, 6]  // Diagonales
];

export const MorpionGame: React.FC<MorpionGameProps> = ({
  socket,
  opponentId,
  opponentName,
  opponentAvatar = '/assets/usertiles/guest.png',
  myId: _myId,
  myName,
  myAvatar = '/assets/usertiles/chess.png',
  initialSymbol,
  initialIsMyTurn,
  isBotOpponent = false,
  onClose,
  onMinimize,
  onGameStateChange
}) => {
  const { t } = useI18n();
  const [board, setBoard] = useState<(string | null)[]>(Array(9).fill(null));
  const [mySymbol] = useState<'X' | 'O'>(initialSymbol);
  const opponentSymbol = mySymbol === 'X' ? 'O' : 'X';
  const [isMyTurn, setIsMyTurn] = useState<boolean>(initialIsMyTurn);
  const [myScore, setMyScore] = useState(0);
  const [opponentScore, setOpponentScore] = useState(0);
  const [draws, setDraws] = useState(0);
  const [winner, setWinner] = useState<'me' | 'opponent' | 'draw' | null>(null);
  const [winningLine, setWinningLine] = useState<number[] | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>('');

  const checkWinner = (newBoard: (string | null)[]) => {
    for (const combo of WINNING_COMBOS) {
      const [a, b, c] = combo;
      if (newBoard[a] && newBoard[a] === newBoard[b] && newBoard[a] === newBoard[c]) {
        return { winnerSymbol: newBoard[a], combo };
      }
    }
    if (newBoard.every(cell => cell !== null)) {
      return { winnerSymbol: 'draw', combo: null };
    }
    return null;
  };

  // Gestion des clics sur la grille
  const handleCellClick = (index: number) => {
    if (!isMyTurn || board[index] !== null || winner !== null) {
      return;
    }

    const newBoard = [...board];
    newBoard[index] = mySymbol;
    setBoard(newBoard);
    setIsMyTurn(false);

    try {
      SoundManager.play('TYPE');
    } catch {}

    // Notifier l'adversaire
    if (socket && !isBotOpponent) {
      socket.emit('game_move', {
        target: opponentId,
        index,
        symbol: mySymbol
      });
    }

    // Vérifier s'il y a un gagnant
    const result = checkWinner(newBoard);
    if (result) {
      if (result.winnerSymbol === mySymbol) {
        setWinner('me');
        setWinningLine(result.combo);
        setMyScore(prev => prev + 1);
        try { SoundManager.play('ONLINE'); } catch {}
      } else if (result.winnerSymbol === 'draw') {
        setWinner('draw');
        setDraws(prev => prev + 1);
      }
    } else if (isBotOpponent) {
      // Le bot joue automatiquement après un court délai réaliste
      setTimeout(() => {
        setBoard(currentBoard => {
          const availableIndices: number[] = [];
          currentBoard.forEach((cell, idx) => {
            if (cell === null) availableIndices.push(idx);
          });
          if (availableIndices.length === 0) return currentBoard;

          let botMoveIndex = -1;

          // 1. Coup gagnant pour le bot ?
          for (const idx of availableIndices) {
            const testB = [...currentBoard];
            testB[idx] = opponentSymbol;
            const winTest = checkWinner(testB);
            if (winTest && winTest.winnerSymbol === opponentSymbol) {
              botMoveIndex = idx;
              break;
            }
          }

          // 2. Bloquer le joueur s'il gagne au tour suivant ?
          if (botMoveIndex === -1) {
            for (const idx of availableIndices) {
              const testB = [...currentBoard];
              testB[idx] = mySymbol;
              const winTest = checkWinner(testB);
              if (winTest && winTest.winnerSymbol === mySymbol) {
                botMoveIndex = idx;
                break;
              }
            }
          }

          // 3. Centre (case 4)
          if (botMoveIndex === -1 && availableIndices.includes(4)) {
            botMoveIndex = 4;
          }

          // 4. Case aléatoire parmi les choix restants
          if (botMoveIndex === -1) {
            botMoveIndex = availableIndices[Math.floor(Math.random() * availableIndices.length)];
          }

          const botBoard = [...currentBoard];
          botBoard[botMoveIndex] = opponentSymbol;

          try { SoundManager.play('TYPE'); } catch {}

          const botResult = checkWinner(botBoard);
          if (botResult) {
            if (botResult.winnerSymbol === opponentSymbol) {
              setWinner('opponent');
              setWinningLine(botResult.combo);
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
      }, 450);
    }
  };

  // Recommencer une nouvelle manche
  const handleRestart = useCallback((notifyOpponent: boolean = true) => {
    setBoard(Array(9).fill(null));
    setWinner(null);
    setWinningLine(null);
    // Celui qui a perdu commence, ou alternation
    setIsMyTurn(winner === 'opponent' || (winner === 'draw' && initialSymbol === 'X'));

    if (notifyOpponent && socket && !isBotOpponent) {
      socket.emit('game_restart', { target: opponentId });
    }
  }, [winner, initialSymbol, socket, opponentId, isBotOpponent]);

  const handleQuit = useCallback(() => {
    if (socket && !isBotOpponent) {
      socket.emit('game_quit', { target: opponentId });
    }
    onClose();
  }, [socket, opponentId, isBotOpponent, onClose]);

  // Écoute des événements socket du jeu
  useEffect(() => {
    if (!socket) return;

    const onGameMove = (data: { from: number; index: number; symbol: string }) => {
      // SÉCURITÉ 1 : Vérifier que le coup provient bien de l'adversaire de la partie
      if (data.from !== opponentId) return;

      // SÉCURITÉ 2 : Vérifier que l'index de la case est valide
      if (!Number.isInteger(data.index) || data.index < 0 || data.index > 8) return;

      setBoard(prevBoard => {
        // SÉCURITÉ 3 (ANTI-USURPATION) : Si la case est DÉJÀ occupée, REFUSER le coup !
        // Impossible pour l'adversaire d'écraser un choix déjà fait
        if (prevBoard[data.index] !== null) {
          console.warn("[Sécurité] Tentative d'écrasement d'une case déjà occupée rejetée :", data.index);
          return prevBoard;
        }

        const nextBoard = [...prevBoard];
        // SÉCURITÉ 4 : Utiliser impérativement le symbole légitime de l'adversaire (ignore tout symbole forgé)
        nextBoard[data.index] = opponentSymbol;

        const result = checkWinner(nextBoard);
        if (result) {
          if (result.winnerSymbol === opponentSymbol) {
            setWinner('opponent');
            setWinningLine(result.combo);
            setOpponentScore(prev => prev + 1);
            try { SoundManager.play('NUDGE'); } catch {}
          } else if (result.winnerSymbol === 'draw') {
            setWinner('draw');
            setDraws(prev => prev + 1);
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
      alert(t.games.opponentQuit.replace('{name}', opponentName));
      onClose();
    };

    const onGameError = (data: { message: string }) => {
      setStatusMessage(data.message);
      setTimeout(() => setStatusMessage(''), 4000);
    };

    // RESYNC : après une reconnexion (veille mobile), récupérer l'état autoritaire du plateau
    const requestResync = () => {
      if (socket.connected) socket.emit('game_resync', { target: opponentId });
    };
    const onResync = (data: { active?: boolean; gameType?: string; board?: (string | null)[]; isMyTurn?: boolean }) => {
      if (!data || !data.active || data.gameType !== 'morpion' || !Array.isArray(data.board)) return;
      setBoard(data.board);
      setIsMyTurn(Boolean(data.isMyTurn));
      const result = checkWinner(data.board);
      if (result && result.winnerSymbol === mySymbol) { setWinner('me'); setWinningLine(result.combo); }
      else if (result && result.winnerSymbol === opponentSymbol) { setWinner('opponent'); setWinningLine(result.combo); }
      else if (result && result.winnerSymbol === 'draw') { setWinner('draw'); setWinningLine(null); }
      else { setWinner(null); setWinningLine(null); }
    };

    socket.on('game_move', onGameMove);
    socket.on('game_restart', onGameRestart);
    socket.on('game_quit', onGameQuit);
    socket.on('game_error', onGameError);
    socket.on('connect', requestResync);
    socket.on('game_resync_state', onResync);
    requestResync();

    return () => {
      socket.off('game_move', onGameMove);
      socket.off('game_restart', onGameRestart);
      socket.off('game_quit', onGameQuit);
      socket.off('game_error', onGameError);
      socket.off('connect', requestResync);
      socket.off('game_resync_state', onResync);
    };
  }, [socket, opponentId, opponentName, opponentSymbol, handleRestart, onClose, t]);

  // Synchronisation de l'état du jeu avec le parent pour affichage en mode réduit
  useEffect(() => {
    onGameStateChange?.({ isMyTurn, myScore, opponentScore, winner });
  }, [isMyTurn, myScore, opponentScore, winner, onGameStateChange]);

  return (
    <div className="wlm-game-side-panel">
      {/* En-tête de panneau Aero */}
      <div className="wlm-game-header">
        <div className="wlm-game-title">
          <span className="wlm-game-icon">🎮</span>
          <span>{formatNickname(t.games.morpionTitle.replace('{name}', opponentName))}</span>
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

      {/* Barre de retour rapide à la discussion (pratique sur petits écrans et pour réduire) */}
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
            <span className={`player-symbol-badge symbol-${mySymbol}`}>{mySymbol}</span>
          </div>
          <div className="player-details">
            <span className="player-name">{formatNickname(myName)} {t.games.meLabel}</span>
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
            <span className={`player-symbol-badge symbol-${opponentSymbol}`}>{opponentSymbol}</span>
          </div>
          <div className="player-details">
            <span className="player-name">{formatNickname(opponentName)}</span>
            <span className="player-score-badge">{opponentScore} {opponentScore > 1 ? t.games.winPlural : t.games.winSingle}</span>
          </div>
        </div>
      </div>

      {/* Bannière de statut de jeu */}
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
          <span>{t.games.bannerYourTurnSymbol.replace('{symbol}', mySymbol)}</span>
        ) : (
          <span>{formatNickname(t.games.bannerWaitOpponent.replace('{name}', opponentName))}</span>
        )}
      </div>

      {/* Grille 3x3 de Morpion */}
      <div className="wlm-morpion-board">
        {board.map((cell, idx) => {
          const isWinningCell = winningLine?.includes(idx);
          return (
            <button
              key={idx}
              className={`morpion-cell ${cell ? `cell-${cell}` : ''} ${isWinningCell ? 'cell-winning' : ''} ${!cell && isMyTurn && !winner ? 'cell-clickable' : ''}`}
              onClick={() => handleCellClick(idx)}
              disabled={!isMyTurn || cell !== null || winner !== null}
              title={!cell && isMyTurn ? t.games.placeSymbol.replace('{symbol}', mySymbol) : undefined}
            >
              {cell === 'X' && (
                <span className="symbol-x">✕</span>
              )}
              {cell === 'O' && (
                <span className="symbol-o">◯</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Barre d'action inférieure */}
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

export default MorpionGame;
