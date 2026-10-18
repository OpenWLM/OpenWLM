import { db } from '../db.js';
import { getUserRoom, isUserOnline } from '../sessionStore.js';
import { canInteract } from '../middleware/auth.js';
import { dispatchPushNotification, countPushSubscriptions } from '../routes/push.js';

// Accusé de réception de l'appel par un appareil de l'appelé : sans lui, l'appelant n'entend
// pas « ça sonne » (un téléphone en veille garde une connexion « fantôme » pendant ~45 s).
export const CALL_ACK_TIMEOUT_MS = 4000;
// Push d'appel : courte durée de vie (un appel périmé ne doit pas arriver) et urgence haute
const CALL_PUSH_TTL_S = 45;

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

// APPELS EN ATTENTE (sonnerie) : "<appelant>:<appelé>" -> { expires, offre chiffrée, … }.
// L'offre est gardée pour la redonner à un appareil de l'appelé qui se (re)connecte pendant la
// sonnerie (réveil par Push, téléphone sorti de veille).
// SÉCURITÉ : call_accept / call_reject ne sont acceptés que pour un appel réellement
// en attente. Sans cela, n'importe quel contact pouvait émettre call_accept et faire
// passer un utilisateur (et lui-même) en « occupé » sans aucun appel (DoS d'appels),
// ou envoyer de faux call_rejected.
export const PENDING_CALL_TTL_MS = 60 * 1000;
const pendingCalls = new Map();
const pendingKey = (callerId, calleeId) => `${callerId}:${calleeId}`;
const setPending = (callerId, calleeId, call = {}) => {
  pendingCalls.set(pendingKey(callerId, calleeId), { expires: Date.now() + PENDING_CALL_TTL_MS, ringing: false, pushed: false, ...call });
};
const getPending = (callerId, calleeId) => {
  const entry = pendingCalls.get(pendingKey(callerId, calleeId));
  return entry && entry.expires > Date.now() ? entry : null;
};
/** Consomme l'appel en attente caller→callee s'il existe et n'a pas expiré. */
const takePending = (callerId, calleeId) => {
  const key = pendingKey(callerId, calleeId);
  const entry = pendingCalls.get(key);
  pendingCalls.delete(key);
  return entry !== undefined && entry.expires > Date.now();
};
const clearPendingFor = (userId) => {
  for (const key of pendingCalls.keys()) {
    const [a, b] = key.split(':').map(Number);
    if (a === userId || b === userId) pendingCalls.delete(key);
  }
};
const pendingCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of pendingCalls.entries()) {
    if (entry.expires <= now) pendingCalls.delete(key);
  }
}, 60000);
if (pendingCleanupTimer.unref) pendingCleanupTimer.unref();

const asId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const callPushPayload = (callerId, callee, entry) => ({
  type: 'call',
  title: `${entry.callerName} — OpenWLM`,
  body: entry.audioOnly ? '📞 Appel audio entrant' : '📹 Appel vidéo entrant',
  l10n: entry.audioOnly ? 'callAudio' : 'callVideo',
  tag: `openwlm-call-${callerId}`,
  senderId: callerId,
  data: { url: `/?chat=${callerId}`, senderId: callerId, type: 'call', callerId, expiresAt: entry.expires }
});

// Fin d'un appel qui avait réveillé l'appelé par Push : la notification qui sonne sur ses
// appareils est remplacée (manqué, pris ou refusé ailleurs) au lieu de rester affichée.
const CALL_END_TEXT = {
  missed: '📵 Appel manqué',
  answered: '📞 Appel pris sur un autre appareil',
  declined: '📵 Appel refusé'
};
const notifyCallEnded = (callerId, calleeId, entry, reason) => {
  if (!entry?.pushed) return;
  dispatchPushNotification(calleeId, {
    type: 'call_cancel',
    reason,
    title: `${entry.callerName} — OpenWLM`,
    body: CALL_END_TEXT[reason],
    l10n: reason === 'missed' ? 'callMissed' : reason === 'answered' ? 'callAnswered' : 'callDeclined',
    tag: `openwlm-call-${callerId}`,
    senderId: callerId,
    data: { url: `/?chat=${callerId}`, senderId: callerId, type: 'call_cancel' }
  }, { TTL: 3600, urgency: 'normal' }).catch(() => { /* ignore */ });
};

/** Un appel sonne-t-il déjà chez cet appelé (venant d'un autre appelant) ? */
const hasOtherIncoming = (calleeId, callerId) => {
  const now = Date.now();
  for (const [key, entry] of pendingCalls.entries()) {
    const [a, b] = key.split(':').map(Number);
    if (b === calleeId && a !== callerId && entry.expires > now) return true;
  }
  return false;
};

/**
 * Présente l'appel à des sockets de l'appelé en exigeant un accusé de réception.
 * Renvoie le nombre d'appareils qui ont confirmé (la sonnerie s'affiche chez eux).
 */
const deliverIncomingCall = (target, callerId, entry) => new Promise((resolve) => {
  target.timeout(CALL_ACK_TIMEOUT_MS).emit('incoming_call', {
    caller: callerId,
    callerName: entry.callerName,
    signal: entry.signal,
    audioOnly: entry.audioOnly,
  }, (_err, responses) => {
    // Diffusion vers une room : tableau des réponses reçues à temps ; socket unique : une valeur
    const list = Array.isArray(responses) ? responses : (responses ? [responses] : []);
    resolve(list.filter((r) => r && r.ok).length);
  });
});

/** L'appelé a confirmé : l'appelant entend « ça sonne » (une seule fois). */
const markRinging = (io, callerId, calleeId) => {
  const entry = getPending(callerId, calleeId);
  if (!entry || entry.ringing) return;
  entry.ringing = true;
  io.to(getUserRoom(callerId)).emit('call_ringing', { target: calleeId });
};

/** Refus d'un appel en attente (bouton de l'appel, ou bouton « Refuser » de la notification). */
export const declinePendingCall = (io, callerId, calleeId) => {
  const entry = getPending(callerId, calleeId);
  if (!takePending(callerId, calleeId)) return false;
  io.to(getUserRoom(callerId)).emit('call_rejected', { by: calleeId });
  notifyCallEnded(callerId, calleeId, entry, 'declined');
  return true;
};

export const registerWebRtcHandlers = (io, socket) => {
  const self = socket.user.id;

  // Appareil de l'appelé qui se (re)connecte pendant une sonnerie (ex. ouvert depuis la
  // notification Push d'appel) : l'appel en attente lui est présenté à son tour.
  const redeliverPending = () => {
    for (const [key, entry] of pendingCalls.entries()) {
      const [callerId, calleeId] = key.split(':').map(Number);
      if (calleeId !== self || entry.expires <= Date.now()) continue;
      deliverIncomingCall(socket, callerId, entry).then((acks) => {
        if (acks > 0) markRinging(io, callerId, self);
      });
    }
  };
  redeliverPending();

  // Retour au premier plan SANS reconnexion (page suspendue dont la connexion a survécu) :
  // le client redemande les appels en attente
  socket.on('call_resync', () => {
    if (!rtcRateAllowed(self, 20)) return;
    redeliverPending();
  });

  socket.on('call_request', (data) => {
    const { target, signal, audioOnly } = data || {};
    const targetId = asId(target);
    if (!targetId) return;
    if (!canInteract(self, targetId).allowed) return;
    if (!rtcRateAllowed(self, 10)) return;

    if (!isValidRtcSignal(signal)) {
      return socket.emit('call_error', { message: 'Signal WebRTC invalide ou trop volumineux.' });
    }

    const online = isUserOnline(targetId);
    // Hors ligne et aucun appareil réveillable par Push : injoignable
    if (!online && countPushSubscriptions(targetId) === 0) {
      return socket.emit('call_unavailable', { target: targetId });
    }
    // En appel, ou un autre appel sonne déjà chez lui : occupé (un seul appel présenté à la fois)
    if (isUserBusy(targetId) || hasOtherIncoming(targetId, self)) {
      return socket.emit('call_busy', { target: targetId });
    }

    const callerUser = db.prepare('SELECT id, nickname, username FROM users WHERE id = ?').get(self);
    if (!callerUser) return;

    setPending(self, targetId, { callerName: callerUser.nickname || callerUser.username, signal, audioOnly: !!audioOnly });
    const entry = getPending(self, targetId);

    (async () => {
      // 1) Les appareils connectés doivent CONFIRMER la réception (une connexion fantôme ne répond pas)
      const acks = online ? await deliverIncomingCall(io.to(getUserRoom(targetId)), self, entry) : 0;
      if (acks > 0) return markRinging(io, self, targetId);
      if (!getPending(self, targetId)) return; // raccroché entre-temps

      // 2) Aucun appareil n'a confirmé : réveil par une notification Push d'appel
      const push = await dispatchPushNotification(targetId, callPushPayload(self, targetId, entry), { TTL: CALL_PUSH_TTL_S, urgency: 'high' });
      const current = getPending(self, targetId);
      if (!current || current.ringing) return;
      current.pushed = push.sent > 0;
      if (!online && !current.pushed) {
        pendingCalls.delete(pendingKey(self, targetId));
        return socket.emit('call_unavailable', { target: targetId });
      }
      // L'appelant patiente : l'appareil sera sonné s'il se reconnecte pendant la sonnerie
      socket.emit('call_waking', { target: targetId, pushed: current.pushed });
    })().catch((err) => console.error('[Calls] Erreur de remise d\'appel :', err));
  });

  socket.on('call_accept', (data) => {
    const targetId = asId(data?.target);
    if (!targetId) return;
    if (!canInteract(self, targetId).allowed) return;
    if (!rtcRateAllowed(self, 20)) return;
    // L'appelé (self) ne peut accepter qu'un appel que targetId lui a réellement envoyé
    const entry = getPending(targetId, self);
    if (!takePending(targetId, self)) return;
    notifyCallEnded(targetId, self, entry, 'answered');

    markActive(self, targetId);
    io.to(getUserRoom(targetId)).emit('call_accepted', { by: self });
  });

  socket.on('call_reject', (data) => {
    const targetId = asId(data?.target);
    if (!targetId) return;
    if (!canInteract(self, targetId).allowed) return;
    if (!rtcRateAllowed(self, 20)) return;
    declinePendingCall(io, targetId, self);
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
    // L'appelant raccroche pendant la sonnerie : l'appel ne peut plus être accepté. Si l'appelé
    // avait été réveillé par Push, sa notification d'appel devient « Appel manqué ».
    notifyCallEnded(self, targetId, getPending(self, targetId), 'missed');
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
