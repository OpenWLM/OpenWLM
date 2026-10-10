import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { fileURLToPath } from 'url';
import { db } from '../db.js';
import { getClientIp } from '../clientIdentity.js';
import { createAccountRateLimiter } from '../accountRateLimiter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const getJwtSecret = () => {
  const envSecret = process.env.JWT_SECRET ? process.env.JWT_SECRET.trim() : null;
  const FORBIDDEN_SECRETS = ['wlm_classic_secret_key', 'secret', 'jwt_secret', 'password', '123456', 'changeme'];

  if (envSecret) {
    if (FORBIDDEN_SECRETS.includes(envSecret) || envSecret.length < 32) {
      console.error("[FATAL SECURITY] Le secret JWT fourni dans JWT_SECRET est trop faible ou interdit (minimum 32 caractères requis).");
      process.exit(1);
    }
    return envSecret;
  }

  const secretPath = path.join(__dirname, '../../.jwt_secret');
  if (fs.existsSync(secretPath)) {
    try {
      const savedSecret = fs.readFileSync(secretPath, 'utf8').trim();
      if (savedSecret && savedSecret.length >= 64 && !FORBIDDEN_SECRETS.includes(savedSecret)) {
        return savedSecret;
      }
    } catch (e) {
      console.warn("[Security] Impossible de lire .jwt_secret existant:", e.message);
    }
  }

  const generatedSecret = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(secretPath, generatedSecret, { mode: 0o600 });
    console.log("[Security] Nouveau secret JWT fort (256 bits) généré et stocké dans .jwt_secret.");
  } catch (err) {
    console.warn("[Security] Impossible d'écrire .jwt_secret sur le disque, secret conservé en mémoire pour ce processus.");
  }
  return generatedSecret;
};

export const SECRET = getJwtSecret();

export const parseCookies = (cookieHeader) => {
  const list = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') return list;
  cookieHeader.split(';').forEach(cookie => {
    const parts = cookie.split('=');
    const name = parts.shift()?.trim();
    if (!name) return;
    const value = parts.join('=').trim();
    try {
      list[name] = decodeURIComponent(value);
    } catch {
      list[name] = value;
    }
  });
  return list;
};

export const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1];

  // Fallback sécurisé : Cookie HttpOnly (SameSite=Strict)
  if (!token && req.headers.cookie) {
    const cookies = parseCookies(req.headers.cookie);
    token = cookies.token;
  }
  
  if (!token) return res.status(401).json({ error: "Non autorisé. Token manquant." });

  jwt.verify(token, SECRET, { algorithms: ['HS256'] }, (err, payload) => {
    if (err || !payload || !payload.id) return res.status(403).json({ error: "Token invalide ou expiré." });
    
    // Vérifier que l'utilisateur existe toujours en base de données
    const dbUser = db.prepare('SELECT id, username, token_version FROM users WHERE id = ?').get(payload.id);
    if (!dbUser) return res.status(401).json({ error: "Compte utilisateur introuvable ou révoqué." });

    // SÉCURITÉ : Vérifier que le token n'a pas été révoqué (changement de mot de passe, etc.)
    const currentTv = dbUser.token_version || 0;
    const tokenTv = payload.tv !== undefined ? payload.tv : 0;
    if (tokenTv !== currentTv) {
      return res.status(401).json({ error: "Session révoquée. Veuillez vous reconnecter." });
    }

    req.user = dbUser;
    next();
  });
};

export const hashPassword = (authKeyHex, salt) => {
  return crypto.pbkdf2Sync(authKeyHex, salt, 210000, 64, 'sha512').toString('hex');
};

export const verifyPasswordHash = (authKeyHex, salt, storedHash) => {
  if (!authKeyHex || !salt || !storedHash || typeof storedHash !== 'string') return false;
  const calculatedHash = hashPassword(authKeyHex, salt);
  const bufCalc = Buffer.from(calculatedHash, 'hex');
  const bufStored = Buffer.from(storedHash, 'hex');
  if (bufCalc.length !== bufStored.length) return false;
  return crypto.timingSafeEqual(bufCalc, bufStored);
};

export const safeTokenEqual = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  try { return crypto.timingSafeEqual(bufA, bufB); } catch { return false; }
};

export const isValidPath = (path) => {
  return typeof path === 'string' && path.startsWith('/assets/') && !path.includes('..');
};

export const canInteract = (senderId, targetId) => {
  const sId = parseInt(senderId, 10);
  const tId = parseInt(targetId, 10);
  if (isNaN(sId) || isNaN(tId) || sId <= 0 || tId <= 0) {
    return { allowed: false, reason: "Identifiants invalides." };
  }
  if (sId === tId) {
    return { allowed: false, reason: "Action impossible sur son propre compte." };
  }

  // Vérifier l'existence de la cible
  const targetUser = db.prepare('SELECT id FROM users WHERE id = ?').get(tId);
  if (!targetUser) {
    return { allowed: false, reason: "Utilisateur destinataire introuvable." };
  }

  // Vérifier la relation dans contacts (target -> sender)
  const targetRelation = db.prepare('SELECT status, blocked FROM contacts WHERE user_id = ? AND contact_id = ?').get(tId, sId);
  if (!targetRelation) {
    return { allowed: false, reason: "Ce contact n'est pas dans votre liste d'amis." };
  }
  if (Number(targetRelation.blocked) === 1) {
    return { allowed: false, reason: "Vous ne pouvez pas interagir avec cet utilisateur (bloqué)." };
  }

  // Vérifier la relation dans contacts (sender -> target)
  const senderRelation = db.prepare('SELECT status, blocked FROM contacts WHERE user_id = ? AND contact_id = ?').get(sId, tId);
  if (!senderRelation) {
    return { allowed: false, reason: "Ce contact n'est pas dans votre liste d'amis." };
  }
  if (Number(senderRelation.blocked) === 1) {
    return { allowed: false, reason: "Vous avez bloqué ce contact." };
  }

  return { allowed: true };
};

// Rate Limiters
export const rateLimitStorage = new Map();
export const authRateLimiter = (req, res, next) => {
  const ip = getClientIp(req);
  if (!ip) return res.status(400).json({ error: "Adresse IP cliente non déterminable." });

  const now = Date.now();
  const windowMs = 60000;
  const limit = 10;

  if (!rateLimitStorage.has(ip)) {
    rateLimitStorage.set(ip, []);
  }

  let timestamps = rateLimitStorage.get(ip).filter(ts => now - ts < windowMs);
  if (timestamps.length >= limit) {
    console.warn(`[Security] Rate limit atteint pour l'IP: ${ip}`);
    return res.status(429).json({ error: "Trop de tentatives. Veuillez réessayer dans une minute." });
  }

  timestamps.push(now);
  rateLimitStorage.set(ip, timestamps);
  next();
};

export const uploadRateLimitStorage = new Map();
export const uploadRateLimiter = (req, res, next) => {
  const ip = getClientIp(req);
  if (!ip) return res.status(400).json({ error: "Adresse IP cliente non déterminable." });

  const now = Date.now();
  const windowMs = 60000;
  const limit = 5;

  if (!uploadRateLimitStorage.has(ip)) {
    uploadRateLimitStorage.set(ip, []);
  }

  let timestamps = uploadRateLimitStorage.get(ip).filter(ts => now - ts < windowMs);
  if (timestamps.length >= limit) {
    console.warn(`[Security] Upload rate limit atteint pour l'IP: ${ip}`);
    return res.status(429).json({ error: "Trop d'envois de fichiers. Veuillez réessayer dans une minute." });
  }

  timestamps.push(now);
  uploadRateLimitStorage.set(ip, timestamps);
  next();
};

export const loginAccountLimiter = createAccountRateLimiter({ windowMs: 15 * 60 * 1000, limit: 10 });
export const signupAccountLimiter = createAccountRateLimiter({ windowMs: 15 * 60 * 1000, limit: 5 });
export const changePasswordAccountLimiter = createAccountRateLimiter({ windowMs: 15 * 60 * 1000, limit: 10 });
export const resetE2eAccountLimiter = createAccountRateLimiter({ windowMs: 15 * 60 * 1000, limit: 10 });

export const accountLimiters = [
  loginAccountLimiter,
  signupAccountLimiter,
  changePasswordAccountLimiter,
  resetE2eAccountLimiter
];

export const createIpRateLimiter = ({ windowMs, limit, message }) => {
  const store = new Map();
  const limiter = (req, res, next) => {
    const ip = getClientIp(req);
    if (!ip) return res.status(400).json({ error: "Adresse IP cliente non déterminable." });
    const now = Date.now();
    const timestamps = (store.get(ip) || []).filter(ts => now - ts < windowMs);
    if (timestamps.length >= limit) {
      return res.status(429).json({ error: message });
    }
    timestamps.push(now);
    store.set(ip, timestamps);
    next();
  };
  limiter.cleanup = () => {
    const now = Date.now();
    for (const [ip, timestamps] of store.entries()) {
      const active = timestamps.filter(ts => now - ts < windowMs);
      if (active.length === 0) store.delete(ip);
      else store.set(ip, active);
    }
  };
  return limiter;
};

export const inviteRateLimiter = createIpRateLimiter({ windowMs: 60 * 1000, limit: 20, message: "Trop d'invitations envoyées. Veuillez réessayer dans une minute." });
export const captchaRateLimiter = createIpRateLimiter({ windowMs: 60 * 1000, limit: 30, message: "Trop de demandes de captcha. Veuillez réessayer dans une minute." });
export const sensitiveRateLimiter = createIpRateLimiter({ windowMs: 60 * 1000, limit: 60, message: "Trop de requêtes. Veuillez ralentir." });

export const ipRateLimiters = [inviteRateLimiter, captchaRateLimiter, sensitiveRateLimiter];
