import { useCallback, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Socket } from 'socket.io-client';
import SoundManager from '../utils/SoundManager';
import { SYSTEM_BOT_ID, type Message, type User } from '../types';

/**
 * DOMAINE CLINS D'ŒIL & WIZZ (nudges)
 *
 * Regroupe l'état et les actions des interactions « hoquet » du client WLM :
 * - clin d'œil animé en cours (`activeWink` / `winkCounter`) ;
 * - wizz (nudge) : secousse visuelle, anti-spam local, partie solo contre l'assistant.
 *
 * L'envoi d'un clin d'œil est **chiffré et signé** comme un message : ce hook reçoit donc
 * `sealForContact`, `getPublicKey`, `myKeys` ainsi que l'état du mode privé par injection.
 * Les événements Socket.IO (`receive_wink`, `receive_wizz`) restent dans l'effet socket de
 * `App`, qui rappelle ici `handleSendWink`/`handleNudge` en mode « reçu ».
 */

export interface WinkDefinition {
  id: string;
  name: string;
  icon: string;
}

/** Catalogue des clins d'œil (partagé avec la modale de sélection). */
export const WINKS: WinkDefinition[] = [
  { id: 'bouncy_ball', name: 'Bouncy Ball', icon: '⚽' },
  { id: 'kiss', name: 'Kiss', icon: '💋' },
  { id: 'love_letter', name: 'Love Letter', icon: '💌' },
  { id: 'frog', name: 'Frog', icon: '🐸' },
  { id: 'guitar_smash', name: 'Guitar Smash', icon: '🎸' },
  { id: 'heart', name: 'Heart', icon: '❤️' },
  { id: 'knock', name: 'Knock', icon: '🚪' },
  { id: 'bow', name: 'Bow', icon: '🎀' },
  { id: 'dancing_pig', name: 'Dancing Pig', icon: '🐷' },
  { id: 'eyeball', name: 'Eyeball', icon: '👁️' },
  { id: 'lipstick_girl', name: 'Lipstick Girl', icon: '💄' },
  { id: 'notes', name: 'Notes', icon: '🎵' },
  { id: 'silly_face', name: 'Silly Face', icon: '😜' },
  { id: 'stars', name: 'Stars', icon: '⭐' },
  { id: 'water_balloon', name: 'Water Balloon', icon: '🎈' }
];

export interface UseWinksAndNudgeOptions {
  socket: Socket | null;
  user: User | null;
  activeChatId: number;
  myNickname: string;
  /** Présence des clés E2EE : conditionne l'envoi d'un clin d'œil chiffré. */
  myKeys: unknown;
  getPublicKey: (contactId: number, forceRefresh?: boolean) => Promise<JsonWebKey | null | undefined>;
  sealForContact: (payload: unknown, contactId: number, contactPubKey: JsonWebKey) => Promise<unknown>;
  globalPrivateMode: boolean;
  isPrivateMode: Record<number, boolean>;
  setMessages: Dispatch<SetStateAction<Record<number, Message[]>>>;
  setShowWinksModal: Dispatch<SetStateAction<boolean>>;
  /** Textes i18n d'échec d'envoi du clin d'œil (réseau / contact hors ligne). */
  winkNotSentNetworkText: string;
  winkNotSentOfflineText: string;
}

export interface WinksAndNudgeApi {
  activeWink: string | null;
  setActiveWink: Dispatch<SetStateAction<string | null>>;
  winkCounter: number;
  setWinkCounter: Dispatch<SetStateAction<number>>;
  isNudging: boolean;
  setIsNudging: Dispatch<SetStateAction<boolean>>;
  nudgeTimestamps: number[];
  setNudgeTimestamps: Dispatch<SetStateAction<number[]>>;
  handleSendWink: (winkId: string, received?: boolean, fromId?: number) => Promise<void>;
  handleNudge: (received?: boolean, fromId?: number) => void;
  handleWinkFinish: () => void;
}

const SEND_ACK_TIMEOUT_MS = 15_000;

export function useWinksAndNudge(options: UseWinksAndNudgeOptions): WinksAndNudgeApi {
  const {
    socket,
    user,
    activeChatId,
    myNickname,
    myKeys,
    getPublicKey,
    sealForContact,
    globalPrivateMode,
    isPrivateMode,
    setMessages,
    setShowWinksModal,
    winkNotSentNetworkText,
    winkNotSentOfflineText
  } = options;

  const [activeWink, setActiveWink] = useState<string | null>(null);
  const [winkCounter, setWinkCounter] = useState(0);
  const [isNudging, setIsNudging] = useState(false);
  const [nudgeTimestamps, setNudgeTimestamps] = useState<number[]>([]);

  /**
   * ENVOI D'UN CLIN D'ŒIL (WINK)
   */
  const handleSendWink = async (winkId: string, received: boolean = false, fromId: number = 0) => {
    const targetId = received ? fromId : activeChatId;
    const wink = WINKS.find(w => w.id === winkId);
    const winkName = wink?.name || winkId;
    const winkTime = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    setShowWinksModal(false);
    setActiveWink(winkId);
    setWinkCounter(prev => prev + 1);

    // Réception : simple ligne système (le clin d'œil reçu a déjà été remis par le serveur).
    if (received) {
      setMessages(prev => ({
        ...prev,
        [targetId]: [...(prev[targetId] || []), {
          text: `Vous avez reçu un clin d'œil (${winkName}).`,
          sender: 'Système', time: winkTime(), isWink: true, style: null
        }]
      }));
      return;
    }

    if (!socket || !myKeys) return;
    const contactPubKey = await getPublicKey(activeChatId);
    if (!contactPubKey) {
      alert("Ce contact doit être en ligne pour recevoir un clin d'œil.");
      return;
    }

    const unencryptedPayload = {
      text: `--- Clin d'œil: ${winkName} ---`,
      sender: myNickname,
      winkId: winkId,
      type: 'wink'
    };

    let e2eData: unknown;
    try {
      e2eData = await sealForContact(unencryptedPayload, activeChatId, contactPubKey);
    } catch (err) { console.error("Echec envoi Wink chiffré:", err); return; }

    const pushWinkLine = (text: string) => setMessages(prev => ({
      ...prev,
      [targetId]: [...(prev[targetId] || []), { text, sender: 'Système', time: winkTime(), isWink: true, style: null }]
    }));

    // ACCUSÉ : on n'affiche « envoyé » qu'après acceptation du serveur. En mode privé vers un
    // contact hors ligne, le serveur refuse (rien n'est conservé) — même garantie que les
    // messages texte/fichier/vocal (cf. deliverSealedMessage).
    if (!socket.connected) {
      pushWinkLine(winkNotSentNetworkText);
      return;
    }
    socket.timeout(SEND_ACK_TIMEOUT_MS).emit('send_message', {
      senderId: user?.id,
      receiverId: activeChatId,
      text: JSON.stringify(e2eData),
      type: 'wink',
      isPrivate: globalPrivateMode || !!isPrivateMode[activeChatId]
    }, (err: Error | null, ack?: { success?: boolean; code?: string }) => {
      if (err || !ack?.success) {
        pushWinkLine(ack?.code === 'RECIPIENT_OFFLINE_PRIVATE' ? winkNotSentOfflineText : winkNotSentNetworkText);
      } else {
        pushWinkLine(`Vous venez d'envoyer un clin d'œil (${winkName}).`);
      }
    });
  };

  /**
   * ENVOI/RÉCEPTION D'UN WIZZ (NUDGE)
   */
  const handleNudge = (received: boolean = false, fromId: number = 0) => {
    const targetId = received ? fromId : activeChatId;

    if (!received) {
      if (activeChatId === SYSTEM_BOT_ID) { // partie solo locale contre l'assistant
        SoundManager.play('NUDGE');
        if (!isNudging) {
          setIsNudging(true);
          setTimeout(() => setIsNudging(false), 2000);
        }
        setMessages(prev => ({
          ...prev,
          [SYSTEM_BOT_ID]: [...(prev[SYSTEM_BOT_ID] || []), { text: "Vous venez d'envoyer un Wizz !", sender: 'Système' }]
        }));

        setTimeout(() => {
          SoundManager.play('NUDGE');
          setIsNudging(true);
          setTimeout(() => setIsNudging(false), 2000);
          setMessages(prev => ({
            ...prev,
            [SYSTEM_BOT_ID]: [
              ...(prev[SYSTEM_BOT_ID] || []),
              { text: "Vous venez de recevoir un Wizz !", sender: 'Système' },
              {
                senderId: SYSTEM_BOT_ID,
                receiverId: user?.id,
                text: "Wizz bien reçu.",
                sender: 'OpenWLM',
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                timestamp: new Date().toISOString()
              }
            ]
          }));
        }, 1500);
        return;
      }

      // Anti-spam local pour les Wizz
      const now = Date.now();
      const recentNudges = nudgeTimestamps.filter(ts => now - ts < 60000);
      if (recentNudges.length >= 3) {
        setMessages(prev => ({
          ...prev,
          [activeChatId]: [...(prev[activeChatId] || []), { text: 'Vous ne pouvez pas envoyer de Wizz aussi souvent.', sender: 'Système' }]
        }));
        return;
      }
      setNudgeTimestamps([...recentNudges, now]);
      if (socket) socket.emit('send_wizz', { senderId: user?.id, receiverId: activeChatId });
    }

    SoundManager.play('NUDGE');
    if (isNudging) return;
    setIsNudging(true);

    const msgText = received ? 'Vous venez de recevoir un Wizz !' : 'Vous venez d\'envoyer un Wizz !';
    setMessages(prev => ({ ...prev, [targetId]: [...(prev[targetId] || []), { text: msgText, sender: 'Système' }] }));
    setTimeout(() => setIsNudging(false), 2000);
  };

  const handleWinkFinish = useCallback(() => setActiveWink(null), []);

  return {
    activeWink,
    setActiveWink,
    winkCounter,
    setWinkCounter,
    isNudging,
    setIsNudging,
    nudgeTimestamps,
    setNudgeTimestamps,
    handleSendWink,
    handleNudge,
    handleWinkFinish
  };
}
