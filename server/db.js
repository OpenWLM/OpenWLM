import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const db = new Database('messenger.db');
// SQLite n'applique les clés étrangères (ON DELETE CASCADE des abonnements Push, jetons FCM,
// émoticônes, curseurs…) que si on le demande à chaque connexion.
db.pragma('foreign_keys = ON');

/**
 * INITIALISATION DE LA BASE DE DONNÉES SQLITE
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

  -- Jetons Firebase Cloud Messaging de l'app Android (un par installation), cf. server/utils/fcm.js
  CREATE TABLE IF NOT EXISTS fcm_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_fcm_tokens_user ON fcm_tokens(user_id);
`);

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
try {
  db.exec("ALTER TABLE users ADD COLUMN token_version INTEGER DEFAULT 0;");
} catch(e) {}

// Récupération de la clé d'authentification ouverte par l'administrateur (scripts/auth-recovery.mjs) :
// jusqu'à cette date (ms), le compte peut prouver son mot de passe par son coffre de clés
try {
  db.exec("ALTER TABLE users ADD COLUMN auth_recovery_until INTEGER DEFAULT 0;");
} catch { /* colonne déjà présente */ }

// STATUTS DE MESSAGES (envoyé / remis / lu)
try {
  db.exec("ALTER TABLE messages ADD COLUMN delivery_status TEXT DEFAULT 'sent';");
} catch(e) {}

// IDENTIFIANT D'ENVELOPPE (mid) : permet de dédupliquer les renvois « Non envoyé ».
// Le renvoi réutilise le mid d'origine ; un index unique (sender_id, mid) rend
// l'écriture idempotente et empêche un doublon si l'accusé initial s'est perdu.
try {
  db.exec("ALTER TABLE messages ADD COLUMN mid TEXT;");
} catch(e) {}
try {
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_sender_mid ON messages(sender_id, mid) WHERE mid IS NOT NULL;");
  // Quota de stockage par expéditeur (somme des messages persistés)
  db.exec("CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);");
} catch (e) {
  console.warn("Index unique messages(sender_id, mid) déjà présent ou erreur:", e.message);
}

// Clé AES de chaque émoticône personnalisée, chiffrée par le client pour sa propre clé publique
// (RSA-OAEP + AES-GCM, format de encryptForLocal) : le serveur ne peut pas la lire. Sans cette
// copie, la clé n'existait qu'en IndexedDB et disparaissait à la déconnexion.
const emoColumns = db.prepare("PRAGMA table_info(custom_emoticons)").all().map((c) => c.name);
if (!emoColumns.includes('encrypted_key')) {
  db.exec("ALTER TABLE custom_emoticons ADD COLUMN encrypted_key TEXT;");
}

// Curseur minimal de lecture par conversation
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

// MODE PRIVÉ PAR CONVERSATION : une ligne par direction (« owner considère sa
// conversation avec contact comme privée »). Persisté côté serveur, qui fait seul
// autorité sur la persistance des messages (le `isPrivate` du client est ignoré).
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_privacy (
      owner_id INTEGER NOT NULL,
      contact_id INTEGER NOT NULL,
      is_private INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT,
      PRIMARY KEY (owner_id, contact_id),
      FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(contact_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
} catch(e) {
  console.warn("Table conversation_privacy déjà présente ou erreur:", e.message);
}

/**
 * Mode privé effectif d'une conversation, calculé UNIQUEMENT à partir de l'état
 * persisté : mode global de l'un ou l'autre, ou préférence de conversation de l'un
 * ou l'autre. Chacun ne peut faire valoir que sa propre ligne ; personne ne peut
 * retirer la confidentialité voulue par l'autre.
 */
export const isConversationPrivate = (userA, userB) => {
  const globals = db.prepare('SELECT COUNT(*) AS n FROM users WHERE id IN (?, ?) AND global_private = 1').get(userA, userB);
  if (globals && globals.n > 0) return true;
  const convo = db.prepare(`
    SELECT COUNT(*) AS n FROM conversation_privacy
    WHERE is_private = 1 AND ((owner_id = ? AND contact_id = ?) OR (owner_id = ? AND contact_id = ?))
  `).get(userA, userB, userB, userA);
  return !!(convo && convo.n > 0);
};

/**
 * DTO pour les données publiques d'un utilisateur
 */
export const toPublicUserDTO = (user) => {
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
 */
export const toPrivateUserDTO = (user) => {
  if (!user) return null;
  return {
    ...toPublicUserDTO(user),
    encrypted_private_key: user.encrypted_private_key
  };
};
