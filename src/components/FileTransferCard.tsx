import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { type EncryptedFileKeys, decryptFileBinary } from '../utils/Security';

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
  myPrivateKey?: JsonWebKey | null;
  isSender: boolean;
}

const formatBytes = (bytes: number): string => {
  if (!bytes || bytes === 0) return '0 o';
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
};

const getExtension = (fileName: string): string => {
  if (!fileName || !fileName.includes('.')) return 'FIC';
  const ext = fileName.split('.').pop() || 'FIC';
  return ext.slice(0, 4).toUpperCase();
};

export const isImageFile = (fileData?: FileDataPayload | null): boolean => {
  if (!fileData) return false;
  const mime = (fileData.fileType || '').toLowerCase();
  if (mime.startsWith('image/')) return true;
  const name = (fileData.fileName || '').toLowerCase();
  return /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(name);
};

export const FileTransferCard: React.FC<FileTransferCardProps> = ({
  fileData,
  myPrivateKey,
  isSender
}) => {
  const [isDownloading, setIsDownloading] = useState(false);
  const [isDownloaded, setIsDownloaded] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // États spécifiques à la prévisualisation d'image
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [isAutoLoading, setIsAutoLoading] = useState(false);
  const [autoLoadError, setAutoLoadError] = useState(false);
  const [showLightbox, setShowLightbox] = useState(false);

  const calculateRemaining = useCallback(() => {
    const diff = fileData.expiresAt - Date.now();
    if (diff <= 0) return { expired: true, text: 'Expiré (délai de 4H dépassé)' };
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    if (hours > 0) {
      return { expired: false, text: `Disponible encore ${hours}h ${minutes}min` };
    }
    return { expired: false, text: `Disponible encore ${minutes} min` };
  }, [fileData.expiresAt]);

  const [remaining, setRemaining] = useState(calculateRemaining);

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

  // Raccourci Échap pour fermer la visionneuse agrandie
  useEffect(() => {
    if (!showLightbox) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowLightbox(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showLightbox]);

  const handleDownload = async () => {
    if (remaining.expired) {
      alert("Ce lien de téléchargement a expiré (validité 4H max).");
      return;
    }

    // Optimisation : si l'image est déjà déchiffrée en local, téléchargement immédiat sans requête réseau
    if (imageUrl) {
      const downloadAnchor = document.createElement('a');
      downloadAnchor.href = imageUrl;
      downloadAnchor.download = fileData.fileName || 'image_recue.png';
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      document.body.removeChild(downloadAnchor);
      setIsDownloaded(true);
      return;
    }

    if (!myPrivateKey) {
      alert("Clé privée de déchiffrement manquante. Veuillez vous reconnecter.");
      return;
    }

    setIsDownloading(true);
    setErrorMessage(null);
    setDownloadProgress(0);

    try {
      // 1. Télécharger le blob binaire chiffré depuis le serveur
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
      const objectUrl = URL.createObjectURL(blob);

      // Si c'est une image, alimenter aussi l'aperçu inline
      if (isImage && !imageUrl) {
        setImageUrl(objectUrl);
      }

      const downloadAnchor = document.createElement('a');
      downloadAnchor.href = objectUrl;
      downloadAnchor.download = fileData.fileName || 'fichier_dechiffre';
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      document.body.removeChild(downloadAnchor);

      if (!isImage) {
        setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
      }

      setIsDownloaded(true);
    } catch (err: unknown) {
      const axiosErr = err as { response?: { status?: number } };
      if (axiosErr.response?.status === 410) {
        setErrorMessage("Lien expiré (4h dépassées)");
        setRemaining({ expired: true, text: 'Expiré (délai de 4H dépassé)' });
      } else {
        setErrorMessage("Erreur lors du téléchargement/déchiffrement.");
      }
    } finally {
      setIsDownloading(false);
      setDownloadProgress(null);
    }
  };

  const ext = getExtension(fileData.fileName);

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
            title="Cliquer pour agrandir la capture"
          >
            <img 
              src={imageUrl} 
              alt={fileData.fileName} 
              className="wlm-image-thumbnail" 
            />
            <div className="wlm-image-zoom-overlay">
              <span>🔍 Agrandir</span>
            </div>
          </div>
        ) : isAutoLoading ? (
          /* Cas B : Déchiffrement auto en cours */
          <div className="wlm-image-loading-box">
            <div className="wlm-image-spinner"></div>
            <span>Déchiffrement de l'image ({formatBytes(fileData.fileSize)})...</span>
          </div>
        ) : (
          /* Cas C : Fallback si > 10 Mo, erreur ou pas encore déchiffré */
          <div className="wlm-image-fallback-box">
            <div className="wlm-image-fallback-icon">📷</div>
            <div className="wlm-image-fallback-info">
              <span className="wlm-image-fallback-title">
                {isHeavyImage ? "Image volumineuse (> 10 Mo)" : "Image chiffrée"}
              </span>
              <span className="wlm-image-fallback-sub">
                {remaining.expired 
                  ? "Délai expiré" 
                  : autoLoadError 
                    ? "Déchiffrement auto en échec" 
                    : "Cliquer pour charger l'aperçu"}
              </span>
            </div>
          </div>
        )}

        {/* Pied de carte de l'image (Métadonnées & Actions) */}
        <div className="wlm-image-card-footer">
          <div className="wlm-image-info">
            <div className="wlm-image-name" title={fileData.fileName}>
              {fileData.fileName}
            </div>
            <div className="wlm-file-meta">
              <span>{formatBytes(fileData.fileSize)}</span>
              <span className={`wlm-file-badge-direction ${isSender ? 'outgoing' : 'incoming'}`}>
                {isSender ? '📤 Envoyée' : '📥 Reçue'}
              </span>
              <span className="wlm-file-badge-e2ee" title="Chiffré de bout en bout avec AES-256 et RSA">🔒 E2EE</span>
              {remaining.expired && <span className="wlm-file-badge-expired">Expiré</span>}
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
                {isAutoLoading ? 'Déchiffrement...' : "Afficher l'image"}
              </button>
            )}

            <button
              type="button"
              className="wlm-file-download-btn"
              onClick={handleDownload}
              disabled={isDownloading || remaining.expired}
              title="Enregistrer le fichier image sur votre ordinateur"
            >
              {isDownloading ? (
                <span>{downloadProgress !== null && downloadProgress > 0 ? `${downloadProgress}%...` : 'Déchiffrement...'}</span>
              ) : isDownloaded ? (
                <span>✓ Enregistré</span>
              ) : (
                <span>⬇ Télécharger</span>
              )}
            </button>
          </div>
        </div>

        {errorMessage && (
          <div style={{ color: '#c5221f', fontSize: '9px', marginTop: '4px', padding: '0 4px' }}>
            {errorMessage}
          </div>
        )}

        {/* Visionneuse agrandie (Lightbox MSN / Windows) */}
        {showLightbox && imageUrl && (
          <div className="modal-bg wlm-lightbox-bg" onClick={() => setShowLightbox(false)}>
            <div className="wlm-lightbox-box" onClick={e => e.stopPropagation()}>
              <div className="wlm-paste-modal-header">
                <div className="wlm-paste-title-area">
                  <span className="wlm-paste-icon">📷</span>
                  <span className="wlm-paste-title">{fileData.fileName} ({formatBytes(fileData.fileSize)})</span>
                </div>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <button 
                    type="button" 
                    className="win-btn win-btn-primary" 
                    onClick={handleDownload}
                    style={{ fontSize: '11px', padding: '2px 10px' }}
                  >
                    ⬇ Enregistrer
                  </button>
                  <button 
                    type="button" 
                    className="win-close-btn" 
                    onClick={() => setShowLightbox(false)} 
                    title="Fermer (Échap)"
                  >
                    ✕
                  </button>
                </div>
              </div>
              <div className="wlm-lightbox-content">
                <img src={imageUrl} alt={fileData.fileName} className="wlm-lightbox-image" />
              </div>
            </div>
          </div>
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
        <div className="wlm-file-icon" title={`Fichier .${ext}`}>
          {ext}
        </div>
        <div className="wlm-file-info">
          <div className="wlm-file-name" title={fileData.fileName}>
            {fileData.fileName}
          </div>
          <div className="wlm-file-meta">
            <span>{formatBytes(fileData.fileSize)}</span>
            <span className={`wlm-file-badge-direction ${isSender ? 'outgoing' : 'incoming'}`}>
              {isSender ? '📤 Envoyé' : '📥 Reçu'}
            </span>
            <span className="wlm-file-badge-e2ee" title="Chiffré de bout en bout avec AES-256 et RSA">🔒 E2EE</span>
            {remaining.expired ? (
              <span className="wlm-file-badge-expired">Expiré</span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="wlm-file-actions">
        {remaining.expired ? (
          <span className="wlm-file-expiry" style={{ color: '#c5221f' }}>
            Le lien de 4h a expiré
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
              {downloadProgress !== null && downloadProgress > 0 ? `${downloadProgress}%...` : 'Déchiffrement...'}
            </span>
          ) : isDownloaded ? (
            <span>✓ Téléchargé</span>
          ) : (
            <span>⬇ Télécharger</span>
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
