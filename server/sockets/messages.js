import { db } from '../db.js';
import { getUserRoom, isUserOnline } from '../sessionStore.js';
import { canInteract } from '../middleware/auth.js';
import { dispatchPushNotification } from '../routes/push.js';

export const wizzLimits = new Map();
export const messageLimits = new Map();

export const registerMessageHandlers = (io, socket) => {
  /**
   * Envoi d'un message
   */
  socket.on('send_message', (data, callback) => {
    const { senderId, receiverId, text, style, audio, type, isPrivate } = data || {};
    
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

    const now = Date.now();
    const timestamps = messageLimits.get(senderId) || [];
    const recentMessages = timestamps.filter(ts => now - ts < 10000);
    if (recentMessages.length >= 20) {
      if (typeof callback === 'function') callback({ success: false, error: "Trop de messages envoyés." });
      return; 
    }
    
    recentMessages.push(now);
    messageLimits.set(senderId, recentMessages);

    const sender = db.prepare('SELECT id, username, nickname, global_private FROM users WHERE id = ?').get(senderId);
    const receiver = db.prepare('SELECT global_private FROM users WHERE id = ?').get(receiverId);
    const isForcedPrivate = (sender && Number(sender.global_private) === 1) || (receiver && Number(receiver.global_private) === 1);
    const finalIsPrivate = isPrivate || isForcedPrivate;
    const senderDisplayName = sender ? (sender.nickname || sender.username) : null;

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
          INSERT INTO messages (sender_id, receiver_id, text, style, audio, type, delivery_status, timestamp) 
          VALUES (?, ?, ?, ?, ?, ?, 'sent', ?)
        `);
        const info = stmt.run(senderId, receiverId, text, JSON.stringify(style), audio, type || 'text', nowIso);
        messageToDeliver.id = info.lastInsertRowid;
        messageToDeliver.delivery_status = 'sent';
      } catch (err) {
        console.error("Erreur insertion BDD message:", err);
        // SÉCURITÉ/FIABILITÉ : ne pas présenter un échec de persistance comme un succès
        if (typeof callback === 'function') callback({ success: false, error: "Échec de l'enregistrement du message." });
        return;
      }
    } else {
      messageToDeliver.isPrivate = true;
      messageToDeliver.delivery_status = 'sent';
      messageToDeliver.id = Date.now(); // ID temporaire (non persisté) pour le frontend
    }

    io.to(getUserRoom(receiverId)).emit('receive_message', messageToDeliver);
    socket.to(getUserRoom(senderId)).emit('receive_message', messageToDeliver);

    const pushSenderName = sender ? (sender.nickname || sender.username) : 'Contact';
    let pushBody = 'Nouveau message reçu';
    if (finalIsPrivate) {
      pushBody = '🔒 Nouveau message privé';
    } else if (type === 'audio') {
      pushBody = '🎤 Message vocal';
    } else if (type === 'file') {
      pushBody = '📎 Fichier partagé';
    } else if (text) {
      try {
        const parsed = JSON.parse(text);
        if (parsed.keyReceiver || parsed.keySender) {
          pushBody = '🔐 Message chiffré (E2EE)';
        }
      } catch (_) {}
    }

    dispatchPushNotification(receiverId, {
      title: `${pushSenderName} - OpenWLM`,
      body: pushBody,
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
        db.prepare(`
          UPDATE messages 
          SET delivery_status = 'delivered' 
          WHERE id = ? AND sender_id = ? AND receiver_id = ? AND delivery_status = 'sent'
        `).run(mId, sId, recipientId);
      } catch (err) {
        console.error("Erreur mise à jour message_delivered:", err);
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

    const now = Date.now();
    const timestamps = wizzLimits.get(senderId) || [];
    const recentWizz = timestamps.filter(ts => now - ts < 60000);
    if (recentWizz.length >= 3) return;
    
    recentWizz.push(now);
    wizzLimits.set(senderId, recentWizz);

    io.to(getUserRoom(receiverId)).emit('receive_wizz', { senderId, receiverId });

    const sender = db.prepare('SELECT username, nickname FROM users WHERE id = ?').get(senderId);
    const senderDisplayName = sender ? (sender.nickname || sender.username) : 'Contact';

    dispatchPushNotification(receiverId, {
      title: `${senderDisplayName} - OpenWLM`,
      body: '💥 [Wizz !]',
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

    const now = Date.now();
    const timestamps = wizzLimits.get(senderId) || [];
    const recentWinks = timestamps.filter(ts => now - ts < 60000);
    if (recentWinks.length >= 7) return;
    
    recentWinks.push(now);
    wizzLimits.set(senderId, recentWinks);

    io.to(getUserRoom(receiverId)).emit('receive_wink', { senderId, receiverId, winkId });
  });

  /**
   * Synchronisation du mode privé
   */
  socket.on('toggle_private_mode', (data) => {
    const { senderId, receiverId, isPrivate } = data || {};
    if (socket.user.id !== senderId) return;

    const check = canInteract(senderId, receiverId);
    if (!check.allowed) {
      console.warn(`[Security Alert] Tentative de toggle_private_mode non autorisée de ${senderId} vers ${receiverId}: ${check.reason}`);
      return;
    }

    const senderUser = db.prepare('SELECT nickname, username FROM users WHERE id = ?').get(senderId);
    const safeNickname = senderUser ? (senderUser.nickname || senderUser.username) : 'Un contact';

    io.to(getUserRoom(receiverId)).emit('private_mode_changed', { 
      senderId, 
      receiverId,
      isPrivate: !!isPrivate,
      senderNickname: safeNickname 
    });

    socket.to(getUserRoom(senderId)).emit('private_mode_changed', { 
      senderId, 
      receiverId,
      isPrivate: !!isPrivate,
      senderNickname: safeNickname 
    });
  });
};
