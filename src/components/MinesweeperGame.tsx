import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Socket } from 'socket.io-client';
import GameSfx from '../utils/GameSfx';
import { useI18n } from '../i18n';
import { formatNickname } from '../utils/NicknameFormatter';
import GameDialog from './GameDialog';

/**
 * DÉMINEUR À DEUX (« Minesweeper Flags » de MSN) — il faut TROUVER les mines.
 * 16 × 16, 51 mines, premier à 26. Une mine trouvée = 1 point et on rejoue ; une bombe 5 × 5
 * par manche, utilisable avec au moins 3 points de retard.
 *
 * Le client ne connaît JAMAIS l'emplacement des mines : il n'affiche que l'état public envoyé
 * par le serveur (cases révélées), et n'envoie que l'index cliqué.
 */

// Valeurs par défaut, remplacées par les règles envoyées par le serveur (`state.config`)
const DEFAULT_CONFIG = { size: 16, mines: 51, winScore: 26, bombRadius: 2, bombMinDeficit: 3 };
const PENDING_TIMEOUT_MS = 5000;

interface MinesweeperState {
  config?: typeof DEFAULT_CONFIG;
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
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cfg = state?.config ?? DEFAULT_CONFIG;
  const SIZE = cfg.size;

  const isMyTurn = state ? state.turn === myId && state.winner === null : initialIsMyTurn;
  const myFound = state?.found[myId] ?? 0;
  const oppFound = state?.found[opponentId] ?? 0;
  const winner: 'me' | 'opponent' | null = !state || state.winner === null ? null : state.winner === myId ? 'me' : 'opponent';
  const bombAvailable = !!state && isMyTurn && !state.bombUsed[myId] && oppFound - myFound >= cfg.bombMinDeficit;

  // Verrou anti double-clic : toujours relâché (réponse, erreur, reconnexion ou délai dépassé)
  const releasePending = useCallback(() => {
    if (pendingTimerRef.current) { clearTimeout(pendingTimerRef.current); pendingTimerRef.current = null; }
    setPending(false);
  }, []);

  const applyState = useCallback((next: MinesweeperState) => {
    // On n'accepte que l'état de NOTRE partie avec cet adversaire
    const ids = [next?.players?.blue, next?.players?.red];
    if (!ids.includes(myId) || !ids.includes(opponentId) || !Array.isArray(next.revealed)) return;
    setState(next);
    releasePending();
    // La bombe armée ne survit pas à un changement de main ni à une nouvelle manche
    if (next.turn !== myId || next.winner !== null) setBombArmed(false);
  }, [myId, opponentId, releasePending]);

  const handleCellClick = (index: number) => {
    if (!socket || !state || !isMyTurn || pending) return;
    if (!bombArmed && state.revealed[index] !== null) return;
    setPending(true);
    if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current);
    pendingTimerRef.current = setTimeout(() => {
      pendingTimerRef.current = null;
      setPending(false);
      if (socket.connected) socket.emit('game_resync', { target: opponentId });
    }, PENDING_TIMEOUT_MS);
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
        setBombArmed(false);
        setStatusMessage(data.from === myId ? '' : t.games.opponentRestarted.replace('{name}', opponentName));
        if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
        if (data.from !== myId) statusTimerRef.current = setTimeout(() => setStatusMessage(''), 4000);
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

    // Erreur de jeu : on relâche le plateau, on désarme la bombe et on se recale sur le serveur
    const onGameError = (data: { message: string }) => {
      releasePending();
      setBombArmed(false);
      if (data.message) setDialog({ message: data.message });
      if (socket.connected) socket.emit('game_resync', { target: opponentId });
    };

    // État initial et resynchronisation après une reconnexion : uniquement l'état public
    const requestResync = () => {
      releasePending();
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
  }, [socket, myId, opponentId, opponentName, applyState, releasePending, onClose, t]);

  // Minuteries nettoyées au démontage
  useEffect(() => () => {
    if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current);
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
  }, []);

  // Résumé pour la barre réduite : mines trouvées dans la manche en cours
  useEffect(() => {
    onGameStateChange?.({ isMyTurn, myScore: myFound, opponentScore: oppFound, winner });
  }, [isMyTurn, myFound, oppFound, winner, onGameStateChange]);

  const inBombArea = (index: number) => {
    if (!bombArmed || hoverIndex === null) return false;
    const r = Math.floor(index / SIZE), c = index % SIZE;
    const hr = Math.floor(hoverIndex / SIZE), hc = hoverIndex % SIZE;
    return Math.abs(r - hr) <= cfg.bombRadius && Math.abs(c - hc) <= cfg.bombRadius;
  };

  const unfoundMines = new Set(state?.mines ?? []);
  // Bleu toujours à gauche, Rouge à droite, comme dans l'original
  const blueId = state?.players.blue ?? (myColor === 'blue' ? myId : opponentId);
  const redId = state?.players.red ?? (myColor === 'red' ? myId : opponentId);
  const lastMoveColor = state?.lastMove ? (state.lastMove.by === blueId ? 'blue' : 'red') : null;

  const renderPlayer = (color: 'blue' | 'red') => {
    const playerId = color === 'blue' ? blueId : redId;
    const isMe = playerId === myId;
    const name = isMe ? myName : opponentName;
    const avatar = isMe ? myAvatar : opponentAvatar;
    const found = state?.found[playerId] ?? 0;
    const wins = state?.wins[playerId] ?? 0;
    const active = !!state && state.winner === null && state.turn === playerId;
    const bombUsed = !!state?.bombUsed[playerId];
    return (
      <div className={`msf-player msf-${color} ${active ? 'msf-active' : ''}`} data-testid={`msf-player-${color}`}>
        <div className="msf-player-color">{color === 'blue' ? t.games.blueTeam : t.games.redTeam}</div>
        <div className="msf-player-id">
          <img src={avatar} alt="" className="msf-avatar" />
          <span className="msf-name" title={name}>{formatNickname(name)}{isMe ? ` ${t.games.meLabel}` : ''}</span>
        </div>
        <div className="msf-turn" aria-live="polite">
          {active ? (isMe ? t.games.msYourTurn : t.games.msTheirTurn) : wins > 0 ? t.games.msRoundsWon.replace('{n}', String(wins)) : ' '}
        </div>
        <div className="msf-player-foot">
          <span className="msf-flag-count" title={t.games.minesFound.replace('{n}', String(found)).replace('{target}', String(cfg.winScore))}>
            <FlagIcon color={color} />
            <span className="msf-flag-num">{found}</span>
          </span>
          {isMe ? (
            <button
              type="button"
              className={`msf-bomb ${bombArmed ? 'armed' : ''} ${bombUsed ? 'used' : ''}`}
              disabled={!bombAvailable && !bombArmed}
              onClick={() => setBombArmed((v) => !v)}
              title={bombUsed ? t.games.bombUsed : bombArmed ? t.games.bombCancel : t.games.bombHint}
              aria-label={bombUsed ? t.games.bombUsed : bombArmed ? t.games.bombCancel : t.games.bombBtn}
            >
              <BombIcon crossed={bombUsed || (!bombAvailable && !bombArmed)} />
            </button>
          ) : (
            <span className={`msf-bomb msf-bomb-static ${bombUsed ? 'used' : ''}`} title={bombUsed ? t.games.bombUsed : t.games.bombHint}>
              <BombIcon crossed={bombUsed} />
            </span>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="wlm-game-side-panel msf-panel">
      {dialog && (
        <GameDialog
          title={t.games.noticeTitle}
          message={dialog.message}
          onClose={() => { const cb = dialog.onOk; setDialog(null); cb?.(); }}
        />
      )}
      <div className="wlm-game-header">
        <div className="wlm-game-title">
          <span className="wlm-game-icon">🚩</span>
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

      {/* Panneaux Bleu / Rouge et compteur central de mines, comme dans Minesweeper Flags */}
      <div className="msf-players">
        {renderPlayer('blue')}
        <div className="msf-counter" title={t.games.minesLeftLabel}>
          <span className="msf-star" aria-hidden="true">★</span>
          <span className="msf-remaining" data-testid="ms-remaining">{state?.remaining ?? cfg.mines}</span>
          <span className="msf-star" aria-hidden="true">★</span>
        </div>
        {renderPlayer('red')}
      </div>

      {/* Bandeau : uniquement les événements (fin de manche, bombe armée, mine trouvée…) */}
      {(winner || statusMessage || bombArmed || (isMyTurn && state?.lastMove?.by === myId && typeof state.revealed[state.lastMove.index] === 'string')) && (
        <div className={`game-turn-banner msf-banner ${winner ? `banner-${winner}` : 'banner-my-turn'}`}>
          {statusMessage ? (
            <span>{formatNickname(statusMessage)}</span>
          ) : winner === 'me' ? (
            <span>{t.games.bannerWin}</span>
          ) : winner === 'opponent' ? (
            <span>{formatNickname(t.games.bannerLoss.replace('{name}', opponentName))}</span>
          ) : bombArmed ? (
            <span>{t.games.bombArmed}</span>
          ) : (
            <span>{t.games.bannerMineFound}</span>
          )}
        </div>
      )}

      <div className="msf-board-frame" title={t.games.minesweeperRule}>
        <div
          className={`ms-grid msf-grid ${isMyTurn && !winner ? 'ms-grid-active' : ''} ${bombArmed ? 'ms-grid-bomb' : ''}`}
          style={{ gridTemplateColumns: `repeat(${SIZE}, 1fr)` }}
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
              if (unfoundMines.has(i)) { cls += ' ms-mine-end'; content = <MineIcon />; }
            } else if (typeof v === 'number') {
              cls += ' ms-open';
              if (v > 0) { cls += ` ${NUMBER_CLASS[v] ?? ''}`; content = v; }
            } else {
              const fc = v === 'B' ? 'blue' : 'red';
              cls += ` ms-open ms-flagged ms-flagged-${fc}`;
              content = <FlagIcon color={fc} />;
            }
            if (isLast && lastMoveColor) cls += ` ms-last ms-last-${lastMoveColor}`;
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

      <div className="wlm-game-footer msf-footer">
        {winner && (
          <button className="win-btn primary-btn" onClick={handleRestart}>{t.games.replayRound}</button>
        )}
        <button className="msf-resign" onClick={handleQuit}>{t.games.resign}</button>
      </div>
    </div>
  );
};

/** Drapeau de Minesweeper Flags : mât noir, socle sombre, fanion bleu ou rouge. */
const FlagIcon: React.FC<{ color: 'blue' | 'red' }> = ({ color }) => (
  <svg className={`msf-flag-icon msf-flag-${color}`} viewBox="0 0 20 20" aria-hidden="true">
    <rect x="5" y="2.5" width="1.8" height="13" rx="0.6" fill="#1b1b1b" />
    <path d="M6.8 3 L17 6.6 L6.8 10.2 Z" fill={color === 'blue' ? '#2459d6' : '#e3262f'} stroke={color === 'blue' ? '#10307a' : '#7d0d12'} strokeWidth="0.7" strokeLinejoin="round" />
    <path d="M7.6 4.3 L12.5 6.1 L7.6 7.6 Z" fill="#ffffff" opacity="0.35" />
    <ellipse cx="6" cy="16.2" rx="4.6" ry="1.7" fill="#2a2a2a" />
  </svg>
);

/** Mine (dévoilée en fin de manche). */
const MineIcon: React.FC = () => (
  <svg className="msf-mine-icon" viewBox="0 0 20 20" aria-hidden="true">
    <g stroke="#111" strokeWidth="1.6" strokeLinecap="round">
      <line x1="10" y1="2.5" x2="10" y2="17.5" /><line x1="2.5" y1="10" x2="17.5" y2="10" />
      <line x1="4.7" y1="4.7" x2="15.3" y2="15.3" /><line x1="15.3" y1="4.7" x2="4.7" y2="15.3" />
    </g>
    <circle cx="10" cy="10" r="5.2" fill="#111" />
    <circle cx="8.2" cy="8.2" r="1.5" fill="#fff" opacity="0.8" />
  </svg>
);

/** Bombe (bouton du panneau joueur), barrée quand elle n'est pas disponible. */
const BombIcon: React.FC<{ crossed?: boolean }> = ({ crossed }) => (
  <svg className="msf-bomb-icon" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="10" cy="14" r="6.5" fill="#1d1d1d" />
    <circle cx="7.8" cy="11.8" r="1.7" fill="#fff" opacity="0.7" />
    <path d="M14.5 9.5 L17 7" stroke="#6b4a1e" strokeWidth="1.8" strokeLinecap="round" />
    <path d="M17.6 4.2 l0.6 1.6 1.6 0.6 -1.6 0.6 -0.6 1.6 -0.6 -1.6 -1.6 -0.6 1.6 -0.6 z" fill="#ffb300" />
    {crossed && <path d="M4 4 L20 20 M20 4 L4 20" stroke="#d01b1b" strokeWidth="2.4" strokeLinecap="round" />}
  </svg>
);

export default MinesweeperGame;
