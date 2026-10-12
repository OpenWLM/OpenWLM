import { db } from '../db.js';
import { getUserRoom, isUserOnline } from '../sessionStore.js';
import { canInteract } from '../middleware/auth.js';

export const isValidRtcSignal = (signal) => {
  if (typeof signal === 'string') return signal.length > 0 && signal.length <= 65536;
  if (signal && typeof signal === 'object') {
    if (typeof signal.type !== 'string' || !['offer', 'answer', 'ice-candidate'].includes(signal.type)) return false;
    // SÉCURITÉ : borner aussi la taille sérialisée des objets (pas seulement le type)
    try { return JSON.stringify(signal).length <= 65536; } catch { return false; }
  }
  return false;
};

// SÉCURITÉ : rate limiting léger des événements d'appel/signalisation (anti-spam par contact)
const rtcSignalLimits = new Map();
const rtcRateAllowed = (userId, limit, windowMs = 10000) => {
  const now = Date.now();
  const ts = (rtcSignalLimits.get(userId) || []).filter((t) => now - t < windowMs);
  if (ts.length >= limit) return false;
  ts.push(now);
  rtcSignalLimits.set(userId, ts);
  return true;
};

// SÉCURITÉ : purge périodique des compteurs RTC inactifs (évite la croissance mémoire)
const rtcCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [uid, ts] of rtcSignalLimits.entries()) {
    const active = ts.filter((t) => now - t < 10000);
    if (active.length === 0) rtcSignalLimits.delete(uid);
    else rtcSignalLimits.set(uid, active);
  }
}, 60000);
if (rtcCleanupTimer.unref) rtcCleanupTimer.unref();

// ÉTAT DES APPELS EN COURS : userId -> peerId (dans les deux sens) pour détecter « occupé »
// et pour prévenir le pair en cas de déconnexion brutale (coupure réseau).
const activeCalls = new Map();
const markActive = (a, b) => { activeCalls.set(a, b); activeCalls.set(b, a); };
const clearActive = (uid) => {
  const peer = activeCalls.get(uid);
  if (peer !== undefined) {
    activeCalls.delete(uid);
    activeCalls.delete(peer);
  }
  return peer;
};
export const isUserBusy = (userId) => activeCalls.has(userId);

// APPELS EN ATTENTE (sonnerie) : "<appelant>:<appelé>" -> expiration (ms).
// SÉCURITÉ : call_accept / call_reject ne sont acceptés que pour un appel réellement
// en attente. Sans cela, n'importe quel contact pouvait émettre call_accept et faire
// passer un utilisateur (et lui-même) en « occupé » sans aucun appel (DoS d'appels),
// ou envoyer de faux call_rejected.
export const PENDING_CALL_TTL_MS = 60 * 1000;
const pendingCalls = new Map();
const pendingKey = (callerId, calleeId) => `${callerId}:${calleeId}`;
const setPending = (callerId, calleeId) => {
  pendingCalls.set(pendingKey(callerId, calleeId), Date.now() + PENDING_CALL_TTL_MS);
};
/** Consomme l'appel en attente caller→callee s'il existe et n'a pas expiré. */
const takePending = (callerId, calleeId) => {
  const key = pendingKey(callerId, calleeId);
  const expires = pendingCalls.get(key);
  pendingCalls.delete(key);
  return expires !== undefined && expires > Date.now();
};
const clearPendingFor = (userId) => {
  for (const key of pendingCalls.keys()) {
    const [a, b] = key.split(':').map(Number);
    if (a === userId || b === userId) pendingCalls.delete(key);
  }
};
const pendingCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, expires] of pendingCalls.entries()) {
    if (expires <= now) pendingCalls.delete(key);
  }
}, 60000);
if (pendingCleanupTimer.unref) pendingCleanupTimer.unref();

const asId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export const registerWebRtcHandlers = (io, socket) => {
  const self = socket.user.id;

  socket.on('call_request', (data) => {
    const { target, signal, audioOnly } = data || {};
    const targetId = asId(target);
    if (!targetId) return;
    if (!canInteract(self, targetId).allowed) return;
    if (!rtcRateAllowed(self, 10)) return;

    if (!isValidRtcSignal(signal)) {
      return socket.emit('call_error', { message: 'Signal WebRTC invalide ou trop volumineux.' });
    }

    if (!isUserOnline(targetId)) {
      return socket.emit('call_unavailable', { target: targetId });
    }
    if (isUserBusy(targetId)) {
      return socket.emit('call_busy', { target: targetId });
    }

    const callerUser = db.prepare('SELECT id, nickname, username FROM users WHERE id = ?').get(self);
    if (!callerUser) return;

    setPending(self, targetId);
    io.to(getUserRoom(targetId)).emit('incoming_call', {
      caller: self,
      callerName: callerUser.nickname || callerUser.username,
      signal,
      audioOnly: !!audioOnly,
    });
    // Retour à l'appelant : le contact est bien en train de sonner
    socket.emit('call_ringing', { target: targetId });
  });

  socket.on('call_accept', (data) => {
    const targetId = asId(data?.target);
    if (!targetId) return;
    if (!canInteract(self, targetId).allowed) return;
    if (!rtcRateAllowed(self, 20)) return;
    // L'appelé (self) ne peut accepter qu'un appel que targetId lui a réellement envoyé
    if (!takePending(targetId, self)) return;

    markActive(self, targetId);
    io.to(getUserRoom(targetId)).emit('call_accepted', { by: self });
  });

  socket.on('call_reject', (data) => {
    const targetId = asId(data?.target);
    if (!targetId) return;
    if (!canInteract(self, targetId).allowed) return;
    if (!rtcRateAllowed(self, 20)) return;
    if (!takePending(targetId, self)) return;

    io.to(getUserRoom(targetId)).emit('call_rejected', { by: self });
  });

  socket.on('webrtc_signal', (data) => {
    const { target, signal } = data || {};
    const targetId = asId(target);
    if (!targetId) return;
    if (!canInteract(self, targetId).allowed) return;
    if (!rtcRateAllowed(self, 100)) return;

    if (!isValidRtcSignal(signal)) {
      return socket.emit('call_error', { message: 'Signal WebRTC invalide ou trop volumineux.' });
    }

    if (isUserOnline(targetId)) {
      io.to(getUserRoom(targetId)).emit('webrtc_signal', {
        signal,
        caller: self,
      });
    }
  });

  socket.on('end_call', (data) => {
    const targetId = asId(data?.target);
    if (!targetId) return;
    if (!canInteract(self, targetId).allowed) return;

    clearActive(self);
    // L'appelant raccroche pendant la sonnerie : l'appel ne peut plus être accepté
    pendingCalls.delete(pendingKey(self, targetId));
    pendingCalls.delete(pendingKey(targetId, self));
    if (isUserOnline(targetId)) {
      io.to(getUserRoom(targetId)).emit('call_ended', { caller: self });
    }
  });

  // Coupure brutale (réseau, fermeture d'onglet) : prévenir le pair
  socket.on('disconnect', () => {
    // Différé : le handler de sockets/index.js retire la socket du registre APRÈS celui-ci.
    // Si c'était la dernière socket de l'utilisateur, ses appels en attente sont purgés.
    setImmediate(() => { if (!isUserOnline(self)) clearPendingFor(self); });
    const peer = clearActive(self);
    if (peer !== undefined && isUserOnline(peer)) {
      io.to(getUserRoom(peer)).emit('call_ended', { caller: self });
    }
  });
};
