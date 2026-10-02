/**
 * OpenWLM - Script de peuplement de démonstration / développement
 * Crée 2 comptes fictifs sans aucune donnée personnelle pour tester l'application en local.
 */
import Database from 'better-sqlite3';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, '..', 'messenger.db');

const db = new Database(dbPath);

// 1. Initialiser le schéma si nécessaire
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    nickname TEXT,
    psm TEXT,
    avatar TEXT,
    scene TEXT,
    status TEXT DEFAULT 'offline',
    global_private INTEGER DEFAULT 0,
    public_key TEXT,
    encrypted_private_key TEXT,
    token_version INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    contact_id INTEGER NOT NULL,
    status INTEGER DEFAULT 1,
    blocked INTEGER DEFAULT 0,
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(contact_id) REFERENCES users(id),
    UNIQUE(user_id, contact_id)
  );

  CREATE TABLE IF NOT EXISTS invitations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL,
    receiver_id INTEGER NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(sender_id) REFERENCES users(id),
    FOREIGN KEY(receiver_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL,
    receiver_id INTEGER NOT NULL,
    text TEXT,
    style TEXT,
    audio TEXT,
    type TEXT DEFAULT 'text',
    timestamp TEXT NOT NULL,
    FOREIGN KEY(sender_id) REFERENCES users(id),
    FOREIGN KEY(receiver_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS shared_files (
    id TEXT PRIMARY KEY,
    sender_id INTEGER NOT NULL,
    receiver_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    file_type TEXT NOT NULL,
    token TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
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
    FOREIGN KEY(owner_id) REFERENCES users(id)
  );
`);

console.log('--- Initialisation de la base de démonstration OpenWLM ---');

// Calcul du hash PBKDF2 pour le mot de passe démo standard "DemoPassword123!"
// AuthKey = SHA256("DemoPassword123!")
const demoAuthKey = crypto.createHash('sha256').update('DemoPassword123!').digest('hex');
const saltAlice = crypto.randomBytes(16).toString('hex');
const hashAlice = crypto.pbkdf2Sync(demoAuthKey, saltAlice, 210000, 64, 'sha512').toString('hex');

const saltBob = crypto.randomBytes(16).toString('hex');
const hashBob = crypto.pbkdf2Sync(demoAuthKey, saltBob, 210000, 64, 'sha512').toString('hex');

db.transaction(() => {
  // Purger les éventuels comptes démo précédents
  const existingAlice = db.prepare('SELECT id FROM users WHERE username = ?').get('alice@openwlm.local');
  const existingBob = db.prepare('SELECT id FROM users WHERE username = ?').get('bob@openwlm.local');

  if (existingAlice || existingBob) {
    const ids = [existingAlice?.id, existingBob?.id].filter(Boolean);
    db.prepare(`DELETE FROM contacts WHERE user_id IN (${ids.join(',')}) OR contact_id IN (${ids.join(',')})`).run();
    db.prepare(`DELETE FROM messages WHERE sender_id IN (${ids.join(',')}) OR receiver_id IN (${ids.join(',')})`).run();
    db.prepare(`DELETE FROM users WHERE id IN (${ids.join(',')})`).run();
  }

  // 1. Créer Alice Demo
  const resAlice = db.prepare(`
    INSERT INTO users (username, password_hash, salt, nickname, psm, avatar, scene, status, token_version)
    VALUES (?, ?, ?, 'Alice (Démo)', 'En ligne sur OpenWLM !', '/assets/usertiles/chess.png', '/assets/scenes/0006.png', 'online', 0)
  `).run('alice@openwlm.local', hashAlice, saltAlice);

  // 2. Créer Bob Demo
  const resBob = db.prepare(`
    INSERT INTO users (username, password_hash, salt, nickname, psm, avatar, scene, status, token_version)
    VALUES (?, ?, ?, 'Bob (Démo)', 'Disponible pour discuter', '/assets/usertiles/frog.png', '/assets/scenes/0001.png', 'online', 0)
  `).run('bob@openwlm.local', hashBob, saltBob);

  const aliceId = resAlice.lastInsertRowid;
  const bobId = resBob.lastInsertRowid;

  // 3. Contact mutuel
  db.prepare('INSERT INTO contacts (user_id, contact_id, status, blocked) VALUES (?, ?, 1, 0)').run(aliceId, bobId);
  db.prepare('INSERT INTO contacts (user_id, contact_id, status, blocked) VALUES (?, ?, 1, 0)').run(bobId, aliceId);

  // 4. Message d'accueil de bienvenue
  db.prepare(`
    INSERT INTO messages (sender_id, receiver_id, text, style, type, timestamp)
    VALUES (?, ?, 'Salut Bob, bienvenue sur OpenWLM !', ?, 'text', ?)
  `).run(aliceId, bobId, JSON.stringify({ font: 'Segoe UI', color: '#000000', size: 10 }), new Date().toISOString());

  console.log('✅ Base de démonstration initialisée avec succès !');
  console.log('\nComptes disponibles pour les tests :');
  console.log('  1. Utilisateur: alice@openwlm.local | Mot de passe: DemoPassword123!');
  console.log('  2. Utilisateur: bob@openwlm.local   | Mot de passe: DemoPassword123!');
})();
