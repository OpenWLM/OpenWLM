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

export const FileTransferCard: React.FC<FileTransferCardProps> = ({
  fileData,
  myPrivateKey,
  isSender
}) => {
  const [isDownloading, setIsDownloading] = useState(false);
  const [isDownloaded, setIsDownloaded] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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

  const handleDownload = async () => {
    if (remaining.expired) {
      alert("Ce lien de téléchargement a expiré (validité 4H max).");
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
      const blob = new Blob([decryptedBuffer], { type: fileData.fileType || 'application/octet-stream' });
      const objectUrl = URL.createObjectURL(blob);
      const downloadAnchor = document.createElement('a');
      downloadAnchor.href = objectUrl;
      downloadAnchor.download = fileData.fileName || 'fichier_dechiffre';
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      document.body.removeChild(downloadAnchor);
      setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);

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
