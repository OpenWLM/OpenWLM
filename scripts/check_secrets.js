#!/usr/bin/env node
/**
 * scripts/check_secrets.js - OpenWLM
 * Garde-fou automatisé anti-fuite de secrets (VAPID, JWT, certificats, credentials).
 * 
 * Scanne :
 * 1. La liste des fichiers trackés par Git (interdiction stricte de .env, .jwt_secret, .vapid_keys.json, *.pem, *.key).
 * 2. Le contenu de tous les fichiers versionnés pour détecter toute chaîne ressemblant à une clé privée.
 * 3. Les modifications indexées (staged) si exécuté dans un hook pre-commit.
 * 4. La conformité du template .env.example (valeurs de secrets obligatoirement vides).
 * 
 * Usage :
 *   node scripts/check_secrets.js
 *   npm run check:secrets
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

console.log('======================================================');
console.log('   OpenWLM — Audit de Sécurité Anti-Secrets           ');
console.log('======================================================\n');

let violations = [];

// 1. Noms de fichiers et extensions formellement interdits dans Git
const FORBIDDEN_FILE_PATTERNS = [
  /^\.env$/,
  /^\.env\.(?!example$)[a-zA-Z0-9._-]+$/,
  /^\.jwt_secret$/,
  /^\.vapid_keys\.json$/,
  /\.pem$/,
  /\.key$/,
  /\.secret$/,
  /\.sqlite$/,
  /\.sqlite3$/,
  /^messenger\.db.*$/
];

// Vérification des fichiers actuellement suivis par Git
try {
  const trackedFilesOutput = execSync('git ls-files', { cwd: rootDir, encoding: 'utf8' });
  const trackedFiles = trackedFilesOutput.split('\n').filter(Boolean);

  console.log(`[Audit] Analyse des ${trackedFiles.length} fichiers versionnés...`);

  for (const file of trackedFiles) {
    const basename = path.basename(file);

    for (const pattern of FORBIDDEN_FILE_PATTERNS) {
      if (pattern.test(basename)) {
        violations.push({
          type: 'FORBIDDEN_TRACKED_FILE',
          file,
          message: `Le fichier "${file}" correspond au motif interdit ${pattern} et ne doit JAMAIS être versionné.`
        });
      }
    }
  }

  // 2. Vérification du contenu des fichiers texte versionnés
  const SECRET_CONTENT_PATTERNS = [
    {
      name: 'VAPID_PRIVATE_KEY_VALUE',
      regex: /VAPID_PRIVATE_KEY\s*=\s*["']?([A-Za-z0-9_-]{30,})["']?/i,
      filter: (match) => !match.includes('example') && !match.includes('placeholder')
    },
    {
      name: 'RAW_PRIVATE_KEY_PEM',
      regex: /-----BEGIN\s+(?:RSA|EC|DSA|OPENSSH|ENCRYPTED)?\s*PRIVATE\s+KEY-----/i
    }
  ];

  for (const file of trackedFiles) {
    const fullPath = path.join(rootDir, file);
    if (!fs.existsSync(fullPath)) continue;

    // Ignorer les fichiers binaires ou très lourds
    if (file.endsWith('.png') || file.endsWith('.jpg') || file.endsWith('.mp3') || file.endsWith('.ico')) continue;

    try {
      const content = fs.readFileSync(fullPath, 'utf8');

      for (const { name, regex, filter } of SECRET_CONTENT_PATTERNS) {
        const match = content.match(regex);
        if (match) {
          if (!filter || filter(match[0])) {
            violations.push({
              type: 'EXPOSED_SECRET_PATTERN',
              file,
              message: `Motif de secret détecté [${name}] dans le fichier "${file}".`
            });
          }
        }
      }
    } catch {
      // Ignorer les fichiers non lisibles en UTF-8
    }
  }

  // 3. Vérification du contenu du template .env.example
  const envExamplePath = path.join(rootDir, '.env.example');
  if (fs.existsSync(envExamplePath)) {
    const envExample = fs.readFileSync(envExamplePath, 'utf8');
    const privateMatch = envExample.match(/^[ \t]*VAPID_PRIVATE_KEY[ \t]*=[ \t]*(.+)$/m);
    if (privateMatch && privateMatch[1].trim()) {
      violations.push({
        type: 'ENV_EXAMPLE_HAS_SECRET',
        file: '.env.example',
        message: `.env.example ne doit contenir aucune valeur pour VAPID_PRIVATE_KEY (actuellement: "${privateMatch[1].trim().slice(0, 5)}...").`
      });
    }

    const publicMatch = envExample.match(/^[ \t]*VAPID_PUBLIC_KEY[ \t]*=[ \t]*(.+)$/m);
    if (publicMatch && publicMatch[1].trim()) {
      violations.push({
        type: 'ENV_EXAMPLE_HAS_PUBLIC_KEY',
        file: '.env.example',
        message: `.env.example doit laisser VAPID_PUBLIC_KEY vide pour que chaque déploiement génère ses propres clés.`
      });
    }
  }

  // 4. Vérification du git diff staged (si un commit est en cours de préparation)
  try {
    const stagedDiff = execSync('git diff --cached', { cwd: rootDir, encoding: 'utf8' });
    if (stagedDiff) {
      for (const { name, regex, filter } of SECRET_CONTENT_PATTERNS) {
        const match = stagedDiff.match(regex);
        if (match && (!filter || filter(match[0]))) {
          violations.push({
            type: 'STAGED_DIFF_SECRET',
            file: 'git-index (staged)',
            message: `Un secret potentiel [${name}] a été indexé dans le staging Git.`
          });
        }
      }
    }
  } catch {}

} catch (err) {
  console.error('[ERREUR] Échec de l\'exécution de l\'audit Git:', err.message);
  process.exit(1);
}

// Bilan
if (violations.length > 0) {
  console.error(`\n❌ ÉCHEC DE L'AUDIT DE SÉCURITÉ : ${violations.length} anomalie(s) détectée(s) !\n`);
  for (const v of violations) {
    console.error(`• [${v.type}] ${v.file} : ${v.message}`);
  }
  console.error('\n[BLOCAGE COMMIT] Veuillez corriger ces éléments avant tout push vers GitHub.');
  process.exit(1);
}

console.log('✅ SUCCÈS : Aucun secret, clé privée ou fichier sensible détecté dans les fichiers trackés.');
console.log('Le dépôt est sain et prêt pour le versionnage.\n');
process.exit(0);
