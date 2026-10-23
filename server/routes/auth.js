import { isValidFormattedField } from '../utils/plusText.js';
import { removePushTargets } from '../utils/pushTargets.js';
import { Router } from 'express';
import crypto from 'crypto';
import { db, toPrivateUserDTO } from '../db.js';
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
      res.json({ success: true, user: toPrivateUserDTO(user) });
    } catch (err) {
      res.status(500).json({ error: "Erreur serveur." });
    }
  });

  /**
   * Déconnexion explicite
   */
  /**
   * Abandon d'une ouverture de session sur CET appareil (clés de chiffrement impossibles à
   * mettre en place) : seul le cookie de ce navigateur est retiré. Les autres appareils restent
   * connectés (contrairement à /logout, qui révoque toutes les sessions du compte).
   */
  router.post('/logout-device', (req, res) => {
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
