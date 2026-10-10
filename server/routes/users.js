import { Router } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { db, toPublicUserDTO } from '../db.js';
import { getUserRoom } from '../sessionStore.js';
import { 
  SECRET, 
  authenticateToken, 
  sensitiveRateLimiter, 
  inviteRateLimiter, 
  changePasswordAccountLimiter, 
  resetE2eAccountLimiter, 
  canInteract, 
  isValidPath, 
  hashPassword, 
  verifyPasswordHash 
} from '../middleware/auth.js';

export const createUsersRouter = ({ io, broadcastStatusToContacts, isProd }) => {
  const router = Router();

  /**
   * Envoi d'une invitation de contact
   */
  router.post('/invite', authenticateToken, inviteRateLimiter, (req, res) => {
    const { receiverUsername } = req.body;
    const senderId = req.user.id;
    
    const normalizedUsername = String(receiverUsername || '').trim().toLowerCase();
    const receiver = db.prepare('SELECT id FROM users WHERE LOWER(username) = ?').get(normalizedUsername);
    if (!receiver) {
      return res.json({ success: true });
    }
    if (senderId === receiver.id) return res.status(400).json({ error: "Vous ne pouvez pas vous ajouter vous-même." });
    
    const existingContact = db.prepare('SELECT * FROM contacts WHERE user_id = ? AND contact_id = ?').get(senderId, receiver.id);
    if (existingContact) return res.status(400).json({ error: "Utilisateur déjà présent dans vos contacts." });

    const existingInvite = db.prepare('SELECT * FROM invitations WHERE sender_id = ? AND receiver_id = ? AND status = \'pending\'').get(senderId, receiver.id);
    if (existingInvite) return res.status(400).json({ error: "Une invitation est déjà en attente." });

    try {
      const stmt = db.prepare('INSERT INTO invitations (sender_id, receiver_id) VALUES (?, ?)');
      stmt.run(senderId, receiver.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Erreur lors de l\'envoi de l\'invitation.' });
    }
  });

  /**
   * Invitations en attente
   */
  router.get('/invitations/:userId', authenticateToken, (req, res) => {
    const userId = parseInt(req.params.userId);
    if (req.user.id !== userId) return res.status(403).json({ error: "Accès refusé." });

    const invites = db.prepare(`
      SELECT invitations.id, users.username, users.nickname, users.avatar 
      FROM invitations 
      JOIN users ON invitations.sender_id = users.id 
      WHERE invitations.receiver_id = ? AND invitations.status = 'pending'
    `).all(userId);
    
    res.json(invites);
  });

  /**
   * Accepter une invitation
   */
  router.post('/accept-invite', authenticateToken, (req, res) => {
    const { invitationId } = req.body;
    const userId = req.user.id;

    const invite = db.prepare('SELECT * FROM invitations WHERE id = ?').get(invitationId);

    if (invite && invite.receiver_id === userId) {
      try {
        db.transaction(() => {
          db.prepare('INSERT OR IGNORE INTO contacts (user_id, contact_id) VALUES (?, ?)').run(invite.sender_id, invite.receiver_id);
          db.prepare('INSERT OR IGNORE INTO contacts (user_id, contact_id) VALUES (?, ?)').run(invite.receiver_id, invite.sender_id);
          db.prepare('UPDATE invitations SET status = ? WHERE id = ?').run('accepted', invitationId);
        })();

        io.to(getUserRoom(invite.sender_id)).emit('contact_accepted');
        io.to(getUserRoom(invite.receiver_id)).emit('contact_accepted');

        res.json({ success: true });
      } catch (err) {
        res.status(500).json({ error: "Erreur lors de l'acceptation." });
      }
    } else {
      res.status(404).json({ error: "Invitation non trouvée ou non autorisée." });
    }
  });

  /**
   * Refuser une invitation
   */
  router.post('/decline-invite', authenticateToken, (req, res) => {
    const { invitationId } = req.body;
    const userId = req.user.id;

    try {
      const invite = db.prepare('SELECT * FROM invitations WHERE id = ?').get(invitationId);
      if (!invite || invite.receiver_id !== userId) {
        return res.status(403).json({ error: "Accès refusé ou invitation introuvable." });
      }

      db.prepare('UPDATE invitations SET status = ? WHERE id = ?').run('declined', invitationId);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Erreur lors du refus de l'invitation." });
    }
  });

  /**
   * Liste des contacts
   */
  router.get('/contacts/:userId', authenticateToken, (req, res) => {
    const userId = parseInt(req.params.userId);
    if (req.user.id !== userId) return res.status(403).json({ error: "Accès refusé." });

    const contacts = db.prepare(`
      SELECT 
        users.id, 
        users.username, 
        users.nickname, 
        users.psm, 
        users.avatar, 
        users.scene, 
        users.global_private, 
        users.public_key, 
        CASE WHEN reverse_c.blocked = 1 THEN 'offline' ELSE users.status END as status, 
        contacts.blocked 
      FROM contacts 
      JOIN users ON contacts.contact_id = users.id 
      LEFT JOIN contacts reverse_c ON reverse_c.user_id = contacts.contact_id AND reverse_c.contact_id = contacts.user_id
      WHERE contacts.user_id = ?
    `).all(userId);
    
    res.json(contacts);
  });

  /**
   * Bloquer / débloquer un contact
   */
  router.post('/contacts/block', authenticateToken, (req, res) => {
    const { contactId, block } = req.body;
    const userId = req.user.id;

    try {
      db.prepare('UPDATE contacts SET blocked = ? WHERE user_id = ? AND contact_id = ?').run(block ? 1 : 0, userId, contactId);

      const blocker = db.prepare('SELECT status FROM users WHERE id = ?').get(userId);
      io.to(getUserRoom(contactId)).emit('user_status_changed', { 
        userId: userId, 
        status: block ? 'offline' : (blocker ? blocker.status : 'online') 
      });

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Erreur lors de l'opération de blocage." });
    }
  });

  /**
   * Supprimer un contact
   */
  router.post('/contacts/delete', authenticateToken, (req, res) => {
    const { contactId } = req.body;
    const userId = req.user.id;

    try {
      db.prepare('DELETE FROM contacts WHERE user_id = ? AND contact_id = ?').run(userId, contactId);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Erreur lors de la suppression." });
    }
  });

  /**
   * Clé publique E2EE d'un utilisateur
   */
  router.get('/user/:userId/public-key', authenticateToken, sensitiveRateLimiter, (req, res) => {
    const targetId = parseInt(req.params.userId, 10);
    if (isNaN(targetId)) return res.status(400).json({ error: "Identifiant utilisateur invalide." });

    if (req.user.id !== targetId && !canInteract(req.user.id, targetId).allowed) {
      return res.status(403).json({ error: "Accès refusé." });
    }

    const user = db.prepare('SELECT public_key FROM users WHERE id = ?').get(targetId);
    if (user && user.public_key) {
      try {
        res.json({ publicKey: JSON.parse(user.public_key) });
      } catch (e) {
        res.status(500).json({ error: "Données de clé corrompues." });
      }
    } else {
      res.status(404).json({ error: "Clé publique introuvable." });
    }
  });

  /**
   * Sauvegarde des clés E2E
   */
  router.post('/user/keys', authenticateToken, sensitiveRateLimiter, (req, res) => {
    const { publicKey, encryptedPrivateKey } = req.body;
    const userId = req.user.id;

    if (!publicKey || typeof publicKey !== 'object' ||
        publicKey.kty !== 'RSA' || typeof publicKey.n !== 'string' || typeof publicKey.e !== 'string') {
      return res.status(400).json({ error: "Clé publique invalide (JWK RSA requis)." });
    }
    if (!encryptedPrivateKey || typeof encryptedPrivateKey !== 'object') {
      return res.status(400).json({ error: "Clé privée chiffrée invalide." });
    }

    try {
      db.prepare('UPDATE users SET public_key = ?, encrypted_private_key = ? WHERE id = ?')
        .run(JSON.stringify(publicKey), JSON.stringify(encryptedPrivateKey), userId);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Erreur lors de la sauvegarde des clés." });
    }
  });

  /**
   * Réinitialisation d'urgence des clés E2E
   */
  router.post('/user/reset-e2e-keys', authenticateToken, sensitiveRateLimiter, (req, res) => {
    const userId = req.user.id;
    const { authKeyHex, publicKey, encryptedPrivateKey } = req.body;

    const resetLimit = resetE2eAccountLimiter.attempt(userId);
    if (!resetLimit.allowed) {
      return res.status(429).json({ error: "Trop de tentatives de réinitialisation E2E. Veuillez réessayer plus tard." });
    }

    if (req.body.userId !== undefined && Number(req.body.userId) !== userId) {
      return res.status(403).json({ error: "Action non autorisée : vous ne pouvez réinitialiser que votre propre identité." });
    }

    if (!authKeyHex || typeof authKeyHex !== 'string' || !/^[a-fA-F0-9]{64}$/.test(authKeyHex)) {
      return res.status(400).json({ error: "Format de la clé d'authentification invalide (hex 256 bits requis)." });
    }

    if (!publicKey || typeof publicKey !== 'object' || !encryptedPrivateKey || typeof encryptedPrivateKey !== 'object') {
      return res.status(400).json({ error: "Clés cryptographiques invalides ou manquantes." });
    }

    const user = db.prepare('SELECT id, username, salt, password_hash, token_version FROM users WHERE id = ?').get(userId);
    if (!user) {
      return res.status(404).json({ error: "Utilisateur introuvable." });
    }

    if (!verifyPasswordHash(authKeyHex, user.salt, user.password_hash)) {
      return res.status(401).json({ error: "Mot de passe incorrect." });
    }

    try {
      db.transaction(() => {
        db.prepare('UPDATE users SET public_key = ?, encrypted_private_key = ? WHERE id = ?')
          .run(JSON.stringify(publicKey), JSON.stringify(encryptedPrivateKey), userId);

        db.prepare('DELETE FROM messages WHERE sender_id = ? OR receiver_id = ?')
          .run(userId, userId);

        db.prepare('DELETE FROM conversation_read_cursors WHERE user_id = ? OR contact_id = ?')
          .run(userId, userId);

        db.prepare('UPDATE users SET token_version = COALESCE(token_version, 0) + 1 WHERE id = ?')
          .run(userId);
      })();

      const updatedUser = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      broadcastStatusToContacts(userId, toPublicUserDTO(updatedUser));

      try {
        io.in(getUserRoom(userId)).disconnectSockets(true);
      } catch (e) {
        console.warn("[E2EE Reset] Erreur déconnexion sockets:", e);
      }

      resetE2eAccountLimiter.reset(userId);
      res.json({ success: true, message: "Clés E2E réinitialisées avec succès." });
    } catch (err) {
      console.error("[E2EE Reset] Erreur lors de la réinitialisation:", err);
      res.status(500).json({ error: "Erreur lors de la réinitialisation des clés E2E." });
    }
  });

  /**
   * Mode privé global
   */
  router.post('/user/global-private', authenticateToken, (req, res) => {
    const { globalPrivate } = req.body;
    const userId = req.user.id;

    try {
      db.prepare('UPDATE users SET global_private = ? WHERE id = ?').run(globalPrivate ? 1 : 0, userId);
      const updatedUser = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

      broadcastStatusToContacts(userId, toPublicUserDTO(updatedUser));
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Erreur lors de la mise à jour." });
    }
  });

  /**
   * Mise à jour du profil
   */
  router.post('/user/update', authenticateToken, (req, res) => {
    const { nickname, psm, avatar, scene, status } = req.body;
    const userId = req.user.id;

    if (nickname !== undefined && (typeof nickname !== 'string' || nickname.length > 50)) return res.status(400).json({ error: "Surnom invalide (max 50 caractères)." });
    if (psm !== undefined && (typeof psm !== 'string' || psm.length > 150)) return res.status(400).json({ error: "Message personnel invalide (max 150 caractères)." });

    if (avatar && !isValidPath(avatar)) return res.status(400).json({ error: "Image d'avatar invalide." });
    if (scene && !isValidPath(scene)) return res.status(400).json({ error: "Scène invalide." });

    const allowedStatus = ['online', 'busy', 'away', 'offline'];

    try {
      const currentUser = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      if (!currentUser) return res.status(404).json({ error: "Utilisateur non trouvé." });

      const newNickname = nickname !== undefined ? nickname : currentUser.nickname;
      const newPsm = psm !== undefined ? psm : currentUser.psm;
      const newAvatar = avatar !== undefined ? avatar : currentUser.avatar;
      const newScene = scene !== undefined ? scene : currentUser.scene;
      const newStatus = status !== undefined && allowedStatus.includes(status) ? status : currentUser.status;

      const stmt = db.prepare('UPDATE users SET nickname = ?, psm = ?, avatar = ?, scene = ?, status = ? WHERE id = ?');
      stmt.run(newNickname, newPsm, newAvatar, newScene, newStatus, userId);

      const updatedUser = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      broadcastStatusToContacts(userId, toPublicUserDTO(updatedUser));

      res.json({ success: true, user: toPublicUserDTO(updatedUser) });
    } catch (err) {
      console.error("Update profile error:", err);
      res.status(500).json({ error: "Erreur lors de la mise à jour du profil." });
    }
  });

  /**
   * Changement de mot de passe (Zero-Knowledge)
   */
  router.post('/user/change-password', authenticateToken, sensitiveRateLimiter, (req, res) => {
    const { oldAuthKeyHex, newAuthKeyHex, newEncryptedPrivateKey } = req.body;
    const oldKey = oldAuthKeyHex || req.body.oldPassword;
    const newKey = newAuthKeyHex || req.body.newPassword;
    const newVault = newEncryptedPrivateKey || req.body.newVault;
    const userId = req.user.id;

    const changeLimit = changePasswordAccountLimiter.attempt(userId);
    if (!changeLimit.allowed) {
      return res.status(429).json({ error: "Trop de tentatives de changement de mot de passe. Veuillez réessayer plus tard." });
    }

    if (!oldKey || !newKey || !/^[a-fA-F0-9]{64}$/.test(oldKey) || !/^[a-fA-F0-9]{64}$/.test(newKey)) {
      return res.status(400).json({ error: "Format des clés d'authentification invalide (hex 256 bits requis)." });
    }

    const user = db.prepare('SELECT password_hash, salt FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable.' });

    if (!verifyPasswordHash(oldKey, user.salt, user.password_hash)) {
      return res.status(401).json({ error: 'Ancien mot de passe incorrect.' });
    }

    const newSalt = crypto.randomBytes(16).toString('hex');
    const newHash = hashPassword(newKey, newSalt);

    try {
      db.transaction(() => {
        if (newVault) {
          db.prepare('UPDATE users SET password_hash = ?, salt = ?, encrypted_private_key = ? WHERE id = ?')
            .run(newHash, newSalt, JSON.stringify(newVault), userId);
        } else {
          db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?')
            .run(newHash, newSalt, userId);
        }
        db.prepare('UPDATE users SET token_version = COALESCE(token_version, 0) + 1 WHERE id = ?').run(userId);
      })();

      const newTv = (db.prepare('SELECT token_version FROM users WHERE id = ?').get(userId) || {}).token_version || 0;
      const newToken = jwt.sign({ id: userId, username: req.user.username, tv: newTv }, SECRET, { expiresIn: '24h' });
      const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
      const isSecure = (isProd || Boolean(req.headers['cf-ray'] || isHttps)) && isHttps;
      res.cookie('token', newToken, {
        httpOnly: true,
        secure: isSecure,
        sameSite: 'strict',
        maxAge: 24 * 60 * 60 * 1000,
        path: '/'
      });
      io.in(getUserRoom(userId)).disconnectSockets(true);

      changePasswordAccountLimiter.reset(userId);
      res.json({ success: true });
    } catch (err) {
      console.error("Change password error:", err);
      res.status(500).json({ error: 'Erreur lors du changement de mot de passe.' });
    }
  });

  return router;
};
