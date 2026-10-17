import React, { useState, useEffect, useCallback } from 'react';
import { Socket } from 'socket.io-client';
import GameSfx from '../utils/GameSfx';
import { useI18n } from '../i18n';
import { formatNickname } from '../utils/NicknameFormatter';
import GameDialog from './GameDialog';

/**
 * DÉMINEUR À DEUX (« Minesweeper Flags » de MSN) — il faut TROUVER les mines.
 * 16 × 16, 51 mines, premier à 26. Une mine trouvée = 1 point et on rejoue ; une bombe 5 × 5
 * par partie, utilisable avec au moins 3 points de retard.
 *
 * Le client ne connaît JAMAIS l'emplacement des mines : il n'affiche que l'état public envoyé
 * par le serveur (cases révélées), et n'envoie que l'index cliqué.
 */

const SIZE = 16;
const WIN_SCORE = 26;
const BOMB_RADIUS = 2;
const BOMB_MIN_DEFICIT = 3;

interface MinesweeperState {
  players: { blue: number; red: number };
  revealed: (number | 'B' | 'R' | null)[]; // null = cachée ; 0–8 = case sûre ; 'B'/'R' = mine trouvée par Bleu/Rouge
  found: Record<string, number>;
  wins: Record<string, number>;
  bombUsed: Record<string, boolean>;
  turn: number;
  winner: number | null;
  remaining: number;
  lastMove: { by: number; index: number; bomb: boolean } | null;
  mines?: number[];
}

interface MinesweeperGameProps {
  socket: Socket | null;
  opponentId: number;
  opponentName: string;
  opponentAvatar?: string;
  myId: number;
  myName: string;
  myAvatar?: string;
  myColor?: 'blue' | 'red';
  initialIsMyTurn: boolean;
  onClose: () => void;
  onMinimize?: () => void;
  onGameStateChange?: (state: { isMyTurn: boolean; myScore: number; opponentScore: number; winner: 'me' | 'opponent' | 'draw' | null }) => void;
}

// Couleurs classiques des chiffres du Démineur
const NUMBER_CLASS = ['', 'ms-n1', 'ms-n2', 'ms-n3', 'ms-n4', 'ms-n5', 'ms-n6', 'ms-n7', 'ms-n8'];

export const MinesweeperGame: React.FC<MinesweeperGameProps> = ({
  socket,
  opponentId,
  opponentName,
  opponentAvatar = '/assets/usertiles/guest.png',
  myId,
  myName,
  myAvatar = '/assets/usertiles/chess.png',
  myColor = 'blue',
  initialIsMyTurn,
  onClose,
  onMinimize,
  onGameStateChange
}) => {
  const { t } = useI18n();
  const [state, setState] = useState<MinesweeperState | null>(null);
  const [bombArmed, setBombArmed] = useState(false);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [dialog, setDialog] = useState<{ message: string; onOk?: () => void } | null>(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [pending, setPending] = useState(false);

  const opponentColor: 'blue' | 'red' = myColor === 'blue' ? 'red' : 'blue';
  const isMyTurn = state ? state.turn === myId && state.winner === null : initialIsMyTurn;
  const myFound = state?.found[myId] ?? 0;
  const oppFound = state?.found[opponentId] ?? 0;
  const myWins = state?.wins[myId] ?? 0;
  const oppWins = state?.wins[opponentId] ?? 0;
  const winner: 'me' | 'opponent' | null = !state || state.winner === null ? null : state.winner === myId ? 'me' : 'opponent';
  const bombAvailable = !!state && isMyTurn && !state.bombUsed[myId] && oppFound - myFound >= BOMB_MIN_DEFICIT;

  const applyState = useCallback((next: MinesweeperState) => {
    // On n'accepte que l'état de NOTRE partie avec cet adversaire
    const ids = [next?.players?.blue, next?.players?.red];
    if (!ids.includes(myId) || !ids.includes(opponentId) || !Array.isArray(next.revealed)) return;
    setState(next);
    setPending(false);
  }, [myId, opponentId]);

  const handleCellClick = (index: number) => {
    if (!socket || !state || !isMyTurn || pending) return;
    if (!bombArmed && state.revealed[index] !== null) return;
    setPending(true);
    socket.emit('minesweeper_move', { target: opponentId, index, bomb: bombArmed });
    setBombArmed(false);
  };

  const handleRestart = () => {
    if (socket) socket.emit('game_restart', { target: opponentId, gameType: 'minesweeper' });
  };

  const handleQuit = useCallback(() => {
    if (socket) socket.emit('game_quit', { target: opponentId });
    onClose();
  }, [socket, opponentId, onClose]);

  useEffect(() => {
    if (!socket) return;

    const onUpdate = (data: { from: number; revealed: { i: number; n?: number; f?: 'B' | 'R' }[]; bomb?: boolean; restart?: boolean; state: MinesweeperState }) => {
      if (!data?.state) return;
      applyState(data.state);
      if (data.restart) {
        setStatusMessage(data.from === myId ? '' : t.games.opponentRestarted.replace('{name}', opponentName));
        if (data.from !== myId) setTimeout(() => setStatusMessage(''), 4000);
        return;
      }
      // Bruitages de jeu synthétisés (distincts des sons de messagerie)
      const foundMine = data.revealed?.some((x) => x.f !== undefined);
      const mine = data.from === myId;
      if (data.bomb) GameSfx.bomb();
      if (data.state.winner !== null) {
        setTimeout(() => (data.state.winner === myId ? GameSfx.win() : GameSfx.lose()), data.bomb ? 450 : 120);
      } else if (foundMine) {
        setTimeout(() => (mine ? GameSfx.mineFound() : GameSfx.opponentMine()), data.bomb ? 350 : 0);
      } else if (!data.bomb) {
        if ((data.revealed?.length ?? 0) > 1) GameSfx.cascade(); else GameSfx.reveal();
      }
    };

    const onGameQuit = (data: { from: number }) => {
      if (data.from !== opponentId) return;
      setDialog({ message: t.games.opponentQuit.replace('{name}', opponentName), onOk: onClose });
    };

    const onGameError = (data: { message: string }) => {
      setPending(false);
      if (data.message) setDialog({ message: data.message });
    };

    // État initial et resynchronisation après une reconnexion : uniquement l'état public
    const requestResync = () => {
      if (socket.connected) socket.emit('game_resync', { target: opponentId });
    };
    const onResync = (data: { active?: boolean; gameType?: string; state?: MinesweeperState }) => {
      if (!data?.active || data.gameType !== 'minesweeper' || !data.state) return;
      applyState(data.state);
    };

    socket.on('minesweeper_update', onUpdate);
    socket.on('game_quit', onGameQuit);
    socket.on('game_error', onGameError);
    socket.on('connect', requestResync);
    socket.on('game_resync_state', onResync);
    requestResync();

    return () => {
      socket.off('minesweeper_update', onUpdate);
      socket.off('game_quit', onGameQuit);
      socket.off('game_error', onGameError);
      socket.off('connect', requestResync);
      socket.off('game_resync_state', onResync);
    };
  }, [socket, myId, opponentId, opponentName, applyState, onClose, t]);

  // Résumé pour la barre réduite : mines trouvées dans la manche en cours
  useEffect(() => {
    onGameStateChange?.({ isMyTurn, myScore: myFound, opponentScore: oppFound, winner });
  }, [isMyTurn, myFound, oppFound, winner, onGameStateChange]);

  const inBombArea = (index: number) => {
    if (!bombArmed || hoverIndex === null) return false;
    const r = Math.floor(index / SIZE), c = index % SIZE;
    const hr = Math.floor(hoverIndex / SIZE), hc = hoverIndex % SIZE;
    return Math.abs(r - hr) <= BOMB_RADIUS && Math.abs(c - hc) <= BOMB_RADIUS;
  };

  const myColorLabel = myColor === 'blue' ? t.games.blueLabel : t.games.redLabel;
  const unfoundMines = new Set(state?.mines ?? []);

  return (
    <div className="wlm-game-side-panel">
      {dialog && (
        <GameDialog
          title={t.games.noticeTitle}
          message={dialog.message}
          onClose={() => { const cb = dialog.onOk; setDialog(null); cb?.(); }}
        />
      )}
      <div className="wlm-game-header">
        <div className="wlm-game-title">
          <span className="wlm-game-icon">💣</span>
          <span>{formatNickname(t.games.minesweeperTitle.replace('{name}', opponentName))}</span>
        </div>
        <div className="wlm-game-header-controls">
          {onMinimize && (
            <button className="win-title-control win-minimize-btn" onClick={onMinimize} title={t.games.minimizeTitle}>_</button>
          )}
          <button className="win-title-control win-close-btn" onClick={handleQuit} title={t.games.quitGameTitle}>✕</button>
        </div>
      </div>

      {onMinimize && (
        <div className="wlm-game-quick-return-bar" onClick={onMinimize} title={t.games.minimizeTitle}>
          <span>{t.games.minimizeToChat}</span>
          <span className="quick-return-arrow">◀</span>
        </div>
      )}

      {/* Scores : drapeaux trouvés dans la manche + manches gagnées */}
      <div className="wlm-game-scoreboard">
        <div className={`player-card ${isMyTurn && !winner ? 'active-turn' : ''}`}>
          <div className="player-avatar-wrap">
            <img src={myAvatar} alt={myName} className="player-avatar" />
          </div>
          <div className="player-details">
            <div className="p4-player-name-row" title={`${myName} ${t.games.meLabel} (${myColorLabel})`}>
              <span className={`ms-flag ms-flag-${myColor}`}>⚑</span>
              <span className="player-name">{formatNickname(myName)} {t.games.meLabel}</span>
            </div>
            <span className="player-score-badge ms-found-badge">{t.games.minesFound.replace('{n}', String(myFound)).replace('{target}', String(WIN_SCORE))}</span>
          </div>
        </div>

        <div className="game-vs-badge">
          <div className="vs-label">{t.games.minesLeftLabel}</div>
          <div className="score-numbers ms-remaining" data-testid="ms-remaining">{state?.remaining ?? 51}</div>
          <div className="draws-count">{t.games.roundsScore.replace('{me}', String(myWins)).replace('{opp}', String(oppWins))}</div>
        </div>

        <div className={`player-card ${!isMyTurn && !winner ? 'active-turn' : ''}`}>
          <div className="player-avatar-wrap">
            <img src={opponentAvatar} alt={opponentName} className="player-avatar" />
          </div>
          <div className="player-details">
            <div className="p4-player-name-row" title={opponentName}>
              <span className={`ms-flag ms-flag-${opponentColor}`}>⚑</span>
              <span className="player-name">{formatNickname(opponentName)}</span>
            </div>
            <span className="player-score-badge ms-found-badge">{t.games.minesFound.replace('{n}', String(oppFound)).replace('{target}', String(WIN_SCORE))}</span>
          </div>
        </div>
      </div>

      <div className={`game-turn-banner ${winner ? `banner-${winner}` : isMyTurn ? 'banner-my-turn' : 'banner-wait'}`}>
        {statusMessage ? (
          <span>{formatNickname(statusMessage)}</span>
        ) : winner === 'me' ? (
          <span>{t.games.bannerWin}</span>
        ) : winner === 'opponent' ? (
          <span>{formatNickname(t.games.bannerLoss.replace('{name}', opponentName))}</span>
        ) : bombArmed ? (
          <span>{t.games.bombArmed}</span>
        ) : isMyTurn && state?.lastMove?.by === myId && typeof state.revealed[state.lastMove.index] === 'string' ? (
          <span>{t.games.bannerMineFound}</span>
        ) : isMyTurn ? (
          <span>{t.games.bannerYourTurnColor.replace('{color}', myColorLabel)}</span>
        ) : (
          <span>{formatNickname(t.games.bannerWaitOpponent.replace('{name}', opponentName))}</span>
        )}
      </div>

      {/* Bombe : une par partie, avec au moins 3 points de retard */}
      <div className="ms-toolbar">
        <button
          type="button"
          className={`win-btn ms-bomb-btn ${bombArmed ? 'armed' : ''}`}
          disabled={!bombAvailable && !bombArmed}
          onClick={() => setBombArmed((v) => !v)}
          title={state?.bombUsed[myId] ? t.games.bombUsed : t.games.bombHint}
        >
          💣 {state?.bombUsed[myId] ? t.games.bombUsed : bombArmed ? t.games.bombCancel : t.games.bombBtn}
        </button>
        <span className="ms-rule-note">{t.games.minesweeperRule}</span>
      </div>

      <div className="ms-board-wrapper">
        <div
          className={`ms-grid ${isMyTurn && !winner ? 'ms-grid-active' : ''} ${bombArmed ? 'ms-grid-bomb' : ''}`}
          onMouseLeave={() => setHoverIndex(null)}
          role="grid"
          aria-label={t.games.minesweeper}
        >
          {Array.from({ length: SIZE * SIZE }).map((_, i) => {
            const v = state?.revealed[i] ?? null;
            const isLast = state?.lastMove?.index === i;
            let cls = 'ms-cell';
            let content: React.ReactNode = null;
            if (v === null) {
              cls += ' ms-hidden';
              if (unfoundMines.has(i)) { cls += ' ms-mine-end'; content = '✹'; }
            } else if (typeof v === 'number') {
              cls += ' ms-open';
              if (v > 0) { cls += ` ${NUMBER_CLASS[v] ?? ''}`; content = v; }
            } else {
              cls += ` ms-open ms-flagged ms-flagged-${v === 'B' ? 'blue' : 'red'}`;
              content = '⚑';
            }
            if (isLast) cls += ' ms-last';
            if (inBombArea(i)) cls += ' ms-bomb-area';
            return (
              <div
                key={i}
                className={cls}
                role="gridcell"
                data-index={i}
                onClick={() => handleCellClick(i)}
                onMouseEnter={() => setHoverIndex(i)}
              >
                {content}
              </div>
            );
          })}
        </div>
      </div>

      <div className="wlm-game-footer">
        {winner && (
          <button className="win-btn primary-btn" onClick={handleRestart}>{t.games.replayRound}</button>
        )}
        <button className="win-btn" onClick={handleQuit}>{t.games.quitGameBtn}</button>
      </div>
    </div>
  );
};

export default MinesweeperGame;
