/**
 * scripts/live_server_guard.mjs - OpenWLM
 *
 * Garde-fou des tests « live » (ceux qui parlent à http://localhost:3001 et ouvrent
 * directement messenger.db). Sur une machine qui fait aussi tourner la prod, ce port est
 * celui de la PROD : sans ce contrôle, les inscriptions de test y créaient de vrais comptes.
 *
 * Un serveur lancé avec NODE_ENV=test envoie l'empreinte de sa base (en-tête
 * X-OpenWLM-Test-Db, cf. server/index.js). Si un serveur répond sur :3001 sans l'empreinte de
 * la base de CE checkout, les tests s'arrêtent. Aucun serveur : rien à vérifier (les tests
 * live se mettent en skip, les autres lancent leur propre serveur isolé).
 *
 * Chargé dans chaque fichier de test (`node --test --import ./scripts/live_server_guard.mjs`)
 * et par scripts/test_preflight.js.
 */
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expected = crypto.createHash('sha256').update(path.resolve(rootDir, 'messenger.db')).digest('hex');

/** 'none' (rien sur :3001), 'test' (serveur de test de ce checkout) ou 'foreign' (autre serveur). */
export const checkLiveServer = () => new Promise((resolve) => {
  const req = http.request({ hostname: '127.0.0.1', port: 3001, path: '/api/push/status', method: 'GET', timeout: 3000 }, (res) => {
    res.resume();
    resolve(res.headers['x-openwlm-test-db'] === expected ? 'test' : 'foreign');
  });
  req.on('timeout', () => { req.destroy(); resolve('foreign'); });
  req.on('error', () => resolve('none'));
  req.end();
});

export const FOREIGN_SERVER_MESSAGE =
  '[tests] Un serveur répond sur localhost:3001 mais ce n\'est pas le serveur de test de ce checkout '
  + '(prod ?). Les tests live écriraient dans SA base. Arrêtez-le, ou lancez le serveur de test : '
  + 'NODE_ENV=test node server/index.js (depuis la racine du dépôt).';

if (process.env.OPENWLM_GUARD_IMPORT_ONLY !== '1' && await checkLiveServer() === 'foreign') {
  console.error(FOREIGN_SERVER_MESSAGE);
  process.exit(1);
}
