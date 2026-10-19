import type { FileDataPayload } from './components/FileTransferCard';
import type { EnvelopeStatus } from './utils/MessageEnvelope';

/**
 * TYPES DE DOMAINE PARTAGÉS
 *
 * Regroupe les interfaces qui étaient définies directement dans `App.tsx` et qui sont
 * désormais consommées par plusieurs modules (hooks d'extraction, composants). Les éviter
 * dans `App.tsx` permet aux hooks de les importer sans créer de dépendance circulaire.
 */

export interface CustomEmoticonPayload {
  assetId: string;
  key: string;       // Clé AES-GCM 256 en base64
  mime: string;      // image/png, image/gif, etc.
  width?: number;
  height?: number;
  animated?: number | boolean;
}

export interface User {
  id: number;
  username: string;
  nickname?: string;
  psm?: string;
  avatar?: string;
  scene?: string;
  status?: string;
  token?: string;
  encrypted_private_key?: string;
  public_key?: string;
  global_private?: number;
  rememberMe?: boolean;
}

export interface Contact {
  id: number;
  username: string;
  nickname?: string;
  psm?: string;
  avatar?: string;
  scene?: string;
  status: string;
  blocked: number | boolean;
  global_private?: number;
  /** Ma préférence « conversation privée » envers ce contact (état serveur). */
  my_private?: number;
  /** Préférence « conversation privée » du contact envers moi (état serveur). */
  their_private?: number;
  isBot?: boolean;
}

export interface Message {
  id?: number | string;
  sender_id?: number;
  receiver_id?: number;
  senderId?: number;
  receiverId?: number;
  sender: string;
  text: string;
  time?: string;
  timestamp?: string | number;
  style?: any;
  audio?: string | null;
  type?: string;
  isWink?: boolean;
  /** Clin d'œil reçu non joué automatiquement : identifiant pour le bouton « Voir ». */
  winkId?: string;
  _isPending?: boolean;
  clientMsgId?: string;
  fileData?: FileDataPayload;
  customEmoticons?: Record<string, CustomEmoticonPayload>;
  delivery_status?: 'sent' | 'delivered' | 'read';
  isPrivate?: boolean;
  /** Verdict d'authenticité de l'enveloppe signée (cf. utils/MessageEnvelope). */
  _auth?: EnvelopeStatus;
  /** Identifiant aléatoire signé par l'émetteur (détection des rejeux). */
  mid?: string;
  /** Échec d'envoi : le message n'a pas été accepté par le serveur. */
  _failed?: 'offline_private' | 'too_large' | 'error';
  /** Détail renvoyé par le serveur, le cas échéant. */
  _failReason?: string;
  /** Message d'action envoyé avec /me (« * Pseudo texte »). */
  action?: boolean;
  /** Ligne système locale (mode privé, Wizz, clin d'œil…) : texte déjà traduit, jamais envoyée ni stockée sur le serveur. */
  system?: boolean;
}

/** Identifiant réservé du bot de test WLM (l'assistant local). */
export const SYSTEM_BOT_ID = -1;

/** Contact statique de l'assistant OpenWLM (service 100 % local, hors réseau). */
export const SYSTEM_BOT_CONTACT: Contact = {
  id: SYSTEM_BOT_ID,
  username: 'openwlm',
  nickname: 'OpenWLM',
  psm: 'En ligne pour vos tests',
  status: 'online',
  avatar: '/assets/usertiles/robot.png',
  scene: '/assets/scenes/0002.jpg',
  blocked: 0,
  isBot: true
};
