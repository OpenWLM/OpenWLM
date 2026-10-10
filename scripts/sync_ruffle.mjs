/**
 * Copie les fichiers Ruffle (self-hosted) depuis node_modules vers public/ruffle/.
 * Ainsi le dépôt reste léger : les 28 Mo de Ruffle ne sont PAS versionnés.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const src = path.join(root, 'node_modules', '@ruffle-rs', 'ruffle');
const dest = path.join(root, '.ruffle');

if (!fs.existsSync(src)) {
  console.warn('[ruffle:sync] @ruffle-rs/ruffle introuvable — lancez `npm install`.');
  process.exit(0);
}

fs.mkdirSync(dest, { recursive: true });
let n = 0;
for (const f of fs.readdirSync(src)) {
  if (f.endsWith('.map')) continue;                       // pas de source maps
  if (!(f.endsWith('.wasm') || f.endsWith('.js') || f.startsWith('LICENSE'))) continue;
  fs.copyFileSync(path.join(src, f), path.join(dest, f));
  n++;
}
console.log(`[ruffle:sync] ${n} fichier(s) Ruffle copiés dans .ruffle/`);
