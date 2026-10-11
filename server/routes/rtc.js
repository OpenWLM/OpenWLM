import express from 'express';
import crypto from 'crypto';
import { authenticateToken } from '../middleware/auth.js';

/**
 * Configuration ICE (STUN/TURN) pour les appels WebRTC.
 *
 * Entièrement pilotable par variables d'environnement — voir `.env.example` :
 *   STUN_URLS              liste séparée par des virgules (défaut : STUN Google)
 *   TURN_URLS              liste séparée par des virgules (ex : turn:host:3478?transport=udp)
 *   TURN_SECRET            secret partagé (TURN REST API / coturn)
 *   TURN_TTL               durée de vie des identifiants éphémères, en secondes (défaut 3600)
 *   ICE_TRANSPORT_POLICY   'all' (défaut) ou 'relay'
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

export default function createRtcRouter() {
  const router = express.Router();

  router.get('/rtc-config', authenticateToken, (req, res) => {
    const iceServers = [];

    const stun = parseList(process.env.STUN_URLS);
    iceServers.push({ urls: stun.length ? stun : DEFAULT_STUN });

    const turnUrls = parseList(process.env.TURN_URLS);
    const turnSecret = process.env.TURN_SECRET;
    if (turnUrls.length > 0 && turnSecret) {
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
