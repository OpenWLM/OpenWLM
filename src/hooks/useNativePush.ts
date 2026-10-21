import { useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import axios from 'axios';
import { useI18n } from '../i18n';
import { askConfirm } from '../utils/dialogs';
import {
  isNativeApp,
  getNativeCallPermissions,
  requestNativeCallPermission,
  getNativeFcmToken,
  getNativeNotificationPermission,
  requestNativeNotificationPermission,
  onNativeFcmToken,
  onNativeOpenChat,
  onNativeServerChangeCancelled,
  openServerSettings
} from '../utils/platform';

/**
 * NOTIFICATIONS DE L'APP ANDROID (Firebase Cloud Messaging, docs/ANDROID.md)
 *
 * Dans l'app native uniquement :
 * - après la connexion, demande l'autorisation d'afficher des notifications (Android 13+,
 *   une fois) puis enregistre le jeton FCM de l'appareil pour le compte connecté ;
 * - réenregistre le jeton quand Firebase le renouvelle ;
 * - une fois par appareil, explique puis demande les autorisations des appels (micro, écran
 *   d'appel plein écran) ;
 * - ouvre la conversation quand une notification est touchée (et signale « Répondre » à un
 *   appel : l'interface le prend dès que le serveur le lui redonne).
 * Le Web Push (service worker) n'existe pas dans la WebView : c'est la voie de remplacement.
 */

const registerToken = (token: string) =>
  axios.post('/api/push/fcm/register', { token }).catch((err) => {
    console.warn('[FCM] Enregistrement du jeton impossible:', err);
  });

/**
 * Changer de serveur : le jeton est d'abord retiré du compte sur le serveur actuel (sinon il
 * continuerait d'y réveiller le téléphone). Si l'utilisateur annule, il est réenregistré
 * (cf. useNativePush) ; s'il change de serveur, l'app supprime aussi le jeton chez Firebase.
 */
export const changeNativeServer = async (): Promise<void> => {
  await unregisterNativePush();
  await openServerSettings();
};

/** Retire le jeton de cet appareil du compte (à appeler avant la déconnexion). */
export const unregisterNativePush = async (): Promise<void> => {
  const token = await getNativeFcmToken();
  if (!token) return;
  await axios.post('/api/push/fcm/unregister', { token }).catch(() => { /* déjà retiré ou hors ligne */ });
};

// Explication des autorisations d'appel déjà montrée sur cet appareil (une seule fois)
const CALL_SETUP_KEY = 'wlm_native_call_setup';
const callSetupShown = () => { try { return localStorage.getItem(CALL_SETUP_KEY) === '1'; } catch { return true; } };
const markCallSetupShown = () => { try { localStorage.setItem(CALL_SETUP_KEY, '1'); } catch { /* ignore */ } };

export function useNativePush(options: {
  userId: number | undefined;
  setOpenChatIds: Dispatch<SetStateAction<number[]>>;
  setActiveChatId: Dispatch<SetStateAction<number>>;
  /** « Répondre » sur l'écran d'appel natif : l'interface prend l'appel de ce contact. */
  onAnswerCall: (callerId: number) => void;
}): void {
  const { userId, setOpenChatIds, setActiveChatId, onAnswerCall } = options;
  const { t } = useI18n();
  const tRef = useRef(t);
  useEffect(() => { tRef.current = t; });
  const onAnswerCallRef = useRef(onAnswerCall);
  useEffect(() => { onAnswerCallRef.current = onAnswerCall; });

  useEffect(() => {
    const handle = onNativeOpenChat((senderId, answer) => {
      if (!senderId) return;
      setOpenChatIds(prev => prev.includes(senderId) ? prev : [...prev, senderId]);
      setActiveChatId(senderId);
      if (answer) onAnswerCallRef.current(senderId);
    });
    return () => { handle?.then(h => h.remove()); };
  }, [setOpenChatIds, setActiveChatId]);

  useEffect(() => {
    if (!userId || !isNativeApp()) return;
    let cancelled = false;
    (async () => {
      if (await getNativeNotificationPermission() === 'prompt') {
        await requestNativeNotificationPermission();
      }
      const token = await getNativeFcmToken();
      if (token && !cancelled) await registerToken(token);

      // Appels : micro et écran d'appel plein écran (Android 14+, dans les réglages), expliqués
      // avant les demandes d'Android
      const perms = await getNativeCallPermissions();
      if (cancelled || !perms || callSetupShown()) return;
      if (perms.microphone !== 'prompt' && perms.fullScreen === 'granted') return;
      markCallSetupShown();
      const texts = tRef.current.settings;
      const ok = await askConfirm(texts.nativeCallSetupText, { title: texts.nativeCallSetupTitle, icon: '📞', confirmLabel: texts.nativeCallSetupConfirm });
      if (!ok || cancelled) return;
      if (perms.microphone === 'prompt') await requestNativeCallPermission('microphone');
      if (perms.fullScreen !== 'granted') await requestNativeCallPermission('fullScreen');
    })();
    const handle = onNativeFcmToken((token) => { registerToken(token); });
    // Écran de choix du serveur fermé sans changement : le jeton retiré est réenregistré
    const cancelHandle = onNativeServerChangeCancelled(() => {
      getNativeFcmToken().then((token) => { if (token) registerToken(token); });
    });
    return () => {
      cancelled = true;
      handle?.then(h => h.remove());
      cancelHandle?.then(h => h.remove());
    };
  }, [userId]);
}
