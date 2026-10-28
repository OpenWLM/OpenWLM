import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { db } from '../db.js';
import { authenticateToken, canInteract, uploadRateLimiter } from '../middleware/auth.js';
import { UPLOADS_DIR } from './files.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const EMOTICONS_UPLOADS_DIR = path.join(UPLOADS_DIR, 'emoticons');

if (!fs.existsSync(EMOTICONS_UPLOADS_DIR)) {
  fs.mkdirSync(EMOTICONS_UPLOADS_DIR, { recursive: true, mode: 0o700 });
}

const emoticonStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, EMOTICONS_UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const randomHex = crypto.randomBytes(16).toString('hex');
    cb(null, `emo_${randomHex}.bin`);
  }
});

// Mêmes bornes que l'upload de fichiers (cf. server/routes/files.js) : un seul fichier et
// quelques champs courts (shortcut, mimeType, width, height, isAnimated).
const uploadEmoticon = multer({
  storage: emoticonStorage,
  limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 8, parts: 10, fieldSize: 4 * 1024, fieldNameSize: 100 }
});

/** Format de encryptForLocal (src/utils/Security.ts) : { iv, data, key } en base64, ≤ 4 Ko. */
const isValidEncryptedKey = (value) => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return false;
  try {
    const o = JSON.parse(value);
    const b64 = /^[A-Za-z0-9+/]+={0,2}$/;
    return !!o && typeof o === 'object' && ['iv', 'data', 'key'].every((k) => typeof o[k] === 'string' && o[k].length > 0 && b64.test(o[k]));
  } catch {
    return false;
  }
};

/**
 * Volume total des émoticônes d'un compte (octets). Le nombre (100) seul laissait 100 Mo par
 * compte, conservés sans limite de durée : avec plusieurs comptes, de quoi remplir le disque.
 */
export const EMOTICONS_BYTES_QUOTA = 20 * 1024 * 1024;

export const createEmoticonsRouter = () => {
  const router = Router();

  /**
   * Copie chiffrée de la clé d'une émoticône (émoticônes créées avant cette sauvegarde) :
   * uniquement par son propriétaire, et seulement si aucune copie n'existe encore.
   */
  router.post('/emoticons/custom/key', authenticateToken, (req, res) => {
    const id = String(req.body?.id || '');
    const encryptedKey = String(req.body?.encryptedKey || '');
    if (!/^emo_[0-9a-f-]{36}$/.test(id) || !isValidEncryptedKey(encryptedKey)) {
      return res.status(400).json({ error: 'Requête invalide.' });
    }
    const result = db.prepare('UPDATE custom_emoticons SET encrypted_key = ? WHERE id = ? AND owner_id = ? AND encrypted_key IS NULL').run(encryptedKey, id, req.user.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Émoticône introuvable ou clé déjà enregistrée.' });
    res.json({ success: true });
  });

  /**
   * Métadonnées des émoticônes de l'utilisateur connecté
   */
  router.get('/emoticons/custom/my', authenticateToken, (req, res) => {
    try {
      const rows = db.prepare(`
        SELECT id, shortcut, mime_type, file_size, width, height, is_animated, created_at, encrypted_key 
        FROM custom_emoticons 
        WHERE owner_id = ? 
        ORDER BY created_at ASC
      `).all(req.user.id);
      res.json({ success: true, emoticons: rows });
    } catch (err) {
      console.error("Erreur récupération émoticônes custom:", err);
      res.status(500).json({ error: "Erreur serveur lors de la récupération des émoticônes." });
    }
  });

  /**
   * Upload d'un asset chiffré d'émoticône personnalisée
   */
  router.post('/emoticons/custom/upload', authenticateToken, uploadRateLimiter, (req, res) => {
    uploadEmoticon.single('file')(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: "L'émoticône dépasse la taille autorisée (max 1 Mo pour GIF, 256 Ko pour image statique)." });
        }
        return res.status(400).json({ error: err.message || "Erreur lors du téléversement de l'émoticône." });
      }

      if (!req.file) {
        return res.status(400).json({ error: "Aucun fichier reçu." });
      }

      const cleanupFile = () => {
        if (req.file?.path && fs.existsSync(req.file.path)) {
          try { fs.unlinkSync(req.file.path); } catch (e) {}
        }
      };

      try {
        const countRow = db.prepare('SELECT COUNT(*) as count FROM custom_emoticons WHERE owner_id = ?').get(req.user.id);
        if (countRow && countRow.count >= 100) {
          cleanupFile();
          return res.status(400).json({ error: "Quota atteint (100 émoticônes personnalisées maximum par compte)." });
        }

        const shortcut = String(req.body.shortcut || '').trim();
        const shortcutRegex = /^[\w\-():;@#!?*~[\]{}]{2,32}$/;
        if (shortcut.length < 2 || shortcut.length > 32 || !shortcutRegex.test(shortcut)) {
          cleanupFile();
          return res.status(400).json({ error: "Raccourci invalide (2 à 32 caractères, lettres, chiffres et symboles usuels autorisés)." });
        }

        const existing = db.prepare('SELECT id FROM custom_emoticons WHERE owner_id = ? AND shortcut = ?').get(req.user.id, shortcut);
        if (existing) {
          cleanupFile();
          return res.status(400).json({ error: "Ce raccourci existe déjà dans vos émoticônes." });
        }

        const allowedMimes = ['image/png', 'image/webp', 'image/gif', 'image/jpeg'];
        const mimeType = String(req.body.mimeType || '').toLowerCase();
        if (!allowedMimes.includes(mimeType)) {
          cleanupFile();
          return res.status(400).json({ error: "Format non supporté (PNG, WebP, GIF ou JPEG uniquement)." });
        }

        const width = parseInt(req.body.width, 10);
        const height = parseInt(req.body.height, 10);
        if (isNaN(width) || isNaN(height) || width < 1 || width > 128 || height < 1 || height > 128) {
          cleanupFile();
          return res.status(400).json({ error: "Dimensions invalides (128x128 pixels maximum)." });
        }

        const isAnimated = (req.body.isAnimated === 'true' || req.body.isAnimated === true || req.body.isAnimated === 1 || req.body.isAnimated === '1') ? 1 : 0;
        const maxAllowedSize = isAnimated ? (1024 * 1024 + 1024) : (256 * 1024 + 1024);
        if (req.file.size > maxAllowedSize) {
          cleanupFile();
          return res.status(400).json({ error: isAnimated ? "Le GIF animé dépasse 1 Mo." : "L'image statique dépasse 256 Ko." });
        }

        const usedRow = db.prepare('SELECT COALESCE(SUM(file_size), 0) AS used FROM custom_emoticons WHERE owner_id = ?').get(req.user.id);
        if (Number(usedRow?.used || 0) + req.file.size > EMOTICONS_BYTES_QUOTA) {
          cleanupFile();
          return res.status(400).json({ error: "Espace des émoticônes plein (20 Mo par compte). Supprimez-en pour en ajouter.", code: 'emoticon_bytes_quota' });
        }

        const encryptedKey = req.body.encryptedKey === undefined ? null : String(req.body.encryptedKey);
        if (encryptedKey !== null && !isValidEncryptedKey(encryptedKey)) {
          cleanupFile();
          return res.status(400).json({ error: "Clé chiffrée invalide." });
        }

        const assetId = 'emo_' + crypto.randomUUID();
        const now = Date.now();

        const stmt = db.prepare(`
          INSERT INTO custom_emoticons (id, owner_id, shortcut, mime_type, file_size, width, height, is_animated, asset_filename, created_at, encrypted_key)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(assetId, req.user.id, shortcut, mimeType, req.file.size, width, height, isAnimated, req.file.filename, now, encryptedKey);

        res.json({
          success: true,
          emoticon: {
            id: assetId,
            shortcut,
            mime_type: mimeType,
            file_size: req.file.size,
            width,
            height,
            is_animated: isAnimated,
            created_at: now
          }
        });
      } catch (dbErr) {
        console.error("Erreur insertion émoticône custom:", dbErr);
        cleanupFile();
        res.status(500).json({ error: "Erreur serveur lors de l'enregistrement de l'émoticône." });
      }
    });
  });

  /**
   * Téléchargement d'un asset chiffré
   */
  router.get('/emoticons/custom/asset/:assetId', authenticateToken, (req, res) => {
    const { assetId } = req.params;
    const emoRecord = db.prepare('SELECT asset_filename, mime_type, owner_id FROM custom_emoticons WHERE id = ?').get(assetId);

    if (!emoRecord) {
      return res.status(404).json({ error: "Émoticône introuvable." });
    }

    if (emoRecord.owner_id !== req.user.id && !canInteract(req.user.id, emoRecord.owner_id).allowed) {
      return res.status(403).json({ error: "Accès refusé." });
    }

    const filePath = path.join(EMOTICONS_UPLOADS_DIR, emoRecord.asset_filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Asset introuvable sur le disque." });
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    // SÉCURITÉ : asset authentifié → cache navigateur privé uniquement (jamais de cache partagé/proxy)
    res.setHeader('Cache-Control', 'private, max-age=604800, immutable');
    res.sendFile(filePath);
  });

  /**
   * Suppression d'une émoticône personnalisée
   */
  router.delete('/emoticons/custom/:assetId', authenticateToken, (req, res) => {
    const id = req.params.assetId;
    const emoRecord = db.prepare('SELECT asset_filename FROM custom_emoticons WHERE id = ? AND owner_id = ?').get(id, req.user.id);

    if (!emoRecord) {
      return res.status(404).json({ error: "Émoticône introuvable ou non autorisée." });
    }

    const filePath = path.join(EMOTICONS_UPLOADS_DIR, emoRecord.asset_filename);
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (e) { console.error("Erreur suppression asset disque:", e); }
    }

    db.prepare('DELETE FROM custom_emoticons WHERE id = ?').run(id);
    res.json({ success: true });
  });

  return router;
};
