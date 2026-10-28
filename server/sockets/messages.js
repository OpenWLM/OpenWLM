import { stripPlusTags } from '../utils/plusText.js';
import { db, isConversationPrivate } from '../db.js';
import { getUserRoom, isUserOnline } from '../sessionStore.js';
import { canInteract } from '../middleware/auth.js';
import { dispatchPushNotification } from '../routes/push.js';
import { isAllowed } from '../utils/rateWindow.js';

// Compteurs SÉPARÉS (fenêtre 60 s) : les Wizz et les Winks ne doivent pas se voler
// mutuellement leur quota (3 Wizz/min ET 7 Winks/min, indépendants).
export const wizzLimits = new Map();   // Wizz uniquement — 3 / 60 s
export const winkLimits = new Map();   // Winks uniquement — 7 / 60 s
export const messageLimits = new Map(); // Messages — 20 / 10 s
// Accusés (remis / lu) et bascule du mode privé : 60 / 10 s et 10 / 10 s. Sans limite, un
// contact pouvait déclencher en boucle des lectures/écritures SQLite et des événements chez
// l'autre (mode privé qui clignote).
export const ackLimits = new Map();
export const privateToggleLimits = new Map();
// Volume persisté par expéditeur : 24 Mo glissants sur 10 min (≈ 30 messages vocaux de 90 s).
// Les messages ne sont ni purgés ni soumis à quota : sans cette borne, deux comptes
// complices remplissaient le disque à ~1 Mo par message.
export const messageByteLimits = new Map();
export const MESSAGE_BYTES_WINDOW_MS = 10 * 60 * 1000;
export const MESSAGE_BYTES_MAX = (process.env.NODE_ENV === 'test' && Number(process.env.OPENWLM_TEST_MESSAGE_BYTES_MAX) > 0)
  ? Number(process.env.OPENWLM_TEST_MESSAGE_BYTES_MAX) // serveur de test uniquement
  : 24 * 1024 * 1024;
// Tailles par message : une enveloppe de texte ou de fichier tient en quelques Ko ; seul un
// message vocal (90 s, base64 dans l'enveloppe) approche la trame socket de 1 Mo.
// Quota de stockage persisté par expéditeur (texte + audio) : au-delà, les nouveaux messages
// sont refusés (code 'storage_quota') jusqu'à ce que l'utilisateur efface des conversations.
// Le volume est relu en base au plus toutes les 60 s, puis tenu à jour à chaque insertion.
export const SENDER_STORAGE_QUOTA = (process.env.NODE_ENV === 'test' && Number(process.env.OPENWLM_TEST_SENDER_STORAGE_QUOTA) > 0)
  ? Number(process.env.OPENWLM_TEST_SENDER_STORAGE_QUOTA)
  : 512 * 1024 * 1024;
const senderStorage = new Map(); // senderId -> { bytes, at }
const senderStoredBytes = (senderId, now = Date.now()) => {
  const cached = senderStorage.get(senderId);
  if (cached && now - cached.at < 60000) return cached.bytes;
  const row = db.prepare("SELECT COALESCE(SUM(LENGTH(text)) + SUM(LENGTH(COALESCE(audio, ''))), 0) AS bytes FROM messages WHERE sender_id = ?").get(senderId);
  const bytes = Number(row?.bytes) || 0;
  senderStorage.set(senderId, { bytes, at: now });
  return bytes;
};
const noteStored = (senderId, bytes) => {
  const cached = senderStorage.get(senderId);
  if (cached) cached.bytes += bytes;
};
export const cleanupSenderStorage = (now = Date.now()) => {
  for (const [key, entry] of senderStorage.entries()) {
    if (now - entry.at > 10 * 60 * 1000) senderStorage.delete(key);
  }
};
export const MAX_TEXT_CHARS = 64 * 1024;
export const MAX_AUDIO_CHARS = 900 * 1024;
export const MAX_MID_CHARS = 64;
const MESSAGE_TYPES = new Set(['text', 'audio', 'file']);

const asId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** Budget de volume glissant par expéditeur (octets persistés). */
const byteBudgetAllows = (senderId, bytes, now = Date.now()) => {
  const fresh = (messageByteLimits.get(senderId) || []).filter((e) => now - e.t < MESSAGE_BYTES_WINDOW_MS);
  const used = fresh.reduce((sum, e) => sum + e.n, 0);
  if (used + bytes > MESSAGE_BYTES_MAX) { messageByteLimits.set(senderId, fresh); return false; }
  fresh.push({ t: now, n: bytes });
  messageByteLimits.set(senderId, fresh);
  return true;
};
export const cleanupByteBudget = (now = Date.now()) => {
  for (const [key, entries] of messageByteLimits.entries()) {
    const fresh = entries.filter((e) => now - e.t < MESSAGE_BYTES_WINDOW_MS);
    if (fresh.length === 0) messageByteLimits.delete(key);
    else messageByteLimits.set(key, fresh);
  }
};

/** Style d'affichage : objet plat de quelques clés courtes (couleur, police, gras…), sinon null. */
const sanitizeStyle = (style) => {
  if (!style || typeof style !== 'object' || Array.isArray(style)) return null;
  const out = {};
  let count = 0;
  for (const [k, v] of Object.entries(style)) {
    if (++count > 12) return null;
    if (k.length > 32) return null;
    if (typeof v === 'string') { if (v.length > 64) return null; out[k] = v; }
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else return null;
  }
  return out;
};

// Compteur d'ids temporaires pour les messages privés (évite les collisions Date.now() à la même ms)
let privateMsgSeq = 0;

export const registerMessageHandlers = (io, socket) => {
  /**
   * Envoi d'un message
   */
  socket.on('send_message', (data, callback) => {
    // `isPrivate` éventuellement fourni par le client est volontairement IGNORÉ :
    // le serveur calcule seul le mode privé effectif à partir de l'état persisté.
    const { senderId, text, audio } = data || {};
    const receiverId = asId(data?.receiverId);
    
    if (socket.user.id !== senderId || !receiverId) {
      if (typeof callback === 'function') callback({ success: false, error: "Non autorisé." });
      return;
    }
    // Champs libres bornés : type sur liste blanche, style de forme attendue
    const type = MESSAGE_TYPES.has(data?.type) ? data.type : 'text';
    const style = sanitizeStyle(data?.style);
    if ((text !== undefined && text !== null && typeof text !== 'string') || (audio !== undefined && audio !== null && typeof audio !== 'string')) {
      if (typeof callback === 'function') callback({ success: false, error: "Message invalide." });
      return;
    }

    const check = canInteract(senderId, receiverId);
    if (!check.allowed) {
      console.warn(`[Security Alert] Tentative d'envoi non autorisée de ${senderId} vers ${receiverId}: ${check.reason}`);
      if (typeof callback === 'function') callback({ success: false, error: check.reason });
      return;
    }

    // 20 messages / 10 s
    if (!isAllowed(messageLimits, senderId, 20, 10000)) {
      if (typeof callback === 'function') callback({ success: false, error: "Trop de messages envoyés." });
      return;
    }

    const sender = db.prepare('SELECT id, username, nickname FROM users WHERE id = ?').get(senderId);
    const finalIsPrivate = isConversationPrivate(senderId, receiverId);
    const senderDisplayName = sender ? (sender.nickname || sender.username) : null;

    // Enveloppe v2 : on extrait le `mid` (identifiant aléatoire signé) pour rendre
    // l'écriture idempotente. Le renvoi d'un message « Non envoyé » réutilise ce mid.
    let envelopeMid = null;
    if (typeof text === 'string') {
      try {
        const parsed = JSON.parse(text);
        if (parsed && parsed.v === 2 && typeof parsed.mid === 'string' && parsed.mid.length > 0) {
          if (parsed.mid.length > MAX_MID_CHARS) {
            if (typeof callback === 'function') callback({ success: false, error: "Message invalide." });
            return;
          }
          envelopeMid = parsed.mid;
        }
      } catch (_) { /* texte non-JSON : pas de mid */ }
    }

    // MODE PRIVÉ : rien n'est conservé côté serveur. Si le destinataire n'a aucune session
    // connectée, le message serait perdu : on le REFUSE explicitement (au lieu de répondre
    // « succès ») pour que le client affiche « Non envoyé » et propose de renvoyer.
    if (finalIsPrivate && !isUserOnline(receiverId)) {
      if (typeof callback === 'function') {
        callback({
          success: false,
          code: 'RECIPIENT_OFFLINE_PRIVATE',
          error: "Mode privé : le contact est hors ligne et les messages privés ne sont pas conservés."
        });
      }
      return;
    }

    // DÉDUPLICATION DU RENVOI : si ce mid a déjà été persisté pour cet émetteur, le
    // message a déjà été accepté (l'accusé s'est simplement perdu). On répond « succès »
    // avec l'id existant, SANS rediffuser ni re-notifier, pour ne pas créer de doublon.
    if (!finalIsPrivate && envelopeMid) {
      try {
        const existing = db.prepare('SELECT id, timestamp FROM messages WHERE sender_id = ? AND mid = ?').get(senderId, envelopeMid);
        if (existing) {
          if (typeof callback === 'function') {
            callback({ success: true, id: existing.id, timestamp: existing.timestamp, isPrivate: false, duplicate: true });
          }
          return;
        }
      } catch (err) {
        console.error("Erreur vérification doublon (mid):", err);
      }
    }

    // Un message vocal (type 'audio') voyage dans l'enveloppe chiffrée (champ text) ; tout le
    // reste tient en quelques Ko. Le champ `audio` hors enveloppe (ancien format) est borné pareil.
    const textLimit = type === 'audio' ? MAX_AUDIO_CHARS : MAX_TEXT_CHARS;
    if (text && text.length > textLimit) {
      if (typeof callback === 'function') callback({ success: false, error: "Message trop volumineux.", code: 'too_large' });
      return;
    }
    if (audio && audio.length > MAX_AUDIO_CHARS) {
      if (typeof callback === 'function') callback({ success: false, error: "Audio trop volumineux.", code: 'too_large' });
      return;
    }
    const messageBytes = (text ? text.length : 0) + (audio ? audio.length : 0);
    if (!finalIsPrivate && !byteBudgetAllows(senderId, messageBytes)) {
      if (typeof callback === 'function') callback({ success: false, error: "Volume de messages trop important, réessayez plus tard.", code: 'quota' });
      return;
    }
    if (!finalIsPrivate && senderStoredBytes(senderId) + messageBytes > SENDER_STORAGE_QUOTA) {
      if (typeof callback === 'function') callback({ success: false, error: "Espace de stockage de vos messages épuisé : effacez d'anciennes conversations.", code: 'storage_quota' });
      return;
    }
    
    const nowIso = new Date().toISOString();
    let messageToDeliver = {
      senderId,
      sender_id: senderId,
      receiverId,
      receiver_id: receiverId,
      sender: senderDisplayName,
      sender_name: senderDisplayName,
      text,
      style,
      audio,
      type,
      isPrivate: !!finalIsPrivate,
      timestamp: nowIso
    };

    if (!finalIsPrivate) {
      try {
        const stmt = db.prepare(`
          INSERT INTO messages (sender_id, receiver_id, text, style, audio, type, delivery_status, timestamp, mid) 
          VALUES (?, ?, ?, ?, ?, ?, 'sent', ?, ?)
        `);
        const info = stmt.run(senderId, receiverId, text, JSON.stringify(style), audio, type || 'text', nowIso, envelopeMid);
        noteStored(senderId, messageBytes);
        messageToDeliver.id = info.lastInsertRowid;
        messageToDeliver.delivery_status = 'sent';
      } catch (err) {
        // Course concurrente : deux renvois du même mid ont tenté l'insertion en même temps.
        // L'index unique (sender_id, mid) fait échouer le second : on le traite comme un doublon.
        if (envelopeMid && /UNIQUE|constraint/i.test(String(err?.code || err?.message || ''))) {
          const existing = db.prepare('SELECT id, timestamp FROM messages WHERE sender_id = ? AND mid = ?').get(senderId, envelopeMid);
          if (existing) {
            if (typeof callback === 'function') {
              callback({ success: true, id: existing.id, timestamp: existing.timestamp, isPrivate: false, duplicate: true });
            }
            return;
          }
        }
        console.error("Erreur insertion BDD message:", err);
        // SÉCURITÉ/FIABILITÉ : ne pas présenter un échec de persistance comme un succès
        if (typeof callback === 'function') callback({ success: false, error: "Échec de l'enregistrement du message." });
        return;
      }
    } else {
      messageToDeliver.isPrivate = true;
      messageToDeliver.delivery_status = 'sent';
      messageToDeliver.id = Date.now() * 1000 + (privateMsgSeq++ % 1000); // ID temporaire unique (non persisté)
    }

    io.to(getUserRoom(receiverId)).emit('receive_message', messageToDeliver);
    socket.to(getUserRoom(senderId)).emit('receive_message', messageToDeliver);

    const pushSenderName = sender ? (stripPlusTags(sender.nickname) || sender.username) : 'Contact';
    // `l10n` : clé traduite par le service worker dans la langue de l'app (le serveur ne la
    // connaît pas) ; `body` reste le texte de repli (ancien service worker)
    let pushBody = 'Nouveau message reçu';
    let pushKey = 'message';
    if (finalIsPrivate) {
      pushBody = '🔒 Nouveau message privé'; pushKey = 'privateMessage';
    } else if (type === 'audio') {
      pushBody = '🎤 Message vocal'; pushKey = 'voice';
    } else if (type === 'file') {
      pushBody = '📎 Fichier partagé'; pushKey = 'file';
    } else if (text) {
      try {
        const parsed = JSON.parse(text);
        if (parsed.keyReceiver || parsed.keySender) {
          pushBody = '🔐 Message chiffré (E2EE)'; pushKey = 'encrypted';
        }
      } catch (_) {}
    }

    dispatchPushNotification(receiverId, {
      title: `${pushSenderName} - OpenWLM`,
      body: pushBody,
      l10n: pushKey,
      senderId: senderId,
      url: `/?chat=${senderId}`,
      tag: `openwlm-chat-${senderId}`
    });

    if (typeof callback === 'function') {
      callback({ success: true, id: messageToDeliver.id, timestamp: messageToDeliver.timestamp, isPrivate: !!finalIsPrivate });
    }
  });

  /**
   * Accusé de réception (message_delivered)
   */
  socket.on('message_delivered', (data) => {
    const { messageId, senderId } = data || {};
    const recipientId = socket.user.id;
    const sId = Number(senderId);
    const mId = Number(messageId);
    if (!mId || !sId) return;
    if (!isAllowed(ackLimits, recipientId, 60, 10000)) return;

    const check = canInteract(sId, recipientId);
    if (!check.allowed) return;

    // Le mode privé est décidé par l'état persisté, jamais par le drapeau du client (sinon un
    // faux « remis » pour n'importe quel id contournait la vérification d'existence).
    const isPrivate = isConversationPrivate(sId, recipientId);
    if (!isPrivate) {
      try {
        // SÉCURITÉ : n'accuser que des messages réellement existants et destinés à ce destinataire
        const exists = db.prepare('SELECT 1 FROM messages WHERE id = ? AND sender_id = ? AND receiver_id = ?').get(mId, sId, recipientId);
        if (!exists) return;
        db.prepare(`
          UPDATE messages 
          SET delivery_status = 'delivered' 
          WHERE id = ? AND sender_id = ? AND receiver_id = ? AND delivery_status = 'sent'
        `).run(mId, sId, recipientId);
      } catch (err) {
        console.error("Erreur mise à jour message_delivered:", err);
        return;
      }
    }

    io.to(getUserRoom(sId)).emit('message_status_updated', {
      contactId: recipientId,
      messageId: mId,
      status: 'delivered',
      isPrivate: !!isPrivate
    });

    socket.to(getUserRoom(recipientId)).emit('message_status_updated', {
      contactId: sId,
      messageId: mId,
      status: 'delivered',
      isPrivate: !!isPrivate
    });
  });

  /**
   * Curseur et statut de lecture (message_read)
   */
  socket.on('message_read', (data) => {
    const { contactId, lastReadMessageId } = data || {};
    const readerId = socket.user.id;
    const cId = Number(contactId);
    const rawLastId = Number(lastReadMessageId) || 0;

    if (!cId || cId === readerId) return;
    if (!isAllowed(ackLimits, readerId, 60, 10000)) return;
    const isPrivate = isConversationPrivate(cId, readerId);

    const check = canInteract(readerId, cId);
    if (!check.allowed) return;

    let maxValidId = 0;
    try {
      const maxRow = db.prepare(`
        SELECT COALESCE(MAX(id), 0) as max_id 
        FROM messages 
        WHERE sender_id = ? AND receiver_id = ?
      `).get(cId, readerId);
      maxValidId = maxRow ? Number(maxRow.max_id) : 0;
    } catch (e) {}

    // PRIVÉ : conserver l'id temporaire brut (aucun id SQL à clamper) ; NORMAL : clamper sur les ids SQL réels
    let emittedLastId = rawLastId;

    if (!isPrivate) {
      // SÉCURITÉ : aucun message valide dans la conversation → ne rien persister ni diffuser
      if (maxValidId <= 0) return;

      const clampedLastId = Math.min(Math.max(0, rawLastId), maxValidId);

      // Progression strictement monotone : refuser toute régression en arrière
      let currentReadId = 0;
      try {
        const cursorRow = db.prepare('SELECT last_read_message_id FROM conversation_read_cursors WHERE user_id = ? AND contact_id = ?').get(readerId, cId);
        currentReadId = cursorRow ? Number(cursorRow.last_read_message_id) || 0 : 0;
      } catch (e) {}
      if (clampedLastId <= currentReadId) return;

      emittedLastId = clampedLastId;
      const now = Date.now();
      try {
        db.transaction(() => {
          db.prepare(`
            UPDATE messages 
            SET delivery_status = 'read' 
            WHERE sender_id = ? AND receiver_id = ? AND id <= ? AND delivery_status != 'read'
          `).run(cId, readerId, clampedLastId);

          db.prepare(`
            INSERT INTO conversation_read_cursors (user_id, contact_id, last_read_message_id, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id, contact_id) DO UPDATE SET
              last_read_message_id = MAX(conversation_read_cursors.last_read_message_id, excluded.last_read_message_id),
              updated_at = excluded.updated_at
          `).run(readerId, cId, clampedLastId, now);
        })();
      } catch (err) {
        console.error("Erreur persistance message_read:", err);
      }
    }

    io.to(getUserRoom(cId)).emit('conversation_read', {
      contactId: readerId,
      lastReadMessageId: emittedLastId,
      isPrivate: !!isPrivate
    });

    socket.to(getUserRoom(readerId)).emit('conversation_read', {
      contactId: cId,
      lastReadMessageId: emittedLastId,
      isPrivate: !!isPrivate
    });
  });

  /**
   * Envoi d'un Wizz
   */
  socket.on('send_wizz', (data) => {
    const { senderId } = data || {};
    if (socket.user.id !== senderId) return;
    // Identifiant normalisé AVANT tout usage : brut, « 7e1 » passait canInteract comme 7
    // (parseInt) mais la notification Push partait vers 70 (conversion SQLite)
    const receiverId = asId(data?.receiverId);
    if (!receiverId) return;

    const check = canInteract(senderId, receiverId);
    if (!check.allowed) {
      console.warn(`[Security Alert] Tentative de Wizz non autorisée de ${senderId} vers ${receiverId}: ${check.reason}`);
      return;
    }

    // 3 Wizz / minute (compteur dédié)
    if (!isAllowed(wizzLimits, senderId, 3, 60000)) return;

    io.to(getUserRoom(receiverId)).emit('receive_wizz', { senderId, receiverId });

    const sender = db.prepare('SELECT username, nickname FROM users WHERE id = ?').get(senderId);
    const senderDisplayName = sender ? (stripPlusTags(sender.nickname) || sender.username) : 'Contact';

    dispatchPushNotification(receiverId, {
      title: `${senderDisplayName} - OpenWLM`,
      body: '💥 [Wizz !]',
      l10n: 'nudge',
      senderId: senderId,
      url: `/?chat=${senderId}`,
      tag: `openwlm-chat-${senderId}`
    });
  });

  /**
   * Envoi d'un clin d'oeil (Wink)
   */
  socket.on('send_wink', (data) => {
    const { senderId, winkId } = data || {};
    if (socket.user.id !== senderId) return;
    const receiverId = asId(data?.receiverId);
    if (!receiverId) return;

    const check = canInteract(senderId, receiverId);
    if (!check.allowed) {
      console.warn(`[Security Alert] Tentative de Wink non autorisée de ${senderId} vers ${receiverId}: ${check.reason}`);
      return;
    }

    if (!winkId || typeof winkId !== 'string' || winkId.length > 64 || !/^[\w-]+$/.test(winkId)) return;

    // 7 Winks / minute (compteur dédié, indépendant des Wizz)
    if (!isAllowed(winkLimits, senderId, 7, 60000)) return;

    io.to(getUserRoom(receiverId)).emit('receive_wink', { senderId, receiverId, winkId });
  });

  /**
   * Synchronisation du mode privé
   */
  socket.on('toggle_private_mode', (data) => {
    const { senderId, receiverId, isPrivate } = data || {};
    // SÉCURITÉ : le propriétaire de la ligne est TOUJOURS l'identité authentifiée de la
    // socket, jamais un champ du payload. Un senderId divergent est rejeté.
    const ownerId = socket.user.id;
    if (senderId !== undefined && senderId !== ownerId) return;
    const contactId = Number(receiverId);
    if (!Number.isInteger(contactId) || contactId <= 0 || contactId === ownerId) return;
    if (typeof isPrivate !== 'boolean') return;
    if (!isAllowed(privateToggleLimits, ownerId, 10, 10000)) return;

    const check = canInteract(ownerId, contactId);
    if (!check.allowed) {
      console.warn(`[Security Alert] Tentative de toggle_private_mode non autorisée de ${ownerId} vers ${contactId}: ${check.reason}`);
      return;
    }

    try {
      db.prepare(`
        INSERT INTO conversation_privacy (owner_id, contact_id, is_private, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(owner_id, contact_id) DO UPDATE SET is_private = excluded.is_private, updated_at = excluded.updated_at
      `).run(ownerId, contactId, isPrivate ? 1 : 0, new Date().toISOString());
    } catch (err) {
      console.error("Erreur enregistrement conversation_privacy:", err);
      return;
    }

    const senderUser = db.prepare('SELECT nickname, username FROM users WHERE id = ?').get(ownerId);
    const safeNickname = senderUser ? (senderUser.nickname || senderUser.username) : 'Un contact';
    const effectivePrivate = isConversationPrivate(ownerId, contactId);

    // Notifications de confort (réactivité de l'UI) : l'état persisté reste la source de vérité.
    io.to(getUserRoom(contactId)).emit('private_mode_changed', {
      senderId: ownerId,
      receiverId: contactId,
      isPrivate,
      effectivePrivate,
      senderNickname: safeNickname
    });

    // Autres sessions du propriétaire : resynchroniser sa propre préférence
    socket.to(getUserRoom(ownerId)).emit('private_mode_self_sync', {
      contactId,
      isPrivate,
      effectivePrivate
    });
  });
};
