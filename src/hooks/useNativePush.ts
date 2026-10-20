import { useEffect } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import axios from 'axios';
import {
  isNativeApp,
  getNativeFcmToken,
  getNativeNotificationPermission,
  requestNativeNotificationPermission,
  onNativeFcmToken,
  onNativeOpenChat
} from '../utils/platform';

/**
 * NOTIFICATIONS DE L'APP ANDROID (Firebase Cloud Messaging, docs/ANDROID.md)
 *
 * Dans l'app native uniquement :
 * - après la connexion, demande l'autorisation d'afficher des notifications (Android 13+,
 *   une fois) puis enregistre le jeton FCM de l'appareil pour le compte connecté ;
 * - réenregistre le jeton quand Firebase le renouvelle ;
 * - ouvre la conversation quand une notification est touchée.
 * Le Web Push (service worker) n'existe pas dans la WebView : c'est la voie de remplacement.
 */

const registerToken = (token: string) =>
  axios.post('/api/push/fcm/register', { token }).catch((err) => {
    console.warn('[FCM] Enregistrement du jeton impossible:', err);
  });

/** Retire le jeton de cet appareil du compte (à appeler avant la déconnexion). */
export const unregisterNativePush = async (): Promise<void> => {
  const token = await getNativeFcmToken();
  if (!token) return;
  await axios.post('/api/push/fcm/unregister', { token }).catch(() => { /* déjà retiré ou hors ligne */ });
};

export function useNativePush(options: {
  userId: number | undefined;
  setOpenChatIds: Dispatch<SetStateAction<number[]>>;
  setActiveChatId: Dispatch<SetStateAction<number>>;
}): void {
  const { userId, setOpenChatIds, setActiveChatId } = options;

  useEffect(() => {
    const handle = onNativeOpenChat((senderId) => {
      if (!senderId) return;
      setOpenChatIds(prev => prev.includes(senderId) ? prev : [...prev, senderId]);
      setActiveChatId(senderId);
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
    })();
    const handle = onNativeFcmToken((token) => { registerToken(token); });
    return () => {
      cancelled = true;
      handle?.then(h => h.remove());
    };
  }, [userId]);
}
