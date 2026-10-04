/**
 * NotificationManager.ts - OpenWLM
 * Gestion unifiée des notifications desktop (toasts in-app rétro WLM & notifications système).
 */

export interface NotificationDecisionContext {
  isSender: boolean;
  senderId: number;
  activeChatId: number;
  isAppVisible: boolean; // document.visibilityState === 'visible' && document.hasFocus()
  isDesktop: boolean;    // window.innerWidth > 768
  hasSystemPermission: boolean; // Notification.permission === 'granted'
}

export type NotificationDecision = 'none' | 'in-app' | 'system';

/**
 * Logique stricte de décision de notification :
 * 1. Pas de notification pour ses propres messages.
 * 2. Pas de notification si la conversation est déjà ouverte et activement visible.
 * 3. Si l'application est visible au premier plan sur PC, privilégier le toast in-app.
 * 4. Si l'application est en arrière-plan et que la permission existe, utiliser la notification système.
 * 5. Repli : si l'application est en arrière-plan sans permission système sur desktop, préparer/afficher le toast in-app.
 */
export function decideNotificationType(ctx: NotificationDecisionContext): NotificationDecision {
  // 1. Pas de notification pour ses propres messages
  if (ctx.isSender) {
    return 'none';
  }

  // 2. Pas de notification si la conversation est déjà ouverte et activement visible
  if (ctx.isAppVisible && ctx.activeChatId === ctx.senderId) {
    return 'none';
  }

  // 3. Si l'application est visible au premier plan sur PC, privilégier le toast in-app
  if (ctx.isAppVisible) {
    if (ctx.isDesktop) {
      return 'in-app';
    }
    return 'none';
  }

  // 4. Si l'application est en arrière-plan et que la permission existe, utiliser la notification système
  if (ctx.hasSystemPermission) {
    return 'system';
  }

  // 5. Repli sur PC : afficher le toast in-app si pas de permission système
  if (ctx.isDesktop) {
    return 'in-app';
  }

  return 'none';
}

/**
 * Vérifie si la Notification API du navigateur est disponible
 */
export function isSystemNotificationSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/**
 * Récupère le statut de permission actuel
 */
export function getSystemNotificationPermission(): NotificationPermission | 'unsupported' {
  if (!isSystemNotificationSupported()) return 'unsupported';
  return Notification.permission;
}

/**
 * Demande la permission pour les notifications système au navigateur
 */
export async function requestSystemNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!isSystemNotificationSupported()) return 'unsupported';
  try {
    const res = await Notification.requestPermission();
    return res;
  } catch (err) {
    console.warn('[NotificationManager] Erreur lors de la demande de permission:', err);
    return Notification.permission;
  }
}

/**
 * Déclenche une notification système standard (HTML5 Web Notification)
 */
export function showSystemNotification(params: {
  title: string;
  body: string;
  icon?: string;
  tag?: string;
  onClick?: () => void;
}): Notification | null {
  if (!isSystemNotificationSupported()) return null;
  if (Notification.permission !== 'granted') return null;

  try {
    const notif = new Notification(params.title, {
      body: params.body,
      icon: params.icon || '/assets/openwlm_logo.png',
      badge: '/assets/openwlm_logo.png',
      tag: params.tag || 'openwlm-message'
    });

    if (params.onClick) {
      notif.onclick = () => {
        try {
          window.focus();
        } catch {}
        params.onClick?.();
        notif.close();
      };
    }

    return notif;
  } catch (e) {
    console.warn('[NotificationManager] Échec affichage notification système:', e);
    return null;
  }
}
