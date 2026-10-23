import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import axios from 'axios';
import { type EncryptedFileKeys, decryptFileBinary } from '../utils/Security';
import { useI18n } from '../i18n';
import { notify } from '../utils/dialogs';
import { isNativeApp, saveBlob } from '../utils/platform';
import { safeFileName } from '../utils/fileNames';
import ImageViewer from './ImageViewer';

export interface FileDataPayload {
  type: 'file';
  fileId: string;
  token: string;
  downloadUrl: string;
  expiresAt: number;
  fileName: string;
  fileSize: number;
  fileType: string;
  fileKeys: EncryptedFileKeys;
  sender?: string;
  senderId?: number;
}

interface FileTransferCardProps {
  fileData: FileDataPayload;
  myPrivateKey?: JsonWebKey | CryptoKey | null;
  isSender: boolean;
}

const formatBytes = (bytes: number, lang: 'fr' | 'en' = 'fr'): string => {
  const byteUnit = lang === 'en' ? 'B' : 'o';
  const kbUnit = lang === 'en' ? 'KB' : 'Ko';
  const mbUnit = lang === 'en' ? 'MB' : 'Mo';
  if (!bytes || bytes === 0) return `0 ${byteUnit}`;
  if (bytes < 1024) return `${bytes} ${byteUnit}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} ${kbUnit}`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} ${mbUnit}`;
};

const getExtension = (fileName: string): string => {
  if (!fileName || !fileName.includes('.')) return 'FIC';
  const ext = fileName.split('.').pop() || 'FIC';
  return ext.slice(0, 4).toUpperCase();
};

// SÉCURITÉ (M4) : n'accepter que les URL de téléchargement internes.
// downloadUrl provient du payload E2EE (contrôlé par l'émetteur) → bloquer toute URL absolue/externe.
const isSafeDownloadUrl = (url: unknown): url is string =>
  typeof url === 'string' && /^\/api\/files\/download\/[0-9a-f-]{36}\?token=[0-9a-f]{16,128}$/.test(url);

export const isImageFile = (fileData?: FileDataPayload | null): boolean => {
  if (!fileData) return false;
  const mime = (fileData.fileType || '').toLowerCase();
  if (mime.startsWith('image/')) return true;
  const name = safeFileName(fileData.fileName).toLowerCase();
  return /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(name);
};

export const FileTransferCard: React.FC<FileTransferCardProps> = ({
  fileData,
  myPrivateKey,
  isSender
}) => {
  const { t, language } = useI18n();
  // Nom affiché et enregistré sans caractères invisibles / bidirectionnels (nom trompeur)
  const fileName = safeFileName(fileData.fileName);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isDownloaded, setIsDownloaded] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // États spécifiques à la prévisualisation d'image
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  // Blob déchiffré de l'aperçu : réutilisé pour l'enregistrer sans nouveau téléchargement
  const imageBlobRef = useRef<Blob | null>(null);
  const [isAutoLoading, setIsAutoLoading] = useState(false);
  const [autoLoadError, setAutoLoadError] = useState(false);
  const [showLightbox, setShowLightbox] = useState(false);

  const calculateRemaining = useCallback(() => {
    const diff = fileData.expiresAt - Date.now();
    if (diff <= 0) return { expired: true, text: t.fileTransfer.expiredText };
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    if (hours > 0) {
      return { expired: false, text: t.fileTransfer.availableFor.replace('{time}', `${hours}h ${minutes}min`) };
    }
    return { expired: false, text: t.fileTransfer.availableFor.replace('{time}', `${minutes} min`) };
  }, [fileData.expiresAt, t]);

  const [remaining, setRemaining] = useState(calculateRemaining);

  useEffect(() => {
    setRemaining(calculateRemaining());
  }, [calculateRemaining]);

  useEffect(() => {
    const timer = setInterval(() => {
      setRemaining(calculateRemaining());
    }, 30000);
    return () => clearInterval(timer);
  }, [calculateRemaining]);

  // Seuil de prévisualisation automatique (10 Mo)
  const AUTO_PREVIEW_MAX_SIZE = 10 * 1024 * 1024;
  const isImage = isImageFile(fileData);
  const isHeavyImage = isImage && fileData.fileSize > AUTO_PREVIEW_MAX_SIZE;

  // Déchiffrement de l'image en mémoire pour aperçu local
  const loadDecryptedImage = useCallback(async () => {
    if (imageUrl || isDownloading || isAutoLoading) return;
    if (remaining.expired || !myPrivateKey) return;

    setIsAutoLoading(true);
    setAutoLoadError(false);

    try {
      if (!isSafeDownloadUrl(fileData.downloadUrl)) {
        throw new Error("URL de téléchargement invalide.");
      }
      const response = await axios.get(fileData.downloadUrl, {
        responseType: 'arraybuffer'
      });

      const decryptedBuffer = await decryptFileBinary(
        response.data,
        fileData.fileKeys,
        myPrivateKey,
        isSender
      );

      if (!decryptedBuffer) {
        throw new Error("Échec du déchiffrement de l'image.");
      }

      const mime = fileData.fileType && fileData.fileType.startsWith('image/') 
        ? fileData.fileType 
        : 'image/png';
      const blob = new Blob([decryptedBuffer], { type: mime });
      const objectUrl = URL.createObjectURL(blob);
      imageBlobRef.current = blob;
      setImageUrl(objectUrl);
    } catch (err) {
      console.error("Erreur de prévisualisation auto de l'image:", err);
      setAutoLoadError(true);
    } finally {
      setIsAutoLoading(false);
    }
  }, [imageUrl, isDownloading, isAutoLoading, remaining.expired, myPrivateKey, fileData, isSender]);

  // Déclenchement automatique pour les images standard (<= 10 Mo)
  useEffect(() => {
    if (isImage && !isHeavyImage && !imageUrl && !autoLoadError && !remaining.expired && myPrivateKey) {
      loadDecryptedImage();
    }
  }, [isImage, isHeavyImage, imageUrl, autoLoadError, remaining.expired, myPrivateKey, loadDecryptedImage]);

  // Nettoyage rigoureux de l'URL objet
  useEffect(() => {
    return () => {
      if (imageUrl) {
        URL.revokeObjectURL(imageUrl);
      }
    };
  }, [imageUrl]);

  const handleDownload = async () => {
    if (remaining.expired) {
      notify(t.fileTransfer.expiredAlert, { icon: '⚠️' });
      return;
    }

    // Optimisation : si l'image est déjà déchiffrée en local, téléchargement immédiat sans requête réseau
    if (imageUrl && imageBlobRef.current) {
      try {
        if (await saveBlob(imageBlobRef.current, fileName || 'image_recue.png')) {
          setIsDownloaded(true);
          if (isNativeApp()) notify(t.fileTransfer.savedToDownloads, { icon: '✅' });
        }
      } catch (err) {
        console.error("Erreur d'enregistrement du fichier:", err);
        notify(t.fileTransfer.saveFailed, { icon: '⚠️' });
      }
      return;
    }

    if (!myPrivateKey) {
      notify(t.fileTransfer.missingKeyAlert, { icon: '⚠️' });
      return;
    }

    setIsDownloading(true);
    setErrorMessage(null);
    setDownloadProgress(0);

    try {
      // 1. Télécharger le blob binaire chiffré depuis le serveur
      if (!isSafeDownloadUrl(fileData.downloadUrl)) {
        throw new Error("URL de téléchargement invalide.");
      }
      const response = await axios.get(fileData.downloadUrl, {
        responseType: 'arraybuffer',
        onDownloadProgress: (progressEvent) => {
          if (progressEvent.total) {
            const percent = Math.round((progressEvent.loaded * 100) / progressEvent.total);
            setDownloadProgress(percent);
          }
        }
      });

      // 2. Déchiffrer en local dans le navigateur (AES-256-GCM + clé RSA privée)
      const decryptedBuffer = await decryptFileBinary(
        response.data,
        fileData.fileKeys,
        myPrivateKey,
        isSender
      );

      if (!decryptedBuffer) {
        throw new Error("Échec du déchiffrement cryptographique du fichier.");
      }

      // 3. Déclencher le téléchargement direct du fichier original déchiffré
      const mime = fileData.fileType || 'application/octet-stream';
      const blob = new Blob([decryptedBuffer], { type: mime });

      // Si c'est une image, alimenter aussi l'aperçu inline
      if (isImage && !imageUrl) {
        imageBlobRef.current = blob;
        setImageUrl(URL.createObjectURL(blob));
      }

      if (await saveBlob(blob, fileName || 'fichier_dechiffre')) {
        setIsDownloaded(true);
        if (isNativeApp()) notify(t.fileTransfer.savedToDownloads, { icon: '✅' });
      }
    } catch (err: unknown) {
      const axiosErr = err as { response?: { status?: number } };
      if (axiosErr.response?.status === 410) {
        setErrorMessage(t.fileTransfer.linkExpired);
        setRemaining({ expired: true, text: t.fileTransfer.expiredText });
      } else {
        setErrorMessage(t.fileTransfer.downloadError);
      }
    } finally {
      setIsDownloading(false);
      setDownloadProgress(null);
    }
  };

  const ext = getExtension(fileName);

  // ========================================================
  // BRANCHE 1 : RENDU SPÉCIFIQUE POUR LES IMAGES
  // ========================================================
  if (isImage) {
    return (
      <div className="wlm-image-card">
        {/* Cas A : Miniature déchiffrée et prête */}
        {imageUrl ? (
          <div 
            className="wlm-image-thumbnail-wrapper" 
            onClick={() => setShowLightbox(true)}
            title={t.fileTransfer.clickToEnlarge}
          >
            <img 
              src={imageUrl} 
              alt={fileName} 
              className="wlm-image-thumbnail" 
            />
            <div className="wlm-image-zoom-overlay">
              <span>🔍 {t.fileTransfer.enlarge}</span>
            </div>
          </div>
        ) : isAutoLoading ? (
          /* Cas B : Déchiffrement auto en cours */
          <div className="wlm-image-loading-box">
            <div className="wlm-image-spinner"></div>
            <span>{t.fileTransfer.decryptingImage.replace('{size}', formatBytes(fileData.fileSize, language))}</span>
          </div>
        ) : (
          /* Cas C : Fallback si > 10 Mo, erreur ou pas encore déchiffré */
          <div className="wlm-image-fallback-box">
            <div className="wlm-image-fallback-icon">📷</div>
            <div className="wlm-image-fallback-info">
              <span className="wlm-image-fallback-title">
                {isHeavyImage ? t.fileTransfer.heavyImage : t.fileTransfer.encryptedImage}
              </span>
              <span className="wlm-image-fallback-sub">
                {remaining.expired 
                  ? t.fileTransfer.delayExpired 
                  : autoLoadError 
                    ? t.fileTransfer.autoDecryptFailed 
                    : t.fileTransfer.clickToLoad}
              </span>
            </div>
          </div>
        )}

        {/* Pied de carte de l'image (Métadonnées & Actions) */}
        <div className="wlm-image-card-footer">
          <div className="wlm-image-info">
            <div className="wlm-image-name" title={fileName}>
              {fileName}
            </div>
            <div className="wlm-file-meta">
              <span>{formatBytes(fileData.fileSize, language)}</span>
              <span className={`wlm-file-badge-direction ${isSender ? 'outgoing' : 'incoming'}`}>
                {isSender ? t.fileTransfer.sentBadge : t.fileTransfer.receivedBadge}
              </span>
              <span className="wlm-file-badge-e2ee" title={t.fileTransfer.e2eeTitle}>{t.fileTransfer.e2eeBadge}</span>
              {remaining.expired && <span className="wlm-file-badge-expired">{t.fileTransfer.expiredBadge}</span>}
            </div>
          </div>

          <div className="wlm-image-actions">
            {!imageUrl && !remaining.expired && (
              <button
                type="button"
                className="wlm-file-download-btn win-btn-primary"
                onClick={loadDecryptedImage}
                disabled={isAutoLoading}
              >
                {isAutoLoading ? t.fileTransfer.decrypting : t.fileTransfer.viewImage}
              </button>
            )}

            <button
              type="button"
              className="wlm-file-download-btn"
              onClick={handleDownload}
              disabled={isDownloading || remaining.expired}
              title={t.fileTransfer.saveToComputer}
            >
              {isDownloading ? (
                <span>{downloadProgress !== null && downloadProgress > 0 ? `${downloadProgress}%...` : t.fileTransfer.decrypting}</span>
              ) : isDownloaded ? (
                <span>{t.fileTransfer.saved}</span>
              ) : (
                <span>{t.fileTransfer.download}</span>
              )}
            </button>
          </div>
        </div>

        {errorMessage && (
          <div style={{ color: '#c5221f', fontSize: '9px', marginTop: '4px', padding: '0 4px' }}>
            {errorMessage}
          </div>
        )}

        {/* Visionneuse agrandie : zoom (molette, pincement, double-clic) et déplacement */}
        {showLightbox && imageUrl && createPortal(
          <div className="modal-bg wlm-lightbox-bg" onClick={(e) => { if (e.target === e.currentTarget) setShowLightbox(false); }}>
            <ImageViewer
              src={imageUrl}
              title={`${fileName} (${formatBytes(fileData.fileSize, language)})`}
              onClose={() => setShowLightbox(false)}
              onSave={handleDownload}
            />
          </div>,
          document.body
        )}
      </div>
    );
  }

  // ========================================================
  // BRANCHE 2 : RENDU FICHIER CLASSIQUE (NON IMAGE) INTACT
  // ========================================================
  return (
    <div className="wlm-file-card">
      <div className="wlm-file-card-header">
        <div className="wlm-file-icon" title={language === 'en' ? `File .${ext}` : `Fichier .${ext}`}>
          {ext}
        </div>
        <div className="wlm-file-info">
          <div className="wlm-file-name" title={fileName}>
            {fileName}
          </div>
          <div className="wlm-file-meta">
            <span>{formatBytes(fileData.fileSize, language)}</span>
            <span className={`wlm-file-badge-direction ${isSender ? 'outgoing' : 'incoming'}`}>
              {isSender ? t.fileTransfer.sentBadge : t.fileTransfer.receivedBadge}
            </span>
            <span className="wlm-file-badge-e2ee" title={t.fileTransfer.e2eeTitle}>{t.fileTransfer.e2eeBadge}</span>
            {remaining.expired ? (
              <span className="wlm-file-badge-expired">{t.fileTransfer.expiredBadge}</span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="wlm-file-actions">
        {remaining.expired ? (
          <span className="wlm-file-expiry" style={{ color: '#c5221f' }}>
            {t.fileTransfer.linkExpired}
          </span>
        ) : (
          <span className="wlm-file-expiry">
            {remaining.text}
          </span>
        )}

        <button
          className="wlm-file-download-btn"
          onClick={handleDownload}
          disabled={isDownloading || remaining.expired}
        >
          {isDownloading ? (
            <span>
              {downloadProgress !== null && downloadProgress > 0 ? `${downloadProgress}%...` : t.fileTransfer.decrypting}
            </span>
          ) : isDownloaded ? (
            <span>{t.fileTransfer.downloaded}</span>
          ) : (
            <span>{t.fileTransfer.download}</span>
          )}
        </button>
      </div>

      {errorMessage && (
        <div style={{ color: '#c5221f', fontSize: '9px', marginTop: '4px' }}>
          {errorMessage}
        </div>
      )}
    </div>
  );
};

export default FileTransferCard;
