/**
 * Lance le serveur OpenWLM pour les tests E2E sur une BASE TEMPORAIRE isolée.
 * (Ne touche jamais messenger.db de production.)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openwlm-e2e-'));
const PORT = process.env.E2E_PORT || '3100';
const JWT_SECRET = 'e2e-secret-'.repeat(6);

const child = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
  cwd: tmp,
  env: { ...process.env, PORT, JWT_SECRET, NODE_ENV: 'test' },
  stdio: 'inherit'
});

const cleanup = () => {
  try { child.kill('SIGTERM'); } catch { /* ignore */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
};
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
child.on('exit', (code) => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} process.exit(code ?? 0); });
