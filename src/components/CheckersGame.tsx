import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Socket } from 'socket.io-client';
import SoundManager from '../utils/SoundManager';

export type Piece = 'w' | 'W' | 'b' | 'B' | null;

interface Position {
  row: number;
  col: number;
}

interface Move {
  from: Position;
  to: Position;
  isJump: boolean;
  captured?: Position;
}

interface CheckersGameProps {
  socket: Socket | null;
  opponentId: number;
  opponentName: string;
  opponentAvatar?: string;
  myId: number;
  myName: string;
  myAvatar?: string;
  myColor: 'white' | 'black';
  initialIsMyTurn: boolean;
  onClose: () => void;
  onMinimize?: () => void;
  onGameStateChange?: (state: { isMyTurn: boolean; myScore: number; opponentScore: number; winner: 'me' | 'opponent' | 'draw' | null }) => void;
}

export const createInitialCheckersBoard = (): Piece[][] => {
  const b: Piece[][] = Array(8).fill(null).map(() => Array(8).fill(null));
  // Noirs (b) en haut : rangées 0, 1, 2 sur cases sombres ((r + c) % 2 === 1)
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 8; c++) {
      if ((r + c) % 2 === 1) {
        b[r][c] = 'b';
      }
    }
  }
  // Blancs (w) en bas : rangées 5, 6, 7 sur cases sombres ((r + c) % 2 === 1)
  for (let r = 5; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if ((r + c) % 2 === 1) {
        b[r][c] = 'w';
      }
    }
  }
  return b;
};

export const CheckersGame: React.FC<CheckersGameProps> = ({
  socket,
  opponentId,
  opponentName,
  opponentAvatar = '/assets/usertiles/guest.png',
  myName,
  myAvatar = '/assets/usertiles/chess.png',
  myColor,
  initialIsMyTurn,
  onClose,
  onMinimize,
  onGameStateChange
}) => {
  const [board, setBoard] = useState<Piece[][]>(createInitialCheckersBoard);
  const [isMyTurn, setIsMyTurn] = useState<boolean>(initialIsMyTurn);
  const [selectedPos, setSelectedPos] = useState<Position | null>(null);
  const [myScore, setMyScore] = useState(0);
  const [opponentScore, setOpponentScore] = useState(0);
  const [winner, setWinner] = useState<'me' | 'opponent' | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [lastMove, setLastMove] = useState<{ from: Position; to: Position } | null>(null);

  const isWhite = myColor === 'white';
  const myPiecePrefix = isWhite ? 'w' : 'b';
  const opponentPiecePrefix = isWhite ? 'b' : 'w';

  // Calcul du nombre de pièces restantes par camp
  const pieceCounts = useMemo(() => {
    let white = 0;
    let black = 0;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = board[r][c];
        if (p === 'w' || p === 'W') white++;
        if (p === 'b' || p === 'B') black++;
      }
    }
    return {
      mine: isWhite ? white : black,
      opponent: isWhite ? black : white
    };
  }, [board, isWhite]);

  // Vérifier si une case est sur la grille 8x8
  const isValidCoord = (r: number, c: number): boolean => {
    return r >= 0 && r < 8 && c >= 0 && c < 8;
  };

  // Calculer tous les mouvements légaux d'une pièce donnée
  // Règle simplifiée V1 : Déplacement d'1 case en diagonale (avant pour pion, avant/arrière pour Dame),
  // Saut de 2 cases en diagonale par-dessus une pièce adverse. La prise n'est pas obligatoire.
  const getLegalMovesForPiece = useCallback((b: Piece[][], r: number, c: number): Move[] => {
    const piece = b[r][c];
    if (!piece) return [];

    const isPieceWhite = piece === 'w' || piece === 'W';
    const isKing = piece === 'W' || piece === 'B';

    // Déterminer les directions verticales possibles
    const rowDirs: number[] = [];
    if (isKing) {
      rowDirs.push(-1, 1);
    } else if (isPieceWhite) {
      rowDirs.push(-1); // Blancs avancent vers le haut (row décroissant)
    } else {
      rowDirs.push(1);  // Noirs avancent vers le bas (row croissant)
    }

    const colDirs = [-1, 1];
    const moves: Move[] = [];

    for (const rDir of rowDirs) {
      for (const cDir of colDirs) {
        // 1. Déplacement simple (1 case)
        const simpleR = r + rDir;
        const simpleC = c + cDir;
        if (isValidCoord(simpleR, simpleC) && b[simpleR][simpleC] === null) {
          moves.push({
            from: { row: r, col: c },
            to: { row: simpleR, col: simpleC },
            isJump: false
          });
        }

        // 2. Saut / Prise (2 cases)
        const jumpR = r + rDir * 2;
        const jumpC = c + cDir * 2;
        if (isValidCoord(jumpR, jumpC) && b[jumpR][jumpC] === null) {
          const midPiece = b[simpleR][simpleC];
          if (midPiece) {
            const isMidPieceEnemy = isPieceWhite
              ? (midPiece === 'b' || midPiece === 'B')
              : (midPiece === 'w' || midPiece === 'W');
            if (isMidPieceEnemy) {
              moves.push({
                from: { row: r, col: c },
                to: { row: jumpR, col: jumpC },
                isJump: true,
                captured: { row: simpleR, col: simpleC }
              });
            }
          }
        }
      }
    }

    return moves;
  }, []);

  // Liste des coups possibles pour la pièce actuellement sélectionnée
  const currentLegalMoves = useMemo(() => {
    if (!selectedPos || !isMyTurn || winner) return [];
    return getLegalMovesForPiece(board, selectedPos.row, selectedPos.col);
  }, [board, selectedPos, isMyTurn, winner, getLegalMovesForPiece]);

  // Clic sur une case du damier
  const handleCellClick = (r: number, c: number) => {
    if (!isMyTurn || winner) return;

    const clickedPiece = board[r][c];

    // Cas 1 : Clic sur une de mes pièces -> Sélection
    if (clickedPiece && clickedPiece.toLowerCase() === myPiecePrefix) {
      const moves = getLegalMovesForPiece(board, r, c);
      if (moves.length > 0) {
        setSelectedPos({ row: r, col: c });
      } else {
        // Pièce bloquée
        setSelectedPos({ row: r, col: c });
      }
      return;
    }

    // Cas 2 : Une pièce est sélectionnée et on clique sur une case de destination
    if (selectedPos) {
      const move = currentLegalMoves.find(m => m.to.row === r && m.to.col === c);
      if (move) {
        executeMove(move);
        setSelectedPos(null);
      } else {
        // Clic ailleurs : désélection
        setSelectedPos(null);
      }
    }
  };

  // Exécution d'un mouvement
  const executeMove = (move: Move) => {
    const newBoard = board.map(row => [...row]);
    const { from, to, isJump, captured } = move;
    let piece = newBoard[from.row][from.col];

    if (!piece) return;

    // Retirer la pièce de départ
    newBoard[from.row][from.col] = null;

    // Si saut, retirer la pièce capturée
    if (isJump && captured) {
      newBoard[captured.row][captured.col] = null;
    }

    // Promotion en Dame si arrivée sur la dernière rangée adverse
    const isPromotion = (isWhite && to.row === 0) || (!isWhite && to.row === 7);
    if (isPromotion) {
      piece = isWhite ? 'W' : 'B';
    }

    // Placer la pièce sur la destination
    newBoard[to.row][to.col] = piece;

    setBoard(newBoard);
    setIsMyTurn(false);
    setLastMove({ from, to });

    try {
      SoundManager.play('TYPE');
    } catch {}

    // Notifier le serveur et l'adversaire
    if (socket) {
      socket.emit('checkers_move', {
        target: opponentId,
        from,
        to,
        isJump,
        captured,
        isPromotion
      });
    }

    // Vérifier si l'adversaire n'a plus de pièces
    let enemyPieces = 0;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = newBoard[r][c];
        if (p && p.toLowerCase() === opponentPiecePrefix) {
          enemyPieces++;
        }
      }
    }

    if (enemyPieces === 0) {
      setWinner('me');
      setMyScore(prev => prev + 1);
    }
  };

  // Recommencer une nouvelle manche
  const handleRestart = useCallback((notifyOpponent: boolean = true) => {
    const newBoard = createInitialCheckersBoard();
    setBoard(newBoard);
    setWinner(null);
    setSelectedPos(null);
    setLastMove(null);

    // Les Blancs ont le premier tour
    setIsMyTurn(isWhite);

    if (notifyOpponent && socket) {
      socket.emit('game_restart', { target: opponentId, gameType: 'checkers' });
    }
  }, [isWhite, socket, opponentId]);

  // Quitter la partie
  const handleQuit = useCallback(() => {
    if (socket) {
      socket.emit('game_quit', { target: opponentId });
    }
    onClose();
  }, [socket, opponentId, onClose]);

  // Écoute des événements socket dédiés
  useEffect(() => {
    if (!socket) return;

    const onCheckersMove = (data: {
      from: Position;
      to: Position;
      isJump?: boolean;
      captured?: Position;
      isPromotion?: boolean;
    }) => {
      setBoard(prevBoard => {
        const nextBoard = prevBoard.map(row => [...row]);
        let piece = nextBoard[data.from.row][data.from.col];

        if (!piece) return prevBoard;

        nextBoard[data.from.row][data.from.col] = null;

        if (data.captured) {
          nextBoard[data.captured.row][data.captured.col] = null;
        }

        // Promotion Dame
        if (data.isPromotion) {
          piece = (piece.toLowerCase() === 'w') ? 'W' : 'B';
        }

        nextBoard[data.to.row][data.to.col] = piece;

        // Vérifier si mes pièces sont toutes capturées
        let myRemaining = 0;
        for (let r = 0; r < 8; r++) {
          for (let c = 0; c < 8; c++) {
            const p = nextBoard[r][c];
            if (p && p.toLowerCase() === myPiecePrefix) {
              myRemaining++;
            }
          }
        }

        if (myRemaining === 0) {
          setWinner('opponent');
          setOpponentScore(prev => prev + 1);
        } else {
          setIsMyTurn(true);
        }

        return nextBoard;
      });

      setLastMove({ from: data.from, to: data.to });

      try {
        SoundManager.play('TYPE');
      } catch {}
    };

    const onGameRestart = (data: { from: number; gameType?: string }) => {
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

    const onGameError = (data: { message: string }) => {
      setStatusMessage(data.message);
      setTimeout(() => setStatusMessage(''), 4000);
    };

    socket.on('checkers_move', onCheckersMove);
    socket.on('game_restart', onGameRestart);
    socket.on('game_quit', onGameQuit);
    socket.on('game_error', onGameError);

    return () => {
      socket.off('checkers_move', onCheckersMove);
      socket.off('game_restart', onGameRestart);
      socket.off('game_quit', onGameQuit);
      socket.off('game_error', onGameError);
    };
  }, [socket, opponentId, opponentName, myPiecePrefix, handleRestart, onClose]);

  // Notifier le composant parent de l'état pour la barre réduite
  useEffect(() => {
    onGameStateChange?.({ isMyTurn, myScore, opponentScore, winner });
  }, [isMyTurn, myScore, opponentScore, winner, onGameStateChange]);

  return (
    <div className="wlm-game-side-panel">
      {/* En-tête Aero du panneau de jeu */}
      <div className="wlm-game-header">
        <div className="wlm-game-title">
          <span className="wlm-game-icon">⚪</span>
          <span>Jeu de dames — vs {opponentName}</span>
        </div>
        <div className="wlm-game-header-controls">
          {onMinimize && (
            <button 
              className="win-title-control win-minimize-btn" 
              onClick={onMinimize} 
              title="Réduire le jeu (continuer la discussion)"
            >
              _
            </button>
          )}
          <button 
            className="win-title-control win-close-btn" 
            onClick={handleQuit} 
            title="Quitter la partie"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Barre de retour rapide au chat */}
      {onMinimize && (
        <div className="wlm-game-quick-return-bar" onClick={onMinimize} title="Réduire pour voir la conversation">
          <span>💬 Réduire le jeu pour discuter</span>
          <span className="quick-return-arrow">◀</span>
        </div>
      )}

      {/* Tableau des scores et avatars */}
      <div className="wlm-game-scoreboard">
        {/* Joueur 1 (Moi) */}
        <div className={`player-card ${isMyTurn && !winner ? 'active-turn' : ''}`}>
          <div className="player-avatar-wrap">
            <img src={myAvatar} alt={myName} className="player-avatar" />
            <span className={`checkers-color-dot ${isWhite ? 'dot-white' : 'dot-black'}`} title={isWhite ? 'Pions Blancs' : 'Pions Noirs'} />
          </div>
          <div className="player-details">
            <span className="player-name">{myName} (Moi)</span>
            <span className="player-score-badge">{pieceCounts.mine} pion{pieceCounts.mine > 1 ? 's' : ''}</span>
          </div>
        </div>

        {/* Score central des victoires */}
        <div className="game-vs-badge">
          <div className="vs-label">MANCHES</div>
          <div className="score-numbers">{myScore} - {opponentScore}</div>
        </div>

        {/* Joueur 2 (Adversaire) */}
        <div className={`player-card ${!isMyTurn && !winner ? 'active-turn' : ''}`}>
          <div className="player-avatar-wrap">
            <img src={opponentAvatar} alt={opponentName} className="player-avatar" />
            <span className={`checkers-color-dot ${!isWhite ? 'dot-white' : 'dot-black'}`} title={!isWhite ? 'Pions Blancs' : 'Pions Noirs'} />
          </div>
          <div className="player-details">
            <span className="player-name">{opponentName}</span>
            <span className="player-score-badge">{pieceCounts.opponent} pion{pieceCounts.opponent > 1 ? 's' : ''}</span>
          </div>
        </div>
      </div>

      {/* Bannière de statut de tour */}
      <div className={`game-turn-banner ${winner ? `banner-${winner}` : isMyTurn ? 'banner-my-turn' : 'banner-wait'}`}>
        {statusMessage ? (
          <span>{statusMessage}</span>
        ) : winner === 'me' ? (
          <span>🎉 Bravo ! Vous remportez cette manche !</span>
        ) : winner === 'opponent' ? (
          <span>{opponentName} a remporté cette manche !</span>
        ) : isMyTurn ? (
          <span>👉 C'est à votre tour ({isWhite ? 'Blancs' : 'Noirs'})</span>
        ) : (
          <span>⏳ En attente du coup de {opponentName}...</span>
        )}
      </div>

      {/* Grille 8x8 du Jeu de Dames */}
      <div className="checkers-board-wrapper">
        <div className="checkers-board">
          {board.map((row, rIdx) => (
            <div key={rIdx} className="checkers-row">
              {row.map((cell, cIdx) => {
                const isDarkSquare = (rIdx + cIdx) % 2 === 1;
                const isSelected = selectedPos?.row === rIdx && selectedPos?.col === cIdx;
                const isLegalDestination = currentLegalMoves.some(m => m.to.row === rIdx && m.to.col === cIdx);
                const isLastMoveSquare = (lastMove?.from.row === rIdx && lastMove?.from.col === cIdx) ||
                                         (lastMove?.to.row === rIdx && lastMove?.to.col === cIdx);

                const isPieceMine = cell && cell.toLowerCase() === myPiecePrefix;
                const isKing = cell === 'W' || cell === 'B';
                const isPieceWhite = cell === 'w' || cell === 'W';

                return (
                  <div
                    key={cIdx}
                    className={`checkers-cell ${isDarkSquare ? 'cell-dark' : 'cell-light'} ${isSelected ? 'cell-selected' : ''} ${isLegalDestination ? 'cell-target' : ''} ${isLastMoveSquare ? 'cell-last-move' : ''}`}
                    onClick={() => handleCellClick(rIdx, cIdx)}
                  >
                    {cell && (
                      <div
                        className={`checkers-piece ${isPieceWhite ? 'piece-white' : 'piece-black'} ${isKing ? 'piece-king' : ''} ${isPieceMine && isMyTurn && !winner ? 'piece-playable' : ''}`}
                      >
                        {isKing && <span className="king-crown" title="Dame">👑</span>}
                      </div>
                    )}
                    {isLegalDestination && (
                      <div className="move-indicator" />
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Mention de règle simplifiée assumée V1 */}
      <div className="checkers-rule-note">
        ℹ️ Règle simplifiée V1 : la prise n'est pas obligatoire.
      </div>

      {/* Actions de bas de panneau */}
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

export default CheckersGame;
