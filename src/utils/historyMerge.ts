import type { Message } from '../types';
import { isSystemLine } from './systemLine';

/**
 * FUSION DE L'HISTORIQUE SERVEUR AVEC CE QUI N'EXISTE QUE SUR L'APPAREIL
 *
 * Au chargement complet d'une conversation, l'historique du serveur fait foi pour les messages
 * normaux. Mais certains messages n'existent que localement et ne doivent pas disparaître :
 * - les messages en MODE PRIVÉ (jamais stockés par le serveur) ;
 * - les lignes système (Wizz, clins d'œil, mode privé…) ;
 * - les messages en cours d'envoi ou « Non envoyé ».
 * Avant, la liste était remplacée par l'historique serveur : un message privé reçu dans un
 * onglet qui venait de s'ouvrir disparaissait aussitôt (le son jouait, rien ne s'affichait), et
 * les messages privés ne survivaient jamais à un rechargement.
 */

/** Message à conserver même s'il est absent de l'historique du serveur. */
export const isLocalOnly = (m: Message): boolean =>
  m.isPrivate === true || isSystemLine(m) || !!m._isPending || !!m._failed || (!m.id && !m.mid);

const timeOf = (m: Message): number | null => {
  const t = typeof m.timestamp === 'number' ? m.timestamp : m.timestamp ? Date.parse(m.timestamp) : NaN;
  return Number.isFinite(t) ? t : null;
};

/**
 * Renvoie l'historique fusionné, trié chronologiquement. Les éléments locaux sans horodatage
 * (lignes système) gardent leur place relative : ils héritent de l'heure du message qui les
 * précédait dans la liste affichée.
 */
export const mergeServerHistory = (current: Message[], server: Message[], keepSince?: number): Message[] => {
  const serverIds = new Set(server.map((m) => m.id).filter(Boolean));
  const serverMids = new Set(server.map((m) => m.mid).filter(Boolean));
  const serverClientIds = new Set(server.map((m) => m.clientMsgId).filter(Boolean));
  const inServer = (m: Message) =>
    (!!m.id && serverIds.has(m.id)) || (!!m.mid && serverMids.has(m.mid)) || (!!m.clientMsgId && serverClientIds.has(m.clientMsgId));

  type Entry = { msg: Message; key: number; seq: number };
  const entries: Entry[] = [];
  let seq = 0;
  server.forEach((m) => entries.push({ msg: m, key: timeOf(m) ?? 0, seq: seq++ }));

  let previousKey = 0;
  current.forEach((m) => {
    const t = timeOf(m);
    if (t !== null) previousKey = t;
    if (inServer(m)) return;
    // Message normal absent de la réponse du serveur : conservé s'il est arrivé en direct
    // pendant le chargement (la requête est partie avant lui), sinon il a été supprimé.
    const receivedMeanwhile = keepSince !== undefined && t !== null && t >= keepSince;
    if (!isLocalOnly(m) && !receivedMeanwhile) return;
    entries.push({ msg: m, key: t ?? previousKey, seq: seq++ });
  });

  return entries.sort((a, b) => a.key - b.key || a.seq - b.seq).map((e) => e.msg);
};

/**
 * Insère des messages (rattrapage après une coupure) à leur place chronologique dans la liste
 * affichée, au lieu de les ajouter en fin de liste après ce qui est arrivé en direct entre-temps.
 */
export const insertByTime = (current: Message[], incoming: Message[]): Message[] => {
  if (incoming.length === 0) return current;
  type Entry = { msg: Message; key: number; seq: number };
  const entries: Entry[] = [];
  let seq = 0;
  let previousKey = 0;
  current.forEach((m) => {
    const t = timeOf(m);
    if (t !== null) previousKey = t;
    entries.push({ msg: m, key: t ?? previousKey, seq: seq++ });
  });
  incoming.forEach((m) => entries.push({ msg: m, key: timeOf(m) ?? Number.MAX_SAFE_INTEGER, seq: seq++ }));
  return entries.sort((a, b) => a.key - b.key || a.seq - b.seq).map((e) => e.msg);
};

/**
 * Liste affichée + messages locaux de la copie lue au préchargement qui n'y sont pas encore
 * (aucun rendu entre le préchargement et la réponse du serveur). Seuls les messages qui
 * n'existent que sur l'appareil comptent : le reste viendra du serveur.
 */
export const withLocalOnly = (current: Message[], cached: Message[]): Message[] => {
  if (cached.length === 0) return current;
  const ids = new Set(current.map((m) => m.id).filter(Boolean));
  const mids = new Set(current.map((m) => m.mid).filter(Boolean));
  const cids = new Set(current.map((m) => m.clientMsgId).filter(Boolean));
  const extra = cached.filter((m) => isLocalOnly(m)
    && !(m.id && ids.has(m.id)) && !(m.mid && mids.has(m.mid)) && !(m.clientMsgId && cids.has(m.clientMsgId)));
  return extra.length ? [...current, ...extra] : current;
};

/** Ce qui va dans la copie locale chiffrée : l'historique, messages privés compris (jamais les lignes système ni les envois en cours). */
export const cacheableHistory = (merged: Message[]): Message[] =>
  merged.filter((m) => !isSystemLine(m) && !m._isPending && !m._failed);
