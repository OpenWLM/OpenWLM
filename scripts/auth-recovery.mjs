#!/usr/bin/env node
/**
 * scripts/auth-recovery.mjs — OpenWLM
 *
 * Ouvre une fenêtre de récupération de la clé d'authentification d'un ou de tous les comptes.
 *
 * Quand en a-t-on besoin ? La clé de connexion est dérivée du mot de passe ET de la portée du
 * serveur (AUTH_KEY_SCOPE, sinon le nom d'hôte de la page). Si cette portée change (nouveau nom
 * de domaine, autre port, AUTH_KEY_SCOPE modifiée) sans précaution, plus aucun compte déjà
 * migré ne peut se connecter : le serveur ne garde qu'une empreinte de la clé.
 *
 * Pendant la fenêtre, l'écran de connexion propose automatiquement la récupération : le client
 * prouve le mot de passe en ouvrant son coffre de clés (indépendant de la portée), puis
 * enregistre une nouvelle clé. Mot de passe, clés de chiffrement et historique sont conservés.
 *
 * Usage (depuis le dossier du serveur, service arrêté ou non) :
 *   node scripts/auth-recovery.mjs <identifiant> [--hours 24]
 *   node scripts/auth-recovery.mjs --all [--hours 72]     # changement de domaine planifié
 *   node scripts/auth-recovery.mjs --close <identifiant|--all>
 *
 * Base : ./messenger.db (ou OPENWLM_DB). Le script n'affiche ni ne modifie aucun secret.
 */
import path from 'path';
import Database from 'better-sqlite3';

const args = process.argv.slice(2);
const close = args.includes('--close');
const all = args.includes('--all');
const hoursIndex = args.indexOf('--hours');
const hours = hoursIndex >= 0 ? Number(args[hoursIndex + 1]) : 24;
const username = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--hours');

if ((!all && !username) || !Number.isFinite(hours) || hours <= 0 || hours > 24 * 30) {
  console.error('Usage : node scripts/auth-recovery.mjs <identifiant> [--hours 24] | --all [--hours 72] | --close <identifiant|--all>');
  process.exit(1);
}

const dbPath = path.resolve(process.env.OPENWLM_DB || 'messenger.db');
const db = new Database(dbPath, { fileMustExist: true });
const until = close ? 0 : Date.now() + hours * 3600 * 1000;
const result = all
  ? db.prepare('UPDATE users SET auth_recovery_until = ? WHERE encrypted_private_key IS NOT NULL').run(until)
  : db.prepare('UPDATE users SET auth_recovery_until = ? WHERE LOWER(username) = ? AND encrypted_private_key IS NOT NULL').run(until, username.trim().toLowerCase());
db.close();

if (result.changes === 0) {
  console.error('Aucun compte concerné (identifiant inconnu, ou compte sans coffre de clés : rien à prouver).');
  process.exit(2);
}
console.log(close
  ? `Récupération fermée pour ${result.changes} compte(s).`
  : `Récupération ouverte pour ${result.changes} compte(s) jusqu'au ${new Date(until).toLocaleString('fr-FR')}. `
    + 'Les utilisateurs se connectent normalement avec leur mot de passe ; la fenêtre se ferme d\'elle-même pour chaque compte récupéré.');
