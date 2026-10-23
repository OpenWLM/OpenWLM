import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { SYSTEM_BOT_ID, type User } from '../types';
import { useI18n } from '../i18n';
import { notify } from '../utils/dialogs';

/**
 * DOMAINE APPELS (WebRTC)
 *
 * Regroupe l'état minimal des appels côté `App` :
 * - appel actif (`activeCallId`), appel entrant (`isReceivingCall`), signalisation brute
 *   à déchiffrer par `<VideoCall/>` (`callSignal`), mode audio seul (`isAudioOnly`) ;
 * - démarrage / fin d'appel.
 *
 * Les événements Socket.IO (`incoming_call`, réponse, rejet) restent dans l'effet socket
 * de `App`, qui pilote les setters exposés. La signalisation passe **brute** (chiffrée
 * E2EE) : ce hook ne la déchiffre pas.
 */

export interface CallsApi {
  activeCallId: number | null;
  setActiveCallId: Dispatch<SetStateAction<number | null>>;
  isReceivingCall: boolean;
  setIsReceivingCall: Dispatch<SetStateAction<boolean>>;
  callSignal: any;
  setCallSignal: Dispatch<SetStateAction<any>>;
  isAudioOnly: boolean;
  setIsAudioOnly: Dispatch<SetStateAction<boolean>>;
  handleStartCall: (audioOnly: boolean) => void;
  handleEndCall: () => void;
}

export interface UseCallsOptions {
  user: User | null;
  activeChatId: number;
}

export function useCalls({ user, activeChatId }: UseCallsOptions): CallsApi {
  const { t } = useI18n();
  const [activeCallId, setActiveCallId] = useState<number | null>(null);
  const [isReceivingCall, setIsReceivingCall] = useState(false);
  const [callSignal, setCallSignal] = useState<any>(null);
  const [isAudioOnly, setIsAudioOnly] = useState(false);

  /**
   * LANCER UN APPEL (AUDIO OU VIDÉO)
   */
  const handleStartCall = (audioOnly: boolean) => {
    if (!activeChatId || !user) return;
    if (activeChatId === SYSTEM_BOT_ID) {
      notify(t.notices.callsBotOnly);
      return;
    }
    // Déjà en appel (ou en train d'appeler) : un second appel écrasait le premier dans le même
    // composant, la signalisation partait vers le nouveau contact et l'ancien n'était jamais prévenu
    if (activeCallId) {
      notify(t.notices.callAlreadyActive);
      return;
    }
    setIsAudioOnly(audioOnly);
    setActiveCallId(activeChatId);
    setIsReceivingCall(false);
    setCallSignal(null);
  };

  const handleEndCall = () => {
    setActiveCallId(null);
    setIsReceivingCall(false);
    setCallSignal(null);
  };

  return {
    activeCallId,
    setActiveCallId,
    isReceivingCall,
    setIsReceivingCall,
    callSignal,
    setCallSignal,
    isAudioOnly,
    setIsAudioOnly,
    handleStartCall,
    handleEndCall
  };
}
