import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { encryptCustomEmoticon, validateImageSignature } from '../utils/Security';
import CustomEmoticonsDB, { type MyEmoticonRecord } from '../utils/CustomEmoticonsDB';
import { useI18n } from '../i18n';

interface CustomEmoticonsModalProps {
  isOpen: boolean;
  onClose: () => void;
  userToken?: string;
  onEmoticonsChange: (deletedShortcut?: string) => void;
  onSelectEmoticon?: (shortcut: string) => void;
}

export const CustomEmoticonsModal: React.FC<CustomEmoticonsModalProps> = ({
  isOpen,
  onClose,
  userToken,
  onEmoticonsChange,
  onSelectEmoticon
}) => {
  const { t } = useI18n();
  const [myEmoticons, setMyEmoticons] = useState<MyEmoticonRecord[]>([]);
  const [emoticonUrls, setEmoticonUrls] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [resizeInfo, setResizeInfo] = useState<string | null>(null);

  // Formulaire d'ajout
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileBuffer, setFileBuffer] = useState<ArrayBuffer | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [imageMeta, setImageMeta] = useState<{ width: number; height: number; isAnimated: boolean; mime: string } | null>(null);
  const [shortcutInput, setShortcutInput] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Chargement des émoticônes de l'utilisateur
  const loadEmoticons = async () => {
    setIsLoading(true);
    try {
      // 1. Récupérer les clés locales sauvegardées
      const localRecords = await CustomEmoticonsDB.getMyEmoticons();
      
      // 2. Récupérer les métadonnées serveur pour synchroniser
      const res = await axios.get('/api/emoticons/custom/my', {
        headers: { Authorization: `Bearer ${userToken}` }
      });

      if (res.data.success && Array.isArray(res.data.emoticons)) {
        const serverEmos = res.data.emoticons;

        // Nettoyer localement les clés orphelines en IndexedDB si supprimées du serveur
        const serverIds = new Set(serverEmos.map((s: any) => s.id));
        for (const local of localRecords) {
          if (!serverIds.has(local.id)) {
            await CustomEmoticonsDB.deleteMyEmoticon(local.id);
          }
        }
        
        // Fusionner avec les clés locales correspondantes
        const merged: MyEmoticonRecord[] = [];
        const urls: Record<string, string> = {};

        for (const s of serverEmos) {
          const local = localRecords.find(l => l.id === s.id);
          const record: MyEmoticonRecord = {
            id: s.id,
            shortcut: s.shortcut,
            keyBase64: local?.keyBase64 || '',
            mimeType: s.mime_type,
            width: s.width,
            height: s.height,
            isAnimated: s.is_animated,
            createdAt: s.created_at
          };
          merged.push(record);

          // Si l'asset déchiffré est en cache IndexedDB, créer l'URL d'affichage
          const cachedBlob = await CustomEmoticonsDB.getCachedAsset(s.id);
          if (cachedBlob) {
            urls[s.id] = CustomEmoticonsDB.getOrCreateObjectUrl(s.id, cachedBlob);
          }
        }

        setMyEmoticons(merged);
        setEmoticonUrls(urls);
      }
    } catch (err) {
      console.error("Erreur chargement émoticônes personnalisées:", err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen && userToken) {
      loadEmoticons();
      setErrorMessage(null);
      setSuccessMessage(null);
      setResizeInfo(null);
      resetForm();
    }
  }, [isOpen, userToken]);

  // Nettoyage de la preview locale lors du changement de fichier ou démontage
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const resetForm = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setSelectedFile(null);
    setFileBuffer(null);
    setPreviewUrl(null);
    setImageMeta(null);
    setShortcutInput('');
    setResizeInfo(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Sélection et validation / redimensionnement du fichier
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setErrorMessage(null);
    setSuccessMessage(null);
    setResizeInfo(null);
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const buffer = await file.arrayBuffer();

      // 1. Validation de la signature binaire (magic bytes)
      const sig = validateImageSignature(buffer);
      if (!sig.valid) {
        setErrorMessage(t.customEmoticons.invalidFormat);
        return;
      }

      const isGif = sig.detectedMime === 'image/gif' || file.type === 'image/gif';
      const MAX_STATIC_SIZE = 256 * 1024;
      const MAX_GIF_SIZE = 1024 * 1024;

      // 2. Chargement de l'image pour analyse des dimensions
      const localUrl = URL.createObjectURL(file);
      const img = new Image();
      img.src = localUrl;

      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Impossible de lire l'image."));
      });

      // 3. Gestion stricte des GIF animés (pas de redimensionnement pour ne pas figer/altérer l'animation)
      if (isGif) {
        URL.revokeObjectURL(localUrl);
        if (img.naturalWidth > 128 || img.naturalHeight > 128) {
          setErrorMessage(
            t.customEmoticons.gifDimensionsExceeded
              .replace('{width}', img.naturalWidth.toString())
              .replace('{height}', img.naturalHeight.toString())
          );
          return;
        }
        if (file.size > MAX_GIF_SIZE) {
          setErrorMessage(t.customEmoticons.gifSizeExceeded.replace('{size}', (file.size / 1024).toFixed(1)));
          return;
        }

        // GIF accepté tel quel
        const validGifUrl = URL.createObjectURL(file);
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        setSelectedFile(file);
        setFileBuffer(buffer);
        setPreviewUrl(validGifUrl);
        setImageMeta({
          width: img.naturalWidth,
          height: img.naturalHeight,
          isAnimated: true,
          mime: 'image/gif'
        });

        if (!shortcutInput) {
          const baseName = file.name.split('.')[0].toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
          if (baseName) setShortcutInput(`(${baseName})`);
        }
        return;
      }

      // 4. Gestion des images statiques (PNG, WebP, JPEG) avec redimensionnement automatique si nécessaire
      let finalBuffer = buffer;
      let finalFile = file;
      let finalWidth = img.naturalWidth;
      let finalHeight = img.naturalHeight;
      let finalMime = sig.detectedMime || file.type || 'image/png';
      let wasResized = false;

      if (img.naturalWidth > 128 || img.naturalHeight > 128) {
        const maxDim = 128;
        const ratio = Math.min(maxDim / img.naturalWidth, maxDim / img.naturalHeight);
        finalWidth = Math.round(img.naturalWidth * ratio);
        finalHeight = Math.round(img.naturalHeight * ratio);

        const canvas = document.createElement('canvas');
        canvas.width = finalWidth;
        canvas.height = finalHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error("Impossible d'initialiser le contexte canvas 2D.");
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, finalWidth, finalHeight);

        // Export en PNG pour préserver la transparence
        finalMime = (sig.detectedMime === 'image/webp') ? 'image/webp' : 'image/png';
        const resizedBlob = await new Promise<Blob | null>((res) => canvas.toBlob(res, finalMime, 0.95));
        if (!resizedBlob) throw new Error("Erreur lors de la génération de l'image redimensionnée.");

        finalBuffer = await resizedBlob.arrayBuffer();
        finalFile = new File(
          [resizedBlob],
          file.name.replace(/\.[^/.]+$/, "") + (finalMime === 'image/webp' ? '.webp' : '.png'),
          { type: finalMime }
        );
        wasResized = true;
      }

      URL.revokeObjectURL(localUrl);

      // Validation du poids final après redimensionnement
      if (finalFile.size > MAX_STATIC_SIZE) {
        setErrorMessage(
          t.customEmoticons.staticSizeExceeded.replace('{size}', (finalFile.size / 1024).toFixed(1))
        );
        return;
      }

      const newPreviewUrl = URL.createObjectURL(finalFile);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setSelectedFile(finalFile);
      setFileBuffer(finalBuffer);
      setPreviewUrl(newPreviewUrl);
      setImageMeta({
        width: finalWidth,
        height: finalHeight,
        isAnimated: false,
        mime: finalMime
      });

      if (wasResized) {
        setResizeInfo(
          t.customEmoticons.autoResized
            .replace('{from}', `${img.naturalWidth}x${img.naturalHeight}`)
            .replace('{to}', `${finalWidth}x${finalHeight}`)
            .replace('{size}', (finalFile.size / 1024).toFixed(1))
        );
      }

      if (!shortcutInput) {
        const baseName = file.name.split('.')[0].toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
        if (baseName) setShortcutInput(`(${baseName})`);
      }
    } catch (err: unknown) {
      console.error("Erreur traitement image:", err);
      setErrorMessage(t.customEmoticons.processingError);
    }
  };

  // Soumission et chiffrement E2EE
  const handleSaveEmoticon = async () => {
    if (!selectedFile || !fileBuffer || !imageMeta) {
      setErrorMessage(t.customEmoticons.selectValidImage);
      return;
    }

    const shortcut = shortcutInput.trim();
    const shortcutRegex = /^[\w\-():;@#!?*~[\]{}]{2,32}$/;
    if (shortcut.length < 2 || shortcut.length > 32 || !shortcutRegex.test(shortcut)) {
      setErrorMessage(t.customEmoticons.invalidShortcut);
      return;
    }

    // Vérifier les doublons
    if (myEmoticons.some(e => e.shortcut.toLowerCase() === shortcut.toLowerCase())) {
      setErrorMessage(t.customEmoticons.duplicateShortcut);
      return;
    }

    setIsUploading(true);
    setErrorMessage(null);

    try {
      // 1. Chiffrement local avec AES-GCM 256 bits et IV unique aléatoire
      const { encryptedBlob, keyBase64 } = await encryptCustomEmoticon(fileBuffer);

      // 2. Envoi du blob chiffré au serveur (Zero-Knowledge)
      const formData = new FormData();
      formData.append('file', encryptedBlob, 'encrypted_asset.bin');
      formData.append('shortcut', shortcut);
      formData.append('mimeType', imageMeta.mime);
      formData.append('width', imageMeta.width.toString());
      formData.append('height', imageMeta.height.toString());
      formData.append('isAnimated', imageMeta.isAnimated ? '1' : '0');

      const res = await axios.post('/api/emoticons/custom/upload', formData, {
        headers: {
          Authorization: `Bearer ${userToken}`,
          'Content-Type': 'multipart/form-data'
        }
      });

      if (!res.data.success) {
        throw new Error(res.data.error || "Erreur serveur lors de l'enregistrement.");
      }

      const serverEmoticon = res.data.emoticon;

      // 3. Sauvegarde locale de la clé symétrique dans le trousseau IndexedDB
      const record: MyEmoticonRecord = {
        id: serverEmoticon.id,
        shortcut: serverEmoticon.shortcut,
        keyBase64,
        mimeType: serverEmoticon.mime_type,
        width: serverEmoticon.width,
        height: serverEmoticon.height,
        isAnimated: serverEmoticon.is_animated,
        createdAt: serverEmoticon.created_at
      };
      await CustomEmoticonsDB.saveMyEmoticon(record);

      // 4. Mettre en cache l'image déchiffrée localement
      const originalBlob = new Blob([fileBuffer], { type: imageMeta.mime });
      await CustomEmoticonsDB.saveCachedAsset(serverEmoticon.id, originalBlob, imageMeta.mime);

      setSuccessMessage(t.customEmoticons.createdSuccess.replace('{shortcut}', shortcut));
      resetForm();
      await loadEmoticons();
      onEmoticonsChange();
    } catch (err: unknown) {
      console.error("Erreur upload émoticône:", err);
      const axiosErr = err as { response?: { data?: { error?: string } }; message?: string };
      setErrorMessage(axiosErr.response?.data?.error || axiosErr.message || "Échec de l'enregistrement de l'émoticône.");
    } finally {
      setIsUploading(false);
    }
  };

  // Suppression d'une émoticône
  const handleDeleteEmoticon = async (id: string, shortcut: string) => {
    if (!window.confirm(t.customEmoticons.confirmDelete.replace('{shortcut}', shortcut))) {
      return;
    }

    try {
      await axios.delete(`/api/emoticons/custom/${id}`, {
        headers: { Authorization: `Bearer ${userToken}` }
      });

      await CustomEmoticonsDB.deleteMyEmoticon(id);
      await CustomEmoticonsDB.deleteMyEmoticonByShortcut(shortcut);
      setSuccessMessage(t.customEmoticons.deletedSuccess.replace('{shortcut}', shortcut));
      await loadEmoticons();
      onEmoticonsChange(shortcut);
    } catch (err) {
      console.error("Erreur suppression émoticône:", err);
      setErrorMessage(t.customEmoticons.deleteError);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="wlm-custom-emo-modal" onClick={e => e.stopPropagation()}>
        <div className="wlm-paste-modal-header">
          <div className="wlm-paste-title-area">
            <span className="wlm-paste-icon">✨</span>
            <span className="wlm-paste-title">{t.customEmoticons.title}</span>
          </div>
          <button type="button" className="win-close-btn" onClick={onClose} title={t.common.close}>✕</button>
        </div>

        <div className="wlm-custom-emo-body">
          {/* Section 1 : Formulaire d'ajout */}
          <div className="wlm-custom-emo-add-section">
            <div className="wlm-custom-emo-subtitle">{t.customEmoticons.addNewTitle}</div>
            
            <div className="wlm-custom-emo-form-row">
              <div className="wlm-custom-emo-preview-box">
                {previewUrl ? (
                  <img src={previewUrl} alt="Preview" className="wlm-custom-emo-thumb-preview" />
                ) : (
                  <span className="wlm-custom-emo-no-preview">{t.customEmoticons.preview}</span>
                )}
              </div>

              <div className="wlm-custom-emo-inputs">
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <input
                    type="file"
                    ref={fileInputRef}
                    accept="image/png,image/webp,image/gif,image/jpeg"
                    onChange={handleFileChange}
                    style={{ fontSize: '11px' }}
                  />
                  {selectedFile && (
                    <button type="button" className="win-btn" onClick={resetForm} style={{ fontSize: '10px' }}>
                      {t.customEmoticons.reset}
                    </button>
                  )}
                </div>

                <div className="wlm-custom-emo-hints">
                  {t.customEmoticons.formatsHint}
                </div>

                {imageMeta && (
                  <div className="wlm-custom-emo-meta-badge">
                    {imageMeta.width}x{imageMeta.height} px • {(selectedFile!.size / 1024).toFixed(1)} Ko {imageMeta.isAnimated && t.customEmoticons.animated}
                  </div>
                )}

                {resizeInfo && (
                  <div className="wlm-custom-emo-resized-badge">
                    ℹ️ {resizeInfo}
                  </div>
                )}

                <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <label style={{ fontSize: '11px', fontWeight: 'bold' }}>{t.customEmoticons.shortcutLabel}</label>
                  <input
                    type="text"
                    value={shortcutInput}
                    onChange={e => setShortcutInput(e.target.value)}
                    placeholder={t.customEmoticons.shortcutPlaceholder}
                    style={{ width: '130px', padding: '3px 6px', fontSize: '12px' }}
                    maxLength={32}
                  />
                  <button
                    type="button"
                    className="win-btn win-btn-primary"
                    onClick={handleSaveEmoticon}
                    disabled={isUploading || !selectedFile}
                  >
                    {isUploading ? t.customEmoticons.encrypting : t.common.save}
                  </button>
                </div>
              </div>
            </div>

            {errorMessage && (
              <div className="wlm-custom-emo-error">{errorMessage}</div>
            )}
            {successMessage && (
              <div className="wlm-custom-emo-success">{successMessage}</div>
            )}
          </div>

          {/* Section 2 : Liste des émoticônes de l'utilisateur */}
          <div className="wlm-custom-emo-list-section">
            <div className="wlm-custom-emo-subtitle">
              {t.customEmoticons.myCustomEmoticonsTitle.replace('{count}', myEmoticons.length.toString())}
            </div>

            {isLoading ? (
              <div style={{ padding: '20px', textAlign: 'center', fontSize: '11px', color: '#666' }}>
                {t.customEmoticons.loading}
              </div>
            ) : myEmoticons.length === 0 ? (
              <div className="wlm-custom-emo-empty">
                {t.customEmoticons.emptyHint.split('\n').map((line, idx) => (
                  <React.Fragment key={idx}>
                    {line}
                    {idx === 0 && <br />}
                  </React.Fragment>
                ))}
              </div>
            ) : (
              <div className="wlm-custom-emo-grid">
                {myEmoticons.map(emo => {
                  const url = emoticonUrls[emo.id];
                  return (
                    <div 
                      key={emo.id} 
                      className="wlm-custom-emo-item"
                      title={t.customEmoticons.clickToInsert.replace('{shortcut}', emo.shortcut)}
                      onClick={() => onSelectEmoticon && onSelectEmoticon(emo.shortcut)}
                    >
                      <div className="wlm-custom-emo-thumb-container">
                        {url ? (
                          <img src={url} alt={emo.shortcut} className="wlm-custom-emo-thumb" />
                        ) : (
                          <span style={{ fontSize: '10px', color: '#888' }}>...</span>
                        )}
                        {emo.isAnimated === 1 && (
                          <span className="wlm-custom-emo-gif-badge">GIF</span>
                        )}
                      </div>
                      <span className="wlm-custom-emo-shortcut">{emo.shortcut}</span>
                      <button
                        type="button"
                        className="wlm-custom-emo-del-btn"
                        title={t.common.delete}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteEmoticon(emo.id, emo.shortcut);
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="wlm-paste-modal-footer">
          <button type="button" className="win-btn" onClick={onClose}>
            {t.common.close}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CustomEmoticonsModal;
