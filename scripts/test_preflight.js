#!/usr/bin/env node
/**
 * scripts/test_preflight.js - OpenWLM
 *
 * Garde-fou exécuté avant `npm test` (via le script npm `pretest`).
 *
 * La suite de tests est DESTRUCTIVE :
 *   - `tests/audit_security_enforcement.js` et `tests/test_hardening_audit2.js`
 *     ouvrent directement `PROJECT_ROOT/messenger.db` et parlent au serveur
 *     sur http://localhost:3001 ;
 *   - plusieurs tests insèrent/suppriment des utilisateurs, messages,
 *     invitations, etc.
 *
 * Lancée dans le répertoire de PRODUCTION (qui n'est pas un dépôt Git), la
 * suite frapperait la base réelle. On refuse donc de démarrer tant qu'on n'est
 * pas dans un dépôt Git (contexte prévu : le checkout du repo ou la CI),
 * sauf override explicite.
 *
 * Override conscient :  ALLOW_LIVE_TESTS=1 npm test
 *
 * Usage :
 *   node scripts/test_preflight.js
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

if (process.env.ALLOW_LIVE_TESTS === '1') {
  console.log('[preflight] ALLOW_LIVE_TESTS=1 → exécution forcée (vous assumez le risque).\n');
  process.exit(0);
}

// Détection d'un dépôt Git par le système de fichiers (indépendant de la
// propriété des fichiers : `git rev-parse` échoue sur un dépôt root:root).
function findGitRoot(startDir) {
  let dir = startDir;
  while (true) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const gitRoot = findGitRoot(rootDir);

if (gitRoot) {
  const dbPath = path.join(rootDir, 'messenger.db');
  console.log(`[preflight] Dépôt Git détecté (${gitRoot}) → suite de tests autorisée.`);
  console.log(`[preflight] Cible : serveur http://localhost:${process.env.PORT || 3001} + ${dbPath}`);
  console.log('[preflight] ⚠ Vérifiez que ce serveur est un serveur de TEST isolé :');
  console.log('[preflight]   la production écoute aussi sur le port 3001.\n');
  process.exit(0);
}

const dbPath = path.join(rootDir, 'messenger.db');
const dbExists = fs.existsSync(dbPath);

console.error('');
console.error('======================================================================');
console.error('  TESTS REFUSÉS — répertoire non versionné (pas de dépôt Git)');
console.error('======================================================================');
console.error('');
console.error(`  Répertoire courant : ${rootDir}`);
console.error(`  Base ciblée        : ${dbPath}${dbExists ? ' (présente)' : ''}`);
console.error(`  Serveur ciblé      : http://localhost:${process.env.PORT || 3001}`);
console.error('');
console.error('  La suite de tests est destructive : elle écrit directement dans');
console.error('  messenger.db et interroge le serveur sur localhost:3001. Lancée');
console.error('  dans le dossier de PRODUCTION, elle modifierait la base réelle.');
console.error('');
console.error('  → Lancez les tests depuis le dépôt Git (ex. OpenWLM_github_prep),');
console.error('    ou depuis la CI.');
console.error('  → Pour forcer malgré tout (à vos risques), préfixez la commande :');
console.error('       ALLOW_LIVE_TESTS=1 <votre commande, ex. npm test>');
console.error('');
process.exit(1);
