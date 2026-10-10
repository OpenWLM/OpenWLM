import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { db } from '../db.js';
import { authenticateToken, uploadRateLimiter, canInteract, safeTokenEqual } from '../middleware/auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const UPLOADS_DIR = path.join(__dirname, '../../uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true, mode: 0o700 });
}

const htaccessPath = path.join(UPLOADS_DIR, '.htaccess');
if (!fs.existsSync(htaccessPath)) {
  try {
    fs.writeFileSync(htaccessPath, 'Deny from all\nOptions -Indexes -ExecCGI\n');
  } catch (e) {}
}

const fileStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const randomHex = crypto.randomBytes(16).toString('hex');
    cb(null, `enc_${randomHex}.bin`);
  }
});

const upload = multer({
  storage: fileStorage,
  limits: { fileSize: 100 * 1024 * 1024 } // 100 Mo max
});

export const cleanupExpiredFiles = () => {
  try {
    const now = Date.now();
    const expiredFiles = db.prepare('SELECT id, filename FROM shared_files WHERE expires_at <= ?').all(now);
    for (const f of expiredFiles) {
      const filePath = path.join(UPLOADS_DIR, f.filename);
      if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch (e) { console.error("Erreur suppression fichier disque:", e); }
      }
    }
    const result = db.prepare('DELETE FROM shared_files WHERE expires_at <= ?').run(now);
    if (result.changes > 0) {
      console.log(`[Fichiers E2EE] Nettoyage : ${result.changes} fichier(s) expiré(s) purgé(s).`);
    }
  } catch (err) {
    console.error("Erreur nettoyage fichiers expirés:", err);
  }
};

export const cleanupOrphanUploads = () => {
  try {
    const referenced = new Set(db.prepare('SELECT filename FROM shared_files').all().map(r => r.filename));
    const now = Date.now();
    for (const entry of fs.readdirSync(UPLOADS_DIR, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (referenced.has(entry.name)) continue;
      const full = path.join(UPLOADS_DIR, entry.name);
      try {
        const st = fs.statSync(full);
        if (now - st.mtimeMs > 60 * 60 * 1000) {
          fs.unlinkSync(full);
          console.log(`[Fichiers E2EE] Purge fichier orphelin: ${entry.name}`);
        }
      } catch (e) {}
    }
  } catch (err) {
    console.error("Erreur nettoyage orphelins:", err);
  }
};

export const createFilesRouter = () => {
  const router = Router();

  /**
   * Upload d'un fichier chiffré
   */
  router.post('/files/upload', authenticateToken, uploadRateLimiter, (req, res) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({
              error: "Le fichier dépasse la taille maximale autorisée de 100 Mo."
            });
          }
          return res.status(400).json({ error: `Erreur d'envoi du fichier : ${err.message}` });
        }
        return res.status(400).json({ error: err.message || "Erreur lors du téléversement du fichier." });
      }

      if (!req.file) {
        return res.status(400).json({ error: "Aucun fichier reçu." });
      }

      const rawOriginalName = String(req.body.originalName || 'fichier_chiffre.bin');
      const safeOriginalName = path.basename(rawOriginalName).replace(/[/\\\\?%*:|"<>]/g, '_').slice(0, 255) || 'fichier_chiffre.bin';

      const rawFileType = String(req.body.fileType || 'application/octet-stream');
      const mimeRegex = /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/;
      const safeFileType = mimeRegex.test(rawFileType) ? rawFileType.slice(0, 100) : 'application/octet-stream';

      const senderId = req.user.id;
      const receiverId = parseInt(req.body.receiverId);
      const fileSize = req.file.size;

      if (!receiverId || isNaN(receiverId)) {
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: "Destinataire manquant ou invalide." });
      }

      const check = canInteract(senderId, receiverId);
      if (!check.allowed) {
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.status(403).json({ error: check.reason });
      }

      const fileId = crypto.randomUUID();
      const token = crypto.randomBytes(24).toString('hex');
      const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
      const expiresAt = Date.now() + FOUR_HOURS_MS;

      // SÉCURITÉ : quota + insertion dans une même transaction (atomicité du contrôle de quota)
      const QUOTA_BYTES = 1 * 1024 * 1024 * 1024; // 1 Go
      try {
        const currentUsage = db.transaction(() => {
          const usageRow = db.prepare('SELECT COALESCE(SUM(file_size), 0) as total FROM shared_files WHERE sender_id = ?').get(senderId);
          const usage = usageRow ? usageRow.total : 0;
          if (usage + fileSize > QUOTA_BYTES) {
            return usage; // quota dépassé : aucune insertion
          }
          db.prepare(`
            INSERT INTO shared_files (id, sender_id, receiver_id, filename, original_name, file_size, file_type, token, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(fileId, senderId, receiverId, req.file.filename, safeOriginalName, fileSize, safeFileType, token, expiresAt);
          return null; // succès
        })();

        if (currentUsage !== null) {
          if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
          const usedMB = Math.round(currentUsage / (1024 * 1024));
          return res.status(413).json({
            error: `Quota de stockage dépassé (${usedMB} Mo utilisés sur 1 Go). Attendez l'expiration de vos anciens fichiers.`
          });
        }

        res.json({
          success: true,
          fileId,
          token,
          downloadUrl: `/api/files/download/${fileId}?token=${token}`,
          expiresAt,
          originalName: safeOriginalName,
          fileSize
        });
      } catch (dbErr) {
        console.error("Erreur enregistrement fichier:", dbErr);
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: "Erreur lors de l'enregistrement du fichier." });
      }
    });
  });

  /**
   * Téléchargement d'un fichier chiffré
   */
  router.get('/files/download/:fileId', (req, res) => {
    const { fileId } = req.params;
    const { token } = req.query;

    if (!token) {
      return res.status(401).json({ error: "Token d'accès manquant." });
    }

    const fileRecord = db.prepare('SELECT * FROM shared_files WHERE id = ?').get(fileId);
    if (!fileRecord) {
      return res.status(404).json({ error: "Fichier introuvable ou supprimé." });
    }

    if (!safeTokenEqual(fileRecord.token, token)) {
      return res.status(403).json({ error: "Token d'accès non valide." });
    }

    if (Date.now() > fileRecord.expires_at) {
      const filePath = path.join(UPLOADS_DIR, fileRecord.filename);
      if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch (e) {}
      }
      db.prepare('DELETE FROM shared_files WHERE id = ?').run(fileId);
      return res.status(410).json({ error: "Ce lien de téléchargement a expiré (validité 4H max)." });
    }

    const filePath = path.join(UPLOADS_DIR, fileRecord.filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Fichier physique introuvable sur le disque." });
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Content-Disposition', `attachment; filename="encrypted_${fileRecord.id}.bin"`);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.sendFile(filePath);
  });

  /**
   * Info fichier partagé
   */
  router.get('/files/info/:fileId', (req, res) => {
    const { fileId } = req.params;
    const { token } = req.query;

    const fileRecord = db.prepare('SELECT * FROM shared_files WHERE id = ?').get(fileId);
    if (!fileRecord || !safeTokenEqual(fileRecord.token, token)) {
      return res.status(404).json({ error: "Fichier introuvable." });
    }

    const isExpired = Date.now() > fileRecord.expires_at;
    res.json({
      fileId: fileRecord.id,
      originalName: fileRecord.original_name,
      fileSize: fileRecord.file_size,
      fileType: fileRecord.file_type,
      expiresAt: fileRecord.expires_at,
      isExpired,
      remainingSeconds: Math.max(0, Math.floor((fileRecord.expires_at - Date.now()) / 1000))
    });
  });

  return router;
};
