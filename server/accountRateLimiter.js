/**
 * LIMITEUR DE DÉBIT PAR COMPTE (E2)
 *
 * Complète le rate limiting par IP par une limite par identité logique :
 * - login / signup : clé = nom d'utilisateur (normalisé en minuscules),
 * - changement de mot de passe / reset E2E : clé = identifiant utilisateur.
 *
 * Le compteur est réinitialisé sur succès (reset) afin que les opérations
 * légitimes réussies ne consomment pas le quota.
 */
export const createAccountRateLimiter = ({
  windowMs = 60 * 1000,
  limit = 10,
  now = () => Date.now()
} = {}) => {
  const storage = new Map(); // key -> number[] (horodatages)

  const toKey = (rawKey) => {
    if (rawKey === null || rawKey === undefined) return '';
    return String(rawKey).trim().toLowerCase();
  };

  /**
   * Enregistre une tentative pour la clé donnée.
   * @returns {{allowed: boolean, retryAfterMs?: number}}
   */
  const attempt = (rawKey) => {
    const key = toKey(rawKey);
    if (key === '') return { allowed: true };

    const t = now();
    const timestamps = (storage.get(key) || []).filter((ts) => t - ts < windowMs);

    if (timestamps.length >= limit) {
      storage.set(key, timestamps);
      return { allowed: false, retryAfterMs: windowMs - (t - timestamps[0]) };
    }

    timestamps.push(t);
    storage.set(key, timestamps);
    return { allowed: true };
  };

  /**
   * Réinitialise le compteur d'une clé (à appeler après un succès légitime).
   */
  const reset = (rawKey) => {
    storage.delete(toKey(rawKey));
  };

  /**
   * Purge les entrées inactives (appelée par le nettoyage mémoire périodique).
   */
  const cleanup = () => {
    const t = now();
    for (const [key, timestamps] of storage.entries()) {
      const active = timestamps.filter((ts) => t - ts < windowMs);
      if (active.length === 0) {
        storage.delete(key);
      } else {
        storage.set(key, active);
      }
    }
  };

  return { attempt, reset, cleanup, _storage: storage };
};
