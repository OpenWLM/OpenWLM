import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import multer from 'multer';
import webpush from 'web-push';
import { getClientIp } from './clientIdentity.js';
import { createAccountRateLimiter } from './accountRateLimiter.js';

/**
 * CONFIGURATION ET INITIALISATION
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const UPLOADS_DIR = path.join(__dirname, '../uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true, mode: 0o700 });
} else {
  try { fs.chmodSync(UPLOADS_DIR, 0o700); } catch (e) {}
}

// SÉCURITÉ : Interdire toute exécution de script si un serveur web frontal pointe par mégarde sur uploads
const htaccessPath = path.join(UPLOADS_DIR, '.htaccess');
if (!fs.existsSync(htaccessPath)) {
  try {
    fs.writeFileSync(htaccessPath, "Require all denied\nOptions -Indexes -ExecCGI\nRemoveHandler .php .phtml .php3 .php4 .php5 .php7 .phps .cgi .pl .py .jsp .asp .sh .bash\n");
  } catch (e) {}
}

const fileStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = crypto.randomBytes(16).toString('hex');
    cb(null, `enc_${uniqueSuffix}.bin`);
  }
});

const upload = multer({
  storage: fileStorage,
  limits: { fileSize: 100 * 1024 * 1024 } // Limite 100 Mo
});

const EMOTICONS_UPLOADS_DIR = path.join(UPLOADS_DIR, 'emoticons');
if (!fs.existsSync(EMOTICONS_UPLOADS_DIR)) {
  fs.mkdirSync(EMOTICONS_UPLOADS_DIR, { recursive: true, mode: 0o700 });
} else {
  try { fs.chmodSync(EMOTICONS_UPLOADS_DIR, 0o700); } catch (e) {}
}

const emoticonStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, EMOTICONS_UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = crypto.randomUUID();
    cb(null, `emo_${uniqueSuffix}.bin`);
  }
});

const uploadEmoticon = multer({
  storage: emoticonStorage,
  limits: { fileSize: Math.floor(1.2 * 1024 * 1024) } // Limite 1.2 Mo (GIF 1 Mo max + IV + overhead)
});

const app = express();
const httpServer = createServer(app);

// SÉCURITÉ (E2) : Aucune confiance implicite à un proxy.
// L'IP client fiable est résolue explicitement par getClientIp() (server/clientIdentity.js) :
// socket.remoteAddress en source de vérité, CF-Connecting-IP uniquement depuis une IP Cloudflare de confiance.
app.set('trust proxy', false);

const io = new Server(httpServer, {
  cors: {
    origin: "*", 
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000, // Attendre 60s avant de considérer le client déconnecté
  pingInterval: 25000 // Envoyer un ping toutes les 25s
});

const PORT = process.env.PORT || 3001;
const db = new Database('messenger.db');

/**
 * SÉCURITÉ JWT STRICTE :
 * Suppression totale du fallback statique faible ('wlm_classic_secret_key').
 * 1. Si process.env.JWT_SECRET est fourni : validation stricte de sa force (>= 32 car, interdiction des secrets faibles).
 * 2. Si non fourni : génération automatique d'une clé cryptographique forte de 256 bits (64 hex),
 *    persistée dans .jwt_secret (chmod 0600) pour garantir la continuité des sessions lors des redémarrages.
 */
const getJwtSecret = () => {
  const envSecret = process.env.JWT_SECRET ? process.env.JWT_SECRET.trim() : null;
  const FORBIDDEN_SECRETS = ['wlm_classic_secret_key', 'secret', 'jwt_secret', 'password', '123456', 'changeme'];

  if (envSecret) {
    if (FORBIDDEN_SECRETS.includes(envSecret) || envSecret.length < 32) {
      console.error("[FATAL SECURITY] Le secret JWT fourni dans JWT_SECRET est trop faible ou interdit (minimum 32 caractères requis).");
      process.exit(1);
    }
    return envSecret;
  }

  const secretPath = path.join(__dirname, '../.jwt_secret');
  if (fs.existsSync(secretPath)) {
    try {
      const savedSecret = fs.readFileSync(secretPath, 'utf8').trim();
      if (savedSecret && savedSecret.length >= 64 && !FORBIDDEN_SECRETS.includes(savedSecret)) {
        return savedSecret;
      }
    } catch (e) {
      console.warn("[Security] Impossible de lire .jwt_secret existant:", e.message);
    }
  }

  const generatedSecret = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(secretPath, generatedSecret, { mode: 0o600 });
    console.log("[Security] Nouveau secret JWT fort (256 bits) généré et stocké dans .jwt_secret.");
  } catch (err) {
    console.warn("[Security] Impossible d'écrire .jwt_secret sur le disque, secret conservé en mémoire pour ce processus.");
  }
  return generatedSecret;
};

const SECRET = getJwtSecret();

/**
 * ARCHITECTURE WEB PUSH (RFC 8291 / RFC 8292) :
 * 1. Priorité aux variables d'environnement :
 *    - VAPID_PUBLIC_KEY
 *    - VAPID_PRIVATE_KEY
 *    - VAPID_SUBJECT (défaut : 'mailto:admin@openwlm.dev')
 * 2. Repli sur le fichier local sécurisé .vapid_keys.json (chmod 0600, exclu de git)
 * 3. Validation stricte :
 *    - Si les clés sont absentes ou invalides : Web Push est désactivé proprement sans bloquer le serveur.
 *    - Si les clés sont valides : initialisation de webpush.setVapidDetails(...)
 */
const initVapid = () => {
  let publicKey = process.env.VAPID_PUBLIC_KEY ? process.env.VAPID_PUBLIC_KEY.trim() : null;
  let privateKey = process.env.VAPID_PRIVATE_KEY ? process.env.VAPID_PRIVATE_KEY.trim() : null;
  let subject = process.env.VAPID_SUBJECT ? process.env.VAPID_SUBJECT.trim() : null;

  // Repli sur .vapid_keys.json si non fourni dans l'environnement
  if (!publicKey || !privateKey) {
    const keysPath = path.join(__dirname, '../.vapid_keys.json');
    if (fs.existsSync(keysPath)) {
      try {
        const fileContent = fs.readFileSync(keysPath, 'utf8');
        const parsed = JSON.parse(fileContent);
        if (parsed.publicKey && parsed.privateKey) {
          publicKey = String(parsed.publicKey).trim();
          privateKey = String(parsed.privateKey).trim();
          if (parsed.subject && !subject) {
            subject = String(parsed.subject).trim();
          }
        }
      } catch (err) {
        console.warn('[WebPush] Impossible de lire .vapid_keys.json:', err.message);
      }
    }
  }

  // Repli sur .env si présent
  if (!publicKey || !privateKey) {
    const envPath = path.join(__dirname, '../.env');
    if (fs.existsSync(envPath)) {
      try {
        const envContent = fs.readFileSync(envPath, 'utf8');
        const pubMatch = envContent.match(/^VAPID_PUBLIC_KEY=["']?([^"'\r\n]+)["']?/m);
        const privMatch = envContent.match(/^VAPID_PRIVATE_KEY=["']?([^"'\r\n]+)["']?/m);
        const subMatch = envContent.match(/^VAPID_SUBJECT=["']?([^"'\r\n]+)["']?/m);
        if (pubMatch && !publicKey) publicKey = pubMatch[1].trim();
        if (privMatch && !privateKey) privateKey = privMatch[1].trim();
        if (subMatch && !subject) subject = subMatch[1].trim();
      } catch (e) {}
    }
  }

  if (!publicKey || !privateKey) {
    console.log('[WebPush] Clés VAPID non configurées (ou incomplètes). Web Push désactivé.');
    return null;
  }

  if (!subject) {
    subject = 'mailto:admin@openwlm.dev';
  }

  if (!subject.startsWith('mailto:') && !subject.startsWith('https://')) {
    subject = `mailto:${subject}`;
  }

  try {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    console.log(`[WebPush] VAPID configuré avec succès (Subject: ${subject}, Public: ${publicKey.slice(0, 10)}...). Web Push actif.`);
    return {
      publicKey,
      privateKey,
      subject
    };
  } catch (err) {
    console.warn(`[WebPush] Échec initialisation VAPID (${err.message}). Web Push désactivé.`);
    return null;
  }
};

const vapidConfig = initVapid();

// SÉCURITÉ (E2) : trust proxy reste désactivé (aucun X-Forwarded-* n'est utilisé pour l'IP).
// X-Forwarded-Proto est lu directement ci-dessous uniquement pour décider du flag Secure / HSTS.
app.set('trust proxy', false);

// SÉCURITÉ : Masquer l'empreinte logicielle d'Express
app.disable('x-powered-by');

const isDev = process.env.NODE_ENV === 'development';
const isProd = process.env.NODE_ENV === 'production' || !isDev;

// SÉCURITÉ : Middleware global des en-têtes HTTP et de la Content-Security-Policy
app.use((req, res, next) => {
  // Détection du protocole HTTPS sécurisé (fourni par Cloudflare via x-forwarded-proto ou req.secure)
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  // Détection du passage par Cloudflare Tunnel ou origine distante
  const isCloudflare = Boolean(req.headers['cf-ray'] || isHttps);
  const isProductionMode = isProd || isCloudflare;

  // Directives CSP adaptées au contexte réel d'exécution
  // Note : La variante nonce n’est pas retenue ici car elle n’est pas nécessaire avec le build prod observé.
  const cspDirectives = [
    "default-src 'self'",
    // En production : aucun script inline ('self' uniquement). En dev : toléré pour le HMR de Vite
    isProductionMode ? "script-src 'self'" : "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    // Compromis résiduel : 'unsafe-inline' nécessaire pour les attributs style dynamiques de React
    "style-src 'self' 'unsafe-inline'",
    // Réseau navigateur : en prod, uniquement l'origine ('self'), WebSocket sécurisé (wss:) et STUN WebRTC
    // Note : TURN n’est pas requis actuellement d’après le code observé.
    // En dev : ajout de ws: et localhost pour le serveur de développement Vite
    isProductionMode
      ? "connect-src 'self' wss: stun:"
      : "connect-src 'self' ws: wss: stun: http://localhost:* ws://localhost:*",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'"
  ];

  res.setHeader('Content-Security-Policy', cspDirectives.join('; '));

  // Anti-Clickjacking de secours pour navigateurs anciens (doublon de frame-ancestors 'none')
  res.setHeader('X-Frame-Options', 'DENY');

  // Protection contre le reniflage de type MIME
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Limitation stricte des fuites de Referrer vers l'extérieur
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Restreint le micro et la caméra à notre domaine (WebRTC) et bloque les capteurs inutiles
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(), payment=(), usb=()');

  // Isolation du contexte d'ouverture de fenêtres contre les fuites mémoire
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');

  // HSTS : Actif UNIQUEMENT en production réelle et sur une connexion HTTPS vérifiée
  if (isProductionMode && isHttps) {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }

  next();
});

// SÉCURITÉ : Configuration CORS adaptée (support du dev Vite 5173, du port serveur 3001, Electron et réseau local)
const allowedOrigins = [
  'http://localhost:3001',
  'http://127.0.0.1:3001',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'file://'
];
if (process.env.ALLOWED_ORIGINS) {
  allowedOrigins.push(...process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()));
}

const corsOptions = {
  origin: (origin, callback) => {
    // Autoriser les requêtes sans origine (comme curl, apps mobiles, Electron avec file://) ou présentes dans la liste
    if (!origin || allowedOrigins.includes(origin) || origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
      return callback(null, true);
    }
    callback(null, true); // Permissif en local tout en gardant les en-têtes corrects
  },
  methods: ['GET', 'POST'],
  optionsSuccessStatus: 200,
  credentials: true
};
app.use(cors(corsOptions));
app.use(express.json());

// PWA : Servir le Service Worker avec les en-têtes obligatoires
app.get('/sw.js', (req, res) => {
  const swDistPath = path.join(__dirname, '../dist/sw.js');
  const targetPath = fs.existsSync(swDistPath) ? swDistPath : path.join(__dirname, '../public/sw.js');
  if (fs.existsSync(targetPath)) {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Service-Worker-Allowed', '/');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.sendFile(targetPath);
  }
  res.status(404).send('Service Worker introuvable.');
});

// PWA : Servir le Manifeste avec le bon type MIME
app.get('/manifest.json', (req, res) => {
  const manifestDistPath = path.join(__dirname, '../dist/manifest.json');
  const targetPath = fs.existsSync(manifestDistPath) ? manifestDistPath : path.join(__dirname, '../public/manifest.json');
  if (fs.existsSync(targetPath)) {
    res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.sendFile(targetPath);
  }
  res.status(404).send('Manifest introuvable.');
});

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

  CREATE TABLE IF NOT EXISTS shared_files (
    id TEXT PRIMARY KEY,
    sender_id INTEGER,
    receiver_id INTEGER,
    filename TEXT,
    original_name TEXT,
    file_size INTEGER,
    file_type TEXT,
    token TEXT UNIQUE,
    expires_at INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(sender_id) REFERENCES users(id),
    FOREIGN KEY(receiver_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS custom_emoticons (
    id TEXT PRIMARY KEY,
    owner_id INTEGER NOT NULL,
    shortcut TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    is_animated INTEGER DEFAULT 0,
    asset_filename TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(owner_id, shortcut)
  );

  CREATE INDEX IF NOT EXISTS idx_custom_emoticons_owner ON custom_emoticons(owner_id);

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT,
    auth TEXT,
    user_agent TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);
`);

/**
 * Nettoyage automatique des fichiers expirés (validité 4H max)
 */
const cleanupExpiredFiles = () => {
  try {
    const now = Date.now();
    const expiredFiles = db.prepare('SELECT id, filename FROM shared_files WHERE expires_at <= ?').all(now);
    for (const f of expiredFiles) {
      const filePath = path.join(UPLOADS_DIR, f.filename);
      if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch (e) { console.error("Erreur suppression fichier disque:", e); }
      }
    }
    const result = db.prepare('DELETE FROM shared_files WHERE expires_at <= ?').run(now);
    if (result.changes > 0) {
      console.log(`[Fichiers E2EE] Nettoyage : ${result.changes} fichier(s) expiré(s) purgé(s).`);
    }
  } catch (err) {
    console.error("Erreur nettoyage fichiers expirés:", err);
  }
};
cleanupExpiredFiles();
setInterval(cleanupExpiredFiles, 10 * 60 * 1000); // Exécution toutes les 10 minutes

// Reset all users to offline on server start to fix DB/RAM mismatch
try {
  db.exec("UPDATE users SET status = 'offline'");
} catch(e) {
  console.warn("Erreur lors de la réinitialisation des statuts:", e);
}

// Ajout sécurisé d'un index unique pour éviter les doublons de contacts
try {
  db.exec("DELETE FROM contacts WHERE rowid NOT IN (SELECT min(rowid) FROM contacts GROUP BY user_id, contact_id);");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_contacts ON contacts(user_id, contact_id);");
} catch (e) {
  console.warn("Index unique contacts déjà présent ou erreur:", e.message);
}

try {
  db.exec("ALTER TABLE users ADD COLUMN global_private INTEGER DEFAULT 0;");
} catch(e) {}

// SÉCURITÉ : Colonne de révocation des sessions JWT
// Incrémentée lors de chaque changement de mot de passe ou déconnexion forcée.
// Les tokens émis avec un token_version antérieur sont rejetés.
try {
  db.exec("ALTER TABLE users ADD COLUMN token_version INTEGER DEFAULT 0;");
} catch(e) {}

// STATUTS DE MESSAGES (envoyé / remis / lu)
// 1. Colonne de statut de livraison sur les messages persistés ('sent' | 'delivered' | 'read')
try {
  db.exec("ALTER TABLE messages ADD COLUMN delivery_status TEXT DEFAULT 'sent';");
} catch(e) {}

// 2. Curseur minimal de lecture par conversation (zéro persistance en mode privé)
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_read_cursors (
      user_id INTEGER NOT NULL,
      contact_id INTEGER NOT NULL,
      last_read_message_id INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, contact_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(contact_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
} catch(e) {
  console.warn("Table conversation_read_cursors déjà présente ou erreur:", e.message);
}

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
    userId: user.id,
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
 * GESTION MULTI-SESSIONS ET ROOMS SOCKET.IO
 */
const getUserRoom = (userId) => `user:${userId}`;

const userSockets = new Map();     // userId (number) -> Set<socketId>
const socketToUser = new Map();    // socketId -> userId (number)
const onlineUsers = new Map();     // Rétrocompatibilité : userId -> socketId (dernier connu)

const isUserOnline = (userId) => {
  const sockets = userSockets.get(Number(userId));
  return Boolean(sockets && sockets.size > 0);
};

const addUserSocket = (userId, socketId) => {
  const uId = Number(userId);
  if (!userSockets.has(uId)) {
    userSockets.set(uId, new Set());
  }
  userSockets.get(uId).add(socketId);
  socketToUser.set(socketId, uId);
  onlineUsers.set(uId, socketId);
};

const removeUserSocket = (socketId) => {
  const uId = socketToUser.get(socketId);
  if (uId === undefined) return null;
  socketToUser.delete(socketId);

  const sockets = userSockets.get(uId);
  if (sockets) {
    sockets.delete(socketId);
    if (sockets.size === 0) {
      userSockets.delete(uId);
      onlineUsers.delete(uId);
      return { userId: uId, wasLastSocket: true };
    } else {
      const remainingSocket = sockets.values().next().value;
      onlineUsers.set(uId, remainingSocket);
    }
  }
  return { userId: uId, wasLastSocket: false };
};

/**
 * Diffuse un événement de changement de statut uniquement aux contacts de l'utilisateur
 * (et à toutes les sessions actives de l'utilisateur pour synchronisation)
 */
const broadcastStatusToContacts = (userId, payload) => {
  // 1. Trouver tous les utilisateurs autorisés qui ont "userId" dans leur liste de contacts (non bloqués)
  const contacts = db.prepare('SELECT user_id FROM contacts WHERE contact_id = ? AND (blocked IS NULL OR blocked = 0)').all(userId);
  
  // 2. Diffuser aux contacts via leurs rooms multi-sessions
  contacts.forEach(contact => {
    io.to(getUserRoom(contact.user_id)).emit('user_status_changed', payload);
  });

  // 3. Envoyer aussi à toutes les sessions de l'utilisateur lui-même (fanout multi-session)
  io.to(getUserRoom(userId)).emit('user_status_changed', payload);
};

/**
 * Hachage sécurisé de l'AuthKey avec PBKDF2 (210 000 itérations, SHA-512)
 * Conforme aux recommandations strictes OWASP
 */
const hashPassword = (authKeyHex, salt) => {
  return crypto.pbkdf2Sync(authKeyHex, salt, 210000, 64, 'sha512').toString('hex');
};

/**
 * SÉCURITÉ P3 : Vérification en temps constant du hachage de mot de passe (Anti-Timing Attack).
 * Utilise crypto.timingSafeEqual sur les buffers binaires pour éliminer toute fuite temporelle.
 */
const verifyPasswordHash = (authKeyHex, salt, storedHash) => {
  if (!authKeyHex || !salt || !storedHash || typeof storedHash !== 'string') return false;
  const calculatedHash = hashPassword(authKeyHex, salt);
  const bufCalc = Buffer.from(calculatedHash, 'hex');
  const bufStored = Buffer.from(storedHash, 'hex');
  if (bufCalc.length !== bufStored.length) return false;
  return crypto.timingSafeEqual(bufCalc, bufStored);
};

/**
 * SÉCURITÉ CENTRALISÉE (AUTORISATION & ANTI-USURPATION) :
 * Vérifie si senderId a le droit d'interagir avec targetId :
 * 1. Les deux identifiants doivent être des entiers strictement positifs et distincts.
 * 2. targetId doit exister dans la table users.
 * 3. Les deux utilisateurs doivent être en relation mutuelle acceptée dans contacts.
 * 4. Aucun des deux ne doit avoir bloqué l'autre.
 */
const canInteract = (senderId, targetId) => {
  const sId = parseInt(senderId, 10);
  const tId = parseInt(targetId, 10);
  if (isNaN(sId) || isNaN(tId) || sId <= 0 || tId <= 0) {
    return { allowed: false, reason: "Identifiants invalides." };
  }
  if (sId === tId) {
    return { allowed: false, reason: "Action impossible sur son propre compte." };
  }

  // Vérifier l'existence de la cible
  const targetUser = db.prepare('SELECT id FROM users WHERE id = ?').get(tId);
  if (!targetUser) {
    return { allowed: false, reason: "Utilisateur destinataire introuvable." };
  }

  // Vérifier la relation dans contacts (target -> sender)
  const targetRelation = db.prepare('SELECT status, blocked FROM contacts WHERE user_id = ? AND contact_id = ?').get(tId, sId);
  if (!targetRelation) {
    return { allowed: false, reason: "Ce contact n'est pas dans votre liste d'amis." };
  }
  if (Number(targetRelation.blocked) === 1) {
    return { allowed: false, reason: "Vous ne pouvez pas interagir avec cet utilisateur (bloqué)." };
  }

  // Vérifier la relation dans contacts (sender -> target)
  const senderRelation = db.prepare('SELECT status, blocked FROM contacts WHERE user_id = ? AND contact_id = ?').get(sId, tId);
  if (!senderRelation) {
    return { allowed: false, reason: "Ce contact n'est pas dans votre liste d'amis." };
  }
  if (Number(senderRelation.blocked) === 1) {
    return { allowed: false, reason: "Vous avez bloqué ce contact." };
  }

  return { allowed: true };
};

/**
 * Middleware de limitation de débit (Rate Limiting)
 * Prévient les attaques par force brute sur la connexion et l'inscription.
 */
const rateLimitStorage = new Map();
const authRateLimiter = (req, res, next) => {
  // SÉCURITÉ (E2) : IP client fiable uniquement (socket.remoteAddress, ou CF-Connecting-IP derrière Cloudflare).
  // X-Forwarded-For n'est jamais utilisé.
  const ip = getClientIp(req) || 'unknown';

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
 * Rate Limiter dédié aux uploads de fichiers (5/minute par IP)
 * Plus restrictif que l'auth rate limiter car les uploads consomment du stockage disque.
 */
const uploadRateLimitStorage = new Map();
const uploadRateLimiter = (req, res, next) => {
  // SÉCURITÉ (E2) : IP client fiable uniquement (jamais X-Forwarded-For).
  const ip = getClientIp(req) || 'unknown';

  const now = Date.now();
  const windowMs = 60000;
  const limit = 5;

  if (!uploadRateLimitStorage.has(ip)) {
    uploadRateLimitStorage.set(ip, []);
  }

  let timestamps = uploadRateLimitStorage.get(ip).filter(ts => now - ts < windowMs);
  
  if (timestamps.length >= limit) {
    console.warn(`[Security] Upload rate limit atteint pour l'IP: ${ip}`);
    return res.status(429).json({ error: "Trop d'envois de fichiers. Veuillez réessayer dans une minute." });
  }

  timestamps.push(now);
  uploadRateLimitStorage.set(ip, timestamps);
  next();
};

/**
 * SÉCURITÉ (E2) : Rate limiting par compte (en complément du rate limiting par IP fiable).
 * Fenêtre 15 minutes. Réinitialisé sur succès légitime.
 */
const loginAccountLimiter = createAccountRateLimiter({ windowMs: 15 * 60 * 1000, limit: 10 });
const signupAccountLimiter = createAccountRateLimiter({ windowMs: 15 * 60 * 1000, limit: 5 });
const changePasswordAccountLimiter = createAccountRateLimiter({ windowMs: 15 * 60 * 1000, limit: 10 });
const resetE2eAccountLimiter = createAccountRateLimiter({ windowMs: 15 * 60 * 1000, limit: 10 });

const accountLimiters = [
  loginAccountLimiter,
  signupAccountLimiter,
  changePasswordAccountLimiter,
  resetE2eAccountLimiter
];

const parseCookies = (cookieHeader) => {
  const list = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') return list;
  cookieHeader.split(';').forEach(cookie => {
    const parts = cookie.split('=');
    const name = parts.shift()?.trim();
    if (!name) return;
    const value = parts.join('=').trim();
    try {
      list[name] = decodeURIComponent(value);
    } catch {
      list[name] = value;
    }
  });
  return list;
};

/**
 * Middleware d'authentification par JWT
 */
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1];

  // Fallback sécurisé : Cookie HttpOnly (SameSite=Strict)
  if (!token && req.headers.cookie) {
    const cookies = parseCookies(req.headers.cookie);
    token = cookies.token;
  }
  
  if (!token) return res.status(401).json({ error: "Non autorisé. Token manquant." });

  jwt.verify(token, SECRET, (err, payload) => {
    if (err || !payload || !payload.id) return res.status(403).json({ error: "Token invalide ou expiré." });
    
    // Vérifier que l'utilisateur existe toujours en base de données
    const dbUser = db.prepare('SELECT id, username, token_version FROM users WHERE id = ?').get(payload.id);
    if (!dbUser) return res.status(401).json({ error: "Compte utilisateur introuvable ou révoqué." });

    // SÉCURITÉ : Vérifier que le token n'a pas été révoqué (changement de mot de passe, etc.)
    const currentTv = dbUser.token_version || 0;
    const tokenTv = payload.tv !== undefined ? payload.tv : 0;
    if (tokenTv !== currentTv) {
      return res.status(401).json({ error: "Session révoquée. Veuillez vous reconnecter." });
    }

    req.user = dbUser;
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
 * SÉCURITÉ P3 : Nettoyage périodique des structures en mémoire vive (Anti-Fuite Mémoire / DoS RAM).
 * Purge automatiquement :
 * 1. Les captchas expirés ou abandonnés.
 * 2. Les adresses IP inactives dans les rate limiters d'authentification et d'upload.
 */
const cleanupMemoryMaps = () => {
  const now = Date.now();
  
  // 1. Purge des captchas expirés
  for (const [id, data] of captchas.entries()) {
    if (!data || now > data.expires) {
      captchas.delete(id);
    }
  }

  // 2. Purge des adresses IP inactives dans authRateLimiter (fenêtre 60s)
  for (const [ip, timestamps] of rateLimitStorage.entries()) {
    const active = timestamps.filter(ts => now - ts < 60000);
    if (active.length === 0) {
      rateLimitStorage.delete(ip);
    } else {
      rateLimitStorage.set(ip, active);
    }
  }

  // 3. Purge des adresses IP inactives dans uploadRateLimiter (fenêtre 60s)
  for (const [ip, timestamps] of uploadRateLimitStorage.entries()) {
    const active = timestamps.filter(ts => now - ts < 60000);
    if (active.length === 0) {
      uploadRateLimitStorage.delete(ip);
    } else {
      uploadRateLimitStorage.set(ip, active);
    }
  }

  // 4. Purge des compteurs de rate limiting par compte inactifs
  for (const limiter of accountLimiters) {
    limiter.cleanup();
  }
};

// Exécution périodique toutes les 5 minutes (ne bloque pas la sortie de node si standalone)
const memoryCleanupInterval = setInterval(cleanupMemoryMaps, 5 * 60 * 1000);
if (memoryCleanupInterval.unref) memoryCleanupInterval.unref();

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
    
    // Génère/rafraîchit le token JWT pour la session mémoire vive (RAM / Socket)
    const tv = user.token_version || 0;
    const token = jwt.sign({ id: user.id, username: user.username, tv }, SECRET, { expiresIn: '24h' });

    res.json({ success: true, token, user: toPrivateUserDTO(user) });
  } catch (err) {
    res.status(500).json({ error: "Erreur serveur." });
  }
});

/**
 * Déconnexion explicite et révocation immédiate de session côté serveur
 * Incrémente atomiquement token_version en BDD : tout token JWT émis antérieurement
 * pour cet utilisateur est immédiatement invalidé (HTTP 401 sur l'API, rejet sur WebSocket).
 * Efface également le cookie de session HttpOnly; SameSite=Strict.
 */
app.post('/api/logout', (req, res) => {
  let token = req.headers['authorization']?.split(' ')[1];
  if (!token && req.headers.cookie) {
    const cookies = parseCookies(req.headers.cookie);
    token = cookies.token;
  }

  if (token) {
    try {
      const payload = jwt.verify(token, SECRET);
      if (payload && payload.id) {
        db.prepare('UPDATE users SET token_version = COALESCE(token_version, 0) + 1, status = ? WHERE id = ?').run('offline', payload.id);
        broadcastStatusToContacts(payload.id, { id: payload.id, userId: payload.id, status: 'offline' });
      }
    } catch (e) {
      // Ignorer si token invalide/expiré au moment de la déconnexion
    }
  }

  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const isCloudflare = Boolean(req.headers['cf-ray'] || isHttps);
  const isProductionMode = isProd || isCloudflare;
  const isSecure = isProductionMode && isHttps;

  res.clearCookie('token', {
    httpOnly: true,
    secure: isSecure,
    sameSite: 'strict',
    path: '/'
  });

  res.json({ success: true, message: "Session révoquée avec succès côté serveur." });
});

/**
 * Générer un défi mathématique simple pour l'inscription
 */
app.get('/api/captcha', (req, res) => {
  const num1 = Math.floor(Math.random() * 10) + 1;
  const num2 = Math.floor(Math.random() * 10) + 1;
  const id = crypto.randomUUID();
  const lang = (req.query.lang || '').toString().toLowerCase();
  
  // Expiration après 5 minutes
  captchas.set(id, { answer: num1 + num2, expires: Date.now() + 5 * 60000 });
  
  const text = lang === 'en' ? `How much is ${num1} + ${num2}?` : `Combien font ${num1} + ${num2} ?`;
  res.json({ id, num1, num2, text });
});

/**
 * Inscription d'un nouvel utilisateur
 */
app.post('/api/signup', authRateLimiter, (req, res) => {
  const { username, password, nickname, captchaId, captchaAnswer } = req.body;

  // SÉCURITÉ (E2) : rate limiting par compte (par nom d'utilisateur)
  const signupLimit = signupAccountLimiter.attempt(username);
  if (!signupLimit.allowed) {
    return res.status(429).json({ error: "Trop de tentatives d'inscription pour ce compte. Veuillez réessayer plus tard." });
  }
  
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

  // 3. Validation de la clé d'authentification (Zero-Knowledge hex 256 bits)
  if (!password || typeof password !== 'string' || !/^[a-fA-F0-9]{64}$/.test(password)) {
    return res.status(400).json({ error: "Clé d'authentification invalide (format hex 256 bits requis)." });
  }

  // 4. Hachage sécurisé PBKDF2 (210 000 itérations) et insertion
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  
  try {
    const stmt = db.prepare('INSERT INTO users (username, password_hash, salt, nickname, psm, avatar, scene, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    stmt.run(username, hash, salt, nickname || username, 'Disponible', '/assets/usertiles/chess.png', '/assets/scenes/0006.png', 'offline');
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: 'Nom d\'utilisateur déjà utilisé ou erreur système.' });
  }
});

/**
 * Connexion utilisateur (Zero-Knowledge)
 */
app.post('/api/login', authRateLimiter, (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) return res.status(400).json({ error: 'Identifiants requis.' });

  // SÉCURITÉ (E2) : rate limiting par compte (par nom d'utilisateur) en plus du rate limiting par IP
  const loginLimit = loginAccountLimiter.attempt(username);
  if (!loginLimit.allowed) {
    return res.status(429).json({ error: "Trop de tentatives de connexion pour ce compte. Veuillez réessayer plus tard." });
  }

  if (typeof password !== 'string' || !/^[a-fA-F0-9]{64}$/.test(password)) {
    return res.status(400).json({ error: "Format de clé d'authentification invalide." });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  
  if (user && verifyPasswordHash(password, user.salt, user.password_hash)) {
    // SÉCURITÉ (E2) : connexion réussie -> le quota du compte est remis à zéro
    loginAccountLimiter.reset(username);
    // Création d'un token valable 24h avec token_version pour révocation
    const tv = user.token_version || 0;
    const token = jwt.sign({ id: user.id, username: user.username, tv }, SECRET, { expiresIn: '24h' });
    
    // SÉCURITÉ : Définition du cookie de session HttpOnly; SameSite=Strict
    const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
    const isCloudflare = Boolean(req.headers['cf-ray'] || isHttps);
    const isProductionMode = isProd || isCloudflare;
    const isSecure = isProductionMode && isHttps;

    res.cookie('token', token, {
      httpOnly: true,
      secure: isSecure,
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000,
      path: '/'
    });

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

      // Notifier via les rooms multi-sessions
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

    // Notification de changement de statut via room multi-sessions
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
 * Réinitialisation d'urgence des clés E2E de l'utilisateur (Anti-Compromission).
 * 
 * Sécurité et atomicité :
 * 1. Authentification stricte par JWT (req.user.id dérivé du token vérifié).
 * 2. Contrôle d'accès : Rejet immédiat (HTTP 403) si un userId discordé est fourni dans le corps de requête.
 * 3. Vérification Zero-Knowledge : Requiert authKeyHex et valide le mot de passe en temps constant.
 * 4. Transaction atomique :
 *    - Remplacement des clés publique et privée chiffrée.
 *    - Suppression définitive de tous les messages chiffrés sur le serveur (expéditeur ou destinataire).
 *    - Suppression des curseurs de lecture associés.
 *    - Incrémentation de token_version pour révoquer toutes les sessions JWT actives.
 * 5. Notification temps réel :
 *    - Diffusion immédiate de la nouvelle clé publique aux contacts (déclenche la réinitialisation du Safety Number).
 */
app.post('/api/user/reset-e2e-keys', authenticateToken, (req, res) => {
  const userId = req.user.id;
  const { authKeyHex, publicKey, encryptedPrivateKey } = req.body;

  // SÉCURITÉ (E2) : rate limiting par compte
  const resetLimit = resetE2eAccountLimiter.attempt(userId);
  if (!resetLimit.allowed) {
    return res.status(429).json({ error: "Trop de tentatives de réinitialisation E2E. Veuillez réessayer plus tard." });
  }

  // SÉCURITÉ : Contrôle d'accès strict (l'utilisateur ne peut réinitialiser QUE sa propre identité)
  if (req.body.userId !== undefined && Number(req.body.userId) !== userId) {
    return res.status(403).json({ error: "Action non autorisée : vous ne pouvez réinitialiser que votre propre identité." });
  }

  // Validation du format des paramètres
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

  // Vérification Zero-Knowledge du mot de passe
  if (!verifyPasswordHash(authKeyHex, user.salt, user.password_hash)) {
    return res.status(401).json({ error: "Mot de passe incorrect." });
  }

  try {
    db.transaction(() => {
      // 1. Mise à jour de la nouvelle paire de clés cryptographiques
      db.prepare('UPDATE users SET public_key = ?, encrypted_private_key = ? WHERE id = ?')
        .run(JSON.stringify(publicKey), JSON.stringify(encryptedPrivateKey), userId);

      // 2. Suppression de tous les anciens messages chiffrés sur le serveur (devenus indéchiffrables)
      db.prepare('DELETE FROM messages WHERE sender_id = ? OR receiver_id = ?')
        .run(userId, userId);

      // 3. Suppression des curseurs de lecture associés
      db.prepare('DELETE FROM conversation_read_cursors WHERE user_id = ? OR contact_id = ?')
        .run(userId, userId);

      // 4. Révocation de toutes les sessions actives (incrémentation de token_version)
      db.prepare('UPDATE users SET token_version = COALESCE(token_version, 0) + 1 WHERE id = ?')
        .run(userId);
    })();

    // 5. Diffusion en temps réel de la nouvelle clé publique aux contacts connectés
    const updatedUser = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    broadcastStatusToContacts(userId, toPublicUserDTO(updatedUser));

    // 6. Révocation immédiate et forcée de toutes les connexions WebSocket existantes pour cet utilisateur
    try {
      io.in(getUserRoom(userId)).disconnectSockets(true);
    } catch (e) {
      console.warn("[E2EE Reset] Erreur déconnexion sockets:", e);
    }

    // SÉCURITÉ (E2) : réinitialisation réussie -> quota du compte remis à zéro
    resetE2eAccountLimiter.reset(userId);
    res.json({ success: true, message: "Clés E2E réinitialisées avec succès." });
  } catch (err) {
    console.error("[E2EE Reset] Erreur lors de la réinitialisation:", err);
    res.status(500).json({ error: "Erreur lors de la réinitialisation des clés E2E." });
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
    // Diffusion via DTO Public (Empêche de fuiter le encrypted_private_key lors d'un update)
    broadcastStatusToContacts(userId, toPublicUserDTO(updatedUser));

    res.json({ success: true, user: toPublicUserDTO(updatedUser) });
  } catch (err) {
    console.error("Update profile error:", err);
    res.status(500).json({ error: "Erreur lors de la mise à jour du profil." });
  }
});

/**
 * Changement de mot de passe (Zero-Knowledge)
 * Ne reçoit jamais de mot de passe brut : valide oldAuthKeyHex et met à jour
 * le hash et encryptedPrivateKey de manière atomique.
 */
app.post('/api/user/change-password', authenticateToken, (req, res) => {
  const { oldAuthKeyHex, newAuthKeyHex, newEncryptedPrivateKey } = req.body;
  const oldKey = oldAuthKeyHex || req.body.oldPassword;
  const newKey = newAuthKeyHex || req.body.newPassword;
  const newVault = newEncryptedPrivateKey || req.body.newVault;
  const userId = req.user.id;

  // SÉCURITÉ (E2) : rate limiting par compte
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
      // SÉCURITÉ : Incrémenter token_version pour révoquer toutes les sessions JWT existantes
      db.prepare('UPDATE users SET token_version = COALESCE(token_version, 0) + 1 WHERE id = ?').run(userId);
    })();
    // SÉCURITÉ (E2) : changement réussi -> quota du compte remis à zéro
    changePasswordAccountLimiter.reset(userId);
    res.json({ success: true });
  } catch (err) {
    console.error("Change password error:", err);
    res.status(500).json({ error: 'Erreur lors du changement de mot de passe.' });
  }
});

/**
 * Récupération de l'historique des messages
 */
app.get('/api/messages/:userId/:contactId', authenticateToken, (req, res) => {
  const { userId, contactId } = req.params;
  const uId = parseInt(userId, 10);
  const cId = parseInt(contactId, 10);
  if (req.user.id !== uId) return res.status(403).json({ error: "Accès refusé." });

  // 1. Marquer les messages envoyés par le contact vers moi comme 'delivered'
  // (car ma session est en train de les récupérer via l'historique officiel)
  try {
    db.prepare(`
      UPDATE messages 
      SET delivery_status = 'delivered' 
      WHERE sender_id = ? AND receiver_id = ? AND delivery_status = 'sent'
    `).run(cId, uId);
  } catch(e) {}

  // 2. Curseur de lecture du contact (jusqu'à quel message le contact a lu mes messages)
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

  // Harmoniser le delivery_status des messages émis par l'utilisateur connecté
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
 * Supprimer l'historique des messages entre deux utilisateurs
 */
app.post('/api/messages/clear', authenticateToken, (req, res) => {
  const { contactId } = req.body;
  const userId = req.user.id; // On utilise obligatoirement l'ID du token
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

/**
 * --- ENVOI ET TÉLÉCHARGEMENT DE FICHIERS CHIFFRÉS (E2EE) ---
 */

/**
 * Upload d'un fichier chiffré de bout en bout
 * Le serveur reçoit uniquement des octets chiffrés avec AES-GCM (Zero-Knowledge)
 * Validité : 4 heures maximum
 */
app.post('/api/files/upload', authenticateToken, uploadRateLimiter, (req, res) => {
  upload.single('file')(req, res, (err) => {
    // 1. GESTION PROPRE DES ERREURS MULTER (Ex: dépassement de taille)
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({
            error: "Le fichier dépasse la taille maximale autorisée de 100 Mo."
          });
        }
        return res.status(400).json({ error: `Erreur d'envoi du fichier : ${err.message}` });
      }
      return res.status(400).json({ error: err.message || "Erreur lors du téléversement du fichier." });
    }

    if (!req.file) {
      return res.status(400).json({ error: "Aucun fichier reçu." });
    }

    // 2. NE PAS FAIRE CONFIANCE AU MIME ET NOM DÉCLARÉS PAR LE CLIENT
    // - Assainir le nom original pour bloquer toute tentative de path traversal ou caractères de contrôle
    const rawOriginalName = String(req.body.originalName || 'fichier_chiffre.bin');
    const safeOriginalName = path.basename(rawOriginalName).replace(/[/\\\\?%*:|"<>]/g, '_').slice(0, 255) || 'fichier_chiffre.bin';

    // - Valider strictement le format MIME 'type/subtype' (sans l'utiliser comme type d'exécution serveur)
    const rawFileType = String(req.body.fileType || 'application/octet-stream');
    const mimeRegex = /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/;
    const safeFileType = mimeRegex.test(rawFileType) ? rawFileType.slice(0, 100) : 'application/octet-stream';

    const senderId = req.user.id;
    const receiverId = parseInt(req.body.receiverId);
    const fileSize = req.file.size;

    if (!receiverId || isNaN(receiverId)) {
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: "Destinataire manquant ou invalide." });
    }

    // 3. SÉCURITÉ : Vérifier que l'expéditeur a le droit d'interagir avec le destinataire
    const check = canInteract(senderId, receiverId);
    if (!check.allowed) {
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(403).json({ error: check.reason });
    }

    // 4. SÉCURITÉ : Quota de stockage — 1 Go max de fichiers actifs par compte
    const QUOTA_BYTES = 1 * 1024 * 1024 * 1024; // 1 Go
    const usageRow = db.prepare('SELECT COALESCE(SUM(file_size), 0) as total FROM shared_files WHERE sender_id = ?').get(senderId);
    const currentUsage = usageRow ? usageRow.total : 0;
    if (currentUsage + fileSize > QUOTA_BYTES) {
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      const usedMB = Math.round(currentUsage / (1024 * 1024));
      return res.status(413).json({ 
        error: `Quota de stockage dépassé (${usedMB} Mo utilisés sur 1 Go). Attendez l'expiration de vos anciens fichiers.` 
      });
    }

    const fileId = crypto.randomUUID();
    const token = crypto.randomBytes(24).toString('hex');
    const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
    const expiresAt = Date.now() + FOUR_HOURS_MS;

    try {
      const stmt = db.prepare(`
        INSERT INTO shared_files (id, sender_id, receiver_id, filename, original_name, file_size, file_type, token, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(fileId, senderId, receiverId, req.file.filename, safeOriginalName, fileSize, safeFileType, token, expiresAt);

      res.json({
        success: true,
        fileId,
        token,
        downloadUrl: `/api/files/download/${fileId}?token=${token}`,
        expiresAt,
        originalName: safeOriginalName,
        fileSize
      });
    } catch (dbErr) {
      console.error("Erreur enregistrement fichier:", dbErr);
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      res.status(500).json({ error: "Erreur lors de l'enregistrement du fichier." });
    }
  });
});

/**
 * Téléchargement d'un fichier chiffré
 * Vérifie le token d'accès et l'expiration (4h max)
 */
app.get('/api/files/download/:fileId', (req, res) => {
  const { fileId } = req.params;
  const { token } = req.query;

  if (!token) {
    return res.status(401).json({ error: "Token d'accès manquant." });
  }

  const fileRecord = db.prepare('SELECT * FROM shared_files WHERE id = ?').get(fileId);
  if (!fileRecord) {
    return res.status(404).json({ error: "Fichier introuvable ou supprimé." });
  }

  if (fileRecord.token !== token) {
    return res.status(403).json({ error: "Token d'accès non valide." });
  }

  if (Date.now() > fileRecord.expires_at) {
    // Purger le fichier car expiré
    const filePath = path.join(UPLOADS_DIR, fileRecord.filename);
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (e) {}
    }
    db.prepare('DELETE FROM shared_files WHERE id = ?').run(fileId);
    return res.status(410).json({ error: "Ce lien de téléchargement a expiré (validité 4H max)." });
  }

  const filePath = path.join(UPLOADS_DIR, fileRecord.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Fichier physique introuvable sur le disque." });
  }

  // SÉCURITÉ MIME & ANTI-EXÉCUTION :
  // Le serveur ne fait JAMAIS confiance au MIME déclaré par le client.
  // 1. Content-Type forcé en application/octet-stream (flux binaire brut).
  // 2. X-Content-Type-Options: nosniff pour interdire au navigateur de renifler ou interpréter du code (HTML, JS, SVG).
  // 3. Content-Security-Policy: sandbox stricte pour neutraliser toute possibilité d'exécution de script.
  // 4. Content-Disposition: attachment avec nom anonymisé .bin pour forcer le téléchargement sans ouverture inline.
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Content-Disposition', `attachment; filename="encrypted_${fileRecord.id}.bin"`);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.sendFile(filePath);
});

/**
 * Information sur l'état d'un fichier partagé (expiration, statut)
 */
app.get('/api/files/info/:fileId', (req, res) => {
  const { fileId } = req.params;
  const { token } = req.query;

  const fileRecord = db.prepare('SELECT * FROM shared_files WHERE id = ?').get(fileId);
  if (!fileRecord || fileRecord.token !== token) {
    return res.status(404).json({ error: "Fichier introuvable." });
  }

  const isExpired = Date.now() > fileRecord.expires_at;
  res.json({
    fileId: fileRecord.id,
    originalName: fileRecord.original_name,
    fileSize: fileRecord.file_size,
    fileType: fileRecord.file_type,
    expiresAt: fileRecord.expires_at,
    isExpired,
    remainingSeconds: Math.max(0, Math.floor((fileRecord.expires_at - Date.now()) / 1000))
  });
});

/**
 * --- GESTION DES ÉMOTICÔNES PERSONNALISÉES (E2EE ZERO-KNOWLEDGE) ---
 */

// 1. Récupération des métadonnées des émoticônes de l'utilisateur connecté
app.get('/api/emoticons/custom/my', authenticateToken, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT id, shortcut, mime_type, file_size, width, height, is_animated, created_at 
      FROM custom_emoticons 
      WHERE owner_id = ? 
      ORDER BY created_at ASC
    `).all(req.user.id);
    res.json({ success: true, emoticons: rows });
  } catch (err) {
    console.error("Erreur récupération émoticônes custom:", err);
    res.status(500).json({ error: "Erreur serveur lors de la récupération des émoticônes." });
  }
});

// 2. Upload d'un asset chiffré d'émoticône personnalisée
app.post('/api/emoticons/custom/upload', authenticateToken, (req, res) => {
  uploadEmoticon.single('file')(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: "L'émoticône dépasse la taille autorisée (max 1 Mo pour GIF, 256 Ko pour image statique)." });
      }
      return res.status(400).json({ error: err.message || "Erreur lors du téléversement de l'émoticône." });
    }

    if (!req.file) {
      return res.status(400).json({ error: "Aucun fichier reçu." });
    }

    const cleanupFile = () => {
      if (req.file?.path && fs.existsSync(req.file.path)) {
        try { fs.unlinkSync(req.file.path); } catch (e) {}
      }
    };

    try {
      // Quota : max 100 émoticônes personnalisées par utilisateur
      const countRow = db.prepare('SELECT COUNT(*) as count FROM custom_emoticons WHERE owner_id = ?').get(req.user.id);
      if (countRow && countRow.count >= 100) {
        cleanupFile();
        return res.status(400).json({ error: "Quota atteint (100 émoticônes personnalisées maximum par compte)." });
      }

      // Validation stricte du shortcut
      const shortcut = String(req.body.shortcut || '').trim();
      const shortcutRegex = /^[\w\-():;@#!?*~[\]{}]{2,32}$/;
      if (shortcut.length < 2 || shortcut.length > 32 || !shortcutRegex.test(shortcut)) {
        cleanupFile();
        return res.status(400).json({ error: "Raccourci invalide (2 à 32 caractères, lettres, chiffres et symboles usuels autorisés)." });
      }

      // Vérification doublon de shortcut pour le même utilisateur
      const existing = db.prepare('SELECT id FROM custom_emoticons WHERE owner_id = ? AND shortcut = ?').get(req.user.id, shortcut);
      if (existing) {
        cleanupFile();
        return res.status(400).json({ error: "Ce raccourci existe déjà dans vos émoticônes." });
      }

      // Whitelist stricte du type MIME
      const allowedMimes = ['image/png', 'image/webp', 'image/gif', 'image/jpeg'];
      const mimeType = String(req.body.mimeType || '').toLowerCase();
      if (!allowedMimes.includes(mimeType)) {
        cleanupFile();
        return res.status(400).json({ error: "Format non supporté (PNG, WebP, GIF ou JPEG uniquement)." });
      }

      // Validation dimensions (max 128x128)
      const width = parseInt(req.body.width, 10);
      const height = parseInt(req.body.height, 10);
      if (isNaN(width) || isNaN(height) || width < 1 || width > 128 || height < 1 || height > 128) {
        cleanupFile();
        return res.status(400).json({ error: "Dimensions invalides (128x128 pixels maximum)." });
      }

      // Validation animation et poids strict
      const isAnimated = (req.body.isAnimated === 'true' || req.body.isAnimated === true || req.body.isAnimated === 1 || req.body.isAnimated === '1') ? 1 : 0;
      // 1 Mo max pour GIF (+ 1024 o pour IV et overhead), 256 Ko max pour statique (+ 1024 o)
      const maxAllowedSize = isAnimated ? (1024 * 1024 + 1024) : (256 * 1024 + 1024);
      if (req.file.size > maxAllowedSize) {
        cleanupFile();
        return res.status(400).json({ error: isAnimated ? "Le GIF animé dépasse 1 Mo." : "L'image statique dépasse 256 Ko." });
      }

      const assetId = 'emo_' + crypto.randomUUID();
      const now = Date.now();

      const stmt = db.prepare(`
        INSERT INTO custom_emoticons (id, owner_id, shortcut, mime_type, file_size, width, height, is_animated, asset_filename, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(assetId, req.user.id, shortcut, mimeType, req.file.size, width, height, isAnimated, req.file.filename, now);

      res.json({
        success: true,
        emoticon: {
          id: assetId,
          shortcut,
          mime_type: mimeType,
          file_size: req.file.size,
          width,
          height,
          is_animated: isAnimated,
          created_at: now
        }
      });
    } catch (dbErr) {
      console.error("Erreur insertion émoticône custom:", dbErr);
      cleanupFile();
      res.status(500).json({ error: "Erreur serveur lors de l'enregistrement de l'émoticône." });
    }
  });
});

// 3. Téléchargement d'un asset chiffré (Zero-Knowledge, accessible aux utilisateurs authentifiés)
app.get('/api/emoticons/custom/asset/:assetId', authenticateToken, (req, res) => {
  const { assetId } = req.params;
  const emoRecord = db.prepare('SELECT asset_filename, mime_type FROM custom_emoticons WHERE id = ?').get(assetId);

  if (!emoRecord) {
    return res.status(404).json({ error: "Émoticône introuvable." });
  }

  const filePath = path.join(EMOTICONS_UPLOADS_DIR, emoRecord.asset_filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Asset introuvable sur le disque." });
  }

  // SÉCURITÉ MIME & ANTI-EXÉCUTION (Identique au pipeline E2EE de fichiers)
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cache-Control', 'public, max-age=604800, immutable'); // Cache 7 jours immuable car assetId est unique
  res.sendFile(filePath);
});

// 4. Suppression d'une émoticône personnalisée par son propriétaire
app.delete('/api/emoticons/custom/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  const emoRecord = db.prepare('SELECT asset_filename FROM custom_emoticons WHERE id = ? AND owner_id = ?').get(id, req.user.id);

  if (!emoRecord) {
    return res.status(404).json({ error: "Émoticône introuvable ou non autorisée." });
  }

  const filePath = path.join(EMOTICONS_UPLOADS_DIR, emoRecord.asset_filename);
  if (fs.existsSync(filePath)) {
    try { fs.unlinkSync(filePath); } catch (e) { console.error("Erreur suppression asset disque:", e); }
  }

  db.prepare('DELETE FROM custom_emoticons WHERE id = ?').run(id);
  res.json({ success: true });
});

/**
 * --- ARCHITECTURE WEB PUSH (Android / PWA Arrière-plan) ---
 */

// Statut de l'infrastructure Web Push
app.get('/api/push/status', (req, res) => {
  res.json({
    available: true,
    hasVapid: Boolean(vapidConfig),
    publicKey: vapidConfig ? vapidConfig.publicKey : null,
    subject: vapidConfig ? vapidConfig.subject : null
  });
});

// Enregistrement d'un abonnement Push (Client Web / Android PWA)
app.post('/api/push/subscribe', authenticateToken, (req, res) => {
  const { subscription } = req.body || {};
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: "Abonnement Push invalide." });
  }

  const endpoint = String(subscription.endpoint).slice(0, 1000);
  const p256dh = subscription.keys && subscription.keys.p256dh ? String(subscription.keys.p256dh).slice(0, 255) : null;
  const auth = subscription.keys && subscription.keys.auth ? String(subscription.keys.auth).slice(0, 255) : null;
  const userAgent = req.headers['user-agent'] ? String(req.headers['user-agent']).slice(0, 500) : null;
  const now = Date.now();

  try {
    const stmt = db.prepare(`
      INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET
        user_id = excluded.user_id,
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        user_agent = excluded.user_agent,
        created_at = excluded.created_at
    `);
    stmt.run(req.user.id, endpoint, p256dh, auth, userAgent, now);
    res.json({ success: true });
  } catch (err) {
    console.error('[WebPush] Erreur enregistrement subscription:', err);
    res.status(500).json({ error: "Erreur serveur lors de l'enregistrement de l'abonnement." });
  }
});

// Désabonnement Push
app.post('/api/push/unsubscribe', authenticateToken, (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) {
    return res.status(400).json({ error: "Endpoint manquant." });
  }

  try {
    db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(req.user.id, String(endpoint));
    res.json({ success: true });
  } catch (err) {
    console.error('[WebPush] Erreur suppression subscription:', err);
    res.status(500).json({ error: "Erreur serveur lors de la suppression de l'abonnement." });
  }
});

// Test d'envoi Web Push pour le compte connecté
app.post('/api/push/test', authenticateToken, async (req, res) => {
  if (!vapidConfig) {
    return res.status(400).json({ success: false, error: "Web Push non configuré sur le serveur (clés VAPID manquantes)." });
  }

  try {
    const subs = db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?').all(req.user.id);
    if (!subs || subs.length === 0) {
      return res.status(404).json({ success: false, error: "Aucun appareil enregistré en Web Push pour cet utilisateur." });
    }

    const result = await dispatchPushNotification(req.user.id, {
      title: 'OpenWLM — Test Push',
      body: 'La notification Web Push fonctionne correctement sur cet appareil !',
      icon: '/pwa-maskable-192x192.png',
      badge: '/assets/openwlm_logo.png',
      tag: 'openwlm-test',
      data: { url: '/', test: true }
    });

    res.json({ success: true, count: subs.length, sent: result.sent, failed: result.failed });
  } catch (err) {
    console.error('[WebPush] Erreur endpoint test push:', err);
    res.status(500).json({ success: false, error: "Erreur serveur lors de l'envoi du push de test." });
  }
});

/**
 * Dispatch Web Push vers le destinataire en arrière-plan (Android / PWA inactive)
 */
const dispatchPushNotification = async (receiverId, payload) => {
  if (!vapidConfig) {
    return { sent: 0, failed: 0, reason: 'vapid_disabled' };
  }

  try {
    const subs = db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?').all(receiverId);
    if (!subs || subs.length === 0) return { sent: 0, failed: 0 };

    const payloadString = typeof payload === 'string' ? payload : JSON.stringify(payload);
    let sent = 0;
    let failed = 0;

    await Promise.all(subs.map(async (sub) => {
      try {
        const pushSubscription = {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh,
            auth: sub.auth
          }
        };

        await webpush.sendNotification(pushSubscription, payloadString, {
          TTL: 86400
        });
        sent++;
      } catch (err) {
        failed++;
        // Endpoint désinscrit ou expiré par FCM/Mozilla Autopush/Apple Push Service (404/410)
        if (err.statusCode === 404 || err.statusCode === 410) {
          try {
            db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(sub.endpoint);
            console.log(`[WebPush] Abonnement expiré supprimé (${err.statusCode}): ${sub.endpoint.slice(0, 45)}...`);
          } catch (dbErr) {
            console.warn('[WebPush] Erreur nettoyage abonnement expiré:', dbErr);
          }
        } else {
          console.warn(`[WebPush] Échec envoi push (${err.statusCode || err.message}) vers ${sub.endpoint.slice(0, 45)}...`);
        }
      }
    }));

    if (sent > 0) {
      console.log(`[WebPush] Notification envoyée avec succès à ${sent}/${subs.length} appareil(s) pour user ${receiverId}`);
    }

    return { sent, failed };
  } catch (err) {
    console.warn('[WebPush] Erreur dispatch notification:', err);
    return { sent: 0, failed: 0, error: err.message };
  }
};

  /**
  * --- LOGIQUE SOCKET.IO ---
  */

const disconnectTimers = new Map(); // userId -> Timeout (pour gérer les rafraîchissements)
const wizzLimits = new Map();      // userId -> timestamps[]
const messageLimits = new Map();   // userId -> timestamps[]
const activeGames = new Map();     // gameKey -> session de jeu sécurisée (anti-usurpation et vérification de tour)
/**
 * SÉCURITÉ : Invitations de jeu en attente avec expiration (60 secondes).
 * Clé : "inviterId_targetId_gameType" -> timestamp de l'invitation.
 * game_accept ne sera autorisé que si une invitation valide et non expirée existe.
 */
const pendingGameInvites = new Map();
const GAME_INVITE_TTL_MS = 60 * 1000; // 60 secondes

const getGameKey = (id1, id2) => {
  const [min, max] = Number(id1) < Number(id2) ? [id1, id2] : [id2, id1];
  return `${min}_${max}`;
};

const createInitialCheckersBoard = () => {
  const b = Array(8).fill(null).map(() => Array(8).fill(null));
  // Noirs (b) en haut : rangées 0, 1, 2 sur cases sombres
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 8; c++) {
      if ((r + c) % 2 === 1) b[r][c] = 'b';
    }
  }
  // Blancs (w) en bas : rangées 5, 6, 7 sur cases sombres
  for (let r = 5; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if ((r + c) % 2 === 1) b[r][c] = 'w';
    }
  }
  return b;
};

const createEmptyPuissance4Board = () => {
  return Array.from({ length: 6 }, () => Array(7).fill(null));
};

const isPuissance4BoardFull = (board) => {
  for (let c = 0; c < 7; c++) {
    if (board[0][c] === null) return false;
  }
  return true;
};

const checkPuissance4Winner = (board) => {
  const ROWS = 6;
  const COLS = 7;

  // 1. Horizontale
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c <= COLS - 4; c++) {
      const p = board[r][c];
      if (p && p === board[r][c + 1] && p === board[r][c + 2] && p === board[r][c + 3]) {
        return { winner: p, winningCells: [[r, c], [r, c + 1], [r, c + 2], [r, c + 3]] };
      }
    }
  }

  // 2. Verticale
  for (let r = 0; r <= ROWS - 4; r++) {
    for (let c = 0; c < COLS; c++) {
      const p = board[r][c];
      if (p && p === board[r + 1][c] && p === board[r + 2][c] && p === board[r + 3][c]) {
        return { winner: p, winningCells: [[r, c], [r + 1, c], [r + 2, c], [r + 3, c]] };
      }
    }
  }

  // 3. Diagonale descendante (\)
  for (let r = 0; r <= ROWS - 4; r++) {
    for (let c = 0; c <= COLS - 4; c++) {
      const p = board[r][c];
      if (p && p === board[r + 1][c + 1] && p === board[r + 2][c + 2] && p === board[r + 3][c + 3]) {
        return { winner: p, winningCells: [[r, c], [r + 1, c + 1], [r + 2, c + 2], [r + 3, c + 3]] };
      }
    }
  }

  // 4. Diagonale montante (/)
  for (let r = 3; r < ROWS; r++) {
    for (let c = 0; c <= COLS - 4; c++) {
      const p = board[r][c];
      if (p && p === board[r - 1][c + 1] && p === board[r - 2][c + 2] && p === board[r - 3][c + 3]) {
        return { winner: p, winningCells: [[r, c], [r - 1, c + 1], [r - 2, c + 2], [r - 3, c + 3]] };
      }
    }
  }

  return null;
};

/**
 * Middleware Socket.IO pour authentifier via Token
 */
io.use((socket, next) => {
  let token = socket.handshake.auth?.token;
  if (!token && socket.handshake.headers?.cookie) {
    const cookies = parseCookies(socket.handshake.headers.cookie);
    token = cookies.token;
  }
  if (!token) return next(new Error("Erreur d'authentification : Token manquant"));

  jwt.verify(token, SECRET, (err, payload) => {
    if (err || !payload || !payload.id) return next(new Error("Erreur d'authentification : Token invalide ou expiré"));

    // Vérifier que l'utilisateur existe toujours en base de données
    const dbUser = db.prepare('SELECT id, username, token_version FROM users WHERE id = ?').get(payload.id);
    if (!dbUser) return next(new Error("Erreur d'authentification : Compte utilisateur introuvable ou révoqué"));

    // SÉCURITÉ : Vérifier que le token n'a pas été révoqué
    const currentTv = dbUser.token_version || 0;
    const tokenTv = payload.tv !== undefined ? payload.tv : 0;
    if (tokenTv !== currentTv) {
      return next(new Error("Session révoquée. Veuillez vous reconnecter."));
    }

    socket.user = dbUser;
    next();
  });
});

io.on('connection', (socket) => {
  console.log('Utilisateur connecté au socket:', socket.id);

  // Authentification automatique dans la room utilisateur dès la connexion réussie
  const authUserId = socket.user?.id;
  if (authUserId) {
    socket.join(getUserRoom(authUserId));
    const wasAlreadyOnline = isUserOnline(authUserId);
    addUserSocket(authUserId, socket.id);

    if (disconnectTimers.has(authUserId)) {
      clearTimeout(disconnectTimers.get(authUserId));
      disconnectTimers.delete(authUserId);
    }

    if (!wasAlreadyOnline) {
      try {
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(authUserId);
        if (user) {
          if (user.status === 'offline') {
            db.prepare('UPDATE users SET status = ? WHERE id = ?').run('online', authUserId);
            user.status = 'online';
          }
          broadcastStatusToContacts(authUserId, toPublicUserDTO(user));
        }
      } catch (err) { console.error(err); }
    }
  }

  /**
   * Identification du socket par l'ID utilisateur
   */
  socket.on('identify', (userId) => {
    if (socket.user.id !== userId) return; // Sécurité : évite l'usurpation d'identité

    socket.join(getUserRoom(userId));

    // Annuler le minuteur de déconnexion si existant (cas d'un rafraîchissement rapide)
    if (disconnectTimers.has(userId)) {
      clearTimeout(disconnectTimers.get(userId));
      disconnectTimers.delete(userId);
    }
    
    const wasAlreadyOnline = isUserOnline(userId);
    addUserSocket(userId, socket.id);

    try {
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      // Diffuser si c'est une nouvelle session (premier socket pour cet utilisateur)
      if (user && !wasAlreadyOnline) {
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
  socket.on('send_message', (data, callback) => {
    const { senderId, receiverId, text, style, audio, type, isPrivate } = data || {};
    
    // 1. Vérification de sécurité de l'expéditeur (anti-usurpation)
    if (socket.user.id !== senderId) {
      if (typeof callback === 'function') callback({ success: false, error: "Non autorisé." });
      return;
    }

    // 2. CONTRÔLE D'AUTORISATION STRICT : Relation de contact et absence de blocage
    const check = canInteract(senderId, receiverId);
    if (!check.allowed) {
      console.warn(`[Security Alert] Tentative d'envoi non autorisée de ${senderId} vers ${receiverId}: ${check.reason}`);
      if (typeof callback === 'function') callback({ success: false, error: check.reason });
      return;
    }

    // Limitation du débit (Rate Limiting) : max 20 messages par 10 secondes
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

    console.log(`[Message Security] From:${senderId} To:${receiverId} ClientPrivate:${isPrivate} ForcedPrivate:${isForcedPrivate} Final:${finalIsPrivate}`);

    // Limites de taille des données (le texte peut contenir l'audio chiffré E2EE, on augmente la limite)
    if (text && text.length > 5000000) return; 
    if (audio && audio.length > 5000000) return; 
    
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
      isPrivate: !!finalIsPrivate, // Force le flag réel imposé par le serveur
      timestamp: nowIso
    };

    // --- MODE PRIVÉ (Non-persistance) ---
    if (!finalIsPrivate) {
      const stmt = db.prepare('INSERT INTO messages (sender_id, receiver_id, text, style, audio, type, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)');
      const info = stmt.run(senderId, receiverId, text, JSON.stringify(style), audio || null, type || 'text', nowIso);
      messageToDeliver.id = info.lastInsertRowid;
    } else {
      console.log(`[Private Mode] Message éphémère de ${senderId} vers ${receiverId}`);
      messageToDeliver.id = Date.now(); // ID temporaire pour le frontend
    }

    if (typeof callback === 'function') {
      callback({ success: true, id: messageToDeliver.id, timestamp: messageToDeliver.timestamp });
    }

    // 1. Diffusion vers TOUTES les sessions actives du destinataire (fanout multi-session via room)
    io.to(getUserRoom(receiverId)).emit('receive_message', messageToDeliver);

    // 2. Synchronisation vers les AUTRES sessions actives de l'expéditeur (exclut le socket d'origine)
    socket.to(getUserRoom(senderId)).emit('receive_message', messageToDeliver);

    // Dispatch Web Push vers les appareils en arrière-plan (Android / PWA inactive)
    dispatchPushNotification(receiverId, {
      title: `${senderDisplayName || 'OpenWLM'} - OpenWLM`,
      body: 'Nouveau message reçu',
      senderId: senderId,
      url: `/?chat=${senderId}`
    });
  });

  /**
   * ACCUSÉ DE RÉCEPTION : Message effectivement reçu par une session du destinataire
   * ("remis" / delivered).
   */
  socket.on('message_delivered', (data) => {
    const { messageId, senderId, isPrivate } = data || {};
    const recipientId = socket.user.id; // Sécurité : identité certifiée du socket connecté (destinataire)
    const sId = parseInt(senderId, 10);
    const mId = parseInt(messageId, 10);
    if (!sId || isNaN(sId) || !mId || isNaN(mId)) return;

    // Contrôle d'autorisation strict
    const check = canInteract(sId, recipientId);
    if (!check.allowed) return;

    // En mode normal (non privé) : persistance de l'état 'delivered'
    if (!isPrivate) {
      try {
        db.prepare("UPDATE messages SET delivery_status = 'delivered' WHERE id = ? AND sender_id = ? AND receiver_id = ? AND delivery_status = 'sent'")
          .run(mId, sId, recipientId);
      } catch (e) {}
    }

    // Propagation temps réel vers toutes les sessions de l'expéditeur
    io.to(getUserRoom(sId)).emit('message_status_updated', {
      contactId: recipientId,
      messageId: mId,
      status: 'delivered',
      isPrivate: !!isPrivate
    });

    // Synchronisation multi-session du destinataire (autres sessions)
    socket.to(getUserRoom(recipientId)).emit('message_status_updated', {
      contactId: sId,
      messageId: mId,
      status: 'delivered',
      isPrivate: !!isPrivate
    });
  });

  /**
   * ACCUSÉ DE LECTURE : La conversation est activement ouverte et les messages ont été vus
   * ("lu" / read). Batched via lastReadMessageId (curseur de lecture minimal).
   */
  socket.on('message_read', (data) => {
    const { contactId, lastReadMessageId, isPrivate } = data || {};
    const readerId = socket.user.id; // Sécurité : lecteur certifié
    const cId = parseInt(contactId, 10);
    const lastId = parseInt(lastReadMessageId, 10);
    if (!cId || isNaN(cId) || !lastId || isNaN(lastId)) return;

    // Contrôle d'autorisation strict
    const check = canInteract(cId, readerId);
    if (!check.allowed) return;

    // En mode normal (non privé) : persistance du curseur minimal et mise à jour de la colonne
    let clampedLastId = lastId;
    if (!isPrivate) {
      try {
        // SÉCURITÉ : Ne jamais faire confiance à la valeur envoyée par le client.
        // Calculer côté serveur l'ID maximal réel des messages envoyés par contactId vers readerId.
        const maxRow = db.prepare('SELECT MAX(id) as maxId FROM messages WHERE sender_id = ? AND receiver_id = ?').get(cId, readerId);
        const maxExistingId = maxRow && maxRow.maxId !== null ? Number(maxRow.maxId) : 0;
        if (!maxExistingId || maxExistingId <= 0) {
          // Aucun message valide existant dans cette conversation : ne rien mettre à jour ni diffuser
          return;
        }

        // Récupérer le curseur actuel du lecteur pour garantir une progression strictement monotone
        const currentCursorRow = db.prepare('SELECT last_read_message_id FROM conversation_read_cursors WHERE user_id = ? AND contact_id = ?').get(readerId, cId);
        const currentReadId = currentCursorRow ? Number(currentCursorRow.last_read_message_id) || 0 : 0;

        // Clamping : min(lastReadMessageId client, maxExistingId serveur)
        clampedLastId = Math.min(lastId, maxExistingId);

        // Progression monotone : ne jamais régresser en arrière
        if (clampedLastId <= currentReadId) {
          return;
        }

        const now = Date.now();
        db.prepare(`
          INSERT INTO conversation_read_cursors (user_id, contact_id, last_read_message_id, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(user_id, contact_id) DO UPDATE SET
            last_read_message_id = MAX(conversation_read_cursors.last_read_message_id, excluded.last_read_message_id),
            updated_at = excluded.updated_at
        `).run(readerId, cId, clampedLastId, now);

        db.prepare(`
          UPDATE messages 
          SET delivery_status = 'read' 
          WHERE sender_id = ? AND receiver_id = ? AND id <= ? AND delivery_status != 'read'
        `).run(cId, readerId, clampedLastId);
      } catch (e) {
        console.warn("[Read Receipts] Erreur mise à jour curseur:", e.message);
        return;
      }
    }

    // Diffusion temps réel vers toutes les sessions de l'expéditeur du message
    io.to(getUserRoom(cId)).emit('conversation_read', {
      contactId: readerId,
      lastReadMessageId: clampedLastId,
      isPrivate: !!isPrivate
    });

    // Synchronisation multi-session du lecteur (autres sessions du même compte)
    socket.to(getUserRoom(readerId)).emit('conversation_read', {
      contactId: cId,
      lastReadMessageId: clampedLastId,
      isPrivate: !!isPrivate
    });
  });

  /**
   * Envoi d'un "Wizz"
   */
  socket.on('send_wizz', (data) => {
    const { senderId, receiverId } = data || {};
    if (socket.user.id !== senderId) return;

    // Contrôle d'autorisation strict
    const check = canInteract(senderId, receiverId);
    if (!check.allowed) {
      console.warn(`[Security Alert] Tentative de Wizz non autorisée de ${senderId} vers ${receiverId}: ${check.reason}`);
      return;
    }

    // Rate limiting pour les Wizz (max 3 par minute)
    const now = Date.now();
    const timestamps = wizzLimits.get(senderId) || [];
    const recentWizz = timestamps.filter(ts => now - ts < 60000);
    if (recentWizz.length >= 3) return;
    
    recentWizz.push(now);
    wizzLimits.set(senderId, recentWizz);

    // SÉCURITÉ : Payload sain contrôlé vers la room du destinataire
    io.to(getUserRoom(receiverId)).emit('receive_wizz', { senderId, receiverId });

    const sender = db.prepare('SELECT username, nickname FROM users WHERE id = ?').get(senderId);
    const senderDisplayName = sender ? (sender.nickname || sender.username) : 'Contact';

    dispatchPushNotification(receiverId, {
      title: `${senderDisplayName} - OpenWLM`,
      body: '💥 [Wizz !]',
      senderId: senderId,
      url: `/?chat=${senderId}`
    });
  });

  /**
   * Envoi d'un "Clin d'oeil" (Wink)
   */
  socket.on('send_wink', (data) => {
    const { senderId, receiverId, winkId } = data || {};
    if (socket.user.id !== senderId) return;

    // Contrôle d'autorisation strict
    const check = canInteract(senderId, receiverId);
    if (!check.allowed) {
      console.warn(`[Security Alert] Tentative de Wink non autorisée de ${senderId} vers ${receiverId}: ${check.reason}`);
      return;
    }

    if (!winkId || typeof winkId !== 'string' || !/^[\w-]+$/.test(winkId)) return;

    // Rate limiting pour les Winks (max 7 par minute)
    const now = Date.now();
    const timestamps = wizzLimits.get(senderId) || []; // On partage le même limitateur pour simplifier
    const recentWinks = timestamps.filter(ts => now - ts < 60000);
    if (recentWinks.length >= 7) return;
    
    recentWinks.push(now);
    wizzLimits.set(senderId, recentWinks);

    // SÉCURITÉ : Payload sain contrôlé vers la room du destinataire
    io.to(getUserRoom(receiverId)).emit('receive_wink', { senderId, receiverId, winkId });
  });

  /**
   * Synchronisation du Mode Privé (Bidirectionnel et Multi-Sessions)
   */
  socket.on('toggle_private_mode', (data) => {
    const { senderId, receiverId, isPrivate } = data || {};
    if (socket.user.id !== senderId) return;

    // Contrôle d'autorisation strict
    const check = canInteract(senderId, receiverId);
    if (!check.allowed) {
      console.warn(`[Security Alert] Tentative de toggle_private_mode non autorisée de ${senderId} vers ${receiverId}: ${check.reason}`);
      return;
    }

    // SÉCURITÉ : Recalcul obligatoire du pseudonyme depuis la base de données (jamais confiance au client)
    const senderUser = db.prepare('SELECT nickname, username FROM users WHERE id = ?').get(senderId);
    const safeNickname = senderUser ? (senderUser.nickname || senderUser.username) : 'Un contact';

    // Diffusion vers toutes les sessions du destinataire
    io.to(getUserRoom(receiverId)).emit('private_mode_changed', { 
      senderId, 
      receiverId,
      isPrivate: !!isPrivate,
      senderNickname: safeNickname 
    });

    // Synchronisation vers les autres sessions de l'expéditeur
    socket.to(getUserRoom(senderId)).emit('private_mode_changed', { 
      senderId, 
      receiverId,
      isPrivate: !!isPrivate,
      senderNickname: safeNickname 
    });
  });

  /**
   * SIGNALISATION WEBRTC (Appels Audio/Vidéo)
   * Sécurisé : On utilise socket.user.id (token JWT) au lieu de faire confiance au client.
   */
  socket.on('call_request', (data) => {
    const { target, signal, audioOnly } = data || {};
    const check = canInteract(socket.user.id, target);
    if (!check.allowed) return;

    if (isUserOnline(target)) {
      // Récupérer l'identité réelle de l'appelant depuis la session authentifiée
      const callerUser = db.prepare('SELECT id, nickname, username FROM users WHERE id = ?').get(socket.user.id);
      if (!callerUser) return;

      io.to(getUserRoom(target)).emit('incoming_call', { 
        caller: socket.user.id, 
        callerName: callerUser.nickname || callerUser.username, 
        signal, 
        audioOnly: !!audioOnly 
      });
    }
  });

  socket.on('webrtc_signal', (data) => {
    const { target, signal } = data || {};
    const check = canInteract(socket.user.id, target);
    if (!check.allowed) return;

    if (isUserOnline(target)) {
      // On transmet le signal en précisant qui l'envoie (l'utilisateur du socket actuel)
      io.to(getUserRoom(target)).emit('webrtc_signal', { 
        signal, 
        caller: socket.user.id 
      });
    }
  });

  socket.on('end_call', (data) => {
    const { target } = data || {};
    const check = canInteract(socket.user.id, target);
    if (!check.allowed) return;

    if (isUserOnline(target)) {
      io.to(getUserRoom(target)).emit('call_ended', { 
        caller: socket.user.id 
      });
    }
  });

  /**
   * --- ACTIVITÉS & JEUX MULTI-JOUEURS MSN (MORPION / TIC-TAC-TOE) ---
   */

  // 1. Envoi d'une invitation à jouer
  socket.on('game_invite', (data) => {
    if (!socket.user || !socket.user.id) return;
    const { target, gameType } = data || {};
    
    const check = canInteract(socket.user.id, target);
    if (!check.allowed) {
      return socket.emit('game_error', { message: check.reason });
    }

    if (isUserOnline(target)) {
      const senderUser = db.prepare('SELECT id, nickname, username FROM users WHERE id = ?').get(socket.user.id);
      if (!senderUser) return;

      const safeGameType = (gameType === 'checkers' || gameType === 'puissance4') ? gameType : 'morpion';
      
      // SÉCURITÉ : Enregistrer l'invitation avec expiration (60 secondes)
      const inviteKey = `${socket.user.id}_${target}`;
      pendingGameInvites.set(inviteKey, {
        gameType: safeGameType,
        expiresAt: Date.now() + GAME_INVITE_TTL_MS
      });

      io.to(getUserRoom(target)).emit('game_invite_received', {
        from: socket.user.id,
        fromName: senderUser.nickname || senderUser.username,
        gameType: safeGameType
      });
    } else {
      socket.emit('game_user_offline', { target });
    }
  });

  // 2. Acceptation de l'invitation (Création sécurisée de la session de jeu)
  socket.on('game_accept', (data) => {
    if (!socket.user || !socket.user.id) return;
    const { target, gameType } = data || {};

    const check = canInteract(socket.user.id, target);
    if (!check.allowed) {
      return socket.emit('game_error', { message: check.reason });
    }

    // SÉCURITÉ : Exiger une invitation préalable valide et non expirée
    const inviteKey = `${target}_${socket.user.id}`;
    const invite = pendingGameInvites.get(inviteKey);
    if (!invite || Date.now() > invite.expiresAt) {
      if (invite) pendingGameInvites.delete(inviteKey);
      return socket.emit('game_error', { message: "Aucune invitation valide ou expirée." });
    }
    // Consommation unique de l'invitation
    pendingGameInvites.delete(inviteKey);

    const acceptorUser = db.prepare('SELECT id, nickname, username FROM users WHERE id = ?').get(socket.user.id);
    const targetUser = db.prepare('SELECT id, nickname, username FROM users WHERE id = ?').get(target);

    if (isUserOnline(target) && acceptorUser && targetUser) {
      const gameKey = getGameKey(target, socket.user.id);
      const chosenGameType = invite.gameType || (gameType === 'checkers' ? 'checkers' : gameType === 'puissance4' ? 'puissance4' : 'morpion');

      if (chosenGameType === 'checkers') {
        const initialBoard = createInitialCheckersBoard();
        activeGames.set(gameKey, {
          gameType: 'checkers',
          playerWhite: target,         // L'initiateur a les Blancs
          playerBlack: socket.user.id, // L'accepteur a les Noirs
          turn: target,                // Les Blancs commencent
          board: initialBoard,
          status: 'playing',
          scores: { [target]: 0, [socket.user.id]: 0 }
        });

        // L'initiateur a les Blancs et a le premier tour
        io.to(getUserRoom(target)).emit('game_started', {
          opponentId: socket.user.id,
          opponentName: acceptorUser.nickname || acceptorUser.username,
          myColor: 'white',
          mySymbol: 'W',
          isMyTurn: true,
          gameType: 'checkers'
        });

        // L'accepteur a les Noirs et attend son tour
        socket.emit('game_started', {
          opponentId: target,
          opponentName: targetUser.nickname || targetUser.username,
          myColor: 'black',
          mySymbol: 'B',
          isMyTurn: false,
          gameType: 'checkers'
        });
      } else if (chosenGameType === 'puissance4') {
        const initialBoard = createEmptyPuissance4Board();
        activeGames.set(gameKey, {
          gameType: 'puissance4',
          playerRed: target,             // L'initiateur a les Rouges
          playerYellow: socket.user.id,  // L'accepteur a les Jaunes
          turn: target,                  // Les Rouges commencent
          board: initialBoard,
          status: 'playing',
          scores: { [target]: 0, [socket.user.id]: 0 }
        });

        // L'initiateur a les Rouges et a le premier tour
        io.to(getUserRoom(target)).emit('game_started', {
          opponentId: socket.user.id,
          opponentName: acceptorUser.nickname || acceptorUser.username,
          myColor: 'red',
          mySymbol: 'R',
          isMyTurn: true,
          gameType: 'puissance4'
        });

        // L'accepteur a les Jaunes et attend son tour
        socket.emit('game_started', {
          opponentId: target,
          opponentName: targetUser.nickname || targetUser.username,
          myColor: 'yellow',
          mySymbol: 'Y',
          isMyTurn: false,
          gameType: 'puissance4'
        });
      } else {
        // Morpion
        activeGames.set(gameKey, {
          gameType: 'morpion',
          playerX: target,         // L'initiateur joue 'X'
          playerO: socket.user.id, // L'accepteur joue 'O'
          turn: target,            // 'X' commence toujours
          board: Array(9).fill(null),
          status: 'playing',
          scores: { [target]: 0, [socket.user.id]: 0 }
        });

        // L'initiateur joue 'X' et a le premier tour
        io.to(getUserRoom(target)).emit('game_started', {
          opponentId: socket.user.id,
          opponentName: acceptorUser.nickname || acceptorUser.username,
          mySymbol: 'X',
          isMyTurn: true,
          gameType: 'morpion'
        });

        // L'accepteur joue 'O' et attend son tour
        socket.emit('game_started', {
          opponentId: target,
          opponentName: targetUser.nickname || targetUser.username,
          mySymbol: 'O',
          isMyTurn: false,
          gameType: 'morpion'
        });
      }
    }
  });

  // 3. Refus de l'invitation
  socket.on('game_decline', (data) => {
    if (!socket.user || !socket.user.id) return;
    const { target } = data || {};
    const check = canInteract(socket.user.id, target);
    if (!check.allowed) return;

    // SÉCURITÉ : Nettoyer l'invitation refusée
    const inviteKey = `${target}_${socket.user.id}`;
    pendingGameInvites.delete(inviteKey);

    if (isUserOnline(target)) {
      const user = db.prepare('SELECT nickname, username FROM users WHERE id = ?').get(socket.user.id);
      io.to(getUserRoom(target)).emit('game_declined', {
        from: socket.user.id,
        fromName: user?.nickname || user?.username || 'Le contact'
      });
    }
  });

  // 4a. Transmission et validation d'un coup de Morpion
  socket.on('game_move', (data) => {
    if (!socket.user || !socket.user.id) return;
    const userId = socket.user.id;
    const { target, index } = data;

    const gameKey = getGameKey(userId, target);
    const game = activeGames.get(gameKey);

    // SÉCURITÉ 1 : Vérifier qu'une session de jeu active existe
    if (!game || game.status !== 'playing') {
      return socket.emit('game_error', { message: "Aucune partie active trouvée avec ce contact." });
    }

    // SÉCURITÉ 2 : Vérifier que c'est bien le tour du joueur connecté (interdiction de jouer hors-tour)
    if (game.turn !== userId) {
      return socket.emit('game_error', { message: "Ce n'est pas votre tour de jouer !" });
    }

    // SÉCURITÉ 3 : Vérifier la validité arithmétique de la case (entier entre 0 et 8)
    const cellIndex = parseInt(index, 10);
    if (isNaN(cellIndex) || cellIndex < 0 || cellIndex > 8) {
      return socket.emit('game_error', { message: "Coup invalide : case hors limites." });
    }

    // SÉCURITÉ 4 (ANTI-USURPATION) : Vérifier que la case N'EST PAS DÉJÀ OCCUPÉE !
    if (game.board[cellIndex] !== null) {
      return socket.emit('game_error', { message: "Coup invalide : cette case est déjà occupée !" });
    }

    // SÉCURITÉ 5 : Déterminer le symbole légitime depuis l'état du serveur (ignore tout symbole envoyé par le client)
    const legitSymbol = (game.playerX === userId) ? 'X' : 'O';
    const nextTurnUserId = (userId === game.playerX) ? game.playerO : game.playerX;

    // Enregistrement autoritaire sur la grille serveur
    game.board[cellIndex] = legitSymbol;
    game.turn = nextTurnUserId;

    // Vérification des conditions de victoire côté serveur
    const WINNING_COMBOS = [
      [0, 1, 2], [3, 4, 5], [6, 7, 8],
      [0, 3, 6], [1, 4, 7], [2, 5, 8],
      [0, 4, 8], [2, 4, 6]
    ];
    let winner = null;
    let winningCombo = null;

    for (const combo of WINNING_COMBOS) {
      const [a, b, c] = combo;
      if (game.board[a] && game.board[a] === game.board[b] && game.board[a] === game.board[c]) {
        winner = game.board[a];
        winningCombo = combo;
        break;
      }
    }

    if (!winner && game.board.every(cell => cell !== null)) {
      winner = 'draw';
    }

    if (winner) {
      game.status = 'finished';
      if (winner === 'X') game.scores[game.playerX]++;
      if (winner === 'O') game.scores[game.playerO]++;
    }

    // Transmission du coup validé à l'adversaire
    io.to(getUserRoom(target)).emit('game_move', {
      from: userId,
      index: cellIndex,
      symbol: legitSymbol,
      winner,
      winningCombo
    });

    // Confirmation au joueur qui a joué
    socket.emit('game_move_confirmed', {
      index: cellIndex,
      symbol: legitSymbol,
      winner,
      winningCombo
    });
  });

  // 4b. Transmission et validation d'un coup de Jeu de dames (Checkers)
  socket.on('checkers_move', (data) => {
    if (!socket.user || !socket.user.id) return;
    const userId = socket.user.id;
    const { target, from, to, isJump, captured, isPromotion } = data;

    const gameKey = getGameKey(userId, target);
    const game = activeGames.get(gameKey);

    if (!game || game.status !== 'playing' || game.gameType !== 'checkers') {
      return socket.emit('game_error', { message: "Aucune partie de dames active avec ce contact." });
    }

    if (game.turn !== userId) {
      return socket.emit('game_error', { message: "Ce n'est pas votre tour de jouer !" });
    }

    const isValidCoord = (pos) => pos && Number.isInteger(pos.row) && Number.isInteger(pos.col) &&
                                  pos.row >= 0 && pos.row < 8 && pos.col >= 0 && pos.col < 8;

    if (!isValidCoord(from) || !isValidCoord(to)) {
      return socket.emit('game_error', { message: "Coordonnées de coup invalides." });
    }

    const currentPiece = game.board[from.row][from.col];
    if (!currentPiece) {
      return socket.emit('game_error', { message: "Aucune pièce sur la case de départ." });
    }

    // Vérifier la propriété de la pièce
    const isWhite = (game.playerWhite === userId);
    const expectedPrefix = isWhite ? 'w' : 'b';
    if (currentPiece.toLowerCase() !== expectedPrefix) {
      return socket.emit('game_error', { message: "Vous ne pouvez déplacer que vos propres pièces." });
    }

    // Vérifier que la destination est libre
    if (game.board[to.row][to.col] !== null) {
      return socket.emit('game_error', { message: "La case d'arrivée est déjà occupée." });
    }

    // Retirer de la position de départ
    game.board[from.row][from.col] = null;

    // Si saut, retirer la pièce capturée
    if (isJump && captured && isValidCoord(captured)) {
      game.board[captured.row][captured.col] = null;
    }

    // Promotion Dame si arrivée sur la dernière rangée opposée
    let finalPiece = currentPiece;
    if (isWhite && to.row === 0) finalPiece = 'W';
    else if (!isWhite && to.row === 7) finalPiece = 'B';

    game.board[to.row][to.col] = finalPiece;

    // Tour suivant
    const nextTurn = (userId === game.playerWhite) ? game.playerBlack : game.playerWhite;
    game.turn = nextTurn;

    // Transmettre à l'adversaire
    io.to(getUserRoom(target)).emit('checkers_move', {
      from,
      to,
      isJump,
      captured,
      isPromotion: finalPiece === 'W' || finalPiece === 'B'
    });

    socket.emit('checkers_move_confirmed', {
      from,
      to,
      isJump,
      captured,
      isPromotion: finalPiece === 'W' || finalPiece === 'B'
    });
  });

  // 4c. Transmission et validation d'un coup de Puissance 4 (Connect Four)
  socket.on('puissance4_move', (data) => {
    if (!socket.user || !socket.user.id) return;
    const userId = socket.user.id;
    const { target, col } = data || {};

    const gameKey = getGameKey(userId, target);
    const game = activeGames.get(gameKey);

    // SÉCURITÉ 1 : Vérifier qu'une session active de Puissance 4 existe
    if (!game || game.status !== 'playing' || game.gameType !== 'puissance4') {
      return socket.emit('game_error', { message: "Aucune partie de Puissance 4 active avec ce contact." });
    }

    // SÉCURITÉ 2 : Vérifier que c'est bien le tour du joueur connecté
    if (game.turn !== userId) {
      return socket.emit('game_error', { message: "Ce n'est pas votre tour de jouer !" });
    }

    // SÉCURITÉ 3 : Vérifier la colonne (0 à 6)
    const colIndex = parseInt(col, 10);
    if (isNaN(colIndex) || colIndex < 0 || colIndex > 6) {
      return socket.emit('game_error', { message: "Coup invalide : colonne hors limites." });
    }

    // SÉCURITÉ 4 (GRAVITÉ & ANTI-TRICHE) : Trouver la première rangée libre de bas en haut (ligne 5 vers 0)
    let targetRow = -1;
    for (let r = 5; r >= 0; r--) {
      if (game.board[r][colIndex] === null) {
        targetRow = r;
        break;
      }
    }

    if (targetRow === -1) {
      return socket.emit('game_error', { message: "Coup invalide : cette colonne est déjà pleine !" });
    }

    // SÉCURITÉ 5 : Déterminer le symbole légitime depuis l'état serveur
    const legitSymbol = (game.playerRed === userId) ? 'R' : 'Y';
    const nextTurnUserId = (userId === game.playerRed) ? game.playerYellow : game.playerRed;

    // Enregistrement autoritaire
    game.board[targetRow][colIndex] = legitSymbol;
    game.turn = nextTurnUserId;

    // Vérifier les conditions de victoire
    const winResult = checkPuissance4Winner(game.board);
    let winner = null;
    let winningCells = null;

    if (winResult) {
      winner = winResult.winner;
      winningCells = winResult.winningCells;
      game.status = 'finished';
      if (winner === 'R') game.scores[game.playerRed]++;
      if (winner === 'Y') game.scores[game.playerYellow]++;
    } else if (isPuissance4BoardFull(game.board)) {
      winner = 'draw';
      game.status = 'finished';
    }

    // Transmission du coup validé à l'adversaire
    io.to(getUserRoom(target)).emit('puissance4_move', {
      from: userId,
      row: targetRow,
      col: colIndex,
      symbol: legitSymbol,
      winner,
      winningCells
    });

    // Confirmation au joueur
    socket.emit('puissance4_move_confirmed', {
      row: targetRow,
      col: colIndex,
      symbol: legitSymbol,
      winner,
      winningCells
    });
  });

  // 5. Demande de nouvelle manche / Recommencer
  socket.on('game_restart', (data) => {
    if (!socket.user || !socket.user.id) return;
    const userId = socket.user.id;
    const { target, gameType } = data || {};

    const gameKey = getGameKey(userId, target);
    const game = activeGames.get(gameKey);
    if (game) {
      if (game.gameType === 'checkers' || gameType === 'checkers') {
        game.board = createInitialCheckersBoard();
        game.status = 'playing';
        game.turn = game.playerWhite; // Les Blancs reprennent le premier tour
      } else if (game.gameType === 'puissance4' || gameType === 'puissance4') {
        game.board = createEmptyPuissance4Board();
        game.status = 'playing';
        game.turn = game.playerRed; // Les Rouges reprennent le premier tour
      } else {
        game.board = Array(9).fill(null);
        game.status = 'playing';
        game.turn = userId;
      }
    }

    io.to(getUserRoom(target)).emit('game_restart', {
      from: userId,
      gameType: game ? game.gameType : gameType
    });
  });

  // 6. Quitter / Abandonner la partie
  socket.on('game_quit', (data) => {
    if (!socket.user || !socket.user.id) return;
    const userId = socket.user.id;
    const { target } = data;

    const gameKey = getGameKey(userId, target);
    activeGames.delete(gameKey);

    io.to(getUserRoom(target)).emit('game_quit', {
      from: userId
    });
  });

  /**
   * Gestion de la déconnexion
   */
  socket.on('disconnect', () => {
    const removeResult = removeUserSocket(socket.id);
    if (!removeResult) return;

    const { userId: disconnectedUserId, wasLastSocket } = removeResult;

    // Si l'utilisateur possède encore d'autres sessions actives, il reste en ligne
    if (!wasLastSocket) {
      return;
    }

    // Nettoyer les sessions de jeu actives de cet utilisateur (Morpion, Dames ou Puissance 4)
    for (const [key, game] of activeGames.entries()) {
      const isPlayer = game.gameType === 'checkers'
        ? (game.playerWhite === disconnectedUserId || game.playerBlack === disconnectedUserId)
        : game.gameType === 'puissance4'
        ? (game.playerRed === disconnectedUserId || game.playerYellow === disconnectedUserId)
        : (game.playerX === disconnectedUserId || game.playerO === disconnectedUserId);

      if (isPlayer) {
        const opponentUserId = game.gameType === 'checkers'
          ? (game.playerWhite === disconnectedUserId ? game.playerBlack : game.playerWhite)
          : game.gameType === 'puissance4'
          ? (game.playerRed === disconnectedUserId ? game.playerYellow : game.playerRed)
          : (game.playerX === disconnectedUserId ? game.playerO : game.playerX);
        if (isUserOnline(opponentUserId)) {
          io.to(getUserRoom(opponentUserId)).emit('game_quit', { from: disconnectedUserId });
        }
        activeGames.delete(key);
      }
    }

    // Nettoyer les invitations de jeux en attente liées à cet utilisateur
    for (const [key] of pendingGameInvites.entries()) {
      if (key.startsWith(`${disconnectedUserId}_`) || key.endsWith(`_${disconnectedUserId}`)) {
        pendingGameInvites.delete(key);
      }
    }

    // Période de grâce de 60 secondes avant de passer en 'offline' 
    // (Plus adapté au mobile où le navigateur suspend l'onglet en arrière-plan)
    const timer = setTimeout(() => {
      try {
        if (!isUserOnline(disconnectedUserId)) {
          db.prepare('UPDATE users SET status = ? WHERE id = ?').run('offline', disconnectedUserId);
          broadcastStatusToContacts(disconnectedUserId, { id: disconnectedUserId, userId: disconnectedUserId, status: 'offline' });
        }
      } catch (err) { console.error(err); }
      disconnectTimers.delete(disconnectedUserId);
    }, 60000);
    disconnectTimers.set(disconnectedUserId, timer);
  });

  /**
   * Déconnexion explicite (Logout immédiat sans attendre la période de grâce)
   */
  socket.on('manual_disconnect', () => {
    if (!socket.user || !socket.user.id) return;
    const userId = socket.user.id;
    socket.leave(getUserRoom(userId));

    if (disconnectTimers.has(userId)) {
      clearTimeout(disconnectTimers.get(userId));
      disconnectTimers.delete(userId);
    }
    const removeResult = removeUserSocket(socket.id);

    // Nettoyer les invitations de jeux en attente liées à cet utilisateur
    for (const [key] of pendingGameInvites.entries()) {
      if (key.startsWith(`${userId}_`) || key.endsWith(`_${userId}`)) {
        pendingGameInvites.delete(key);
      }
    }

    if (!removeResult || removeResult.wasLastSocket) {
      try {
        db.prepare('UPDATE users SET status = ?, token_version = COALESCE(token_version, 0) + 1 WHERE id = ?').run('offline', userId);
        broadcastStatusToContacts(userId, { id: userId, userId, status: 'offline' });
      } catch (err) { console.error(err); }
    }
  });
});

/**
 * ROUTAGE SPA (Fallback pour React/Vite sur routes inconnues hors API/Socket)
 */
app.use((req, res, next) => {
  if (req.method !== 'GET') {
    return next();
  }
  if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) {
    return next();
  }
  const indexPath = path.join(__dirname, '../dist/index.html');
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }
  next();
});

/**
 * LANCEMENT DU SERVEUR
 */
httpServer.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`);
});
