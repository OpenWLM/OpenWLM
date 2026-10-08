/**
 * ConversationBackgrounds.ts - OpenWLM
 * Gestion de la persistance locale des arrière-plans de conversation par contact/conversation.
 */

export const CONV_BACKGROUNDS_STORAGE_KEY = 'wlm_conversation_backgrounds';

export type ConversationBackgroundMap = Record<number, string>;

/**
 * Charge de manière robuste les fonds d'écran depuis le stockage local.
 * Résilient aux clés manquantes, corrompues ou mal typées.
 */
export function loadConversationBackgrounds(storage: Storage = localStorage): ConversationBackgroundMap {
  try {
    const raw = storage.getItem(CONV_BACKGROUNDS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const clean: ConversationBackgroundMap = {};
    for (const [key, val] of Object.entries(parsed)) {
      const id = parseInt(key, 10);
      if (!isNaN(id) && typeof val === 'string' && val.trim() !== '') {
        clean[id] = val.trim();
      }
    }
    return clean;
  } catch {
    return {};
  }
}

/**
 * Sauvegarde la carte des fonds d'écran dans le stockage local.
 */
export function saveConversationBackgrounds(
  map: ConversationBackgroundMap,
  storage: Storage = localStorage
): void {
  try {
    storage.setItem(CONV_BACKGROUNDS_STORAGE_KEY, JSON.stringify(map));
  } catch (err) {
    console.error('Erreur lors de la sauvegarde locale des arrière-plans de conversation:', err);
  }
}

/**
 * Définit ou réinitialise le fond d'écran pour une conversation spécifique.
 * Si bgFile est vide ('') ou absent, la préférence personnalisée est supprimée (retour au fond par défaut).
 */
export function setConversationBackground(
  prevMap: ConversationBackgroundMap,
  chatId: number,
  bgFile: string,
  storage: Storage = localStorage
): ConversationBackgroundMap {
  if (!chatId) return prevMap;
  const next = { ...prevMap };
  if (!bgFile || bgFile.trim() === '') {
    delete next[chatId];
  } else {
    next[chatId] = bgFile.trim();
  }
  saveConversationBackgrounds(next, storage);
  return next;
}

/**
 * Supprime le fond enregistré pour un contact supprimé.
 */
export function removeConversationBackground(
  prevMap: ConversationBackgroundMap,
  chatId: number,
  storage: Storage = localStorage
): ConversationBackgroundMap {
  if (!chatId || !prevMap[chatId]) return prevMap;
  const next = { ...prevMap };
  delete next[chatId];
  saveConversationBackgrounds(next, storage);
  return next;
}
