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
import { createAuthRouter, captchas } from './routes/auth.js';
import { createUsersRouter } from './routes/users.js';
import { createMessagesRouter } from './routes/messages.js';
import { createFilesRouter, cleanupExpiredFiles, cleanupOrphanUploads } from './routes/files.js';
import { createEmoticonsRouter } from './routes/emoticons.js';
import { createPushRouter } from './routes/push.js';
import { createGamesRouter, activeGames, getGamePlayers } from './routes/games.js';
import { messageLimits, wizzLimits } from './sockets/messages.js';
import { setupSocketHandlers } from './sockets/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
app.use(express.static(path.join(__dirname, '../dist'), { redirect: false }));

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

  for (const map of [messageLimits, wizzLimits]) {
    for (const [uid, timestamps] of map.entries()) {
      const active = timestamps.filter(ts => now - ts < 10000);
      if (active.length === 0) map.delete(uid);
      else map.set(uid, active);
    }
  }

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
