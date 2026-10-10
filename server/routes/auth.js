import { Router } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { db, toPrivateUserDTO } from '../db.js';
import { getUserRoom } from '../sessionStore.js';
import { 
  SECRET, 
  parseCookies, 
  authRateLimiter, 
  authenticateToken, 
  loginAccountLimiter, 
  signupAccountLimiter, 
  captchaRateLimiter, 
  hashPassword, 
  verifyPasswordHash 
} from '../middleware/auth.js';

export const captchas = new Map();

export const createAuthRouter = ({ io, broadcastStatusToContacts, isProd }) => {
  const router = Router();

  /**
   * Statut session utilisateur connecté
   */
  router.get('/user/me', authenticateToken, (req, res) => {
    try {
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
      if (!user) return res.status(404).json({ error: "Utilisateur non trouvé." });
      res.json({ success: true, user: toPrivateUserDTO(user) });
    } catch (err) {
      res.status(500).json({ error: "Erreur serveur." });
    }
  });

  /**
   * Déconnexion explicite
   */
  router.post('/logout', authenticateToken, (req, res) => {
    let token = req.headers['authorization']?.split(' ')[1];
    if (!token && req.headers.cookie) {
      const cookies = parseCookies(req.headers.cookie);
      token = cookies.token;
    }

    if (token) {
      try {
        const payload = jwt.verify(token, SECRET, { algorithms: ['HS256'] });
        if (payload && payload.id) {
          db.prepare('UPDATE users SET token_version = COALESCE(token_version, 0) + 1, status = ? WHERE id = ?').run('offline', payload.id);
          broadcastStatusToContacts(payload.id, { id: payload.id, userId: payload.id, status: 'offline' });
          // SÉCURITÉ : couper réellement toutes les sockets actives de l'utilisateur
          io.in(getUserRoom(payload.id)).disconnectSockets(true);
        }
      } catch (err) {}
    }

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

    captchas.set(id, { answer: num1 + num2, expires: Date.now() + 5 * 60 * 1000 });
    const text = lang === 'en' ? `How much is ${num1} + ${num2}?` : `Combien font ${num1} + ${num2} ?`;
    res.json({ id, num1, num2, question: `${num1} + ${num2} = ?`, text });
  });

  /**
   * Inscription d'un nouvel utilisateur
   */
  router.post('/signup', authRateLimiter, (req, res) => {
    const { username, password, nickname, captchaId, captchaAnswer } = req.body;

    const signupLimit = signupAccountLimiter.attempt(username);
    if (!signupLimit.allowed) {
      return res.status(429).json({ error: "Trop de tentatives d'inscription pour ce compte. Veuillez réessayer plus tard." });
    }
    
    if (!captchaId || captchaAnswer === undefined) {
      return res.status(400).json({ error: 'Captcha manquant.' });
    }
    const storedCaptcha = captchas.get(captchaId);
    if (!storedCaptcha || storedCaptcha.expires < Date.now()) {
      captchas.delete(captchaId);
      return res.status(400).json({ error: 'Captcha expiré ou invalide.' });
    }
    if (parseInt(captchaAnswer) !== storedCaptcha.answer) {
      captchas.delete(captchaId);
      return res.status(400).json({ error: 'Réponse au Captcha incorrecte.' });
    }
    captchas.delete(captchaId);

    const usernameRegex = /^[a-zA-Z0-9_.@-]{3,100}$/;
    if (!username || typeof username !== 'string' || !usernameRegex.test(username.trim()) || username.trim().length > 100) {
      return res.status(400).json({ error: 'Adresse de messagerie invalide (3-100 caractères, sans espaces).' });
    }

    if (nickname !== undefined && nickname !== null && (typeof nickname !== 'string' || nickname.length > 50)) {
      return res.status(400).json({ error: 'Surnom invalide (max 50 caractères).' });
    }

    if (!password || typeof password !== 'string' || !/^[a-fA-F0-9]{64}$/.test(password)) {
      return res.status(400).json({ error: "Clé d'authentification invalide (format hex 256 bits requis)." });
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const hashedPassword = hashPassword(password, salt);

    try {
      const stmt = db.prepare('INSERT INTO users (username, password_hash, salt, nickname, status, token_version) VALUES (?, ?, ?, ?, ?, 0)');
      const info = stmt.run(username.toLowerCase(), hashedPassword, salt, nickname || username.split('@')[0], 'offline');
      res.json({ success: true, userId: info.lastInsertRowid });
    } catch (err) {
      if (err.message.includes('UNIQUE constraint failed')) {
        return res.status(400).json({ error: 'Cet identifiant est déjà utilisé.' });
      }
      res.status(500).json({ error: "Erreur lors de l'inscription." });
    }
  });

  /**
   * Connexion utilisateur
   */
  router.post('/login', authRateLimiter, (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) return res.status(400).json({ error: 'Identifiants requis.' });

    const loginLimit = loginAccountLimiter.attempt(username);
    if (!loginLimit.allowed) {
      return res.status(429).json({ error: "Trop de tentatives de connexion pour ce compte. Veuillez réessayer plus tard." });
    }

    if (typeof password !== 'string' || !/^[a-fA-F0-9]{64}$/.test(password)) {
      return res.status(400).json({ error: "Format de clé d'authentification invalide." });
    }

    const normalizedUsername = String(username).trim().toLowerCase();
    const user = db.prepare('SELECT * FROM users WHERE LOWER(username) = ?').get(normalizedUsername);
    
    if (user && verifyPasswordHash(password, user.salt, user.password_hash)) {
      loginAccountLimiter.reset(username);
      const tv = user.token_version || 0;
      const token = jwt.sign({ id: user.id, username: user.username, tv }, SECRET, { expiresIn: '24h' });

      const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
      const isSecure = (isProd || Boolean(req.headers['cf-ray'] || isHttps)) && isHttps;

      res.cookie('token', token, {
        httpOnly: true,
        secure: isSecure,
        sameSite: 'strict',
        maxAge: 24 * 60 * 60 * 1000,
        path: '/'
      });

      res.json({ success: true, user: toPrivateUserDTO(user) });
    } else {
      res.status(401).json({ error: 'Identifiants invalides.' });
    }
  });

  return router;
};
