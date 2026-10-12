/**
 * Fenêtre glissante simple (compteur par clé — typiquement l'id utilisateur).
 *
 * Règle importante : le NETTOYAGE périodique doit utiliser la MÊME fenêtre que la
 * vérification, sinon des événements encore pertinents sont supprimés et la limite
 * devient plus permissive que ce qu'elle annonce.
 */

/**
 * Enregistre un événement pour `key` si la limite `max` sur `windowMs` n'est pas atteinte.
 * @returns {boolean} true si l'action est autorisée (et enregistrée), false si bloquée.
 */
export const isAllowed = (map, key, max, windowMs, now = Date.now()) => {
  const fresh = (map.get(key) || []).filter((t) => now - t < windowMs);
  if (fresh.length >= max) {
    map.set(key, fresh);
    return false;
  }
  fresh.push(now);
  map.set(key, fresh);
  return true;
};

/**
 * Purge les entrées plus anciennes que `windowMs` (et supprime les clés vides).
 */
export const cleanupWindow = (map, windowMs, now = Date.now()) => {
  for (const [key, timestamps] of map.entries()) {
    const active = timestamps.filter((t) => now - t < windowMs);
    if (active.length === 0) map.delete(key);
    else map.set(key, active);
  }
};
