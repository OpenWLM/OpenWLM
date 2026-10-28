// DOIT rester le tout premier import : charge .env AVANT l'évaluation des autres
// modules (certains lisent process.env dès leur init, ex. middleware/auth.js).
import './loadEnv.js';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

import { db } from './db.js';
import { getUserRoom, isUserOnline } from './sessionStore.js';
import { 
  rateLimitStorage, 
  uploadRateLimitStorage, 
  accountLimiters, 
  ipRateLimiters 
} from './middleware/auth.js';
import { createAuthRouter, captchas, signupIpCounter, recoveryChallenges, recoveryFailures, RECOVERY_FAILURE_WINDOW_MS } from './routes/auth.js';
import { createUsersRouter } from './routes/users.js';
import { createMessagesRouter } from './routes/messages.js';
import { createFilesRouter, cleanupExpiredFiles, cleanupOrphanUploads } from './routes/files.js';
import { createEmoticonsRouter } from './routes/emoticons.js';
import { createPushRouter } from './routes/push.js';
import { createGamesRouter, activeGames, getGamePlayers } from './routes/games.js';
import createRtcRouter from './routes/rtc.js';
import { messageLimits, wizzLimits, winkLimits, ackLimits, privateToggleLimits, cleanupByteBudget, cleanupSenderStorage } from './sockets/messages.js';
import { cleanupWindow } from './utils/rateWindow.js';
import { gameMoveLimits, gameEventLimits, GAME_MOVE_WINDOW_MS } from './sockets/games.js';
import { setupSocketHandlers } from './sockets/index.js';
import { isUnrecognizedTunnelRequest, defaultCloudflareMatcher } from './clientIdentity.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ROBUSTESSE : après une exception non gérée, l'état du processus (verrous, Maps en
// mémoire, transactions, sockets) n'est plus fiable. Continuer à servir est plus
// dangereux que redémarrer : on journalise, on ferme proprement, puis on quitte avec
// un code d'erreur pour que le superviseur (systemd, pm2, Docker restart policy…)
// relance un processus sain. Cf. docs/DEPLOYMENT.md.
let shuttingDown = false;
const fatalShutdown = (kind, err) => {
  console.error(`[FATAL] ${kind} — arrêt du processus pour redémarrage par le superviseur:`, err);
  if (shuttingDown) return;
  shuttingDown = true;
  // Filet : sortie forcée si la fermeture propre se bloque
  setTimeout(() => process.exit(1), 3000).unref();
  try {
    io.close(() => {
      try { db.close(); } catch { /* ignore */ }
      process.exit(1);
    });
  } catch {
    process.exit(1);
  }
};
process.on('uncaughtException', (err) => fatalShutdown('uncaughtException', err));
process.on('unhandledRejection', (reason) => fatalShutdown('unhandledRejection', reason));

// Arrêt demandé (systemd stop/restart, Ctrl+C) : fermeture propre des connexions temps réel,
// du serveur HTTP et de la base, puis sortie normale. Filet : sortie forcée après 10 s (le
// service systemd laisse 15 s avant de tuer le processus).
const gracefulShutdown = (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Arrêt] ${signal} reçu : fermeture des connexions…`);
  setTimeout(() => process.exit(0), 10000).unref();
  try {
    io.close(() => {
      try { db.close(); } catch { /* ignore */ }
      process.exit(0);
    });
  } catch {
    process.exit(0);
  }
};
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

const app = express();
const httpServer = createServer(app);

// SÉCURITÉ (E2) : Aucune confiance implicite à un proxy
app.set('trust proxy', false);

// SÉCURITÉ (M1) : Origines autorisées pour CORS/Socket.IO
const allowedOrigins = [
  'http://localhost:3001',
  'http://127.0.0.1:3001',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'file://'
];
if (process.env.ALLOWED_ORIGINS) {
  allowedOrigins.push(...process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean));
}
const isOriginAllowed = (origin) => {
  if (!origin) return true;
  return allowedOrigins.includes(origin) || origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:');
};

/** L'origine désigne ce même serveur (même hôte et port que la requête). */
const isSameHostOrigin = (origin, host) => {
  try {
    return typeof host === 'string' && new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
};

const io = new Server(httpServer, {
  // SÉCURITÉ : l'option `cors` ne vaut que pour le transport « polling » ; l'ouverture d'un
  // WebSocket n'est pas soumise à CORS. Sans ce contrôle, une page d'un autre port du même
  // hôte (même « site » pour le cookie SameSite) pouvait ouvrir une connexion authentifiée.
  // Acceptées : la page servie par ce serveur, les origines autorisées, et les clients sans
  // origine (app native, scripts), qui doivent de toute façon présenter un jeton valide.
  allowRequest: (req, callback) => {
    const origin = req.headers.origin;
    callback(null, !origin || isOriginAllowed(origin) || isSameHostOrigin(origin, req.headers.host));
  },
  cors: {
    origin: (origin, callback) => callback(null, isOriginAllowed(origin)),
    methods: ["GET", "POST"],
    credentials: true
  },
  maxHttpBufferSize: 1e6, // Borne explicite des trames socket (1 Mo)
  pingTimeout: 60000,
  pingInterval: 25000
});

const PORT = process.env.PORT || 3001;
app.disable('x-powered-by');

// SERVEUR DE TEST UNIQUEMENT (NODE_ENV=test) : empreinte de la base utilisée. Les tests qui
// visent localhost:3001 la comparent à celle de LEUR checkout (scripts/live_server_guard.mjs)
// et refusent de tourner contre un autre serveur, la prod notamment. Jamais envoyé en prod.
if (process.env.NODE_ENV === 'test') {
  const testDbFingerprint = crypto.createHash('sha256').update(path.resolve('messenger.db')).digest('hex');
  app.use((req, res, next) => { res.setHeader('X-OpenWLM-Test-Db', testDbFingerprint); next(); });
}

const isDev = process.env.NODE_ENV === 'development';
const isProd = process.env.NODE_ENV === 'production' || !isDev;

// En-têtes HTTP de sécurité
app.use((req, res, next) => {
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  if (isHttps) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }

  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "connect-src 'self' wss: stun:; " +
    "img-src 'self' data: blob:; " +
    "media-src 'self' data: blob:; " +
    "font-src 'self' data:; " +
    "object-src 'none'; " +
    "base-uri 'self'; " +
    "frame-ancestors 'none'; " +
    "form-action 'self';"
  );

  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // idle-detection=(self) : détection d'inactivité système (option « inactivité de tout l'ordinateur »)
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), idle-detection=(self), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');

  next();
});

const corsOptions = {
  origin: (origin, callback) => callback(null, isOriginAllowed(origin)),
  methods: ['GET', 'POST', 'DELETE'],
  optionsSuccessStatus: 200,
  credentials: true
};
app.use(cors(corsOptions));

// Tunnel Cloudflare local non déclaré (cf. server/clientIdentity.js) : toutes les requêtes
// porteraient l'IP du proxy et les limites par IP seraient globales. Signalé une fois, en
// clair, dans le journal : à corriger avec CLOUDFLARE_IP_RANGES (docs/DEPLOYMENT.md).
let tunnelWarned = false;
app.use((req, res, next) => {
  if (!tunnelWarned && isUnrecognizedTunnelRequest(req)) {
    tunnelWarned = true;
    console.error(`[Sécurité] Requête Cloudflare (cf-ray) reçue depuis ${req.socket.remoteAddress}, hors des plages de confiance : `
      + 'CF-Connecting-IP est ignoré et tous les visiteurs partagent cette IP (limites par IP globales). '
      + 'Ajoutez CLOUDFLARE_IP_RANGES=127.0.0.1/32,::1/128 (tunnel local) dans .env, puis redémarrez.');
  }
  next();
});
app.use(express.json({ limit: '100kb' }));

// PWA : Service Worker
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, '../public/sw.js'));
});

// PWA : Manifeste
app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, '../public/manifest.json'));
});

// Fichiers statiques du build Vite
app.use(express.static(path.join(__dirname, '../dist'), {
  redirect: false,
  // Les audios de winks (.webm) sont joués via <audio> → MIME audio/webm
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.webm')) res.setHeader('Content-Type', 'audio/webm');
  }
}));

// Purge périodique des fichiers expirés et orphelins
cleanupExpiredFiles();
setInterval(cleanupExpiredFiles, 10 * 60 * 1000);
cleanupOrphanUploads();
setInterval(cleanupOrphanUploads, 30 * 60 * 1000);

// Diffusion de statut vers les contacts autorisés : ceux qui ont l'émetteur dans leur liste
// sans l'avoir bloqué, ET que l'émetteur a lui-même dans sa liste sans les avoir bloqués
// (un contact bloqué ou supprimé le voit « hors ligne » dans sa liste : il ne doit pas
// recevoir sa présence ni son profil en temps réel).
const broadcastStatusToContacts = (userId, payload) => {
  const contacts = db.prepare(`
    SELECT c.user_id FROM contacts c
    JOIN contacts mine ON mine.user_id = ? AND mine.contact_id = c.user_id
    WHERE c.contact_id = ? AND (c.blocked IS NULL OR c.blocked = 0) AND (mine.blocked IS NULL OR mine.blocked = 0)
  `).all(userId, userId);
  contacts.forEach(contact => {
    io.to(getUserRoom(contact.user_id)).emit('user_status_changed', payload);
  });
  io.to(getUserRoom(userId)).emit('user_status_changed', payload);
};

// Nettoyage périodique des structures mémoire vive (Anti-Fuite Mémoire / DoS RAM)
const cleanupMemoryMaps = () => {
  const now = Date.now();
  
  for (const [id, data] of recoveryChallenges.entries()) {
    if (!data || now > data.expires) recoveryChallenges.delete(id);
  }
  for (const [key, timestamps] of recoveryFailures.entries()) {
    if (!timestamps.some((ts) => now - ts < RECOVERY_FAILURE_WINDOW_MS)) recoveryFailures.delete(key);
  }

  for (const [id, data] of captchas.entries()) {
    if (!data || now > data.expires) {
      captchas.delete(id);
    }
  }

  for (const [ip, timestamps] of rateLimitStorage.entries()) {
    const active = timestamps.filter(ts => now - ts < 60000);
    if (active.length === 0) rateLimitStorage.delete(ip);
    else rateLimitStorage.set(ip, active);
  }

  for (const [ip, timestamps] of uploadRateLimitStorage.entries()) {
    const active = timestamps.filter(ts => now - ts < 60000);
    if (active.length === 0) uploadRateLimitStorage.delete(ip);
    else uploadRateLimitStorage.set(ip, active);
  }

  for (const limiter of accountLimiters) {
    limiter.cleanup();
  }

  for (const limiter of ipRateLimiters) {
    limiter.cleanup();
  }

  signupIpCounter.cleanup();

  // Le nettoyage utilise la MÊME fenêtre que chaque limiteur (sinon des événements
  // encore pertinents seraient purgés → limite plus permissive que ce qui est annoncé).
  cleanupWindow(messageLimits, 10000, now);
  cleanupWindow(wizzLimits, 60000, now);
  cleanupWindow(winkLimits, 60000, now);
  cleanupWindow(gameMoveLimits, GAME_MOVE_WINDOW_MS, now);
  cleanupWindow(gameEventLimits, GAME_MOVE_WINDOW_MS, now);
  cleanupWindow(ackLimits, 10000, now);
  cleanupWindow(privateToggleLimits, 10000, now);
  cleanupByteBudget(now);
  cleanupSenderStorage(now);

  for (const [key, game] of activeGames.entries()) {
    const players = getGamePlayers(game);
    if (players.length > 0 && !players.some(p => isUserOnline(p))) {
      activeGames.delete(key);
    }
  }
};

const memoryCleanupInterval = setInterval(cleanupMemoryMaps, 5 * 60 * 1000);
if (memoryCleanupInterval.unref) memoryCleanupInterval.unref();

// Santé du service (supervision, scripts/openwlm-service.sh) : le processus répond ET la base
// est lisible. Réservée aux appels faits sur la machine même : connexion locale (adresse de
// bouclage) ET pas d'en-têtes Cloudflare (le tunnel se connecte lui aussi en local, mais ajoute
// cf-ray / cf-connecting-ip). Sinon 404, comme une route inconnue. Définie ici et non dans
// server/routes/ : hors des règles WAF générées.
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
app.get('/api/health', (req, res, next) => {
  if (!LOOPBACK_ADDRESSES.has(req.socket.remoteAddress) || req.headers['cf-ray'] || req.headers['cf-connecting-ip']) return next();
  try {
    db.prepare('SELECT 1').get();
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

// Montage des routeurs API
app.use('/api', createAuthRouter({ io, broadcastStatusToContacts, isProd }));
app.use('/api', createUsersRouter({ io, broadcastStatusToContacts, isProd }));
app.use('/api', createMessagesRouter());
app.use('/api', createFilesRouter());
app.use('/api', createEmoticonsRouter());
app.use('/api', createPushRouter());
app.use('/api', createGamesRouter());
app.use('/api', createRtcRouter({ io }));

// SPA Fallback pour React Router
app.use((req, res, next) => {
  if (req.method !== 'GET') {
    return next();
  }
  if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) {
    return next();
  }
  const indexPath = path.join(__dirname, '../dist/index.html');
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }
  next();
});

// Erreurs non traitées par une route (JSON malformé, corps trop gros, exception) : réponse
// JSON courte, jamais la page HTML par défaut d'Express ni une trace de pile.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = Number(err?.status || err?.statusCode);
  if (status >= 400 && status < 500) {
    return res.status(status).json({ error: status === 413 ? 'Requête trop volumineuse.' : 'Requête invalide.' });
  }
  console.error('[HTTP] Erreur non gérée :', err);
  res.status(500).json({ error: 'Erreur interne du serveur.' });
});

// Initialisation des gestionnaires Socket.IO
setupSocketHandlers(io, broadcastStatusToContacts);

// Démarrage du serveur HTTP
httpServer.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`);
  const loopbackTrusted = defaultCloudflareMatcher.contains('127.0.0.1') || defaultCloudflareMatcher.contains('::1');
  console.log(`[IP client] Plages Cloudflare de confiance : ${process.env.CLOUDFLARE_IP_RANGES ? 'CLOUDFLARE_IP_RANGES' : 'liste publique par défaut'}${loopbackTrusted ? ' (tunnel local reconnu)' : ' (tunnel local NON reconnu : cf. docs/DEPLOYMENT.md)'}`);
});
