import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * CONFIGURATION ET INITIALISATION
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);

// SÉCURITÉ : Faire confiance au proxy Cloudflare pour récupérer l'IP réelle du client
app.set('trust proxy', true);

const io = new Server(httpServer, {
  cors: {
    origin: "*", 
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000, // Attendre 60s avant de considérer le client déconnecté
  pingInterval: 25000 // Envoyer un ping toutes les 25s
});

const PORT = 3001;
const db = new Database('messenger.db');
const SECRET = 'wlm_classic_secret_key'; // Devrait être dans une variable d'environnement

// SÉCURITÉ : Désactiver l'en-tête X-Powered-By qui révèle l'utilisation d'Express
app.disable('x-powered-by');

// SÉCURITÉ : Middleware pour les en-têtes HTTP de sécurité
app.use((req, res, next) => {
  // Anti Clickjacking
  res.setHeader('X-Frame-Options', 'DENY');
  // Empêcher l'analyse MIME (MIME Sniffing)
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Content Security Policy (CSP) très basique
  res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' ws: wss: stun: turn:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; img-src 'self' data: blob:; media-src 'self' data: blob:;");
  // HSTS (Strict Transport Security)
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // XSS Protection (Anciens navigateurs)
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// SÉCURITÉ : Configuration CORS restreinte
const corsOptions = {
  origin: ['http://localhost:3001', 'http://127.0.0.1:3001', 'file://'], // Restreindre aux origines légitimes (inclure file:// pour Electron si nécessaire)
  methods: ['GET', 'POST'],
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));
app.use(express.json());

// SÉCURITÉ : Servir les fichiers statiques du frontend (React/Vite) avec redirect: false pour éviter l'Open Redirect sur les dossiers
app.use(express.static(path.join(__dirname, '../dist'), { redirect: false }));

/**
 * INITIALISATION DE LA BASE DE DONNÉES
 * Utilisation de blocs séparés pour assurer la compatibilité avec les anciennes versions
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password_hash TEXT,
    salt TEXT,
    nickname TEXT,
    psm TEXT,
    avatar TEXT,
    scene TEXT,
    status TEXT,
    public_key TEXT,
    encrypted_private_key TEXT,
    global_private INTEGER DEFAULT 0
  );
  
  CREATE TABLE IF NOT EXISTS contacts (
    user_id INTEGER,
    contact_id INTEGER,
    status INTEGER DEFAULT 1,
    blocked INTEGER DEFAULT 0,
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(contact_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS invitations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER,
    receiver_id INTEGER,
    status TEXT DEFAULT 'pending',
    FOREIGN KEY(sender_id) REFERENCES users(id),
    FOREIGN KEY(receiver_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER,
    receiver_id INTEGER,
    text TEXT,
    style TEXT,
    audio TEXT,
    type TEXT DEFAULT 'text',
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Reset all users to offline on server start to fix DB/RAM mismatch
try {
  db.exec("UPDATE users SET status = 'offline'");
} catch(e) {
  console.warn("Erreur lors de la réinitialisation des statuts:", e);
}

// Ajout sécurisé d'un index unique pour éviter les doublons de contacts
try {
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_contacts ON contacts(user_id, contact_id);");
} catch (e) {
  console.warn("Index unique contacts déjà présent ou erreur:", e.message);
}

try {
  db.exec("ALTER TABLE users ADD COLUMN global_private INTEGER DEFAULT 0;");
} catch(e) {}

/**
 * HELPERS ET MIDDLEWARES
 */

/**
 * DTO (Data Transfer Object) pour les données publiques d'un utilisateur
 * (Visible par les contacts)
 */
const toPublicUserDTO = (user) => {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    nickname: user.nickname,
    psm: user.psm,
    avatar: user.avatar,
    scene: user.scene,
    status: user.status,
    public_key: user.public_key,
    global_private: user.global_private
  };
};

/**
 * DTO pour les données privées de l'utilisateur connecté
 * (Inclut le coffre-fort E2E mais JAMAIS les secrets d'auth serveur)
 */
const toPrivateUserDTO = (user) => {
  if (!user) return null;
  return {
    ...toPublicUserDTO(user),
    encrypted_private_key: user.encrypted_private_key
  };
};

/**
 * Diffuse un événement de changement de statut uniquement aux contacts de l'utilisateur
 */
const broadcastStatusToContacts = (userId, payload) => {
  // 1. Trouver tous les utilisateurs qui ont "userId" dans leur liste de contacts
  const contacts = db.prepare('SELECT user_id FROM contacts WHERE contact_id = ?').all(userId);
  
  // 2. Pour chaque contact, vérifier s'il est en ligne et lui envoyer l'événement
  contacts.forEach(contact => {
    const socketId = onlineUsers.get(contact.user_id);
    if (socketId) {
      io.to(socketId).emit('user_status_changed', payload);
    }
  });

  // 3. Envoyer aussi à l'utilisateur lui-même (pour synchroniser plusieurs onglets/appareils)
  const mySocketId = onlineUsers.get(userId);
  if (mySocketId) {
     io.to(mySocketId).emit('user_status_changed', payload);
  }
};

/**
 * Hachage sécurisé du mot de passe avec PBKDF2
 */
const hashPassword = (password, salt) => {
  return crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
};

/**
 * Middleware de limitation de débit (Rate Limiting)
 * Prévient les attaques par force brute sur la connexion et l'inscription.
 */
const rateLimitStorage = new Map();
const authRateLimiter = (req, res, next) => {
  // SÉCURITÉ : Priorité à l'IP Cloudflare, puis au premier élément du X-Forwarded-For, sinon req.ip (via trust proxy)
  const ip = req.headers['cf-connecting-ip'] || 
             (req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : null) || 
             req.ip || 
             req.socket.remoteAddress;

  const now = Date.now();
  const windowMs = 60000; // 1 minute
  const limit = 10;       // 10 tentatives

  if (!rateLimitStorage.has(ip)) {
    rateLimitStorage.set(ip, []);
  }

  let timestamps = rateLimitStorage.get(ip);
  // Nettoyage des anciennes tentatives au-delà d'une minute
  timestamps = timestamps.filter(ts => now - ts < windowMs);
  
  if (timestamps.length >= limit) {
    console.warn(`[Security] Rate limit atteint pour l'IP: ${ip}`);
    return res.status(429).json({ error: "Trop de tentatives. Veuillez réessayer dans une minute." });
  }

  timestamps.push(now);
  rateLimitStorage.set(ip, timestamps);
  next();
};

/**
 * Middleware d'authentification par JWT
 */
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) return res.status(401).json({ error: "Non autorisé. Token manquant." });

  jwt.verify(token, SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Token invalide ou expiré." });
    req.user = user;
    next();
  });
};

/**
 * Validation des entrées utilisateur (Anti-XSS, injection, etc.)
 */
const isValidPath = (path) => {
  // Autorise uniquement les chemins relatifs internes commençant par /assets/
  return typeof path === 'string' && path.startsWith('/assets/') && !path.includes('..');
};

/**
 * GESTION DES CAPTCHAS (Mémoire vive)
 */
const captchas = new Map();

/**
 * --- API ENDPOINTS ---
 */

/**
 * Récupère le profil de l'utilisateur courant (utilisé pour la synchro E2E)
 */
app.get('/api/user/me', authenticateToken, (req, res) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: "Utilisateur non trouvé." });
    
    res.json({ success: true, user: toPrivateUserDTO(user) });
  } catch (err) {
    res.status(500).json({ error: "Erreur serveur." });
  }
});

/**
 * Générer un défi mathématique simple pour l'inscription
 */
app.get('/api/captcha', (req, res) => {
  const num1 = Math.floor(Math.random() * 10) + 1;
  const num2 = Math.floor(Math.random() * 10) + 1;
  const id = crypto.randomUUID();
  
  // Expiration après 5 minutes
  captchas.set(id, { answer: num1 + num2, expires: Date.now() + 5 * 60000 });
  
  res.json({ id, text: `Combien font ${num1} + ${num2} ?` });
});

/**
 * Inscription d'un nouvel utilisateur
 */
app.post('/api/signup', (req, res) => {
  const { username, password, nickname, captchaId, captchaAnswer } = req.body;
  
  // 1. Validation du Captcha
  if (!captchaId || captchaAnswer === undefined) {
    return res.status(400).json({ error: 'Validation anti-robot manquante.' });
  }
  const captcha = captchas.get(captchaId);
  if (!captcha || Date.now() > captcha.expires) {
    return res.status(400).json({ error: 'Validation expirée ou invalide.' });
  }
  if (parseInt(captchaAnswer) !== captcha.answer) {
    return res.status(400).json({ error: 'Réponse anti-robot incorrecte.' });
  }
  captchas.delete(captchaId); // Consommation unique

  // 2. Validation du nom d'utilisateur (Email ou Alpha-numérique)
  const usernameRegex = /^[a-zA-Z0-9_.@-]{3,100}$/;
  if (!usernameRegex.test(username)) {
    return res.status(400).json({ error: 'Adresse de messagerie invalide (3-100 caractères, sans espaces).' });
  }

  // 3. Validation de la complexité du mot de passe
  const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[\W_]).{12,}$/;
  if (!passwordRegex.test(password)) {
    return res.status(400).json({ error: 'Le mot de passe doit faire 12 caractères et inclure Maj, Min, Chiffre et Caractère spécial.' });
  }

  // 4. Hachage et insertion
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  
  try {
    const stmt = db.prepare('INSERT INTO users (username, password_hash, salt, nickname, psm, avatar, scene, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    stmt.run(username, hash, salt, nickname || username, 'Disponible', '/assets/usertiles/chess.png', '/assets/scenes/0006.png', 'online');
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: 'Nom d\'utilisateur déjà utilisé ou erreur système.' });
  }
});

/**
 * Connexion utilisateur
 */
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) return res.status(400).json({ error: 'Identifiants requis.' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  
  if (user && hashPassword(password, user.salt) === user.password_hash) {
    // Création d'un token valable 24h
    const token = jwt.sign({ id: user.id, username: user.username }, SECRET, { expiresIn: '24h' });
    
    // SÉCURITÉ : DTO pour éviter de fuiter hash/salt
    res.json({ success: true, token, user: toPrivateUserDTO(user) });
  } else {
    res.status(401).json({ error: 'Identifiants invalides.' });
  }
});

/**
 * Envoi d'une invitation de contact
 */
app.post('/api/invite', authenticateToken, (req, res) => {
  const { receiverUsername } = req.body;
  const senderId = req.user.id; // Sécurité : On utilise l'ID du token
  
  const receiver = db.prepare('SELECT id FROM users WHERE username = ?').get(receiverUsername);
  if (!receiver) return res.status(404).json({ error: "Cet utilisateur n'existe pas." });
  if (senderId === receiver.id) return res.status(400).json({ error: "Vous ne pouvez pas vous ajouter vous-même." });
  
  // Vérifier si déjà contact
  const existingContact = db.prepare('SELECT * FROM contacts WHERE user_id = ? AND contact_id = ?').get(senderId, receiver.id);
  if (existingContact) return res.status(400).json({ error: "Utilisateur déjà présent dans vos contacts." });

  // Vérifier si invitation déjà en attente
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
 * Récupérer les invitations en attente pour un utilisateur
 */
app.get('/api/invitations/:userId', authenticateToken, (req, res) => {
  const userId = parseInt(req.params.userId);
  if (req.user.id !== userId) return res.status(403).json({ error: "Accès refusé." });

  const invites = db.prepare(`
    SELECT invitations.id, users.username, users.nickname, users.avatar 
    FROM invitations 
    JOIN users ON invitations.sender_id = users.id 
    WHERE invitations.receiver_id = ? AND invitations.status = 'pending'
  `).all(userId);
  
  // Les colonnes sont déjà filtrées dans le SQL (DTO implicite)
  res.json(invites);
});

/**
 * Accepter une invitation
 */
app.post('/api/accept-invite', authenticateToken, (req, res) => {
  const { invitationId } = req.body;
  const userId = req.user.id; // Sécurité : On utilise l'ID du token

  const invite = db.prepare('SELECT * FROM invitations WHERE id = ?').get(invitationId);

  if (invite && invite.receiver_id === userId) {
    try {
      db.transaction(() => {
        // Ajouter dans les deux sens
        db.prepare('INSERT OR IGNORE INTO contacts (user_id, contact_id) VALUES (?, ?)').run(invite.sender_id, invite.receiver_id);
        db.prepare('INSERT OR IGNORE INTO contacts (user_id, contact_id) VALUES (?, ?)').run(invite.receiver_id, invite.sender_id);
        db.prepare('UPDATE invitations SET status = ? WHERE id = ?').run('accepted', invitationId);
      })();

      // Notifier via sockets si connectés
      const senderSocketId = onlineUsers.get(invite.sender_id);
      const receiverSocketId = onlineUsers.get(invite.receiver_id);
      if (senderSocketId) io.to(senderSocketId).emit('contact_accepted');
      if (receiverSocketId) io.to(receiverSocketId).emit('contact_accepted');

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
app.post('/api/decline-invite', authenticateToken, (req, res) => {
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
 * Récupérer la liste des contacts
 */
app.get('/api/contacts/:userId', authenticateToken, (req, res) => {
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
  
  // Les colonnes sensibles ne sont pas sélectionnées dans le SQL (DTO implicite)
  res.json(contacts);
});

/**
 * Bloquer ou débloquer un contact
 */
app.post('/api/contacts/block', authenticateToken, (req, res) => {
  const { contactId, block } = req.body;
  const userId = req.user.id;

  try {
    db.prepare('UPDATE contacts SET blocked = ? WHERE user_id = ? AND contact_id = ?').run(block ? 1 : 0, userId, contactId);

    // Notification de changement de statut
    const blocker = db.prepare('SELECT status FROM users WHERE id = ?').get(userId);
    const receiverSocketId = onlineUsers.get(contactId);
    if (receiverSocketId) {
      io.to(receiverSocketId).emit('user_status_changed', { 
        userId: userId, 
        status: block ? 'offline' : blocker.status 
      });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erreur lors de l'opération de blocage." });
  }
});

/**
 * Supprimer un contact
 */
app.post('/api/contacts/delete', authenticateToken, (req, res) => {
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
 * Gestion du chiffrement E2EE - Clés publiques/privées
 */
app.get('/api/user/:userId/public-key', authenticateToken, (req, res) => {
  const user = db.prepare('SELECT public_key FROM users WHERE id = ?').get(req.params.userId);
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

app.post('/api/user/keys', authenticateToken, (req, res) => {
  const { publicKey, encryptedPrivateKey } = req.body;
  const userId = req.user.id;

  try {
    db.prepare('UPDATE users SET public_key = ?, encrypted_private_key = ? WHERE id = ?')
      .run(JSON.stringify(publicKey), JSON.stringify(encryptedPrivateKey), userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erreur lors de la sauvegarde des clés." });
  }
});

/**
 * Basculer le mode privé global
 */
app.post('/api/user/global-private', authenticateToken, (req, res) => {
  const { globalPrivate } = req.body;
  const userId = req.user.id;

  try {
    db.prepare('UPDATE users SET global_private = ? WHERE id = ?').run(globalPrivate ? 1 : 0, userId);
    const updatedUser = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

    // Diffusion via DTO Public
    broadcastStatusToContacts(userId, toPublicUserDTO(updatedUser));

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erreur lors de la mise à jour." });
  }
});

/**
 * Mise à jour du profil utilisateur
 */
app.post('/api/user/update', authenticateToken, (req, res) => {
  const { nickname, psm, avatar, scene, status } = req.body;
  const userId = req.user.id;

  // Validation stricte des données reçues
  if (nickname && nickname.length > 50) return res.status(400).json({ error: "Surnom trop long (max 50)." });
  if (psm && psm.length > 150) return res.status(400).json({ error: "Message personnel trop long (max 150)." });

  if (avatar && !isValidPath(avatar)) return res.status(400).json({ error: "Image d'avatar invalide." });
  if (scene && !isValidPath(scene)) return res.status(400).json({ error: "Scène invalide." });

  const allowedStatus = ['online', 'busy', 'away', 'offline'];
  const finalStatus = allowedStatus.includes(status) ? status : 'online';

  try {
    const stmt = db.prepare('UPDATE users SET nickname = ?, psm = ?, avatar = ?, scene = ?, status = ? WHERE id = ?');
    stmt.run(nickname || '', psm || '', avatar || '/assets/usertiles/chess.png', scene || '/assets/scenes/0006.png', finalStatus, userId);

    const updatedUser = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    // Diffusion via DTO Public (Empêche de fuiter le encrypted_private_key lors d'un update)
    broadcastStatusToContacts(userId, toPublicUserDTO(updatedUser));

    res.json({ success: true });
  } catch (err) {
    console.error("Update profile error:", err);
    res.status(500).json({ error: "Erreur lors de la mise à jour du profil." });
  }
});

/**
 * Changement de mot de passe
 */
app.post('/api/user/change-password', authenticateToken, (req, res) => {
  const { oldPassword, newPassword, newVault } = req.body;
  const userId = req.user.id;

  const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[\W_]).{12,}$/;
  if (!passwordRegex.test(newPassword)) {
    return res.status(400).json({ error: 'Le nouveau mot de passe doit respecter les critères de sécurité.' });
  }

  const user = db.prepare('SELECT password_hash, salt FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable.' });

  if (hashPassword(oldPassword, user.salt) !== user.password_hash) {
    return res.status(401).json({ error: 'Ancien mot de passe incorrect.' });
  }

  const newSalt = crypto.randomBytes(16).toString('hex');
  const newHash = hashPassword(newPassword, newSalt);

  try {
    if (newVault) {
      db.prepare('UPDATE users SET password_hash = ?, salt = ?, encrypted_private_key = ? WHERE id = ?')
        .run(newHash, newSalt, JSON.stringify(newVault), userId);
    } else {
      db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?')
        .run(newHash, newSalt, userId);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur lors du changement de mot de passe.' });
  }
});

/**
 * Récupération de l'historique des messages
 */
app.get('/api/messages/:userId/:contactId', authenticateToken, (req, res) => {
  const { userId, contactId } = req.params;
  if (req.user.id !== parseInt(userId)) return res.status(403).json({ error: "Accès refusé." });

  const history = db.prepare(`
    SELECT messages.*, users.nickname as sender_name 
    FROM messages 
    JOIN users ON messages.sender_id = users.id
    WHERE (sender_id = ? AND receiver_id = ?) 
       OR (sender_id = ? AND receiver_id = ?)
    ORDER BY timestamp ASC
  `).all(userId, contactId, contactId, userId);
  res.json(history);
});

/**
 * Supprimer l'historique des messages entre deux utilisateurs
 */
app.post('/api/messages/clear', authenticateToken, (req, res) => {
  const { contactId } = req.body;
  const userId = req.user.id; // On utilise obligatoirement l'ID du token

  try {
    db.prepare(`
      DELETE FROM messages 
      WHERE (sender_id = ? AND receiver_id = ?) 
         OR (sender_id = ? AND receiver_id = ?)
    `).run(userId, contactId, contactId, userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erreur lors de la suppression de l'historique." });
  }
});

  /**
  * --- LOGIQUE SOCKET.IO ---
  */

const onlineUsers = new Map();     // userId -> socketId
const disconnectTimers = new Map(); // userId -> Timeout (pour gérer les rafraîchissements)
const wizzLimits = new Map();      // userId -> timestamps[]
const messageLimits = new Map();   // userId -> timestamps[]

/**
 * Middleware Socket.IO pour authentifier via Token
 */
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error("Erreur d'authentification : Token manquant"));

  jwt.verify(token, SECRET, (err, user) => {
    if (err) return next(new Error("Erreur d'authentification : Token invalide"));
    socket.user = user;
    next();
  });
});

io.on('connection', (socket) => {
  console.log('Utilisateur connecté au socket:', socket.id);

  /**
   * Identification du socket par l'ID utilisateur
   */
  socket.on('identify', (userId) => {
    if (socket.user.id !== userId) return; // Sécurité : évite l'usurpation d'identité

    // Annuler le minuteur de déconnexion si existant (cas d'un rafraîchissement rapide)
    if (disconnectTimers.has(userId)) {
      clearTimeout(disconnectTimers.get(userId));
      disconnectTimers.delete(userId);
    }
    
    const isAlreadyIdentified = onlineUsers.has(userId);
    onlineUsers.set(userId, socket.id);

    try {
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      // Diffuser si c'est une nouvelle session (premier socket pour cet utilisateur)
      if (user && !isAlreadyIdentified) {
        // Si l'utilisateur était considéré comme hors ligne, on le repasse en ligne
        let finalStatus = user.status;
        if (user.status === 'offline') {
          finalStatus = 'online';
          db.prepare('UPDATE users SET status = ? WHERE id = ?').run('online', userId);
          user.status = 'online'; // Mettre à jour l'objet pour le DTO
        }
        
        // Diffusion via DTO Public
        broadcastStatusToContacts(userId, toPublicUserDTO(user));
      }
    } catch (err) { console.error(err); }
  });

  /**
   * Envoi d'un message (Texte, Audio, etc.)
   */
  socket.on('send_message', (data) => {
    const { senderId, receiverId, text, style, audio, type, isPrivate } = data;
    
    // Vérification de sécurité de l'expéditeur
    if (socket.user.id !== senderId) return;

    // Limitation du débit (Rate Limiting) : max 20 messages par 10 secondes
    const now = Date.now();
    const timestamps = messageLimits.get(senderId) || [];
    const recentMessages = timestamps.filter(ts => now - ts < 10000);
    if (recentMessages.length >= 20) return; 
    
    recentMessages.push(now);
    messageLimits.set(senderId, recentMessages);

    
    const sender = db.prepare('SELECT global_private FROM users WHERE id = ?').get(senderId);
    const receiver = db.prepare('SELECT global_private FROM users WHERE id = ?').get(receiverId);
    const isForcedPrivate = (sender && Number(sender.global_private) === 1) || (receiver && Number(receiver.global_private) === 1);
    const finalIsPrivate = isPrivate || isForcedPrivate;

    console.log(`[Message Security] From:${senderId} To:${receiverId} ClientPrivate:${isPrivate} ForcedPrivate:${isForcedPrivate} Final:${finalIsPrivate}`);

    // Limites de taille des données (le texte peut contenir l'audio chiffré E2EE, on augmente la limite)
    if (text && text.length > 5000000) return; 
    if (audio && audio.length > 5000000) return; 

    // Vérifier si le destinataire bloque l'expéditeur
    const blocker = db.prepare('SELECT blocked FROM contacts WHERE user_id = ? AND contact_id = ?').get(receiverId, senderId);
    
    let messageToDeliver = {
      senderId,
      receiverId,
      text,
      style,
      audio,
      type,
      isPrivate: !!finalIsPrivate, // Force le flag réel imposé par le serveur
      timestamp: new Date().toISOString()
    };

    // --- MODE PRIVÉ (Non-persistance) ---
    if (!finalIsPrivate) {
      const stmt = db.prepare('INSERT INTO messages (sender_id, receiver_id, text, style, audio, type) VALUES (?, ?, ?, ?, ?, ?)');
      const info = stmt.run(senderId, receiverId, text, JSON.stringify(style), audio || null, type || 'text');
      messageToDeliver.id = info.lastInsertRowid;
    } else {
      console.log(`[Private Mode] Message éphémère de ${senderId} vers ${receiverId}`);
      messageToDeliver.id = Date.now(); // ID temporaire pour le frontend
    }

    // Si bloqué, on ne transmet pas au destinataire via socket
    if (blocker && Number(blocker.blocked) === 1) return;

    // Livraison si le destinataire est en ligne
    const receiverSocketId = onlineUsers.get(receiverId);
    if (receiverSocketId) {
      io.to(receiverSocketId).emit('receive_message', messageToDeliver);
    }
  });

  /**
   * Envoi d'un "Wizz"
   */
  socket.on('send_wizz', (data) => {
    const { senderId, receiverId } = data;
    if (socket.user.id !== senderId) return;

    // Rate limiting pour les Wizz (max 3 par minute)
    const now = Date.now();
    const timestamps = wizzLimits.get(senderId) || [];
    const recentWizz = timestamps.filter(ts => now - ts < 60000);
    if (recentWizz.length >= 3) return;
    
    recentWizz.push(now);
    wizzLimits.set(senderId, recentWizz);

    const receiverSocketId = onlineUsers.get(receiverId);
    if (receiverSocketId) {
      io.to(receiverSocketId).emit('receive_wizz', data);
    }
  });

  /**
   * Envoi d'un "Clin d'oeil" (Wink)
   */
  socket.on('send_wink', (data) => {
    const { senderId, receiverId } = data;
    if (socket.user.id !== senderId) return;

    // Rate limiting pour les Winks (max 7 par minute)
    const now = Date.now();
    const timestamps = wizzLimits.get(senderId) || []; // On partage le même limitateur pour simplifier
    const recentWinks = timestamps.filter(ts => now - ts < 60000);
    if (recentWinks.length >= 7) return;
    
    recentWinks.push(now);
    wizzLimits.set(senderId, recentWinks);

    const receiverSocketId = onlineUsers.get(receiverId);
    if (receiverSocketId) {
      io.to(receiverSocketId).emit('receive_wink', data);
    }
  });

  /**
   * Synchronisation du Mode Privé (Bidirectionnel)
   */
  socket.on('toggle_private_mode', (data) => {
    const { senderId, receiverId, isPrivate, senderNickname } = data;
    if (socket.user.id !== senderId) return;

    const receiverSocketId = onlineUsers.get(receiverId);
    if (receiverSocketId) {
      io.to(receiverSocketId).emit('private_mode_changed', { 
        senderId, 
        isPrivate,
        senderNickname 
      });
    }
  });

  /**
   * SIGNALISATION WEBRTC (Appels Audio/Vidéo)
   * Sécurisé : On utilise socket.user.id (token JWT) au lieu de faire confiance au client.
   */
  socket.on('call_request', (data) => {
    const { target, signal, audioOnly } = data;
    const targetSocketId = onlineUsers.get(target);
    
    if (targetSocketId) {
      // Récupérer l'identité réelle de l'appelant depuis la session authentifiée
      const callerUser = db.prepare('SELECT id, nickname, username FROM users WHERE id = ?').get(socket.user.id);
      if (!callerUser) return;

      io.to(targetSocketId).emit('incoming_call', { 
        caller: socket.user.id, 
        callerName: callerUser.nickname || callerUser.username, 
        signal, 
        audioOnly 
      });
    }
  });

  socket.on('webrtc_signal', (data) => {
    const { target, signal } = data; // target est le destinataire du signal
    const targetSocketId = onlineUsers.get(target);
    if (targetSocketId) {
      // On transmet le signal en précisant qui l'envoie (l'utilisateur du socket actuel)
      io.to(targetSocketId).emit('webrtc_signal', { 
        signal, 
        caller: socket.user.id 
      });
    }
  });

  socket.on('end_call', (data) => {
    const { target } = data;
    const targetSocketId = onlineUsers.get(target);
    if (targetSocketId) {
      io.to(targetSocketId).emit('call_ended', { 
        caller: socket.user.id 
      });
    }
  });

  /**
   * Gestion de la déconnexion
   */
  socket.on('disconnect', () => {
    let disconnectedUserId = null;
    for (let [userId, socketId] of onlineUsers.entries()) {
      if (socketId === socket.id) {
        disconnectedUserId = userId;
        onlineUsers.delete(userId);
        break;
      }
    }

    if (disconnectedUserId) {
      // Période de grâce de 60 secondes avant de passer en 'offline' 
      // (Plus adapté au mobile où le navigateur suspend l'onglet en arrière-plan)
      const timer = setTimeout(() => {
        try {
          db.prepare('UPDATE users SET status = ? WHERE id = ?').run('offline', disconnectedUserId);
          broadcastStatusToContacts(disconnectedUserId, { userId: disconnectedUserId, status: 'offline' });
        } catch (err) { console.error(err); }
        disconnectTimers.delete(disconnectedUserId);
      }, 60000);
      disconnectTimers.set(disconnectedUserId, timer);
    }
  });
});

/**
 * LANCEMENT DU SERVEUR
 */
httpServer.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`);
});
