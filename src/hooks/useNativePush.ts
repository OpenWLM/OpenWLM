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
  openServerSettings,
  hasNativeMethod
} from '../utils/platform';

/**
 * NOTIFICATIONS DE L'APP ANDROID (Firebase Cloud Messaging, docs/ANDROID.md)
 *
 * Dans l'app native uniquement :
 * - après la connexion, demande l'autorisation d'afficher des notifications (Android 13+,
 *   une fois) puis enregistre le jeton FCM de l'appareil pour le compte connecté, seulement
 *   si les notifications sont autorisées (sinon il le retire) ; revérifié au retour dans l'app ;
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

/** Demande de resynchronisation du jeton avec l'autorisation (cf. OptionsModal). */
export const NATIVE_PUSH_SYNC_EVENT = 'openwlm-native-push-sync';

/**
 * Le jeton n'est enregistré que si l'app peut afficher des notifications : sinon le serveur
 * compterait un appareil « réveillable » pour les appels (l'appelant attendrait une sonnerie
 * qui ne s'affiche pas). Notifications refusées : le jeton est retiré du compte.
 * Renvoie l'état appliqué, pour ne rien renvoyer au serveur tant qu'il ne change pas.
 */
const syncTokenWithPermission = async (previous: 'registered' | 'unregistered' | null): Promise<'registered' | 'unregistered' | null> => {
  const [permission, token] = await Promise.all([getNativeNotificationPermission(), getNativeFcmToken()]);
  if (!token) return previous;
  const wanted = permission === 'granted' ? 'registered' : 'unregistered';
  if (wanted === previous) return previous;
  if (wanted === 'registered') await registerToken(token);
  else await axios.post('/api/push/fcm/unregister', { token }).catch(() => { /* déjà absent */ });
  return wanted;
};

/**
 * Changer de serveur : le jeton est d'abord retiré du compte sur le serveur actuel (sinon il
 * continuerait d'y réveiller le téléphone). Si l'utilisateur annule, il est réenregistré
 * (cf. useNativePush) ; s'il change de serveur, l'app supprime aussi le jeton chez Firebase.
 */
export const changeNativeServer = async (): Promise<void> => {
  // APK v3 : ne signale pas l'annulation (serverChangeCancelled), le jeton ne serait pas
  // réenregistré ; on le laisse donc en place (comportement de la v3)
  if (hasNativeMethod('beginSave')) await unregisterNativePush();
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
    let synced: 'registered' | 'unregistered' | null = null;
    const sync = async () => {
      if (!cancelled) synced = await syncTokenWithPermission(synced);
    };
    (async () => {
      if (await getNativeNotificationPermission() === 'prompt') {
        await requestNativeNotificationPermission();
      }
      await sync();

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
    // Nouveau jeton, ou retour de l'écran de choix du serveur sans changement (le jeton retiré
    // avant de l'ouvrir est réenregistré) : nouvelle synchronisation
    const handle = onNativeFcmToken(() => { synced = null; sync(); });
    const cancelHandle = onNativeServerChangeCancelled(() => { synced = null; sync(); });
    // Retour dans l'app : les notifications ont pu être autorisées ou coupées dans les réglages
    const onVisible = () => { if (document.visibilityState === 'visible') sync(); };
    document.addEventListener('visibilitychange', onVisible);
    // Autorisation accordée depuis les Options (la boîte d'Android ne change pas la visibilité)
    window.addEventListener(NATIVE_PUSH_SYNC_EVENT, sync);
    return () => {
      window.removeEventListener(NATIVE_PUSH_SYNC_EVENT, sync);
      cancelled = true;
      handle?.then(h => h.remove());
      cancelHandle?.then(h => h.remove());
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [userId]);
}
