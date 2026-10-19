/**
 * OpenWLM - Script de peuplement de démonstration / développement
 * Crée 2 comptes fictifs sans aucune donnée personnelle pour tester l'application en local :
 *   alice@openwlm.local / bob@openwlm.local — mot de passe : DemoPassword123!
 *
 * Utilise la base du répertoire courant (`messenger.db`, comme le serveur) et son schéma réel
 * (server/db.js). À lancer depuis la racine du dépôt : `npm run db:seed`.
 *
 * Mot de passe : le navigateur n'envoie jamais le mot de passe, mais une clé d'authentification
 * dérivée (PBKDF2-SHA256 600 000 itérations, sel « openwlm-salt:<identifiant> », puis HKDF
 * « openwlm-auth-key-v1 » — cf. deriveZeroKnowledgeKeys dans src/utils/Security.ts). Le serveur
 * stocke un PBKDF2-SHA512 de cette clé (cf. hashPassword dans server/middleware/auth.js). Le
 * script reproduit exactement ces deux étapes, sinon les comptes de démo ne peuvent pas se
 * connecter. Les clés de chiffrement sont créées par l'app à la première connexion.
 */
import crypto from 'crypto';
import { db } from '../server/db.js';

const DEMO_PASSWORD = 'DemoPassword123!';

// Même dérivation que le client (src/utils/Security.ts → deriveZeroKnowledgeKeys)
const deriveAuthKeyHex = (username, password) => {
  const masterKey = crypto.pbkdf2Sync(password, 'openwlm-salt:' + username.trim().toLowerCase(), 600000, 32, 'sha256');
  return Buffer.from(crypto.hkdfSync('sha256', masterKey, Buffer.alloc(32), 'openwlm-auth-key-v1', 32)).toString('hex');
};

// Même stockage que le serveur (server/middleware/auth.js → hashPassword)
const serverHash = (authKeyHex) => {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(authKeyHex, salt, 210000, 64, 'sha512').toString('hex');
  return { salt, hash };
};

const DEMO_ACCOUNTS = [
  { username: 'alice@openwlm.local', nickname: 'Alice (Démo)', psm: 'En ligne sur OpenWLM !', avatar: '/assets/usertiles/chess.png', scene: '/assets/scenes/0006.png' },
  { username: 'bob@openwlm.local', nickname: 'Bob (Démo)', psm: 'Disponible pour discuter', avatar: '/assets/usertiles/frog.png', scene: '/assets/scenes/0001.png' }
];

console.log('--- Initialisation de la base de démonstration OpenWLM ---');

const credentials = DEMO_ACCOUNTS.map((a) => serverHash(deriveAuthKeyHex(a.username, DEMO_PASSWORD)));

db.transaction(() => {
  // Purger les éventuels comptes démo précédents (lignes dépendantes d'abord)
  const ids = DEMO_ACCOUNTS
    .map((a) => db.prepare('SELECT id FROM users WHERE username = ?').get(a.username)?.id)
    .filter(Boolean);
  if (ids.length) {
    const list = ids.join(',');
    const dependents = [
      ['contacts', 'user_id', 'contact_id'], ['messages', 'sender_id', 'receiver_id'],
      ['invitations', 'sender_id', 'receiver_id'], ['shared_files', 'sender_id', 'receiver_id'],
      ['conversation_privacy', 'owner_id', 'contact_id'], ['conversation_read_cursors', 'user_id', 'contact_id'],
      ['push_subscriptions', 'user_id', 'user_id'], ['custom_emoticons', 'owner_id', 'owner_id']
    ];
    for (const [table, a, b] of dependents) {
      db.prepare(`DELETE FROM ${table} WHERE ${a} IN (${list}) OR ${b} IN (${list})`).run();
    }
    db.prepare(`DELETE FROM users WHERE id IN (${list})`).run();
  }

  const created = DEMO_ACCOUNTS.map((a, i) => Number(db.prepare(`
    INSERT INTO users (username, password_hash, salt, nickname, psm, avatar, scene, status, token_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'offline', 0)
  `).run(a.username, credentials[i].hash, credentials[i].salt, a.nickname, a.psm, a.avatar, a.scene).lastInsertRowid));

  // Contact mutuel. Pas de message pré-rempli : l'app n'affiche que des messages signés et
  // chiffrés, qu'un script ne peut pas produire sans les clés des comptes.
  const contact = db.prepare('INSERT INTO contacts (user_id, contact_id, status, blocked) VALUES (?, ?, 1, 0)');
  contact.run(created[0], created[1]);
  contact.run(created[1], created[0]);
})();

console.log('✅ Base de démonstration initialisée avec succès !');
console.log('\nComptes disponibles pour les tests :');
for (const a of DEMO_ACCOUNTS) console.log(`  - ${a.username} | Mot de passe : ${DEMO_PASSWORD}`);
