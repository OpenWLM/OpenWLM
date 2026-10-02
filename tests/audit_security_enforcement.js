import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import http from 'http';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import { io as ClientIO } from 'socket.io-client';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..');

const jwtSecretPath = path.join(PROJECT_ROOT, '.jwt_secret');
if (!fs.existsSync(jwtSecretPath)) {
  console.error("[ERREUR] Fichier .jwt_secret introuvable. Démarrez le serveur une première fois.");
  process.exit(1);
}

const JWT_SECRET = fs.readFileSync(jwtSecretPath, 'utf8').trim();
const db = new Database(path.join(PROJECT_ROOT, 'messenger.db'));

const makeHttp = (apiPath, method, token, data) => {
  return new Promise((resolve) => {
    const postData = data ? (typeof data === 'string' ? data : JSON.stringify(data)) : '';
    const req = http.request({
      hostname: 'localhost',
      port: 3001,
      path: apiPath,
      method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) } : {}),
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, body });
        }
      });
    });
    if (postData) req.write(postData);
    req.end();
  });
};

async function auditEnforcement() {
  console.log('======================================================================');
  console.log('  TESTS DE CONTOURNEMENT DIRECT API/SERVEUR (SANS LE FRONTEND)');
  console.log('======================================================================\n');

  // Mise en place de 3 comptes de test :
  // 9201 = Alice
  // 9202 = Bob (ami d'Alice)
  // 9203 = Charlie (étranger / pirate)
  // 9204 = David
  db.prepare('DELETE FROM contacts WHERE user_id IN (9201, 9202, 9203, 9204) OR contact_id IN (9201, 9202, 9203, 9204)').run();
  db.prepare('DELETE FROM invitations WHERE sender_id IN (9201, 9202, 9203, 9204) OR receiver_id IN (9201, 9202, 9203, 9204)').run();
  db.prepare('DELETE FROM messages WHERE sender_id IN (9201, 9202, 9203, 9204) OR receiver_id IN (9201, 9202, 9203, 9204)').run();
  db.prepare('DELETE FROM custom_emoticons WHERE owner_id IN (9201, 9202, 9203, 9204)').run();
  db.prepare('DELETE FROM shared_files WHERE sender_id IN (9201, 9202, 9203, 9204) OR receiver_id IN (9201, 9202, 9203, 9204)').run();
  db.prepare('DELETE FROM users WHERE id IN (9201, 9202, 9203, 9204)').run();

  const insertUser = (id, username, nickname, globalPrivate = 0) => {
    db.prepare(`
      INSERT INTO users (id, username, password_hash, salt, nickname, psm, avatar, scene, status, token_version, global_private)
      VALUES (?, ?, 'hash', 'salt', ?, 'PSM', '/assets/usertiles/chess.png', '/assets/scenes/0006.png', 'online', 0, ?)
    `).run(id, username, nickname, globalPrivate);
  };

  insertUser(9201, 'alice_audit', 'Alice', 0);
  insertUser(9202, 'bob_audit', 'Bob', 1); // Bob force global_private = 1
  insertUser(9203, 'charlie_audit', 'Charlie Hacker', 0);
  insertUser(9204, 'david_audit', 'David', 0);

  // Contacts mutuels : Alice <-> Bob
  db.prepare('INSERT INTO contacts (user_id, contact_id, status, blocked) VALUES (9201, 9202, 1, 0)').run();
  db.prepare('INSERT INTO contacts (user_id, contact_id, status, blocked) VALUES (9202, 9201, 1, 0)').run();

  const tokenAlice = jwt.sign({ id: 9201, username: 'alice_audit', tv: 0 }, JWT_SECRET);
  const tokenBob = jwt.sign({ id: 9202, username: 'bob_audit', tv: 0 }, JWT_SECRET);
  const tokenCharlie = jwt.sign({ id: 9203, username: 'charlie_audit', tv: 0 }, JWT_SECRET);

  const socketAlice = ClientIO('http://localhost:3001', { auth: { token: tokenAlice }, transports: ['websocket'] });
  const socketBob = ClientIO('http://localhost:3001', { auth: { token: tokenBob }, transports: ['websocket'] });
  const socketCharlie = ClientIO('http://localhost:3001', { auth: { token: tokenCharlie }, transports: ['websocket'] });

  const safeConnect = (s) => new Promise((resolve, reject) => {
    s.once('connect', resolve);
    s.once('connect_error', reject);
    setTimeout(() => reject(new Error('Timeout connection socket')), 3000);
  });

  await Promise.all([safeConnect(socketAlice), safeConnect(socketBob), safeConnect(socketCharlie)]);

  socketAlice.emit('identify', 9201);
  socketBob.emit('identify', 9202);
  socketCharlie.emit('identify', 9203);
  await new Promise(r => setTimeout(r, 300));

  const results = [];

  // --- 1. MESSAGES : USURPATION SENDER_ID ---
  console.log('[1] Test : Usurpation du senderId (Charlie prétend être Alice)...');
  const spoofMsg = await new Promise(res => {
    socketCharlie.emit('send_message', { senderId: 9201, receiverId: 9202, text: 'Je suis Alice' }, res);
    setTimeout(() => res({ timeout: true }), 1000);
  });
  const t1Ok = spoofMsg?.success === false;
  results.push({ name: 'Messages - Usurpation senderId', ok: t1Ok, detail: JSON.stringify(spoofMsg) });

  // --- 2. MESSAGES : LECTURE HISTORIQUE D\'AUTRUI ---
  console.log('[2] Test : Lecture espionne d\'historique (Charlie tente de lire la conv Alice <-> Bob)...');
  const spyHistory = await makeHttp('/api/messages/9201/9202', 'GET', tokenCharlie);
  const t2Ok = spyHistory.status === 403;
  results.push({ name: 'Messages - Espionnage historique autrui', ok: t2Ok, detail: `HTTP ${spyHistory.status}` });

  // --- 3. MESSAGES : SUPPRESSION HISTORIQUE D\'AUTRUI ---
  console.log('[3] Test : Suppression historique d\'autrui...');
  db.prepare("INSERT INTO messages (sender_id, receiver_id, text) VALUES (9201, 9202, 'Secret Alice Bob')").run();
  await makeHttp('/api/messages/clear', 'POST', tokenCharlie, { contactId: 9202 });
  const msgStillThere = db.prepare('SELECT COUNT(*) as c FROM messages WHERE sender_id = 9201 AND receiver_id = 9202').get().c;
  const t3Ok = msgStillThere === 1;
  results.push({ name: 'Messages - Isolement suppression historique', ok: t3Ok, detail: `${msgStillThere} message conservé` });

  // --- 4. MODE PRIVÉ FORCÉ PAR SERVEUR ---
  console.log('[4] Test : Tentative de forcer la persistance d\'un message quand un contact est en global_private...');
  await new Promise(res => {
    socketAlice.emit('send_message', { senderId: 9201, receiverId: 9202, text: 'Message non-privé tenté', isPrivate: false }, res);
    setTimeout(res, 500);
  });
  const privateMsgInDb = db.prepare("SELECT COUNT(*) as c FROM messages WHERE text = 'Message non-privé tenté'").get().c;
  const t4Ok = privateMsgInDb === 0;
  results.push({ name: 'Mode Privé - Forçage serveur non-persistance', ok: t4Ok, detail: `${privateMsgInDb} en base (attendu: 0)` });

  // --- 5. INVITATIONS : S'INVITER SOI-MÊME OU INVITATION EN DOUBLE ---
  console.log('[5] Test : Invitation de soi-même ou invitation en doublon...');
  const selfInvite = await makeHttp('/api/invite', 'POST', tokenAlice, { receiverUsername: 'alice_audit' });
  const dupInvite = await makeHttp('/api/invite', 'POST', tokenAlice, { receiverUsername: 'bob_audit' });
  const t5Ok = selfInvite.status === 400 && dupInvite.status === 400;
  results.push({ name: 'Invitations - Anti-auto-ajout & Anti-doublon', ok: t5Ok, detail: `Self: HTTP ${selfInvite.status}, Dup: HTTP ${dupInvite.status}` });

  // --- 6. INVITATIONS : ACCEPTER UNE INVITATION DESTINÉE À UN AUTRE ---
  console.log('[6] Test : Vol / Acceptation d\'invitation destinée à un tiers...');
  db.prepare("INSERT INTO invitations (id, sender_id, receiver_id, status) VALUES (9999, 9204, 9201, 'pending')").run();
  const stealInvite = await makeHttp('/api/accept-invite', 'POST', tokenCharlie, { invitationId: 9999 });
  const t6Ok = stealInvite.status === 404 || stealInvite.status === 403;
  results.push({ name: 'Invitations - Vol d\'invitation tiers', ok: t6Ok, detail: `HTTP ${stealInvite.status}` });

  // --- 7. APPELS : APPEL VERS NON-CONTACT OU BOT VIRTUEL ---
  console.log('[7] Test : Appel WebRTC vers non-contact ou faux bot...');
  let charlieCallReceived = false;
  socketCharlie.on('incoming_call', () => { charlieCallReceived = true; });
  socketAlice.emit('call_request', { target: 9203, signal: 'signal_test' });
  socketAlice.emit('call_request', { target: -1, signal: 'signal_test' });
  await new Promise(r => setTimeout(r, 400));
  const t7Ok = !charlieCallReceived;
  results.push({ name: 'Appels - Blocage non-contact et faux contact', ok: t7Ok, detail: `Signal reçu: ${charlieCallReceived}` });

  // --- 8. JEUX : COUP HORS-TOUR ET CASE OCCUPÉE ---
  console.log('[8] Test : Triche aux jeux (coup hors tour, case déjà occupée)...');
  socketAlice.emit('game_invite', { target: 9202, gameType: 'morpion' });
  await new Promise(r => setTimeout(r, 200));
  socketBob.emit('game_accept', { target: 9201, gameType: 'morpion' });
  await new Promise(r => setTimeout(r, 400));

  const bobCheatTurn = await new Promise(res => {
    socketBob.once('game_error', (err) => res({ error: true, msg: err.message }));
    socketBob.emit('game_move', { target: 9201, index: 0 });
    setTimeout(() => res({ error: false }), 800);
  });

  socketAlice.emit('game_move', { target: 9202, index: 0 });
  await new Promise(r => setTimeout(r, 300));

  const bobCheatOccupied = await new Promise(res => {
    socketBob.once('game_error', (err) => res({ error: true, msg: err.message }));
    socketBob.emit('game_move', { target: 9201, index: 0 });
    setTimeout(() => res({ error: false }), 800);
  });

  const t8Ok = bobCheatTurn.error && bobCheatOccupied.error;
  results.push({ name: 'Jeux - Anti-triche (hors-tour & case occupée)', ok: t8Ok, detail: `Hors-tour: "${bobCheatTurn.msg}", Occupée: "${bobCheatOccupied.msg}"` });

  // --- 9. ÉMOTICÔNES : SUPPRESSION DE L\'ÉMOTICÔNE D\'UN TIERS ---
  console.log('[9] Test : Suppression d\'une émoticône d\'un tiers...');
  db.prepare(`
    INSERT INTO custom_emoticons (id, owner_id, shortcut, mime_type, file_size, width, height, asset_filename, created_at)
    VALUES ('emo_alice_secret', 9201, '(alicesecret)', 'image/png', 1024, 32, 32, 'fake.bin', 1000)
  `).run();
  const deleteOtherEmo = await makeHttp('/api/emoticons/custom/emo_alice_secret', 'DELETE', tokenCharlie);
  const emoStillExists = db.prepare("SELECT COUNT(*) as c FROM custom_emoticons WHERE id = 'emo_alice_secret'").get().c;
  const t9Ok = (deleteOtherEmo.status === 404 || deleteOtherEmo.status === 403) && emoStillExists === 1;
  results.push({ name: 'Émoticônes - Protection suppression par autrui', ok: t9Ok, detail: `HTTP ${deleteOtherEmo.status}, Conservée: ${emoStillExists === 1}` });

  // --- 10. PROFILS : TRAVERSAL PATH ET STATUT INTERDIT ---
  console.log('[10] Test : Path traversal dans avatar/scène et injection de statut interdit...');
  const traversalAvatar = await makeHttp('/api/user/update', 'POST', tokenCharlie, { avatar: '/assets/../../../../etc/passwd' });
  const fakeStatus = await makeHttp('/api/user/update', 'POST', tokenCharlie, { status: 'ADMIN_HACK' });
  const charlieDb = db.prepare('SELECT avatar, status FROM users WHERE id = 9203').get();
  const t10Ok = traversalAvatar.status === 400 && charlieDb.status !== 'ADMIN_HACK';
  results.push({ name: 'Profils - Rejet Path Traversal & Statut invalide', ok: t10Ok, detail: `Avatar HTTP ${traversalAvatar.status}, Statut BDD: "${charlieDb.status}"` });

  // --- 11. FICHIERS : TÉLÉCHARGEMENT SANS TOKEN VALIDE ---
  console.log('[11] Test : Téléchargement de fichier sans token d\'accès secret...');
  db.prepare(`
    INSERT INTO shared_files (id, sender_id, receiver_id, filename, original_name, file_size, file_type, token, expires_at)
    VALUES ('file_secu_test', 9201, 9202, 'nonexistent.bin', 'test.bin', 100, 'application/octet-stream', 'good_secret_token_123', ?)
  `).run(Date.now() + 3600000);
  const dlNoToken = await makeHttp('/api/files/download/file_secu_test', 'GET');
  const dlWrongToken = await makeHttp('/api/files/download/file_secu_test?token=wrong_token', 'GET');
  const t11Ok = dlNoToken.status === 401 && dlWrongToken.status === 403;
  results.push({ name: 'Fichiers - Téléchargement sans token secret', ok: t11Ok, detail: `Sans token: HTTP ${dlNoToken.status}, Mauvais token: HTTP ${dlWrongToken.status}` });

  socketAlice.disconnect();
  socketBob.disconnect();
  socketCharlie.disconnect();

  // Nettoyage final
  db.prepare('DELETE FROM contacts WHERE user_id IN (9201, 9202, 9203, 9204) OR contact_id IN (9201, 9202, 9203, 9204)').run();
  db.prepare('DELETE FROM invitations WHERE sender_id IN (9201, 9202, 9203, 9204) OR receiver_id IN (9201, 9202, 9203, 9204)').run();
  db.prepare('DELETE FROM messages WHERE sender_id IN (9201, 9202, 9203, 9204) OR receiver_id IN (9201, 9202, 9203, 9204)').run();
  db.prepare('DELETE FROM custom_emoticons WHERE owner_id IN (9201, 9202, 9203, 9204)').run();
  db.prepare("DELETE FROM shared_files WHERE id = 'file_secu_test'").run();
  db.prepare('DELETE FROM users WHERE id IN (9201, 9202, 9203, 9204)').run();

  console.log('\n======================================================================');
  console.log('  BILAN SYNTHÉTIQUE DES VÉRIFICATIONS D\'ENFORCEMENT SERVEUR :');
  console.log('======================================================================');
  for (const r of results) {
    console.log(`[${r.ok ? 'CONFORME' : 'ÉCHEC'}] ${r.name} -> ${r.detail}`);
  }
  console.log('======================================================================\n');

  const allPassed = results.every(r => r.ok);
  if (!allPassed) {
    console.error('❌ ÉCHEC : Au moins un test d\'enforcement serveur a échoué !');
    process.exit(1);
  } else {
    console.log('✅ SUCCÈS : 100% des restrictions sont strictement appliquées côté serveur.');
    process.exit(0);
  }
}

auditEnforcement().catch((err) => {
  console.error("Erreur d'exécution de l'audit:", err);
  process.exit(1);
});
