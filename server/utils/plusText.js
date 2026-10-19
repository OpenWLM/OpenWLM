/**
 * Mise en forme des pseudos / messages perso ([c=4], [b], ·$4…) côté serveur.
 * Même grammaire que src/utils/plusFormat.tsx : le serveur ne fait que la RETIRER, pour
 * compter la longueur visible (limites 50 / 150 caractères) et pour les textes affichés tels
 * quels par le système (titres des notifications Push).
 */
const COLOR_VALUE = '(#[0-9a-fA-F]{6}|1[0-5]|[0-9])';
const TOKEN_RE = new RegExp(
  `\\[(\\/?)(b|i|u|s)\\]|\\[(c|a)=${COLOR_VALUE}\\]|\\[\\/(c|a)(?:=${COLOR_VALUE})?\\]|·(?:\\$${COLOR_VALUE}|#([0-9a-fA-F]{6})|([biusBIUS0]))`,
  'g'
);

export const stripPlusTags = (text) => (typeof text === 'string' ? text.replace(TOKEN_RE, '') : '');

/** Longueur visible (sans balises). */
export const visibleLength = (text) => stripPlusTags(text).length;

/**
 * Validation d'un champ de profil mis en forme : longueur VISIBLE ≤ max, et longueur brute
 * bornée (balises comprises) pour éviter les abus.
 */
export const isValidFormattedField = (text, maxVisible, maxRaw) =>
  typeof text === 'string' && text.length <= maxRaw && visibleLength(text) <= maxVisible;
