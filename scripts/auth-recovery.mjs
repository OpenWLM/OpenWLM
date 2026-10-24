#!/usr/bin/env node
/**
 * scripts/auth-recovery.mjs — OpenWLM
 *
 * Ouvre une fenêtre de récupération de la clé d'authentification d'un ou de tous les comptes,
 * avec un CODE DE RÉCUPÉRATION à usage unique par compte.
 *
 * Quand en a-t-on besoin ? La clé de connexion est dérivée du mot de passe ET de la portée du
 * serveur (AUTH_KEY_SCOPE, sinon le nom d'hôte de la page). Si cette portée change (nouveau nom
 * de domaine, autre port, AUTH_KEY_SCOPE modifiée) sans précaution, plus aucun compte déjà
 * connecté ne peut se connecter : le serveur ne garde qu'une empreinte de la clé.
 *
 * L'utilisateur saisit son identifiant, son mot de passe et le code (« J'ai un code de
 * récupération » sur l'écran de connexion). L'app prouve le mot de passe en ouvrant son coffre
 * de clés, enregistre une nouvelle clé ; toutes ses anciennes sessions sont révoquées et ses
 * anciens appareils ne reçoivent plus de notifications. Mot de passe, clés de chiffrement et
 * historique sont conservés. Sans le code, le coffre n'est jamais remis.
 *
 * Remettez le code à l'utilisateur par un canal sûr (en personne, message déjà de confiance).
 *
 * Usage (depuis le dossier du serveur) :
 *   node scripts/auth-recovery.mjs <identifiant> [--hours 24]     # affiche le code
 *   node scripts/auth-recovery.mjs --all [--hours 72]             # codes dans un fichier (600)
 *   node scripts/auth-recovery.mjs --close <identifiant|--all>
 *   node scripts/auth-recovery.mjs --log [identifiant]            # journal des récupérations
 *
 * Base : ./messenger.db (ou OPENWLM_DB).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';

const args = process.argv.slice(2);
const close = args.includes('--close');
const all = args.includes('--all');
const showLog = args.includes('--log');
const hoursIndex = args.indexOf('--hours');
const hours = hoursIndex >= 0 ? Number(args[hoursIndex + 1]) : 24;
const username = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--hours');

const usage = () => {
  console.error('Usage : node scripts/auth-recovery.mjs <identifiant> [--hours 24] | --all [--hours 72] | --close <identifiant|--all> | --log [identifiant]');
  process.exit(1);
};
if (!showLog && ((!all && !username) || !Number.isFinite(hours) || hours <= 0 || hours > 24 * 30)) usage();

const dbPath = path.resolve(process.env.OPENWLM_DB || 'messenger.db');
const db = new Database(dbPath, { fileMustExist: true });
const operator = process.env.SUDO_USER || process.env.USER || os.userInfo().username || '?';
const log = (userId, event, detail) => {
  try {
    db.prepare('INSERT INTO auth_recovery_log (user_id, event, detail, ip, at) VALUES (?, ?, ?, NULL, ?)').run(userId, event, detail, Date.now());
  } catch { /* table créée au démarrage du serveur : démarrez-le une fois */ }
};

if (showLog) {
  const rows = db.prepare(`SELECT l.at, l.event, l.detail, l.ip, u.username FROM auth_recovery_log l LEFT JOIN users u ON u.id = l.user_id
    ${username ? 'WHERE LOWER(u.username) = ?' : ''} ORDER BY l.at DESC LIMIT 200`).all(...(username ? [username.trim().toLowerCase()] : []));
  for (const r of rows) console.log(`${new Date(r.at).toISOString()}  ${r.username ?? '?'}  ${r.event}${r.detail ? ' — ' + r.detail : ''}${r.ip ? ' — IP ' + r.ip : ''}`);
  if (rows.length === 0) console.log('Journal vide.');
  db.close();
  process.exit(0);
}

const targets = all
  ? db.prepare('SELECT id, username FROM users WHERE encrypted_private_key IS NOT NULL').all()
  : db.prepare('SELECT id, username FROM users WHERE LOWER(username) = ? AND encrypted_private_key IS NOT NULL').all(username.trim().toLowerCase());
if (targets.length === 0) {
  console.error('Aucun compte concerné (identifiant inconnu, ou compte sans coffre de clés : rien à prouver).');
  db.close();
  process.exit(2);
}

if (close) {
  const stmt = db.prepare('UPDATE users SET auth_recovery_until = 0, auth_recovery_code_hash = NULL, auth_recovery_attempts = 0 WHERE id = ?');
  db.transaction(() => { for (const t of targets) { stmt.run(t.id); log(t.id, 'fermée', `par ${operator}`); } })();
  console.log(`Récupération fermée pour ${targets.length} compte(s).`);
  db.close();
  process.exit(0);
}

// Code : 20 caractères base32 sans ambiguïté (100 bits), groupés par 5
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => {
  const bytes = crypto.randomBytes(20);
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
  return chars.match(/.{5}/g).join('-');
};
const until = Date.now() + hours * 3600 * 1000;
const stmt = db.prepare('UPDATE users SET auth_recovery_until = ?, auth_recovery_code_hash = ?, auth_recovery_attempts = 0 WHERE id = ?');
const issued = [];
db.transaction(() => {
  for (const t of targets) {
    const code = newCode();
    stmt.run(until, crypto.createHash('sha256').update(code).digest('hex'), t.id);
    log(t.id, 'ouverte', `par ${operator}, ${hours} h`);
    issued.push({ username: t.username, code });
  }
})();
db.close();

const expiry = new Date(until).toLocaleString('fr-FR');
if (all) {
  const file = path.resolve(`recovery-codes-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
  fs.writeFileSync(file, issued.map((i) => `${i.username}\t${i.code}`).join('\n') + '\n', { mode: 0o600 });
  console.log(`Récupération ouverte pour ${issued.length} compte(s) jusqu'au ${expiry}.`);
  console.log(`Codes (un par compte) : ${file} (lisible par vous seul). Remettez chaque code à son titulaire par un canal sûr, puis supprimez ce fichier.`);
} else {
  console.log(`Récupération ouverte pour ${issued[0].username} jusqu'au ${expiry}.`);
  console.log(`Code de récupération (à remettre au titulaire par un canal sûr) : ${issued[0].code}`);
}
