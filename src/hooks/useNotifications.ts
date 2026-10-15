import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useI18n } from '../i18n';
import type { ToastItem } from '../components/DesktopToast';
import {
  showSystemNotification,
  requestSystemNotificationPermission,
  getSystemNotificationPermission
} from '../utils/NotificationManager';
import {
  isPushSupported,
  subscribeToWebPush,
  sendTestWebPush,
  fetchPushBackendStatus,
  type PushBackendStatus
} from '../utils/PushNotificationManager';
import { loadEnableDesktopToasts, saveEnableDesktopToasts } from '../utils/profileStorage';
import { SYSTEM_BOT_ID, SYSTEM_BOT_CONTACT } from '../types';

/**
 * DOMAINE NOTIFICATIONS & ALERTES (toasts, notifications système, Web Push)
 *
 * Regroupe l'état et les effets liés aux notifications :
 * - toasts bureau (bureau WLM) et préférence `enableDesktopToasts` (persistée) ;
 * - permission système (écoute des changements), pré-prompt, essai d'alerte ;
 * - statut Web Push (VAPID) et envoi d'un push de test ;
 * - ouverture d'une conversation depuis un clic sur notification (message du Service
 *   Worker ou paramètre d'URL `?chat=` au démarrage à froid).
 *
 * L'ouverture de conversation est injectée via `setOpenChatIds`/`setActiveChatId`. Le
 * rendu du conteneur de toasts reste dans `App` (avec `DesktopToast`).
 */

export interface UseNotificationsOptions {
  user: unknown;
  /** Ouverture de la modale d'options : rafraîchit permission et statut push. */
  showOptionsModal: boolean;
  setOpenChatIds: Dispatch<SetStateAction<number[]>>;
  setActiveChatId: Dispatch<SetStateAction<number>>;
}

export interface NotificationsApi {
  enableDesktopToasts: boolean;
  setEnableDesktopToasts: Dispatch<SetStateAction<boolean>>;
  toasts: ToastItem[];
  addToast: (toast: Omit<ToastItem, 'id' | 'isExiting'>) => void;
  dismissToast: (toastId: string) => void;
  handleToastOpenChat: (senderId: number) => void;
  systemPermission: NotificationPermission | 'unsupported';
  permissionAttempted: boolean;
  prepromptDismissed: boolean;
  setPrepromptDismissed: Dispatch<SetStateAction<boolean>>;
  testAlertFeedback: string | null;
  pushStatus: PushBackendStatus | null;
  pushTestFeedback: string | null;
  handleRequestPermission: () => Promise<void>;
  handleTestAlert: () => void;
  handleTestPush: () => Promise<void>;
}

export function useNotifications(options: UseNotificationsOptions): NotificationsApi {
  const { user, showOptionsModal, setOpenChatIds, setActiveChatId } = options;
  const { t } = useI18n();

  const [enableDesktopToasts, setEnableDesktopToasts] = useState<boolean>(() => loadEnableDesktopToasts(true));
  const enableDesktopToastsRef = useRef(enableDesktopToasts);
  useEffect(() => {
    enableDesktopToastsRef.current = enableDesktopToasts;
    saveEnableDesktopToasts(enableDesktopToasts);
  }, [enableDesktopToasts]);

  const [systemPermission, setSystemPermission] = useState<NotificationPermission | 'unsupported'>(() => {
    return getSystemNotificationPermission();
  });
  const [permissionAttempted, setPermissionAttempted] = useState<boolean>(false);
  const [prepromptDismissed, setPrepromptDismissed] = useState<boolean>(false);
  const [testAlertFeedback, setTestAlertFeedback] = useState<string | null>(null);
  const [pushStatus, setPushStatus] = useState<PushBackendStatus | null>(null);
  const [pushTestFeedback, setPushTestFeedback] = useState<string | null>(null);

  useEffect(() => {
    const updatePerm = () => {
      const current = getSystemNotificationPermission();
      setSystemPermission(current);
      if (current === 'granted') {
        setPrepromptDismissed(true);
      }
    };

    window.addEventListener('focus', updatePerm);
    document.addEventListener('visibilitychange', updatePerm);

    if (typeof navigator !== 'undefined' && navigator.permissions && navigator.permissions.query) {
      navigator.permissions.query({ name: 'notifications' as PermissionName })
        .then(status => {
          status.onchange = () => {
            updatePerm();
          };
        })
        .catch(() => {});
    }

    return () => {
      window.removeEventListener('focus', updatePerm);
      document.removeEventListener('visibilitychange', updatePerm);
    };
  }, []);

  useEffect(() => {
    if (showOptionsModal) {
      const current = getSystemNotificationPermission();
      setSystemPermission(current);
      if (current === 'granted') {
        setPrepromptDismissed(true);
      }
      setTestAlertFeedback(null);
      setPushTestFeedback(null);
      if (isPushSupported()) {
        fetchPushBackendStatus().then(status => setPushStatus(status)).catch(() => {});
      }
    }
  }, [showOptionsModal]);

  // Synchronisation Push / Service Worker lorsque l'utilisateur est connecté et que les notifications sont accordées
  useEffect(() => {
    if (!user) return;
    if (isPushSupported()) {
      fetchPushBackendStatus().then(status => {
        setPushStatus(status);
        if (status.hasVapid && getSystemNotificationPermission() === 'granted') {
          subscribeToWebPush().catch(err => {
            console.warn('[App] Push auto-subscribe:', err);
          });
        }
      }).catch(() => {});
    }
  }, [user, systemPermission]);

  // Écoute des clics sur notification transmis par le Service Worker (PWA / Web Push)
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const handleSwMessage = (event: MessageEvent) => {
      if (event.data?.type === 'OPEN_CHAT' && event.data?.senderId) {
        const sId = Number(event.data.senderId);
        if (sId) {
          setOpenChatIds(prev => prev.includes(sId) ? prev : [...prev, sId]);
          setActiveChatId(sId);
        }
      }
    };
    navigator.serviceWorker.addEventListener('message', handleSwMessage);
    return () => {
      navigator.serviceWorker.removeEventListener('message', handleSwMessage);
    };
  }, [setOpenChatIds, setActiveChatId]);

  // Détection du paramètre URL ?chat=ID (démarrage à froid via clic sur notification)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const params = new URLSearchParams(window.location.search);
      const chatParam = params.get('chat');
      if (chatParam) {
        const cId = parseInt(chatParam, 10);
        if (cId && !isNaN(cId)) {
          setOpenChatIds(prev => prev.includes(cId) ? prev : [...prev, cId]);
          setActiveChatId(cId);
        }
      }
    } catch {}
  }, [setOpenChatIds, setActiveChatId]);

  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const addToast = useCallback((toast: Omit<ToastItem, 'id' | 'isExiting'>) => {
    if (!enableDesktopToastsRef.current) return;
    const id = `toast_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    setToasts(prev => {
      const updated = prev.length >= 3 ? prev.slice(prev.length - 2) : prev;
      return [...updated, { ...toast, id, isExiting: false }];
    });
  }, []);

  const dismissToast = useCallback((toastId: string) => {
    setToasts(prev => prev.map(t => t.id === toastId ? { ...t, isExiting: true } : t));
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== toastId));
    }, 240);
  }, []);

  const handleToastOpenChat = useCallback((senderId: number) => {
    setOpenChatIds(prev => prev.includes(senderId) ? prev : [...prev, senderId]);
    setActiveChatId(senderId);
  }, [setOpenChatIds, setActiveChatId]);

  /** Demande la permission de notification système (et s'abonne au Web Push si accordée). */
  const handleRequestPermission = useCallback(async () => {
    setPermissionAttempted(true);
    const p = await requestSystemNotificationPermission();
    setSystemPermission(p);
    if (p === 'granted') {
      setPrepromptDismissed(true);
      if (isPushSupported()) {
        subscribeToWebPush().catch(() => {});
      }
    }
  }, []);

  /** Affiche un toast + notification système de test et renvoie le retour adapté. */
  const handleTestAlert = useCallback(() => {
    addToast({
      senderId: SYSTEM_BOT_ID,
      senderName: 'OpenWLM Assistant',
      avatar: SYSTEM_BOT_CONTACT.avatar,
      text: t.settings.testAlertText,
      actionText: t.settings.toastAction
    });
    if (systemPermission === 'granted') {
      showSystemNotification({
        title: 'OpenWLM',
        body: t.settings.testAlertText,
        icon: '/assets/openwlm_logo.png',
        tag: 'openwlm-test-alert'
      });
      setTestAlertFeedback('success');
    } else if (systemPermission === 'default') {
      setTestAlertFeedback(permissionAttempted ? 'edge_quiet' : 'unconfigured');
    } else if (systemPermission === 'denied') {
      setTestAlertFeedback('denied');
    } else if (systemPermission === 'unsupported') {
      setTestAlertFeedback('unsupported');
    }
  }, [addToast, systemPermission, permissionAttempted, t]);

  /** Envoie une notification Web Push de test et affiche le retour. */
  const handleTestPush = useCallback(async () => {
    setPushTestFeedback(null);
    await subscribeToWebPush().catch(() => {});
    const res = await sendTestWebPush();
    if (res.success) {
      setPushTestFeedback(t.settings.pushTestSuccess || 'Notification Push de test envoyée avec succès !');
    } else {
      setPushTestFeedback((t.settings.pushTestError || 'Échec du test push') + (res.error ? ` : ${res.error}` : ''));
    }
  }, [t]);

  return {
    enableDesktopToasts,
    setEnableDesktopToasts,
    toasts,
    addToast,
    dismissToast,
    handleToastOpenChat,
    systemPermission,
    permissionAttempted,
    prepromptDismissed,
    setPrepromptDismissed,
    testAlertFeedback,
    pushStatus,
    pushTestFeedback,
    handleRequestPermission,
    handleTestAlert,
    handleTestPush
  };
}
