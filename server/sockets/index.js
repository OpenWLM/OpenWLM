import jwt from 'jsonwebtoken';
import { db, toPublicUserDTO } from '../db.js';
import { 
  getUserRoom, 
  isUserOnline, 
  addUserSocket, 
  removeUserSocket,
  socketToUser
} from '../sessionStore.js';
import { SECRET, parseCookies } from '../middleware/auth.js';
import { activeGames, getGamePlayers, pendingGameInvites } from '../routes/games.js';
import { registerMessageHandlers } from './messages.js';
import { registerWebRtcHandlers } from './webrtc.js';
import { registerGameHandlers } from './games.js';

export const disconnectTimers = new Map();

const CONNECT_STATUSES = ['online', 'busy', 'away', 'offline'];

export const setupSocketHandlers = (io, broadcastStatusToContacts) => {
  /**
   * Statut appliqué quand la PREMIÈRE session d'un compte se connecte.
   * Le client indique le statut voulu (handshake `auth.status` : dernier statut choisi à la
   * main, ou celui de l'écran de connexion). Sans indication valide (ancien client), on garde
   * l'ancien comportement : un compte « offline » repasse « online ». Un « offline » demandé
   * (« Apparaître hors ligne ») reste hors ligne : rien n'est diffusé en ligne aux contacts.
   */
  const applyStatusOnConnect = (userId, requestedStatus) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) return;
    const requested = CONNECT_STATUSES.includes(requestedStatus) ? requestedStatus : null;
    const target = requested ?? (user.status === 'offline' ? 'online' : user.status);
    // Vraie connexion (vue par les contacts) : passage de hors ligne à un statut visible
    const signedIn = user.status === 'offline' && target !== 'offline';
    const changed = target !== user.status;
    if (changed) {
      db.prepare('UPDATE users SET status = ? WHERE id = ?').run(target, userId);
      user.status = target;
    }
    if (changed) broadcastStatusToContacts(userId, { ...toPublicUserDTO(user), signedIn });
  };

  // Middleware d'authentification Socket.IO
  io.use((socket, next) => {
    let token = socket.handshake.auth?.token;
    if (!token && socket.handshake.headers?.cookie) {
      const cookies = parseCookies(socket.handshake.headers.cookie);
      token = cookies.token;
    }
    if (!token) return next(new Error("Erreur d'authentification : Token manquant"));

    jwt.verify(token, SECRET, { algorithms: ['HS256'] }, (err, payload) => {
      if (err || !payload || !payload.id) return next(new Error("Erreur d'authentification : Token invalide ou expiré"));

      const dbUser = db.prepare('SELECT id, username, token_version FROM users WHERE id = ?').get(payload.id);
      if (!dbUser) return next(new Error("Erreur d'authentification : Compte utilisateur introuvable ou révoqué"));

      const currentTv = dbUser.token_version || 0;
      const tokenTv = payload.tv !== undefined ? payload.tv : 0;
      if (tokenTv !== currentTv) {
        return next(new Error("Session révoquée. Veuillez vous reconnecter."));
      }

      socket.user = dbUser;
      socket.tokenExp = payload.exp; // expiration du JWT (secondes)
      socket.tokenTv = tokenTv;
      next();
    });
  });

  // SÉCURITÉ : balayage périodique — ferme les sockets dont le JWT a EXPIRÉ
  // ou dont la session a été RÉVOQUÉE (token_version), même sans révocation explicite.
  const sessionSweep = setInterval(() => {
    const now = Date.now();
    for (const socket of io.sockets.sockets.values()) {
      if (!socket.user || !socket.user.id) continue;
      if (socket.tokenExp && socket.tokenExp * 1000 < now) {
        try { socket.emit('session_expired'); } catch { /* ignore */ }
        socket.disconnect(true);
        continue;
      }
      try {
        const row = db.prepare('SELECT token_version FROM users WHERE id = ?').get(socket.user.id);
        const curTv = row ? (row.token_version || 0) : 0;
        if (!row || (socket.tokenTv || 0) !== curTv) {
          socket.disconnect(true);
        }
      } catch { /* ignore */ }
    }
  }, 60000);
  if (sessionSweep.unref) sessionSweep.unref();

  io.on('connection', (socket) => {
    // ROBUSTESSE : une exception dans un handler d'événement (entrée client malformée,
    // bug) est confinée à CET événement : journalisée puis ignorée. Sinon elle
    // remonterait en uncaughtException, qui arrête désormais le processus
    // (cf. server/index.js) — ce qui offrirait un crash à distance.
    const registerEvent = socket.on.bind(socket);
    socket.on = (event, handler) => registerEvent(event, (...args) => {
      const report = (err) => console.error(`[Socket] Erreur dans le handler '${event}' (utilisateur ${socket.user?.id ?? '?'}):`, err);
      try {
        const result = handler(...args);
        if (result && typeof result.catch === 'function') result.catch(report);
      } catch (err) {
        report(err);
      }
    });

    const authUserId = socket.user?.id;
    if (authUserId) {
      socket.join(getUserRoom(authUserId));
      const wasAlreadyOnline = isUserOnline(authUserId);
      addUserSocket(authUserId, socket.id);

      if (disconnectTimers.has(authUserId)) {
        clearTimeout(disconnectTimers.get(authUserId));
        disconnectTimers.delete(authUserId);
      }

      if (!wasAlreadyOnline) {
        try {
          applyStatusOnConnect(authUserId, socket.handshake.auth?.status);
        } catch (err) {
          console.error("[Session] Erreur passage online:", err);
        }
      }
    }

    // Enregistrement des sous-domaines Socket
    registerMessageHandlers(io, socket);
    registerWebRtcHandlers(io, socket);
    registerGameHandlers(io, socket);

    // Déconnexion d'un socket
    socket.on('disconnect', () => {
      const removeResult = removeUserSocket(socket.id);
      if (!removeResult) return;

      const { userId, wasLastSocket } = removeResult;
      if (!wasLastSocket) return;

      // Nettoyer les invitations de jeux en attente liées à cet utilisateur
      for (const [key] of pendingGameInvites.entries()) {
        if (key.startsWith(`${userId}_`) || key.endsWith(`_${userId}`)) {
          pendingGameInvites.delete(key);
        }
      }

      // Période de grâce de 60 secondes avant de passer en 'offline' (adapté au mobile)
      const timer = setTimeout(() => {
        try {
          if (!isUserOnline(userId)) {
            db.prepare('UPDATE users SET status = ? WHERE id = ?').run('offline', userId);
            broadcastStatusToContacts(userId, { id: userId, userId: userId, status: 'offline' });
          }
        } catch (err) { console.error(err); }
        disconnectTimers.delete(userId);
      }, 60000);

      disconnectTimers.set(userId, timer);
    });

    // Déconnexion manuelle explicite (logout)
    socket.on('manual_disconnect', () => {
      const userId = socketToUser.get(socket.id);
      if (!userId) return;

      if (disconnectTimers.has(userId)) {
        clearTimeout(disconnectTimers.get(userId));
        disconnectTimers.delete(userId);
      }

      for (const [key, game] of activeGames.entries()) {
        const players = getGamePlayers(game);
        if (players.includes(userId)) {
          const opponentId = players.find(p => p !== userId);
          if (opponentId && isUserOnline(opponentId)) {
            io.to(getUserRoom(opponentId)).emit('game_quit', { from: userId });
          }
          activeGames.delete(key);
        }
      }

      const removeResult = removeUserSocket(socket.id);
      if (removeResult && removeResult.wasLastSocket) {
        db.prepare('UPDATE users SET status = ? WHERE id = ?').run('offline', userId);
        broadcastStatusToContacts(userId, { id: userId, userId: userId, status: 'offline' });
      }

      // SÉCURITÉ : ne pas laisser une socket authentifiée active mais absente du registre.
      // On la retire de ses rooms et on ferme réellement la connexion.
      try { socket.leave(getUserRoom(userId)); } catch { /* ignore */ }
      socket.disconnect(true);
    });
  });
};
