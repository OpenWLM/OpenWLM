#!/usr/bin/env node
/**
 * scripts/generate_vapid_keys.js - OpenWLM
 * Génération et provisioning sécurisé des clés VAPID pour le Web Push (RFC 8292).
 * 
 * Ce script est versionné dans le projet, mais les clés générées sont strictement
 * locales et protégées contre tout commit Git accidentel.
 * 
 * Usage:
 *   node scripts/generate_vapid_keys.js                   (Génère et stocke dans .vapid_keys.json)
 *   node scripts/generate_vapid_keys.js --print-only      (Affiche les variables sans écrire de fichier)
 *   node scripts/generate_vapid_keys.js --write-env       (Écrit / met à jour le fichier local .env)
 *   node scripts/generate_vapid_keys.js --force           (Écrase les clés existantes - invalide abonnements)
 *   node scripts/generate_vapid_keys.js --show-private    (Affiche la clé privée dans le terminal)
 *   node scripts/generate_vapid_keys.js --subject <email> (Définit le contact VAPID)
 */

import webpush from 'web-push';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const jsonKeysPath = path.join(rootDir, '.vapid_keys.json');
const envFilePath = path.join(rootDir, '.env');

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
OpenWLM — Utilitaire de Provisioning VAPID (Web Push RFC 8292)

Usage:
  node scripts/generate_vapid_keys.js [options]

Options:
  --print-only          Affiche les clés pour copier/coller manuel sans modifier le disque.
  --write-env           Écrit ou met à jour les variables dans le fichier local .env.
  --force               Force la régénération si un fichier de clés existe déjà.
                        ATTENTION: Cela révoque tous les abonnements push des navigateurs existants !
  --show-private        Affiche la clé privée en clair dans le terminal.
  --subject <uri>       Définit l'URI de contact (ex: mailto:admin@domaine.com).
  -h, --help            Affiche cette aide.
`);
  process.exit(0);
}

const printOnly = args.includes('--print-only') || args.includes('--dry-run');
const writeEnv = args.includes('--write-env');
const force = args.includes('--force');
const showPrivate = args.includes('--show-private');

// Extraction du subject
let customSubject = process.env.VAPID_SUBJECT || 'mailto:admin@openwlm.dev';
const subjectIndex = args.indexOf('--subject');
if (subjectIndex !== -1 && args[subjectIndex + 1]) {
  customSubject = args[subjectIndex + 1].trim();
}
if (!customSubject.startsWith('mailto:') && !customSubject.startsWith('https://')) {
  customSubject = `mailto:${customSubject}`;
}

console.log('======================================================');
console.log('   OpenWLM — Provisioning de Clés VAPID (Web Push)    ');
console.log('======================================================\n');

/**
 * Garde-fou Git : Vérifie qu'un chemin de fichier est bien ignoré par Git
 */
function verifyGitIgnored(filePath) {
  try {
    const relPath = path.relative(rootDir, filePath);
    execSync(`git check-ignore -q "${relPath}"`, { cwd: rootDir, stdio: 'ignore' });
    return true; // Le fichier est bien ignoré
  } catch {
    // Si git check-ignore retourne code 1, le fichier n'est PAS ignoré !
    return false;
  }
}

// 1. Vérification d'un fichier existant pour éviter les rotations involontaires
if (fs.existsSync(jsonKeysPath) && !force && !printOnly) {
  console.log(`[INFO] Un fichier de clés VAPID existe déjà dans :\n  ${jsonKeysPath}`);
  console.log('\n[SÉCURITÉ] La régénération des clés invaliderait tous les abonnements push existants.');
  console.log('Pour forcer une nouvelle génération, exécutez :');
  console.log('  node scripts/generate_vapid_keys.js --force\n');

  try {
    const existing = JSON.parse(fs.readFileSync(jsonKeysPath, 'utf8'));
    console.log('Configuration active :');
    console.log(`• VAPID_PUBLIC_KEY  : ${existing.publicKey}`);
    console.log(`• VAPID_SUBJECT     : ${existing.subject || customSubject}`);
    console.log(`• VAPID_PRIVATE_KEY : ${showPrivate ? existing.privateKey : '*** (masquée, utilisez --show-private) ***'}\n`);
  } catch (e) {
    console.error('[ERREUR] Impossible de lire le fichier existant:', e.message);
  }
  process.exit(0);
}

// 2. Génération de la nouvelle paire de clés VAPID
const vapidKeys = webpush.generateVAPIDKeys();

if (printOnly) {
  console.log('[MODE APERÇU] Aucune écriture sur le disque.\n');
  console.log('Variables générées :');
  console.log('------------------------------------------------------');
  console.log(`VAPID_PUBLIC_KEY="${vapidKeys.publicKey}"`);
  console.log(`VAPID_PRIVATE_KEY="${showPrivate ? vapidKeys.privateKey : '*** (ajoutez --show-private pour afficher) ***'}"`);
  console.log(`VAPID_SUBJECT="${customSubject}"`);
  console.log('------------------------------------------------------\n');
  process.exit(0);
}

// 3. Vérification des garde-fous Git avant toute écriture
if (!verifyGitIgnored(jsonKeysPath)) {
  console.error(`[BLOCAGE SÉCURITÉ] Le fichier cible ${jsonKeysPath} n'est pas ignoré par Git !`);
  console.error('Veuillez ajouter .vapid_keys.json à votre .gitignore avant de continuer.');
  process.exit(1);
}

// 4. Écriture sécurisée dans .vapid_keys.json (chmod 0600)
const configData = {
  publicKey: vapidKeys.publicKey,
  privateKey: vapidKeys.privateKey,
  subject: customSubject,
  createdAt: new Date().toISOString()
};

try {
  fs.writeFileSync(jsonKeysPath, JSON.stringify(configData, null, 2), { mode: 0o600 });
  // Forcer chmod 0600 explicite pour la portabilité
  try { fs.chmodSync(jsonKeysPath, 0o600); } catch {}
  console.log(`[SUCCÈS] Clés VAPID stockées dans .vapid_keys.json (chmod 0600)\n`);
} catch (err) {
  console.error('[ERREUR] Impossible d\'écrire .vapid_keys.json:', err.message);
  process.exit(1);
}

// 5. Optionnel : Écriture dans .env si demandé
if (writeEnv) {
  if (!verifyGitIgnored(envFilePath)) {
    console.error(`[BLOCAGE SÉCURITÉ] Le fichier cible ${envFilePath} n'est pas ignoré par Git !`);
    console.error('Veuillez vérifier votre .gitignore.');
    process.exit(1);
  }

  let envContent = '';
  if (fs.existsSync(envFilePath)) {
    envContent = fs.readFileSync(envFilePath, 'utf8');
  }

  // Remplacer ou ajouter les variables
  const replaceOrAppend = (content, key, value) => {
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
      return content.replace(regex, `${key}="${value}"`);
    } else {
      return content.trimEnd() + (content ? '\n' : '') + `${key}="${value}"\n`;
    }
  };

  envContent = replaceOrAppend(envContent, 'VAPID_PUBLIC_KEY', vapidKeys.publicKey);
  envContent = replaceOrAppend(envContent, 'VAPID_PRIVATE_KEY', vapidKeys.privateKey);
  envContent = replaceOrAppend(envContent, 'VAPID_SUBJECT', customSubject);

  try {
    fs.writeFileSync(envFilePath, envContent, { mode: 0o600 });
    try { fs.chmodSync(envFilePath, 0o600); } catch {}
    console.log(`[SUCCÈS] Variables VAPID ajoutées dans le fichier local .env (chmod 0600)\n`);
  } catch (err) {
    console.warn('[AVERTISSEMENT] Impossible d\'écrire dans .env:', err.message);
  }
}

console.log('Détails de configuration :');
console.log(`• VAPID_PUBLIC_KEY  : ${vapidKeys.publicKey}`);
console.log(`• VAPID_SUBJECT     : ${customSubject}`);
console.log(`• VAPID_PRIVATE_KEY : ${showPrivate ? vapidKeys.privateKey : '*** (stockée de manière sécurisée dans .vapid_keys.json) ***'}\n`);

console.log('Vérification côté serveur :');
console.log('  curl -s http://localhost:3001/api/push/status');
console.log('------------------------------------------------------');
