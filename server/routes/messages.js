import { Router } from 'express';
import { db } from '../db.js';
import { authenticateToken } from '../middleware/auth.js';

export const createMessagesRouter = () => {
  const router = Router();

  /**
   * Récupération de l'historique des messages
   */
  router.get('/messages/:userId/:contactId', authenticateToken, (req, res) => {
    const { userId, contactId } = req.params;
    const uId = parseInt(userId, 10);
    const cId = parseInt(contactId, 10);
    if (req.user.id !== uId) return res.status(403).json({ error: "Accès refusé." });

    // 1. Marquer les messages envoyés par le contact vers moi comme 'delivered'
    try {
      db.prepare(`
        UPDATE messages 
        SET delivery_status = 'delivered' 
        WHERE sender_id = ? AND receiver_id = ? AND delivery_status = 'sent'
      `).run(cId, uId);
    } catch(e) {}

    // 2. Curseur de lecture du contact
    let contactLastReadId = 0;
    try {
      const cursor = db.prepare('SELECT last_read_message_id FROM conversation_read_cursors WHERE user_id = ? AND contact_id = ?').get(cId, uId);
      if (cursor) contactLastReadId = Number(cursor.last_read_message_id) || 0;
    } catch(e) {}

    const history = db.prepare(`
      SELECT messages.*, COALESCE(NULLIF(users.nickname, ''), users.username) as sender_name 
      FROM messages 
      JOIN users ON messages.sender_id = users.id
      WHERE (sender_id = ? AND receiver_id = ?) 
         OR (sender_id = ? AND receiver_id = ?)
      ORDER BY timestamp ASC
    `).all(uId, cId, cId, uId);

    const mapped = history.map(msg => {
      let status = msg.delivery_status || 'sent';
      if (msg.sender_id === uId && contactLastReadId && msg.id <= contactLastReadId) {
        status = 'read';
      }
      return {
        ...msg,
        delivery_status: status
      };
    });

    res.json(mapped);
  });

  /**
   * Supprimer l'historique des messages
   */
  router.post('/messages/clear', authenticateToken, (req, res) => {
    const { contactId } = req.body;
    const userId = req.user.id;
    const cId = parseInt(contactId, 10);

    try {
      db.prepare(`
        DELETE FROM messages 
        WHERE (sender_id = ? AND receiver_id = ?) 
           OR (sender_id = ? AND receiver_id = ?)
      `).run(userId, cId, cId, userId);

      try {
        db.prepare('DELETE FROM conversation_read_cursors WHERE (user_id = ? AND contact_id = ?) OR (user_id = ? AND contact_id = ?)').run(userId, cId, cId, userId);
      } catch(e) {}

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Erreur lors de la suppression de l'historique." });
    }
  });

  return router;
};
