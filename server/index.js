// DOIT rester le tout premier import : charge .env AVANT l'évaluation des autres
// modules (certains lisent process.env dès leur init, ex. middleware/auth.js).
import './loadEnv.js';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { db } from './db.js';
import { getUserRoom, isUserOnline } from './sessionStore.js';
import { 
  rateLimitStorage, 
  uploadRateLimitStorage, 
  accountLimiters, 
  ipRateLimiters 
} from './middleware/auth.js';
import { createAuthRouter, captchas, signupIpCounter } from './routes/auth.js';
import { createUsersRouter } from './routes/users.js';
import { createMessagesRouter } from './routes/messages.js';
import { createFilesRouter, cleanupExpiredFiles, cleanupOrphanUploads } from './routes/files.js';
import { createEmoticonsRouter } from './routes/emoticons.js';
import { createPushRouter } from './routes/push.js';
import { createGamesRouter, activeGames, getGamePlayers } from './routes/games.js';
import createRtcRouter from './routes/rtc.js';
import { messageLimits, wizzLimits, winkLimits } from './sockets/messages.js';
import { cleanupWindow } from './utils/rateWindow.js';
import { gameMoveLimits, GAME_MOVE_WINDOW_MS } from './sockets/games.js';
import { setupSocketHandlers } from './sockets/index.js';

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

const io = new Server(httpServer, {
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
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');

  next();
});

const corsOptions = {
  origin: (origin, callback) => callback(null, isOriginAllowed(origin)),
  methods: ['GET', 'POST'],
  optionsSuccessStatus: 200,
  credentials: true
};
app.use(cors(corsOptions));
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

// Diffusion de statut vers les contacts autorisés
const broadcastStatusToContacts = (userId, payload) => {
  const contacts = db.prepare('SELECT user_id FROM contacts WHERE contact_id = ? AND (blocked IS NULL OR blocked = 0)').all(userId);
  contacts.forEach(contact => {
    io.to(getUserRoom(contact.user_id)).emit('user_status_changed', payload);
  });
  io.to(getUserRoom(userId)).emit('user_status_changed', payload);
};

// Nettoyage périodique des structures mémoire vive (Anti-Fuite Mémoire / DoS RAM)
const cleanupMemoryMaps = () => {
  const now = Date.now();
  
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

  for (const [key, game] of activeGames.entries()) {
    const players = getGamePlayers(game);
    if (players.length > 0 && !players.some(p => isUserOnline(p))) {
      activeGames.delete(key);
    }
  }
};

const memoryCleanupInterval = setInterval(cleanupMemoryMaps, 5 * 60 * 1000);
if (memoryCleanupInterval.unref) memoryCleanupInterval.unref();

// Montage des routeurs API
app.use('/api', createAuthRouter({ io, broadcastStatusToContacts, isProd }));
app.use('/api', createUsersRouter({ io, broadcastStatusToContacts, isProd }));
app.use('/api', createMessagesRouter());
app.use('/api', createFilesRouter());
app.use('/api', createEmoticonsRouter());
app.use('/api', createPushRouter());
app.use('/api', createGamesRouter());
app.use('/api', createRtcRouter());

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

// Initialisation des gestionnaires Socket.IO
setupSocketHandlers(io, broadcastStatusToContacts);

// Démarrage du serveur HTTP
httpServer.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`);
});
