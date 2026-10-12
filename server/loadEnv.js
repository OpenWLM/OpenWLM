/**
 * Chargement du fichier .env — À IMPORTER EN PREMIER.
 *
 * Les modules ES sont évalués avant le corps du module qui les importe. Plusieurs
 * modules lisent `process.env` dès leur initialisation (ex. `server/middleware/auth.js`
 * fait `export const SECRET = getJwtSecret();`). Un chargement de .env placé dans le
 * corps de `server/index.js` interviendrait TROP TARD pour eux.
 *
 * On expose donc le chargement comme un module à effet de bord, importé en toute
 * première ligne de `server/index.js` : il s'exécute avant tous les autres imports.
 *
 * Les variables déjà présentes dans l'environnement restent prioritaires
 * (`process.loadEnvFile` ne les écrase pas).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const envFilePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');

if (typeof process.loadEnvFile === 'function' && fs.existsSync(envFilePath)) {
  try {
    process.loadEnvFile(envFilePath);
  } catch {
    // Fichier .env illisible/invalide : on l'ignore (les variables d'environnement
    // réellement définies restent la source de vérité).
  }
}
