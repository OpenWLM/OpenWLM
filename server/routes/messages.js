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

    // Pagination : les `limit` derniers messages (300 par défaut, 1000 au plus), ou ceux qui
    // précèdent le message `before`. L'en-tête X-Has-More indique s'il en reste de plus anciens.
    // Sans cela, une longue conversation (messages vocaux compris) était renvoyée en entier.
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 300));
    const before = parseInt(req.query.before, 10);
    const beforeClause = Number.isInteger(before) && before > 0 ? 'AND messages.id < ?' : '';
    const params = [uId, cId, cId, uId, ...(beforeClause ? [before] : []), limit + 1];
    const page = db.prepare(`
      SELECT messages.*, COALESCE(NULLIF(users.nickname, ''), users.username) as sender_name 
      FROM messages 
      JOIN users ON messages.sender_id = users.id
      WHERE ((sender_id = ? AND receiver_id = ?) 
         OR (sender_id = ? AND receiver_id = ?)) ${beforeClause}
      ORDER BY messages.id DESC
      LIMIT ?
    `).all(...params);
    const hasMore = page.length > limit;
    const history = page.slice(0, limit).reverse();
    res.set('X-Has-More', hasMore ? '1' : '0');

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
   * Conversations ayant des messages jamais remis à aucune de mes sessions
   * (reçus pendant que j'étais hors ligne). Le client ouvre les onglets
   * correspondants ; le chargement de l'historique les marque ensuite « remis ».
   */
  router.get('/conversations/pending', authenticateToken, (req, res) => {
    try {
      const rows = db.prepare(`
        SELECT m.sender_id AS contactId, COUNT(*) AS count, MAX(m.timestamp) AS lastTimestamp
        FROM messages m
        JOIN contacts c ON c.user_id = m.receiver_id AND c.contact_id = m.sender_id
        WHERE m.receiver_id = ? AND m.delivery_status = 'sent'
          AND (c.blocked IS NULL OR c.blocked = 0)
        GROUP BY m.sender_id
        ORDER BY lastTimestamp DESC
        LIMIT 50
      `).all(req.user.id);
      res.json(rows);
    } catch (err) {
      console.error("Erreur conversations en attente:", err);
      res.status(500).json({ error: "Erreur serveur." });
    }
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
