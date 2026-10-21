import { db } from '../db.js';

/**
 * Appareils joignables par Push d'un compte : abonnements Web Push (navigateurs) et jetons FCM
 * (app Android). Ils doivent disparaître avec les sessions qu'ils servaient : un appareil
 * déconnecté ne doit plus recevoir le nom des expéditeurs ni la sonnerie des appels.
 */

/** Cible Push de l'appareil courant à garder (corps de la requête, valeurs bornées). */
export const keptPushTargets = (body) => {
  const { keepPushEndpoint, keepFcmToken } = body || {};
  return {
    keepEndpoint: typeof keepPushEndpoint === 'string' && keepPushEndpoint.length <= 2048 ? keepPushEndpoint : null,
    keepToken: typeof keepFcmToken === 'string' && keepFcmToken.length <= 4096 ? keepFcmToken : null
  };
};

/**
 * Supprime les abonnements Web Push et jetons FCM du compte, sauf ceux de l'appareil courant
 * (`keepEndpoint`, `keepToken`). Renvoie le nombre de cibles supprimées. À appeler dans la
 * même transaction que la révocation des sessions.
 */
export const removePushTargets = (userId, { keepEndpoint = null, keepToken = null } = {}) => {
  let removed = keepEndpoint
    ? db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint != ?').run(userId, keepEndpoint).changes
    : db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId).changes;
  removed += keepToken
    ? db.prepare('DELETE FROM fcm_tokens WHERE user_id = ? AND token != ?').run(userId, keepToken).changes
    : db.prepare('DELETE FROM fcm_tokens WHERE user_id = ?').run(userId).changes;
  return removed;
};
