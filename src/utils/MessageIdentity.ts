/**
 * IDENTITÉ D'EXPÉDITEUR D'UN MESSAGE (E1 — Anti-usurpation à l'affichage)
 *
 * Décision "ce message a-t-il été envoyé par moi ?" basée EXCLUSIVEMENT sur
 * l'identifiant technique authentifié du message (sender_id / senderId) comparé
 * à l'identifiant de l'utilisateur courant.
 *
 * Ne JAMAIS utiliser un champ d'affichage contrôlé par l'expéditeur
 * (nickname, sender, sender_name, senderName, payload E2EE...) pour décider
 * de la propriété d'un message.
 *
 * Si l'identifiant est absent ou invalide, l'état est "unknown" (neutre) :
 * on ne devine jamais l'expéditeur.
 */

export type MessageSide = 'self' | 'other' | 'unknown';

export interface MessageSenderIdentity {
  senderId?: number | string | null;
  sender_id?: number | string | null;
}

/**
 * Convertit une valeur d'identifiant en entier fini, ou null si invalide.
 */
const toValidId = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  return null;
};

/**
 * Résout la position d'un message vis-à-vis de l'utilisateur courant.
 *
 * - 'self'   : le message a été envoyé par l'utilisateur courant.
 * - 'other'  : le message a été envoyé par un autre utilisateur.
 * - 'unknown': identifiant d'expéditeur absent/invalide -> état neutre.
 */
export const resolveMessageSide = (
  message: MessageSenderIdentity | null | undefined,
  currentUserId?: number | string | null
): MessageSide => {
  if (!message || typeof message !== 'object') return 'unknown';

  const rawSenderId =
    message.senderId !== undefined && message.senderId !== null
      ? message.senderId
      : message.sender_id;

  const senderId = toValidId(rawSenderId);
  if (senderId === null) return 'unknown';

  const meId = toValidId(currentUserId);
  if (meId === null) return 'unknown';

  return senderId === meId ? 'self' : 'other';
};

/**
 * Raccourci booléen : true uniquement si le message est formellement identifié
 * comme émis par l'utilisateur courant (jamais pour un état "unknown").
 */
export const isMessageFromSelf = (
  message: MessageSenderIdentity | null | undefined,
  currentUserId?: number | string | null
): boolean => resolveMessageSide(message, currentUserId) === 'self';
