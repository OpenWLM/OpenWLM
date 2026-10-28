import { isValidFormattedField } from '../utils/plusText.js';
import { removePushTargets } from '../utils/pushTargets.js';
import { Router } from 'express';
import crypto from 'crypto';
import { db, toPrivateUserDTO, toPublicUserDTO, logRecoveryEvent } from '../db.js';
import { getUserRoom } from '../sessionStore.js';
import { 
  authRateLimiter, 
  authenticateToken, 
  loginAccountLimiter,
  loginUsernameLimiter, 
  signupAccountLimiter, 
  captchaRateLimiter, 
  hashPassword, 
  verifyPasswordHash,
  burnPasswordCheck,
  issueSessionCookie,
  safeTokenEqual,
  SESSION_RENEW_AFTER_S
} from '../middleware/auth.js';
import { getClientIp } from '../clientIdentity.js';
import {
  createPowChallenge,
  verifyPow,
  createSuccessCounter,
  getSignupIpDailyLimit
} from '../utils/signupGuard.js';

export const captchas = new Map();

// SÉCURITÉ : plafond d'inscriptions RÉUSSIES par IP (fenêtre glissante 24 h)
export const signupIpCounter = createSuccessCounter({
  windowMs: 24 * 60 * 60 * 1000,
  limit: getSignupIpDailyLimit()
});

/** Portée stable de la clé d'authentification (cf. GET /api/auth/scope, docs/DEPLOYMENT.md). */
const AUTH_KEY_SCOPE = typeof process.env.AUTH_KEY_SCOPE === 'string' && /^[\w.:-]{1,253}$/.test(process.env.AUTH_KEY_SCOPE.trim())
  ? process.env.AUTH_KEY_SCOPE.trim().toLowerCase()
  : '';

/** Défis de récupération en cours (userId → nonce, 5 min), cf. /auth/recovery/*. */
export const recoveryChallenges = new Map();
/** Codes de récupération erronés récents par couple « userId|ip » (horodatages). */
export const recoveryFailures = new Map();
export const RECOVERY_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const RECOVERY_MAX_FAILURES_PER_IP = 5;

export const createAuthRouter = ({ io, broadcastStatusToContacts, isProd }) => {
  const router = Router();

  /**
   * Statut session utilisateur connecté
   */
  router.get('/user/me', authenticateToken, (req, res) => {
    try {
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
      if (!user) return res.status(404).json({ error: "Utilisateur non trouvé." });
      // Appareil mémorisé : prolonger la session (jeton réémis avec la même version)
      const p = req.tokenPayload;
      if (p?.rm && Number.isInteger(p.iat) && Date.now() / 1000 - p.iat > SESSION_RENEW_AFTER_S) {
        issueSessionCookie(req, res, { id: user.id, username: user.username, tv: user.token_version || 0, remember: true }, isProd);
      }
      // Sans le coffre de clés : il n'est remis qu'avec la preuve du mot de passe (connexion,
      // POST /api/user/vault). Un cookie volé ne permet plus d'emporter le coffre pour attaquer
      // le mot de passe hors ligne.
      res.json({ success: true, user: toPublicUserDTO(user) });
    } catch (err) {
      res.status(500).json({ error: "Erreur serveur." });
    }
  });

  /**
   * Déconnexion explicite
   */
  /**
   * Portée de la clé d'authentification (cf. deriveZeroKnowledgeKeys) : identifiant STABLE de ce
   * serveur, indépendant de son nom d'hôte. Sans AUTH_KEY_SCOPE, le client utilise l'hôte de la
   * page (comportement d'origine) : changer de nom de domaine ou de port rendrait alors les
   * clés de tous les comptes invalides (récupération : scripts/auth-recovery.mjs).
   */
  router.get('/auth/scope', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ scope: AUTH_KEY_SCOPE || null });
  });

  /**
   * Récupération de compte ouverte par l'administrateur (scripts/auth-recovery.mjs) :
   * 1. challenge : identifiant + CODE de récupération (remis par l'administrateur, effacé à la récupération réussie,
   *    codes erronés limités à 5 / 15 min par IP, sans refermer la fenêtre) → coffre de clés chiffré + défi chiffré pour la clé publique du compte ;
   * 2. complete : le client a ouvert le coffre avec le mot de passe (preuve) et déchiffré le défi
   *    → nouvelle clé d'authentification, TOUTES les sessions révoquées, cibles Push supprimées
   *    (un appareil perdu ne garde ni accès ni notifications), puis session pour cet appareil.
   * Sans code valide, le coffre n'est jamais remis (pas d'attaque hors ligne sur le mot de passe
   * à partir du seul identifiant). Chaque étape est journalisée (auth_recovery_log).
   */
  const recoveryUser = (username) => {
    const normalized = String(username || '').trim().toLowerCase();
    return normalized ? db.prepare('SELECT * FROM users WHERE LOWER(username) = ?').get(normalized) : null;
  };
  /**
   * Codes erronés : limités par couple (compte, IP) — 5 par 15 min — sans jamais refermer la
   * fenêtre. Fermer sur échecs laisserait n'importe qui, connaissant l'identifiant, bloquer une
   * récupération légitime ; avec un code de 100 bits, la force brute est de toute façon hors de
   * portée. Chaque échec est journalisé, et le blocage d'une IP signalé à l'administrateur.
   */
  const checkRecoveryCode = (user, code, ip) => {
    if (!user || !(Number(user.auth_recovery_until) > Date.now()) || !user.auth_recovery_code_hash) return 'invalid';
    const key = `${user.id}|${ip}`;
    const now = Date.now();
    const failures = (recoveryFailures.get(key) || []).filter((ts) => now - ts < RECOVERY_FAILURE_WINDOW_MS);
    if (failures.length >= RECOVERY_MAX_FAILURES_PER_IP) return 'limited';
    const given = crypto.createHash('sha256').update(String(code || '').trim().toUpperCase()).digest('hex');
    if (safeTokenEqual(given, user.auth_recovery_code_hash)) return 'ok';
    failures.push(now);
    recoveryFailures.set(key, failures);
    const attempts = (Number(user.auth_recovery_attempts) || 0) + 1;
    db.prepare('UPDATE users SET auth_recovery_attempts = ? WHERE id = ?').run(attempts, user.id);
    logRecoveryEvent(user.id, 'code erroné', { detail: `${attempts} au total, ${failures.length}/${RECOVERY_MAX_FAILURES_PER_IP} depuis cette IP`, ip });
    if (failures.length >= RECOVERY_MAX_FAILURES_PER_IP) {
      logRecoveryEvent(user.id, 'ip bloquée', { detail: '15 min, la fenêtre reste ouverte', ip });
      console.warn(`[Auth] Récupération du compte ${user.id} : ${failures.length} codes erronés depuis ${ip}, IP bloquée 15 min (scripts/auth-recovery.mjs --log).`);
    }
    return 'invalid';
  };
  const recoveryLimited = (res) => res.status(429).json({ error: 'Trop de codes erronés depuis cette adresse. Réessayez plus tard.', code: 'recovery_rate_limited' });

  router.post('/auth/recovery/challenge', authRateLimiter, (req, res) => {
    const ip = getClientIp(req);
    const user = recoveryUser(req.body?.username);
    const check = checkRecoveryCode(user, req.body?.code, ip);
    if (check === 'limited') return recoveryLimited(res);
    if (check !== 'ok' || !user.public_key || !user.encrypted_private_key) {
      return res.status(404).json({ error: 'Code de récupération invalide ou aucune récupération en cours.', code: 'no_recovery' });
    }
    // Un défi en cours n'est pas remplacé (une seconde demande ne peut pas gêner la première)
    let challenge = recoveryChallenges.get(user.id);
    if (!challenge || challenge.expires < Date.now()) {
      challenge = { nonce: crypto.randomBytes(32).toString('hex'), expires: Date.now() + 5 * 60 * 1000 };
      recoveryChallenges.set(user.id, challenge);
    }
    let encryptedNonce;
    try {
      const jwk = typeof user.public_key === 'string' ? JSON.parse(user.public_key) : user.public_key;
      const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
      encryptedNonce = crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(challenge.nonce)).toString('base64');
    } catch (err) {
      console.error('[Auth] Récupération : clé publique inutilisable :', err);
      return res.status(500).json({ error: 'Erreur serveur.' });
    }
    logRecoveryEvent(user.id, 'coffre remis', { ip });
    res.json({ success: true, vault: user.encrypted_private_key, encryptedNonce });
  });

  router.post('/auth/recovery/complete', authRateLimiter, async (req, res) => {
    const ip = getClientIp(req);
    const { username, code, nonce, newAuthKeyHex, remember } = req.body || {};
    const user = recoveryUser(username);
    const challenge = user ? recoveryChallenges.get(user.id) : null;
    const check = checkRecoveryCode(user, code, ip);
    if (check === 'limited') return recoveryLimited(res);
    const codeOk = check === 'ok';
    if (!codeOk || !challenge || challenge.expires < Date.now()
      || typeof nonce !== 'string' || !safeTokenEqual(nonce, challenge.nonce) || !/^[a-fA-F0-9]{64}$/.test(String(newAuthKeyHex))) {
      if (codeOk) logRecoveryEvent(user.id, 'preuve refusée', { ip });
      return res.status(401).json({ error: 'Récupération refusée.', code: 'recovery_failed' });
    }
    recoveryChallenges.delete(user.id);
    const salt = crypto.randomBytes(16).toString('hex');
    let tokenVersion;
    try {
      const hash = await hashPassword(newAuthKeyHex, salt);
      db.transaction(() => {
        db.prepare(`UPDATE users SET password_hash = ?, salt = ?, token_version = COALESCE(token_version, 0) + 1, status = 'offline',
          auth_recovery_until = 0, auth_recovery_code_hash = NULL, auth_recovery_attempts = 0 WHERE id = ?`).run(hash, salt, user.id);
        removePushTargets(user.id);
      })();
      tokenVersion = db.prepare('SELECT token_version FROM users WHERE id = ?').get(user.id).token_version;
    } catch (err) {
      console.error('[Auth] Récupération : enregistrement impossible :', err);
      return res.status(500).json({ error: 'Erreur serveur.' });
    }
    // Les anciennes sessions (appareil perdu…) sont coupées tout de suite
    io.in(getUserRoom(user.id)).disconnectSockets(true);
    broadcastStatusToContacts(user.id, { id: user.id, userId: user.id, status: 'offline' });
    logRecoveryEvent(user.id, 'réussie', { detail: 'nouvelle clé, sessions révoquées, cibles Push supprimées', ip });
    issueSessionCookie(req, res, { id: user.id, username: user.username, tv: tokenVersion, remember: remember === true }, isProd);
    res.json({ success: true, user: toPrivateUserDTO({ ...user, token_version: tokenVersion, status: 'offline' }) });
  });

  /**
   * Abandon d'une ouverture de session sur CET appareil (clés de chiffrement impossibles à
   * mettre en place) : seul le cookie de ce navigateur est retiré. Les autres appareils restent
   * connectés (contrairement à /logout, qui révoque toutes les sessions du compte).
   * Authentifiée : sans cookie valide, rien à retirer (pas de déconnexion provoquée par un autre site).
   */
  router.post('/logout-device', authenticateToken, (req, res) => {
    const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
    const isCloudflare = Boolean(req.headers['cf-ray'] || isHttps);
    res.clearCookie('token', { httpOnly: true, secure: (isProd || isCloudflare) && isHttps, sameSite: 'strict', path: '/' });
    res.json({ success: true });
  });

  router.post('/logout', authenticateToken, (req, res) => {
    const userId = req.user.id;
    // Toutes les sessions du compte sont révoquées : plus aucun appareil ne doit recevoir de
    // notification (Web Push, FCM). Route de sécurité : un échec n'est pas passé sous silence.
    try {
      db.transaction(() => {
        db.prepare('UPDATE users SET token_version = COALESCE(token_version, 0) + 1, status = ? WHERE id = ?').run('offline', userId);
        removePushTargets(userId);
      })();
    } catch (err) {
      console.error('[Auth] Échec de la révocation des sessions à la déconnexion:', err);
      return res.status(500).json({ error: 'Erreur serveur : déconnexion non effectuée.', code: 'logout_failed' });
    }
    broadcastStatusToContacts(userId, { id: userId, userId, status: 'offline' });
    // SÉCURITÉ : couper réellement toutes les sockets actives de l'utilisateur
    io.in(getUserRoom(userId)).disconnectSockets(true);

    const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
    const isCloudflare = Boolean(req.headers['cf-ray'] || isHttps);
    const isSecure = (isProd || isCloudflare) && isHttps;

    res.clearCookie('token', {
      httpOnly: true,
      secure: isSecure,
      sameSite: 'strict',
      path: '/'
    });

    res.json({ success: true, message: "Déconnecté avec succès." });
  });

  /**
   * Captcha mathématique pour inscription
   */
  router.get('/captcha', captchaRateLimiter, (req, res) => {
    const num1 = Math.floor(Math.random() * 10) + 1;
    const num2 = Math.floor(Math.random() * 10) + 1;
    const id = crypto.randomUUID();
    const lang = (req.query.lang || '').toString().toLowerCase();

    // Défi de preuve de travail lié à ce captcha (usage unique, même durée de vie)
    const pow = createPowChallenge();
    captchas.set(id, { answer: num1 + num2, pow, expires: Date.now() + 5 * 60 * 1000 });
    const text = lang === 'en' ? `How much is ${num1} + ${num2}?` : `Combien font ${num1} + ${num2} ?`;
    // NB : num1/num2 restent exposés pour l'UX. Le captcha mathématique n'est PAS une
    // protection anti-robot ; ce sont la PoW et le plafond par IP qui le sont.
    res.json({ id, num1, num2, question: `${num1} + ${num2} = ?`, text, pow });
  });

  /**
   * Inscription d'un nouvel utilisateur
   */
  router.post('/signup', authRateLimiter, async (req, res) => {
    const { username, password, nickname, captchaId, captchaAnswer, powNonce } = req.body;

    const clientIp = getClientIp(req);
    if (!signupIpCounter.check(clientIp).allowed) {
      return res.status(429).json({ error: "Trop de comptes créés depuis cette adresse. Veuillez réessayer plus tard.", code: 'signup_ip_limit' });
    }

    const signupLimit = signupAccountLimiter.attempt(username);
    if (!signupLimit.allowed) {
      return res.status(429).json({ error: "Trop de tentatives d'inscription pour ce compte. Veuillez réessayer plus tard.", code: 'signup_rate_limited' });
    }
    
    if (!captchaId || captchaAnswer === undefined) {
      return res.status(400).json({ error: 'Captcha manquant.', code: 'captcha_missing' });
    }
    const storedCaptcha = captchas.get(captchaId);
    if (!storedCaptcha || storedCaptcha.expires < Date.now()) {
      captchas.delete(captchaId);
      return res.status(400).json({ error: 'Captcha expiré ou invalide.', code: 'captcha_expired' });
    }
    if (parseInt(captchaAnswer) !== storedCaptcha.answer) {
      captchas.delete(captchaId);
      return res.status(400).json({ error: 'Réponse au Captcha incorrecte.', code: 'captcha_wrong' });
    }
    if (!verifyPow(storedCaptcha.pow, powNonce)) {
      captchas.delete(captchaId);
      return res.status(400).json({ error: 'Vérification anti-robot (preuve de travail) invalide.', code: 'pow_invalid' });
    }
    captchas.delete(captchaId);

    // Normalisé une seule fois : la même valeur sert à la validation et à l'enregistrement
    // (un identifiant entouré d'espaces était accepté mais introuvable à la connexion)
    const normalizedSignupName = typeof username === 'string' ? username.trim().toLowerCase() : '';
    const usernameRegex = /^[a-zA-Z0-9_.@-]{3,100}$/;
    if (!normalizedSignupName || !usernameRegex.test(normalizedSignupName)) {
      return res.status(400).json({ error: 'Adresse de messagerie invalide (3-100 caractères, sans espaces).', code: 'username_invalid' });
    }

    if (nickname !== undefined && nickname !== null && !isValidFormattedField(nickname, 50, 300)) {
      return res.status(400).json({ error: 'Surnom invalide (max 50 caractères).', code: 'nickname_invalid' });
    }

    if (!password || typeof password !== 'string' || !/^[a-fA-F0-9]{64}$/.test(password)) {
      return res.status(400).json({ error: "Clé d'authentification invalide (format hex 256 bits requis).", code: 'auth_key_invalid' });
    }

    const salt = crypto.randomBytes(16).toString('hex');

    try {
      const hashedPassword = await hashPassword(password, salt);
      const stmt = db.prepare('INSERT INTO users (username, password_hash, salt, nickname, status, token_version) VALUES (?, ?, ?, ?, ?, 0)');
      const info = stmt.run(normalizedSignupName, hashedPassword, salt, nickname || normalizedSignupName.split('@')[0], 'offline');
      signupIpCounter.record(clientIp);
      res.json({ success: true, userId: info.lastInsertRowid });
    } catch (err) {
      if (err.message.includes('UNIQUE constraint failed')) {
        return res.status(400).json({ error: 'Cet identifiant est déjà utilisé.', code: 'username_taken' });
      }
      res.status(500).json({ error: "Erreur lors de l'inscription." });
    }
  });

  /**
   * Connexion utilisateur
   */
  router.post('/login', authRateLimiter, async (req, res) => {
    const { username, password, remember } = req.body;
    
    if (!username || !password) return res.status(400).json({ error: 'Identifiants requis.', code: 'credentials_required' });

    const loginKey = `${String(username).trim().toLowerCase()}|${getClientIp(req) || '?'}`;
    if (!loginAccountLimiter.attempt(loginKey).allowed || !loginUsernameLimiter.attempt(username).allowed) {
      return res.status(429).json({ error: "Trop de tentatives de connexion pour ce compte. Veuillez réessayer plus tard.", code: 'login_rate_limited' });
    }

    if (typeof password !== 'string' || !/^[a-fA-F0-9]{64}$/.test(password)) {
      return res.status(400).json({ error: "Format de clé d'authentification invalide.", code: 'auth_key_invalid' });
    }

    const normalizedUsername = String(username).trim().toLowerCase();
    let user;
    let passwordOk;
    try {
      user = db.prepare('SELECT * FROM users WHERE LOWER(username) = ?').get(normalizedUsername);
      // Toujours un calcul PBKDF2 complet, que le compte existe ou non (anti-énumération temporelle)
      passwordOk = user
        ? await verifyPasswordHash(password, user.salt, user.password_hash)
        : await burnPasswordCheck(password);
    } catch (err) {
      console.error('[Auth] Erreur lors de la vérification du mot de passe:', err);
      return res.status(500).json({ error: 'Erreur serveur.' });
    }

    if (user && passwordOk) {
      loginAccountLimiter.reset(loginKey);
      loginUsernameLimiter.reset(username);
      issueSessionCookie(req, res, { id: user.id, username: user.username, tv: user.token_version || 0, remember: remember === true }, isProd);

      res.json({ success: true, user: toPrivateUserDTO(user) });
    } else {
      res.status(401).json({ error: 'Identifiants invalides.', code: 'invalid_credentials' });
    }
  });

  return router;
};
