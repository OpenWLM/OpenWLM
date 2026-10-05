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
 * Supporte à la fois les implémentations modernes (Promise) et héritées (callback)
 */
export async function requestSystemNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!isSystemNotificationSupported()) return 'unsupported';
  try {
    let result: NotificationPermission;
    const req = Notification.requestPermission();
    if (req && typeof (req as any).then === 'function') {
      result = await req;
    } else {
      result = await new Promise<NotificationPermission>((resolve) => {
        Notification.requestPermission((p) => resolve(p));
      });
    }
    return result;
  } catch (err) {
    console.warn('[NotificationManager] Erreur lors de la demande de permission:', err);
    return Notification.permission;
  }
}

/**
 * Déclenche une notification système standard (HTML5 Web Notification ou ServiceWorkerRegistration)
 * Indispensable pour la compatibilité PWA Chromium / Windows ("Illegal constructor" évité via ServiceWorkerRegistration)
 */
export async function showSystemNotification(params: {
  title: string;
  body: string;
  icon?: string;
  tag?: string;
  data?: any;
  onClick?: () => void;
}): Promise<boolean> {
  if (!isSystemNotificationSupported()) return false;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;

  const defaultIcon = '/assets/openwlm_logo.png';
  const defaultTag = 'openwlm-message';

  // 1. Tenter d'utiliser ServiceWorkerRegistration si disponible (mode PWA / Chromium desktop)
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg && 'showNotification' in reg) {
        await reg.showNotification(params.title, {
          body: params.body,
          icon: params.icon || defaultIcon,
          badge: defaultIcon,
          tag: params.tag || defaultTag,
          data: { url: '/', ...(params.data || {}) }
        });
        return true;
      }
    } catch (swErr) {
      console.warn('[NotificationManager] ServiceWorker showNotification a échoué, repli sur Notification():', swErr);
    }
  }

  // 2. Repli standard via new Notification() (navigateurs classiques / contextes sans SW actif)
  try {
    const notif = new Notification(params.title, {
      body: params.body,
      icon: params.icon || defaultIcon,
      badge: defaultIcon,
      tag: params.tag || defaultTag
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

    return true;
  } catch (e) {
    console.warn('[NotificationManager] Échec affichage notification système:', e);
    return false;
  }
}
