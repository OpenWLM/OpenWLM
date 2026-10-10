import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import webpush from 'web-push';
import { fileURLToPath } from 'url';
import { db } from '../db.js';
import { authenticateToken, sensitiveRateLimiter } from '../middleware/auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const initVapid = () => {
  let publicKey = process.env.VAPID_PUBLIC_KEY ? process.env.VAPID_PUBLIC_KEY.trim() : null;
  let privateKey = process.env.VAPID_PRIVATE_KEY ? process.env.VAPID_PRIVATE_KEY.trim() : null;
  let subject = process.env.VAPID_SUBJECT ? process.env.VAPID_SUBJECT.trim() : null;

  if (!publicKey || !privateKey) {
    const keysPath = path.join(__dirname, '../../.vapid_keys.json');
    if (fs.existsSync(keysPath)) {
      try {
        const fileContent = fs.readFileSync(keysPath, 'utf8');
        const parsed = JSON.parse(fileContent);
        if (parsed.publicKey && parsed.privateKey) {
          publicKey = String(parsed.publicKey).trim();
          privateKey = String(parsed.privateKey).trim();
          if (parsed.subject && !subject) {
            subject = String(parsed.subject).trim();
          }
        }
      } catch (err) {
        console.warn('[WebPush] Impossible de lire .vapid_keys.json:', err.message);
      }
    }
  }

  if (!publicKey || !privateKey) {
    const envPath = path.join(__dirname, '../../.env');
    if (fs.existsSync(envPath)) {
      try {
        const envContent = fs.readFileSync(envPath, 'utf8');
        const pubMatch = envContent.match(/^VAPID_PUBLIC_KEY=["']?([^"'\r\n]+)["']?/m);
        const privMatch = envContent.match(/^VAPID_PRIVATE_KEY=["']?([^"'\r\n]+)["']?/m);
        const subMatch = envContent.match(/^VAPID_SUBJECT=["']?([^"'\r\n]+)["']?/m);
        if (pubMatch && !publicKey) publicKey = pubMatch[1].trim();
        if (privMatch && !privateKey) privateKey = privMatch[1].trim();
        if (subMatch && !subject) subject = subMatch[1].trim();
      } catch (e) {}
    }
  }

  if (!publicKey || !privateKey) {
    console.log('[WebPush] Clés VAPID non configurées (ou incomplètes). Web Push désactivé.');
    return null;
  }

  if (!subject) {
    subject = 'mailto:admin@openwlm.dev';
  }

  if (!subject.startsWith('mailto:') && !subject.startsWith('https://')) {
    subject = `mailto:${subject}`;
  }

  try {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    console.log(`[WebPush] VAPID configuré avec succès (Subject: ${subject}, Public: ${publicKey.slice(0, 10)}...). Web Push actif.`);
    return { publicKey, privateKey, subject };
  } catch (err) {
    console.warn(`[WebPush] Échec initialisation VAPID (${err.message}). Web Push désactivé.`);
    return null;
  }
};

export const vapidConfig = initVapid();

export const dispatchPushNotification = async (receiverId, payload) => {
  if (!vapidConfig) {
    return { sent: 0, failed: 0, reason: 'vapid_not_configured' };
  }

  try {
    const subs = db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?').all(receiverId);
    if (!subs || subs.length === 0) return { sent: 0, failed: 0 };

    const payloadString = typeof payload === 'string' ? payload : JSON.stringify(payload);
    let sent = 0;
    let failed = 0;

    await Promise.all(subs.map(async (sub) => {
      try {
        const pushSubscription = {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh,
            auth: sub.auth
          }
        };

        await webpush.sendNotification(pushSubscription, payloadString, {
          TTL: 86400
        });
        sent++;
      } catch (err) {
        failed++;
        if (err.statusCode === 404 || err.statusCode === 410) {
          try {
            db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(sub.endpoint);
            console.log(`[WebPush] Abonnement expiré supprimé (${err.statusCode}): ${sub.endpoint.slice(0, 45)}...`);
          } catch (dbErr) {
            console.warn('[WebPush] Erreur nettoyage abonnement expiré:', dbErr);
          }
        } else {
          console.warn(`[WebPush] Échec envoi push (${err.statusCode || err.message}) vers ${sub.endpoint.slice(0, 45)}...`);
        }
      }
    }));

    if (sent > 0) {
      console.log(`[WebPush] Notification envoyée avec succès à ${sent}/${subs.length} appareil(s) pour user ${receiverId}`);
    }

    return { sent, failed };
  } catch (err) {
    console.warn('[WebPush] Erreur dispatch notification:', err);
    return { sent: 0, failed: 0, error: err.message };
  }
};

export const createPushRouter = () => {
  const router = Router();

  router.get('/push/status', (req, res) => {
    res.json({
      available: true,
      hasVapid: Boolean(vapidConfig),
      publicKey: vapidConfig ? vapidConfig.publicKey : null,
      subject: vapidConfig ? vapidConfig.subject : null
    });
  });

  router.post('/push/subscribe', authenticateToken, sensitiveRateLimiter, (req, res) => {
    const { subscription } = req.body || {};
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: "Abonnement Push invalide." });
    }

    const { endpoint, keys } = subscription;
    const p256dh = keys?.p256dh || null;
    const auth = keys?.auth || null;
    const userAgent = req.headers['user-agent'] || null;
    const now = Date.now();

    try {
      const stmt = db.prepare(`
        INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET
          user_id = excluded.user_id,
          p256dh = excluded.p256dh,
          auth = excluded.auth,
          user_agent = excluded.user_agent,
          created_at = excluded.created_at
      `);
      stmt.run(req.user.id, endpoint, p256dh, auth, userAgent, now);

      res.json({ success: true });
    } catch (err) {
      console.error("[WebPush] Erreur enregistrement abonnement:", err);
      res.status(500).json({ error: "Erreur enregistrement abonnement Push." });
    }
  });

  router.post('/push/unsubscribe', authenticateToken, sensitiveRateLimiter, (req, res) => {
    const { endpoint } = req.body || {};
    if (!endpoint) {
      return res.status(400).json({ error: "Endpoint manquant." });
    }

    try {
      db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, req.user.id);
      res.json({ success: true });
    } catch (err) {
      console.error("[WebPush] Erreur désabonnement Push:", err);
      res.status(500).json({ error: "Erreur lors du désabonnement Push." });
    }
  });

  router.post('/push/test', authenticateToken, sensitiveRateLimiter, async (req, res) => {
    if (!vapidConfig) {
      return res.status(400).json({ success: false, error: "Web Push non configuré sur le serveur (clés VAPID manquantes)." });
    }

    const result = await dispatchPushNotification(req.user.id, {
      title: 'OpenWLM - Test Web Push',
      body: 'La passerelle de notification Push Web / Android fonctionne correctement !',
      senderId: req.user.id,
      url: '/'
    });

    res.json({ success: true, ...result });
  });

  return router;
};
