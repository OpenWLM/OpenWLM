import React, { useState, useEffect, useCallback } from 'react';
import { Socket } from 'socket.io-client';
import SoundManager from '../utils/SoundManager';

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
  onClose: () => void;
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
  onClose
}) => {
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
    if (socket) {
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
    }
  };

  // Recommencer une nouvelle manche
  const handleRestart = useCallback((notifyOpponent: boolean = true) => {
    setBoard(Array(9).fill(null));
    setWinner(null);
    setWinningLine(null);
    // Celui qui a perdu commence, ou alternation
    setIsMyTurn(winner === 'opponent' || (winner === 'draw' && initialSymbol === 'X'));

    if (notifyOpponent && socket) {
      socket.emit('game_restart', { target: opponentId });
    }
  }, [winner, initialSymbol, socket, opponentId]);

  const handleQuit = useCallback(() => {
    if (socket) {
      socket.emit('game_quit', { target: opponentId });
    }
    onClose();
  }, [socket, opponentId, onClose]);

  // Écoute des événements socket du jeu
  useEffect(() => {
    if (!socket) return;

    const onGameMove = (data: { from: number; index: number; symbol: string }) => {
      if (data.from !== opponentId) return;

      setBoard(prevBoard => {
        const nextBoard = [...prevBoard];
        nextBoard[data.index] = data.symbol;

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
      setStatusMessage(`${opponentName} a relancé une nouvelle manche !`);
      setTimeout(() => setStatusMessage(''), 4000);
    };

    const onGameQuit = (data: { from: number }) => {
      if (data.from !== opponentId) return;
      alert(`${opponentName} a quitté la partie.`);
      onClose();
    };

    socket.on('game_move', onGameMove);
    socket.on('game_restart', onGameRestart);
    socket.on('game_quit', onGameQuit);

    return () => {
      socket.off('game_move', onGameMove);
      socket.off('game_restart', onGameRestart);
      socket.off('game_quit', onGameQuit);
    };
  }, [socket, opponentId, opponentName, opponentSymbol, handleRestart, onClose]);

  return (
    <div className="wlm-game-side-panel">
      {/* En-tête de panneau Aero */}
      <div className="wlm-game-header">
        <div className="wlm-game-title">
          <span className="wlm-game-icon">🎮</span>
          <span>Morpion — Partie contre {opponentName}</span>
        </div>
        <button className="win-close-btn" onClick={handleQuit} title="Quitter le jeu">✕</button>
      </div>

      {/* Tableau des scores et avatars */}
      <div className="wlm-game-scoreboard">
        {/* Joueur 1 (Moi) */}
        <div className={`player-card ${isMyTurn && !winner ? 'active-turn' : ''}`}>
          <div className="player-avatar-wrap">
            <img src={myAvatar} alt={myName} className="player-avatar" />
            <span className={`player-symbol-badge symbol-${mySymbol}`}>{mySymbol}</span>
          </div>
          <div className="player-details">
            <span className="player-name">{myName} (Moi)</span>
            <span className="player-score-badge">{myScore} {myScore > 1 ? 'victoires' : 'victoire'}</span>
          </div>
        </div>

        {/* Versus et Score central */}
        <div className="game-vs-badge">
          <div className="vs-label">VS</div>
          <div className="score-numbers">{myScore} - {opponentScore}</div>
          {draws > 0 && <div className="draws-count">{draws} nul{draws > 1 ? 's' : ''}</div>}
        </div>

        {/* Joueur 2 (Adversaire) */}
        <div className={`player-card ${!isMyTurn && !winner ? 'active-turn' : ''}`}>
          <div className="player-avatar-wrap">
            <img src={opponentAvatar} alt={opponentName} className="player-avatar" />
            <span className={`player-symbol-badge symbol-${opponentSymbol}`}>{opponentSymbol}</span>
          </div>
          <div className="player-details">
            <span className="player-name">{opponentName}</span>
            <span className="player-score-badge">{opponentScore} {opponentScore > 1 ? 'victoires' : 'victoire'}</span>
          </div>
        </div>
      </div>

      {/* Bannière de statut de jeu */}
      <div className={`game-turn-banner ${winner ? `banner-${winner}` : isMyTurn ? 'banner-my-turn' : 'banner-wait'}`}>
        {statusMessage ? (
          <span>{statusMessage}</span>
        ) : winner === 'me' ? (
          <span>🎉 Bravo ! Vous remportez cette manche !</span>
        ) : winner === 'opponent' ? (
          <span>{opponentName} a remporté cette manche !</span>
        ) : winner === 'draw' ? (
          <span>🤝 Match nul ! Personne ne marque de point.</span>
        ) : isMyTurn ? (
          <span>👉 C'est à votre tour de jouer ({mySymbol})</span>
        ) : (
          <span>⏳ En attente du coup de {opponentName}...</span>
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
              title={!cell && isMyTurn ? `Placer ${mySymbol}` : undefined}
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
            🔄 Rejouer une manche
          </button>
        )}
        <button className="win-btn" onClick={handleQuit}>
          Quitter le jeu
        </button>
      </div>

    </div>
  );
};

export default MorpionGame;
