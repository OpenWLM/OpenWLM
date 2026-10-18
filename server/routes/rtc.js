import express from 'express';
import crypto from 'crypto';
import { authenticateToken, canInteract } from '../middleware/auth.js';
import { declinePendingCall } from '../sockets/webrtc.js';

/**
 * Configuration ICE (STUN/TURN) pour les appels WebRTC.
 *
 * Entièrement pilotable par variables d'environnement — voir `.env.example` :
 *   STUN_URLS              liste séparée par des virgules (défaut : STUN Google)
 *   TURN_URLS              liste séparée par des virgules (ex : turn:host:3478?transport=udp)
 *   TURN_USERNAME/TURN_PASSWORD   identifiants STATIQUES (ex : Metered/Twilio « standard »)
 *   TURN_SECRET            secret partagé pour identifiants ÉPHÉMÈRES (TURN REST API / coturn)
 *   TURN_TTL               durée de vie des identifiants éphémères, en secondes (défaut 3600)
 *   ICE_TRANSPORT_POLICY   'all' (défaut) ou 'relay'
 *
 * Priorité : si TURN_USERNAME + TURN_PASSWORD sont fournis → identifiants statiques ;
 * sinon si TURN_SECRET est fourni → identifiants éphémères (HMAC).
 *
 * ⚠️ Un serveur TURN n'est PAS joignable via le Tunnel Cloudflare (HTTP uniquement) :
 * il faut une IP publique avec les ports 3478/5349 (UDP/TCP, + plage relay), ou un
 * TURN hébergé. Tant que TURN_URLS/TURN_SECRET sont vides, seul STUN est renvoyé.
 */

const parseList = (value) => (value || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const DEFAULT_STUN = ['stun:stun.l.google.com:19302'];

export default function createRtcRouter({ io } = {}) {
  const router = express.Router();

  // Bouton « Refuser » de la notification d'appel (service worker, sans connexion temps réel) :
  // l'appel en attente de `callerId` vers l'utilisateur authentifié est refusé.
  router.post('/calls/decline', authenticateToken, (req, res) => {
    const callerId = Number(req.body?.callerId);
    if (!Number.isInteger(callerId) || callerId <= 0) return res.status(400).json({ error: 'Appelant invalide.' });
    if (!canInteract(req.user.id, callerId).allowed) return res.status(403).json({ error: 'Non autorisé.' });
    if (!io || !declinePendingCall(io, callerId, req.user.id)) return res.status(404).json({ error: 'Aucun appel en attente.' });
    res.json({ success: true });
  });

  router.get('/rtc-config', authenticateToken, (req, res) => {
    const iceServers = [];

    const stun = parseList(process.env.STUN_URLS);
    iceServers.push({ urls: stun.length ? stun : DEFAULT_STUN });

    const turnUrls = parseList(process.env.TURN_URLS);
    const turnUser = process.env.TURN_USERNAME;
    const turnPass = process.env.TURN_PASSWORD;
    const turnSecret = process.env.TURN_SECRET;

    if (turnUrls.length > 0 && turnUser && turnPass) {
      // Identifiants STATIQUES (ex : Metered, Twilio « standard »)
      iceServers.push({ urls: turnUrls, username: turnUser, credential: turnPass });
    } else if (turnUrls.length > 0 && turnSecret) {
      // Identifiants éphémères type « TURN REST API » (mécanisme coturn) :
      //   username  = <expiration unix>:<userId>
      //   credential = base64(HMAC-SHA1(TURN_SECRET, username))
      const ttl = Math.max(60, parseInt(process.env.TURN_TTL || '3600', 10) || 3600);
      const username = `${Math.floor(Date.now() / 1000) + ttl}:${req.user?.id ?? 'user'}`;
      const credential = crypto.createHmac('sha1', turnSecret).update(username).digest('base64');
      iceServers.push({ urls: turnUrls, username, credential });
    }

    res.json({
      iceServers,
      iceTransportPolicy: process.env.ICE_TRANSPORT_POLICY === 'relay' ? 'relay' : 'all',
    });
  });

  return router;
}
