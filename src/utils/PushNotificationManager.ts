/**
 * PushNotificationManager.ts - OpenWLM
 * Gestion de l'architecture Web Push & Service Worker pour les notifications Android et arrière-plan.
 */

export interface PushBackendStatus {
  available: boolean;
  hasVapid: boolean;
  publicKey: string | null;
}

/**
 * Détecte si l'appareil est sous Android
 */
export function isAndroidDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android/i.test(navigator.userAgent);
}

/**
 * Vérifie si le navigateur supporte l'API Web Push et les Service Workers
 */
export function isPushSupported(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/**
 * Convertit une clé publique VAPID encodée en base64 URL-safe en Uint8Array
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/**
 * Récupère l'abonnement Push actif auprès du Service Worker
 */
export async function getExistingPushSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.ready;
    return await reg.pushManager.getSubscription();
  } catch (err) {
    console.warn('[PushNotificationManager] Erreur récupération subscription:', err);
    return null;
  }
}

/**
 * Interroge le serveur pour connaître l'état de la configuration Web Push
 */
export async function fetchPushBackendStatus(): Promise<PushBackendStatus> {
  try {
    const res = await fetch('/api/push/status', { credentials: 'include' });
    if (!res.ok) {
      return { available: false, hasVapid: false, publicKey: null };
    }
    return await res.json();
  } catch (e) {
    console.warn('[PushNotificationManager] Échec statut push serveur:', e);
    return { available: false, hasVapid: false, publicKey: null };
  }
}

/**
 * Abonne le client aux notifications Web Push et enregistre l'abonnement sur le serveur
 */
export async function subscribeToWebPush(vapidPublicKey?: string): Promise<{ success: boolean; subscription?: PushSubscription; error?: string }> {
  if (!isPushSupported()) {
    return { success: false, error: 'Web Push non supporté sur ce navigateur' };
  }

  try {
    // 1. Demander la permission notification si nécessaire
    if (Notification.permission !== 'granted') {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        return { success: false, error: 'Permission notifications refusée' };
      }
    }

    const reg = await navigator.serviceWorker.ready;

    // 2. Si pas de clé VAPID fournie, tenter de la récupérer depuis le serveur
    let key = vapidPublicKey;
    if (!key) {
      const status = await fetchPushBackendStatus();
      if (status.hasVapid && status.publicKey) {
        key = status.publicKey;
      }
    }

    if (!key) {
      return { success: false, error: 'Clé VAPID non disponible sur le serveur.' };
    }

    const subscribeOptions: PushSubscriptionOptionsInit = {
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key).buffer as ArrayBuffer
    };

    const subscription = await reg.pushManager.subscribe(subscribeOptions);

    // 3. Envoyer l'abonnement au serveur
    const res = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ subscription })
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { success: false, error: data.error || 'Erreur enregistrement serveur' };
    }

    return { success: true, subscription };
  } catch (err: any) {
    console.warn('[PushNotificationManager] Erreur lors de l\'abonnement Push:', err);
    return { success: false, error: err.message || 'Échec abonnement push' };
  }
}

/**
 * Désabonne le client des notifications Web Push
 */
export async function unsubscribeFromWebPush(): Promise<boolean> {
  if (!isPushSupported()) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    const subscription = await reg.pushManager.getSubscription();
    if (!subscription) return true;

    // Désabonner du navigateur
    await subscription.unsubscribe();

    // Informer le serveur
    await fetch('/api/push/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ endpoint: subscription.endpoint })
    }).catch(() => {});

    return true;
  } catch (err) {
    console.warn('[PushNotificationManager] Erreur désabonnement Push:', err);
    return false;
  }
}

/**
 * Envoie une notification Push de test via le serveur OpenWLM
 */
export async function sendTestWebPush(): Promise<{ success: boolean; count?: number; error?: string }> {
  try {
    const res = await fetch('/api/push/test', {
      method: 'POST',
      credentials: 'include'
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
      return { success: false, error: data.error || 'Erreur lors de l\'envoi du push de test' };
    }
    return { success: true, count: data.count };
  } catch (err: any) {
    return { success: false, error: err.message || 'Erreur réseau test push' };
  }
}
