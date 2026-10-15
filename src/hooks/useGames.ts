import { useCallback, useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Socket } from 'socket.io-client';
import axios from 'axios';
import { SYSTEM_BOT_ID, type Contact, type Message, type User } from '../types';

/**
 * DOMAINE JEUX MULTI-JOUEURS (Morpion, Dames, Puissance 4)
 *
 * Regroupe l'état et les actions des activités MSN :
 * - partie active, invitations entrante/sortante, parties reprenables, résumé de partie ;
 * - actions associées (inviter, accepter/refuser, annuler, quitter, réduire/fermer) ;
 * - reprise automatique d'une partie à l'ouverture de la conversation.
 *
 * Les événements Socket.IO (`game_invite_received`, `game_started`, …) restent enregistrés
 * dans l'effet socket de `App`, qui pilote les setters exposés ici. La partie solo contre
 * l'assistant OpenWLM écrit dans la conversation du bot via `setMessages` injecté.
 */

export interface ActiveGame {
  opponentId: number;
  opponentName: string;
  mySymbol?: string;
  myColor?: 'white' | 'black' | 'red' | 'yellow';
  isMyTurn: boolean;
  gameType: string;
}

export interface IncomingGameInvite {
  from: number;
  fromName: string;
  gameType: string;
}

export interface OutgoingGameInvite {
  target: number;
  targetName: string;
  gameType?: string;
}

export interface ResumableGame {
  opponentId: number;
  opponentName: string;
  gameType: string;
  mySymbol?: string;
  myColor?: 'white' | 'black' | 'red' | 'yellow';
  isMyTurn: boolean;
}

export interface GameSummary {
  isMyTurn: boolean;
  myScore: number;
  opponentScore: number;
  winner: 'me' | 'opponent' | 'draw' | null;
}

export interface UseGamesOptions {
  socket: Socket | null;
  user: User | null;
  activeChatId: number;
  contacts: Contact[];
  /** Conversation de l'assistant (parties solo) : ajout de messages système. */
  setMessages: Dispatch<SetStateAction<Record<number, Message[]>>>;
}

export interface GamesApi {
  activeGame: ActiveGame | null;
  setActiveGame: Dispatch<SetStateAction<ActiveGame | null>>;
  incomingGameInvite: IncomingGameInvite | null;
  setIncomingGameInvite: Dispatch<SetStateAction<IncomingGameInvite | null>>;
  outgoingGameInvite: OutgoingGameInvite | null;
  setOutgoingGameInvite: Dispatch<SetStateAction<OutgoingGameInvite | null>>;
  resumableGames: ResumableGame[];
  setResumableGames: Dispatch<SetStateAction<ResumableGame[]>>;
  showGamesMenu: boolean;
  setShowGamesMenu: Dispatch<SetStateAction<boolean>>;
  isGameMinimized: boolean;
  setIsGameMinimized: Dispatch<SetStateAction<boolean>>;
  gameSummary: GameSummary;
  setGameSummary: Dispatch<SetStateAction<GameSummary>>;
  refreshResumableGames: () => Promise<void>;
  handleGameClose: () => void;
  handleGameMinimize: () => void;
  handleGameStateChange: (summary: GameSummary) => void;
  handleInviteGame: (gameType?: string) => void;
  handleAcceptGameInvite: () => void;
  handleDeclineGameInvite: () => void;
  handleCancelOutgoingInvite: () => void;
  handleQuitActiveGame: () => void;
}

export function useGames(options: UseGamesOptions): GamesApi {
  const { socket, user, activeChatId, contacts, setMessages } = options;

  const [activeGame, setActiveGame] = useState<ActiveGame | null>(null);
  const [incomingGameInvite, setIncomingGameInvite] = useState<IncomingGameInvite | null>(null);
  const [outgoingGameInvite, setOutgoingGameInvite] = useState<OutgoingGameInvite | null>(null);
  const [resumableGames, setResumableGames] = useState<ResumableGame[]>([]);
  const [showGamesMenu, setShowGamesMenu] = useState(false);
  const [isGameMinimized, setIsGameMinimized] = useState<boolean>(false);
  const [gameSummary, setGameSummary] = useState<GameSummary>({
    isMyTurn: false,
    myScore: 0,
    opponentScore: 0,
    winner: null
  });

  /**
   * Reprise de partie : rafraîchit la liste des parties actives de l'utilisateur
   */
  const refreshResumableGames = useCallback(async () => {
    try {
      const res = await axios.get('/api/games/active');
      setResumableGames(Array.isArray(res.data?.games) ? res.data.games : []);
    } catch { /* ignore */ }
  }, []);

  // Callbacks STABLES passés aux jeux. Indispensable : les useEffect des composants de jeu
  // dépendent de ces props ET appellent setState → un prop instable = boucle de rendu (freeze).
  const handleGameClose = useCallback(() => {
    setActiveGame(null);
    setIsGameMinimized(false);
    refreshResumableGames();
  }, [refreshResumableGames]);

  const handleGameMinimize = useCallback(() => {
    setIsGameMinimized(true);
  }, []);

  const handleGameStateChange = useCallback((summary: GameSummary) => {
    setGameSummary(summary);
  }, []);

  // Reprise automatique d'une partie en cours à l'ouverture de la conversation
  useEffect(() => {
    if (!activeChatId || activeGame) return;
    const g = resumableGames.find(x => x.opponentId === activeChatId);
    if (g) {
      setActiveGame({
        opponentId: g.opponentId,
        opponentName: g.opponentName,
        mySymbol: g.mySymbol,
        myColor: g.myColor,
        isMyTurn: g.isMyTurn,
        gameType: g.gameType
      });
    }
  }, [activeChatId, resumableGames, activeGame]);

  /**
   * GESTION DES JEUX MULTI-JOUEURS (MORPION, DAMES & PUISSANCE 4)
   */
  const handleInviteGame = (gameType: string = 'checkers') => {
    if (!activeChatId || !user) return;

    // Invitation de jeu contre OpenWLM (mode solo local)
    if (activeChatId === SYSTEM_BOT_ID) {
      if (gameType === 'morpion') {
        setActiveGame({
          opponentId: SYSTEM_BOT_ID,
          opponentName: 'OpenWLM',
          mySymbol: 'X',
          isMyTurn: true,
          gameType: 'morpion'
        });
        setIsGameMinimized(false);
        setShowGamesMenu(false);
        setMessages(prev => ({
          ...prev,
          [SYSTEM_BOT_ID]: [
            ...(prev[SYSTEM_BOT_ID] || []),
            {
              senderId: SYSTEM_BOT_ID,
              receiverId: user.id,
              sender: 'OpenWLM',
              text: "Partie de Morpion lancée. À vous de jouer (X).",
              time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              timestamp: new Date().toISOString()
            }
          ]
        }));
      } else if (gameType === 'puissance4') {
        setActiveGame({
          opponentId: SYSTEM_BOT_ID,
          opponentName: 'OpenWLM',
          mySymbol: 'R',
          myColor: 'red',
          isMyTurn: true,
          gameType: 'puissance4'
        });
        setIsGameMinimized(false);
        setShowGamesMenu(false);
        setMessages(prev => ({
          ...prev,
          [SYSTEM_BOT_ID]: [
            ...(prev[SYSTEM_BOT_ID] || []),
            {
              senderId: SYSTEM_BOT_ID,
              receiverId: user.id,
              sender: 'OpenWLM',
              text: "Partie de Puissance 4 lancée. À vous de jouer (Rouge 🔴).",
              time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              timestamp: new Date().toISOString()
            }
          ]
        }));
      } else {
        alert("OpenWLM prend en charge le Morpion et le Puissance 4 pour les tests solo.");
        setShowGamesMenu(false);
      }
      return;
    }

    if (!socket) return;
    const contact = contacts.find(c => c.id === activeChatId);
    if (!contact || contact.status === 'offline') {
      const gameLabel = gameType === 'checkers' ? 'au Jeu de dames' : (gameType === 'puissance4' ? 'au Puissance 4' : 'au Morpion');
      alert(`Ce contact doit être en ligne pour jouer ${gameLabel}.`);
      return;
    }

    socket.emit('game_invite', { target: activeChatId, gameType });
    setOutgoingGameInvite({ target: activeChatId, targetName: contact.nickname || contact.username, gameType });
    setShowGamesMenu(false);
  };

  const handleAcceptGameInvite = () => {
    if (!incomingGameInvite || !socket) return;
    socket.emit('game_accept', { target: incomingGameInvite.from, gameType: incomingGameInvite.gameType });
    setIncomingGameInvite(null);
  };

  const handleDeclineGameInvite = () => {
    if (!incomingGameInvite || !socket) return;
    socket.emit('game_decline', { target: incomingGameInvite.from });
    setIncomingGameInvite(null);
  };

  const handleCancelOutgoingInvite = () => {
    if (!outgoingGameInvite || !socket) return;
    socket.emit('game_quit', { target: outgoingGameInvite.target });
    setOutgoingGameInvite(null);
  };

  const handleQuitActiveGame = () => {
    if (activeGame && socket) {
      socket.emit('game_quit', { target: activeGame.opponentId });
    }
    setActiveGame(null);
    setIsGameMinimized(false);
  };

  return {
    activeGame,
    setActiveGame,
    incomingGameInvite,
    setIncomingGameInvite,
    outgoingGameInvite,
    setOutgoingGameInvite,
    resumableGames,
    setResumableGames,
    showGamesMenu,
    setShowGamesMenu,
    isGameMinimized,
    setIsGameMinimized,
    gameSummary,
    setGameSummary,
    refreshResumableGames,
    handleGameClose,
    handleGameMinimize,
    handleGameStateChange,
    handleInviteGame,
    handleAcceptGameInvite,
    handleDeclineGameInvite,
    handleCancelOutgoingInvite,
    handleQuitActiveGame
  };
}
