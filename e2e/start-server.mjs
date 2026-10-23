/**
 * Lance le serveur OpenWLM pour les tests E2E sur une BASE TEMPORAIRE isolée.
 * (Ne touche jamais messenger.db de production.)
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openwlm-e2e-'));
const PORT = process.env.E2E_PORT || '3100';
const JWT_SECRET = 'e2e-secret-'.repeat(6);
// Dossier de la base temporaire, pour les specs qui jouent un geste d'administrateur
// (scripts/auth-recovery.mjs, cf. e2e/auth-recovery.spec.ts)
export const E2E_DIR_FILE = path.join(os.tmpdir(), `openwlm-e2e-dir-${PORT}`);
fs.writeFileSync(E2E_DIR_FILE, tmp);

// Comptes de démonstration (npm run db:seed) dans la base temporaire : e2e/auth.spec.ts
// vérifie qu'on peut s'y connecter comme l'annonce le README
spawnSync(process.execPath, [path.join(root, 'scripts', 'seed-demo.js')], { cwd: tmp, stdio: 'inherit' });

const child = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
  cwd: tmp,
  // CLOUDFLARE_IP_RANGES = localhost : le serveur de test fait confiance à CF-Connecting-IP,
  // ce qui donne à chaque navigateur de test sa propre IP (en-tête posé par les specs).
  // Sans cela, toute la suite partage 127.0.0.1 et sature le limiteur d'auth (10/min/IP).
  // POW_DIFFICULTY=10 : la preuve de travail de l'inscription reste exercée, mais en ~1 000
  // hachages au lieu de ~130 000. À la difficulté réelle (17), sa durée est aléatoire et, sous
  // la charge de la suite complète, dépassait parfois le délai d'inscription des specs (échecs
  // au hasard). La difficulté réelle est couverte par tests/test_signup_guard.js.
  env: { ...process.env, PORT, JWT_SECRET, NODE_ENV: 'test', CLOUDFLARE_IP_RANGES: '127.0.0.1/32,::1/128', POW_DIFFICULTY: '10' },
  stdio: 'inherit'
});

const cleanup = () => {
  try { fs.rmSync(E2E_DIR_FILE, { force: true }); } catch { /* ignore */ }
  try { child.kill('SIGTERM'); } catch { /* ignore */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
};
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
child.on('exit', (code) => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} process.exit(code ?? 0); });
