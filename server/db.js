import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const db = new Database('messenger.db');

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

// STATUTS DE MESSAGES (envoyé / remis / lu)
try {
  db.exec("ALTER TABLE messages ADD COLUMN delivery_status TEXT DEFAULT 'sent';");
} catch(e) {}

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
