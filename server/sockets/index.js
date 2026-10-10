import jwt from 'jsonwebtoken';
import { db, toPublicUserDTO } from '../db.js';
import { 
  getUserRoom, 
  isUserOnline, 
  addUserSocket, 
  removeUserSocket 
} from '../sessionStore.js';
import { SECRET, parseCookies } from '../middleware/auth.js';
import { activeGames, getGamePlayers, pendingGameInvites } from '../routes/games.js';
import { registerMessageHandlers } from './messages.js';
import { registerWebRtcHandlers } from './webrtc.js';
import { registerGameHandlers } from './games.js';

export const disconnectTimers = new Map();

export const setupSocketHandlers = (io, broadcastStatusToContacts) => {
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
      next();
    });
  });

  io.on('connection', (socket) => {
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
          const user = db.prepare('SELECT * FROM users WHERE id = ?').get(authUserId);
          if (user && user.status === 'offline') {
            db.prepare('UPDATE users SET status = ? WHERE id = ?').run('online', authUserId);
            user.status = 'online';
            broadcastStatusToContacts(authUserId, toPublicUserDTO(user));
          }
        } catch (err) {
          console.error("[Session] Erreur passage online:", err);
        }
      }
    }

    // Gestion rétrocompatible de 'identify'
    socket.on('identify', (userId) => {
      try {
        if (!socket.user || socket.user.id !== userId) return;
        socket.join(getUserRoom(userId));
        const wasAlreadyOnline = isUserOnline(userId);
        addUserSocket(userId, socket.id);

        if (disconnectTimers.has(userId)) {
          clearTimeout(disconnectTimers.get(userId));
          disconnectTimers.delete(userId);
        }

        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
        if (user && !wasAlreadyOnline) {
          let finalStatus = user.status;
          if (user.status === 'offline') {
            finalStatus = 'online';
            db.prepare('UPDATE users SET status = ? WHERE id = ?').run('online', userId);
            user.status = 'online';
          }
          broadcastStatusToContacts(userId, toPublicUserDTO(user));
        }
      } catch (err) {
        console.error("[Session] Erreur identify:", err);
      }
    });

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
    });
  });
};
