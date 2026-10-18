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

// Compteur d'ids temporaires pour les messages privés (évite les collisions Date.now() à la même ms)
let privateMsgSeq = 0;

export const registerMessageHandlers = (io, socket) => {
  /**
   * Envoi d'un message
   */
  socket.on('send_message', (data, callback) => {
    // `isPrivate` éventuellement fourni par le client est volontairement IGNORÉ :
    // le serveur calcule seul le mode privé effectif à partir de l'état persisté.
    const { senderId, receiverId, text, style, audio, type } = data || {};
    
    if (socket.user.id !== senderId) {
      if (typeof callback === 'function') callback({ success: false, error: "Non autorisé." });
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

    if (text && text.length > 5000000) {
      if (typeof callback === 'function') callback({ success: false, error: "Message trop volumineux." });
      return;
    }
    if (audio && audio.length > 5000000) {
      if (typeof callback === 'function') callback({ success: false, error: "Audio trop volumineux." });
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

    const pushSenderName = sender ? (sender.nickname || sender.username) : 'Contact';
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
    const { messageId, senderId, isPrivate } = data || {};
    const recipientId = socket.user.id;
    const sId = Number(senderId);
    const mId = Number(messageId);
    if (!mId || !sId) return;

    const check = canInteract(sId, recipientId);
    if (!check.allowed) return;

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
    const { contactId, lastReadMessageId, isPrivate } = data || {};
    const readerId = socket.user.id;
    const cId = Number(contactId);
    const rawLastId = Number(lastReadMessageId) || 0;

    if (!cId || cId === readerId) return;

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
    const { senderId, receiverId } = data || {};
    if (socket.user.id !== senderId) return;

    const check = canInteract(senderId, receiverId);
    if (!check.allowed) {
      console.warn(`[Security Alert] Tentative de Wizz non autorisée de ${senderId} vers ${receiverId}: ${check.reason}`);
      return;
    }

    // 3 Wizz / minute (compteur dédié)
    if (!isAllowed(wizzLimits, senderId, 3, 60000)) return;

    io.to(getUserRoom(receiverId)).emit('receive_wizz', { senderId, receiverId });

    const sender = db.prepare('SELECT username, nickname FROM users WHERE id = ?').get(senderId);
    const senderDisplayName = sender ? (sender.nickname || sender.username) : 'Contact';

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
    const { senderId, receiverId, winkId } = data || {};
    if (socket.user.id !== senderId) return;

    const check = canInteract(senderId, receiverId);
    if (!check.allowed) {
      console.warn(`[Security Alert] Tentative de Wink non autorisée de ${senderId} vers ${receiverId}: ${check.reason}`);
      return;
    }

    if (!winkId || typeof winkId !== 'string' || !/^[\w-]+$/.test(winkId)) return;

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
