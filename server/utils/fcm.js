import fs from 'fs';

/**
 * Notifications de l'app Android via Firebase Cloud Messaging (docs/ANDROID.md).
 *
 * Même contenu que le Web Push : jamais le texte d'un message ni l'offre d'un appel, seulement
 * le nom de l'expéditeur et une clé de traduction (`l10n`) que l'app traduit dans sa langue.
 * Messages FCM « data » uniquement : c'est l'app qui construit la notification (texte traduit,
 * sonnerie des appels, actions Répondre / Refuser).
 *
 * Configuration : FIREBASE_SERVICE_ACCOUNT = chemin du JSON de la clé de compte de service,
 * hors dépôt. Sans elle (ou si elle est invalide), FCM est désactivé et le serveur démarre
 * normalement.
 */

/** Format d'un jeton d'enregistrement FCM (caractères base64url et « : »). */
export const isValidFcmToken = (token) =>
  typeof token === 'string' && token.length >= 20 && token.length <= 4096 && /^[A-Za-z0-9_:.-]+$/.test(token);

/** Erreurs FCM qui signifient que le jeton n'est plus valable (app désinstallée, jeton renouvelé). */
const STALE_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token'
]);

/**
 * Message FCM « data » (valeurs chaînes uniquement) pour une charge utile de
 * dispatchPushNotification. `options` : { TTL (s), urgency } comme pour le Web Push.
 */
export const toFcmMessage = (token, payload, options = {}) => {
  const p = payload && typeof payload === 'object' ? payload : { body: String(payload ?? '') };
  const nested = p.data && typeof p.data === 'object' ? p.data : {};
  const fields = {
    type: p.type ?? nested.type ?? 'message',
    title: p.title,
    body: p.body,
    l10n: p.l10n,
    reason: p.reason,
    tag: p.tag,
    senderId: p.senderId ?? nested.senderId,
    callerId: nested.callerId,
    expiresAt: nested.expiresAt,
    url: p.url ?? nested.url
  };
  const data = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null && value !== '') data[key] = String(value);
  }
  const ttlS = Number.isInteger(options.TTL) ? options.TTL : 86400;
  return {
    token,
    data,
    android: {
      // Haute priorité : réveille un téléphone en veille (Doze). Réservée à ce qui affiche une
      // notification ; la fin d'un appel (urgency « normal ») n'en a pas besoin.
      priority: options.urgency === 'normal' ? 'normal' : 'high',
      ttl: ttlS * 1000
    }
  };
};

/**
 * Envoi FCM à tous les appareils Android d'un utilisateur.
 * `getMessaging()` : client firebase-admin (ou null si FCM désactivé) ;
 * `listTokens(userId)` / `deleteToken(token)` : accès aux jetons enregistrés.
 */
export const createFcmDispatcher = ({ getMessaging, listTokens, deleteToken, log = console }) =>
  async (receiverId, payload, options = {}) => {
    const messaging = await getMessaging();
    if (!messaging) return { sent: 0, failed: 0, reason: 'fcm_not_configured' };
    const tokens = listTokens(receiverId);
    if (tokens.length === 0) return { sent: 0, failed: 0 };

    let sent = 0;
    let failed = 0;
    await Promise.all(tokens.map(async (token) => {
      try {
        await messaging.send(toFcmMessage(token, payload, options));
        sent++;
      } catch (err) {
        failed++;
        if (STALE_TOKEN_CODES.has(err?.code)) {
          try { deleteToken(token); } catch { /* ignore */ }
          log.log(`[FCM] Jeton expiré supprimé (${err.code}) : ${token.slice(0, 12)}...`);
        } else {
          log.warn(`[FCM] Échec d'envoi (${err?.code || err?.message}) vers ${token.slice(0, 12)}...`);
        }
      }
    }));
    return { sent, failed };
  };

let messagingPromise = null;

/**
 * Client FCM (firebase-admin), initialisé au premier envoi. null si FIREBASE_SERVICE_ACCOUNT
 * est absent ou invalide : le serveur continue sans FCM.
 */
export const getFcmMessaging = () => {
  if (!messagingPromise) {
    messagingPromise = (async () => {
      const keyPath = (process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
      if (!keyPath) {
        console.log('[FCM] FIREBASE_SERVICE_ACCOUNT non configuré. Notifications de l\'app Android désactivées.');
        return null;
      }
      try {
        const serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
        const { initializeApp, cert } = await import('firebase-admin/app');
        const { getMessaging } = await import('firebase-admin/messaging');
        const app = initializeApp({ credential: cert(serviceAccount) }, 'openwlm-fcm');
        console.log(`[FCM] Configuré (projet ${serviceAccount.project_id}). Notifications de l'app Android actives.`);
        return getMessaging(app);
      } catch (err) {
        console.warn(`[FCM] Configuration invalide (${err.message}). Notifications de l'app Android désactivées.`);
        return null;
      }
    })();
  }
  return messagingPromise;
};

/** FCM configuré ? (même règle que getFcmMessaging, sans initialiser firebase-admin) */
export const isFcmConfigured = () => {
  const keyPath = (process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  return Boolean(keyPath) && fs.existsSync(keyPath);
};
