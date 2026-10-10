import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import dns from 'dns';
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
        // SÉCURITÉ : re-vérifier la destination AU MOMENT DE L'ENVOI (anti-DNS-rebinding +
        // couvre les abonnements historiques jamais réévalués). Le nombre est borné (≤20/compte).
        if (!(await isAllowedPushEndpoint(sub.endpoint))) {
          failed++;
          console.warn(`[WebPush] Endpoint non autorisé ignoré: ${String(sub.endpoint).slice(0, 45)}...`);
          return;
        }
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

// SÉCURITÉ (anti-SSRF) : détection d'adresses IP privées/réservées (v4 + v6)
const isPrivateIp = (ip) => {
  if (!ip || typeof ip !== 'string') return false;
  if (ip.includes(':')) {
    const l = ip.toLowerCase();
    // IPv4 encapsulée en IPv6 (::ffff:a.b.c.d) → évaluer la partie IPv4
    const mapped = l.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
  }
  const parts = ip.split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d+$/.test(p))) return false; // pas une IPv4 littérale → pas « privé »
  const [a, b] = parts.map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
         (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
};

// SÉCURITÉ (anti-SSRF) : endpoint Push HTTPS public, ET l'hôte doit résoudre vers une IP publique
const isAllowedPushEndpoint = async (endpoint) => {
  try {
    const u = new URL(String(endpoint));
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
    if (host.startsWith('[') || host.includes(':')) return false; // littéraux IPv6
    if (isPrivateIp(host)) return false;
    const { address } = await dns.promises.lookup(host);
    if (isPrivateIp(address)) return false;
    return true;
  } catch {
    return false;
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

  router.post('/push/subscribe', authenticateToken, sensitiveRateLimiter, async (req, res) => {
    const { subscription } = req.body || {};
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: "Abonnement Push invalide." });
    }

    const { endpoint, keys } = subscription;
    // SÉCURITÉ : anti-SSRF — HTTPS public + résolution DNS vers une IP publique
    if (!(await isAllowedPushEndpoint(endpoint))) {
      return res.status(400).json({ error: "Endpoint Push invalide (HTTPS public requis)." });
    }
    // SÉCURITÉ : plafonner le nombre d'abonnements par compte (anti-ressources)
    const already = db.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').get(endpoint, req.user.id);
    if (!already) {
      const cnt = db.prepare('SELECT COUNT(*) as c FROM push_subscriptions WHERE user_id = ?').get(req.user.id).c;
      if (cnt >= 20) return res.status(400).json({ error: "Trop d'abonnements Push (maximum 20)." });
    }

    const p256dh = keys?.p256dh || null;
    const auth = keys?.auth || null;
    const userAgent = req.headers['user-agent'] || null;
    const now = Date.now();

    try {
      // SÉCURITÉ : ne jamais réattribuer un endpoint appartenant à un AUTRE compte.
      const owner = db.prepare('SELECT user_id FROM push_subscriptions WHERE endpoint = ?').get(endpoint);
      if (owner && Number(owner.user_id) !== Number(req.user.id)) {
        return res.status(409).json({ error: "Cet endpoint Push appartient déjà à un autre compte." });
      }
      const stmt = db.prepare(`
        INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET
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
