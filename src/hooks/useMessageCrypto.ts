import { useCallback, useEffect, useRef } from 'react';
import {
  sealMessage,
  openMessage,
  sanitizeDecryptedPayload,
  type OpenedMessage,
  type SignedEnvelope
} from '../utils/MessageEnvelope';

/**
 * CRYPTOGRAPHIE DES MESSAGES (chiffrement, signature, authentification à la réception)
 *
 * Regroupe les primitives E2EE et l'état associé qui étaient auparavant imbriqués dans
 * le composant `App` :
 * - `sealForContact` : chiffre ET signe une enveloppe v2 pour un contact (jamais non signée).
 * - `authenticateIncoming` : ouvre et authentifie un message entrant (direct ou historique).
 * - `seenMidsRef` : identifiants de messages déjà vus (anti-rejeu de session).
 *
 * Les dépendances externes sont injectées par référence (`myKeysRef`, `getPublicKeyRef`) :
 * le hook ne capture jamais un cache figé, si bien que les handlers socket enregistrés une
 * seule fois lisent toujours la valeur courante.
 */

export interface MyCryptoKeys {
  publicKeyJwk: any;
  privateKeyJwk: any;
  privateKey?: CryptoKey;
  signingKey?: CryptoKey | null;
}

export type GetPublicKeyFn = (
  contactId: number,
  forceRefresh?: boolean
) => Promise<JsonWebKey | null | undefined>;

export interface UseMessageCryptoOptions {
  /** Référence toujours à jour vers les clés de l'utilisateur courant. */
  myKeysRef: { current: MyCryptoKeys | null };
  /** Référence toujours à jour vers le résolveur de clé publique d'un contact. */
  getPublicKeyRef: { current: GetPublicKeyFn };
  /** Identifiant de l'utilisateur courant (undefined tant que non connecté). */
  userId: number | undefined;
  /** Message d'erreur levé lorsque la clé de signature est absente (i18n). */
  signingKeyMissingMessage: string;
}

export interface MessageCryptoApi {
  seenMidsRef: { current: Set<string> };
  authenticateIncoming: (
    rawText: unknown,
    senderId: number,
    receiverId: number,
    myId: number,
    serverTimestamp?: number
  ) => Promise<OpenedMessage>;
  sealForContact: (
    payload: unknown,
    contactId: number,
    contactPubKey: JsonWebKey,
    mid?: string
  ) => Promise<SignedEnvelope>;
}

const legacySignedContactsKey = (uid: number) => `wlm_signed_contacts_${uid}`;

export function useMessageCrypto({
  myKeysRef,
  getPublicKeyRef,
  userId,
  signingKeyMissingMessage
}: UseMessageCryptoOptions): MessageCryptoApi {
  // Identifiants de messages déjà vus (anti-rejeu) pour cette session.
  const seenMidsRef = useRef<Set<string>>(new Set());
  // Dernier rafraîchissement forcé de clé publique par contact (borne les requêtes si
  // beaucoup de messages invalides arrivent, ex. historique falsifié par le serveur).
  const keyRefreshAtRef = useRef<Map<number, number>>(new Map());
  // Les messages non signés étant désormais refusés, la liste « contacts qui signent »
  // (anti-rétrogradation) n'a plus d'usage : on purge l'ancienne entrée locale.
  useEffect(() => {
    if (!userId) return;
    try { localStorage.removeItem(legacySignedContactsKey(userId)); } catch { /* ignore */ }
  }, [userId]);

  const authenticateIncoming = useCallback(async (
    rawText: unknown, senderId: number, receiverId: number, myId: number, serverTimestamp?: number
  ): Promise<OpenedMessage> => {
    const keys = myKeysRef.current;
    if (!keys) return { status: 'undecryptable', payload: null };
    const isSelf = senderId === myId;
    const resolveKey = async (force: boolean): Promise<JsonWebKey | null> =>
      isSelf ? keys.publicKeyJwk : ((await getPublicKeyRef.current(senderId, force)) ?? null);
    const ctx = {
      serverSenderId: senderId, serverReceiverId: receiverId, myId, myPrivateKey: keys.privateKeyJwk,
      serverTimestamp: Number.isFinite(serverTimestamp) ? serverTimestamp : undefined
    };

    let opened = await openMessage(rawText, { ...ctx, senderPublicKeyJwk: await resolveKey(false) });
    if (!isSelf && (opened.status === 'invalid' || opened.status === 'unverifiable')) {
      const last = keyRefreshAtRef.current.get(senderId) ?? 0;
      if (Date.now() - last > 30_000) {
        keyRefreshAtRef.current.set(senderId, Date.now());
        const fresh = await resolveKey(true);
        if (fresh) opened = await openMessage(rawText, { ...ctx, senderPublicKeyJwk: fresh });
      }
    }
    if (opened.payload) opened = { ...opened, payload: sanitizeDecryptedPayload(opened.payload) };
    return opened;
  }, [myKeysRef, getPublicKeyRef]);

  /**
   * Chiffre ET signe un payload pour un contact (enveloppe v2).
   * Échoue si la clé de signature est absente : on n'envoie jamais de message non signé.
   */
  const sealForContact = useCallback(async (
    payload: unknown, contactId: number, contactPubKey: JsonWebKey, mid?: string
  ): Promise<SignedEnvelope> => {
    const keys = myKeysRef.current;
    if (!keys?.signingKey || !userId) {
      throw new Error(signingKeyMissingMessage);
    }
    return sealMessage(payload, {
      from: Number(userId),
      to: Number(contactId),
      receiverPublicKeyJwk: contactPubKey,
      senderPublicKeyJwk: keys.publicKeyJwk,
      signingKey: keys.signingKey,
      mid
    });
  }, [myKeysRef, userId, signingKeyMissingMessage]);

  return {
    seenMidsRef,
    authenticateIncoming,
    sealForContact
  };
}
