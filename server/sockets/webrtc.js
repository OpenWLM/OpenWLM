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

export const registerWebRtcHandlers = (io, socket) => {
  socket.on('call_request', (data) => {
    const { target, signal, audioOnly } = data || {};
    const check = canInteract(socket.user.id, target);
    if (!check.allowed) return;
    if (!rtcRateAllowed(socket.user.id, 10)) return;

    if (!isValidRtcSignal(signal)) {
      return socket.emit('call_error', { message: "Signal WebRTC invalide ou trop volumineux." });
    }

    if (isUserOnline(target)) {
      const callerUser = db.prepare('SELECT id, nickname, username FROM users WHERE id = ?').get(socket.user.id);
      if (!callerUser) return;

      io.to(getUserRoom(target)).emit('incoming_call', { 
        caller: socket.user.id, 
        callerName: callerUser.nickname || callerUser.username, 
        signal, 
        audioOnly: !!audioOnly 
      });
    }
  });

  socket.on('webrtc_signal', (data) => {
    const { target, signal } = data || {};
    const check = canInteract(socket.user.id, target);
    if (!check.allowed) return;
    if (!rtcRateAllowed(socket.user.id, 100)) return;

    if (!isValidRtcSignal(signal)) {
      return socket.emit('call_error', { message: "Signal WebRTC invalide ou trop volumineux." });
    }

    if (isUserOnline(target)) {
      io.to(getUserRoom(target)).emit('webrtc_signal', { 
        signal, 
        caller: socket.user.id 
      });
    }
  });

  socket.on('end_call', (data) => {
    const { target } = data || {};
    const check = canInteract(socket.user.id, target);
    if (!check.allowed) return;

    if (isUserOnline(target)) {
      io.to(getUserRoom(target)).emit('call_ended', { 
        caller: socket.user.id 
      });
    }
  });
};
