import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { encryptCustomEmoticon, validateImageSignature } from '../utils/Security';
import CustomEmoticonsDB, { type MyEmoticonRecord } from '../utils/CustomEmoticonsDB';

interface CustomEmoticonsModalProps {
  isOpen: boolean;
  onClose: () => void;
  userToken?: string;
  onEmoticonsChange: () => void;
  onSelectEmoticon?: (shortcut: string) => void;
}

export const CustomEmoticonsModal: React.FC<CustomEmoticonsModalProps> = ({
  isOpen,
  onClose,
  userToken,
  onEmoticonsChange,
  onSelectEmoticon
}) => {
  const [myEmoticons, setMyEmoticons] = useState<MyEmoticonRecord[]>([]);
  const [emoticonUrls, setEmoticonUrls] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

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
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Sélection et validation stricte du fichier
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setErrorMessage(null);
    setSuccessMessage(null);
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const buffer = await file.arrayBuffer();

      // 1. Validation de la signature binaire (magic bytes)
      const sig = validateImageSignature(buffer);
      if (!sig.valid) {
        setErrorMessage("Format de fichier non reconnu. Veuillez choisir un fichier PNG, WebP, GIF ou JPEG valide.");
        return;
      }

      const isGif = sig.detectedMime === 'image/gif' || file.type === 'image/gif';

      // 2. Validation du poids strict (256 Ko statique, 1 Mo GIF)
      const MAX_STATIC_SIZE = 256 * 1024;
      const MAX_GIF_SIZE = 1024 * 1024;
      if (isGif && file.size > MAX_GIF_SIZE) {
        setErrorMessage(`Le GIF animé dépasse la taille maximale autorisée de 1 Mo (actuelle : ${(file.size / 1024).toFixed(1)} Ko).`);
        return;
      }
      if (!isGif && file.size > MAX_STATIC_SIZE) {
        setErrorMessage(`L'image statique dépasse la taille maximale autorisée de 256 Ko (actuelle : ${(file.size / 1024).toFixed(1)} Ko).`);
        return;
      }

      // 3. Validation des dimensions via chargement d'image
      const localUrl = URL.createObjectURL(file);
      const img = new Image();
      img.src = localUrl;

      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Impossible de lire l'image."));
      });

      if (img.naturalWidth > 128 || img.naturalHeight > 128) {
        URL.revokeObjectURL(localUrl);
        setErrorMessage(`L'image dépasse les dimensions maximales autorisées (128x128 px). Dimensions actuelles : ${img.naturalWidth}x${img.naturalHeight} px.`);
        return;
      }

      // Succès validation
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setSelectedFile(file);
      setFileBuffer(buffer);
      setPreviewUrl(localUrl);
      setImageMeta({
        width: img.naturalWidth,
        height: img.naturalHeight,
        isAnimated: isGif,
        mime: sig.detectedMime || file.type || 'image/png'
      });

      // Suggestion automatique de raccourci si vide
      if (!shortcutInput) {
        const baseName = file.name.split('.')[0].toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
        if (baseName) setShortcutInput(`(${baseName})`);
      }
    } catch (err: unknown) {
      console.error("Erreur lecture image:", err);
      setErrorMessage("Une erreur est survenue lors de l'analyse du fichier.");
    }
  };

  // Soumission et chiffrement E2EE
  const handleSaveEmoticon = async () => {
    if (!selectedFile || !fileBuffer || !imageMeta) {
      setErrorMessage("Veuillez sélectionner une image valide.");
      return;
    }

    const shortcut = shortcutInput.trim();
    const shortcutRegex = /^[\w\-():;@#!?*~[\]{}]{2,32}$/;
    if (shortcut.length < 2 || shortcut.length > 32 || !shortcutRegex.test(shortcut)) {
      setErrorMessage("Le raccourci doit contenir entre 2 et 32 caractères (ex: (monchat), :rock:, [star]).");
      return;
    }

    // Vérifier les doublons
    if (myEmoticons.some(e => e.shortcut.toLowerCase() === shortcut.toLowerCase())) {
      setErrorMessage("Vous possédez déjà une émoticône avec ce raccourci.");
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
      await CustomEmoticonsDB.saveCachedAsset(serverEmoticon.id, originalBlob, imageMeta.mime, keyBase64);

      setSuccessMessage(`Émoticône "${shortcut}" créée et chiffrée avec succès !`);
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
    if (!window.confirm(`Voulez-vous vraiment supprimer l'émoticône ${shortcut} ?`)) {
      return;
    }

    try {
      await axios.delete(`/api/emoticons/custom/${id}`, {
        headers: { Authorization: `Bearer ${userToken}` }
      });

      await CustomEmoticonsDB.deleteMyEmoticon(id);
      setSuccessMessage(`Émoticône "${shortcut}" supprimée.`);
      await loadEmoticons();
      onEmoticonsChange();
    } catch (err) {
      console.error("Erreur suppression émoticône:", err);
      setErrorMessage("Erreur lors de la suppression de l'émoticône.");
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="wlm-custom-emo-modal" onClick={e => e.stopPropagation()}>
        <div className="wlm-paste-modal-header">
          <div className="wlm-paste-title-area">
            <span className="wlm-paste-icon">✨</span>
            <span className="wlm-paste-title">Gestionnaire des émoticônes personnalisées (E2EE)</span>
          </div>
          <button type="button" className="win-close-btn" onClick={onClose} title="Fermer">✕</button>
        </div>

        <div className="wlm-custom-emo-body">
          {/* Section 1 : Formulaire d'ajout */}
          <div className="wlm-custom-emo-add-section">
            <div className="wlm-custom-emo-subtitle">Ajouter une nouvelle émoticône</div>
            
            <div className="wlm-custom-emo-form-row">
              <div className="wlm-custom-emo-preview-box">
                {previewUrl ? (
                  <img src={previewUrl} alt="Aperçu" className="wlm-custom-emo-thumb-preview" />
                ) : (
                  <span className="wlm-custom-emo-no-preview">Aperçu</span>
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
                      Réinitialiser
                    </button>
                  )}
                </div>

                <div className="wlm-custom-emo-hints">
                  Formats : PNG, WebP (≤ 256 Ko), GIF (≤ 1 Mo) • Max 128x128 px
                </div>

                {imageMeta && (
                  <div className="wlm-custom-emo-meta-badge">
                    {imageMeta.width}x{imageMeta.height} px • {(selectedFile!.size / 1024).toFixed(1)} Ko {imageMeta.isAnimated && '• Animé'}
                  </div>
                )}

                <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <label style={{ fontSize: '11px', fontWeight: 'bold' }}>Raccourci :</label>
                  <input
                    type="text"
                    value={shortcutInput}
                    onChange={e => setShortcutInput(e.target.value)}
                    placeholder="Ex: (chat)"
                    style={{ width: '130px', padding: '3px 6px', fontSize: '12px' }}
                    maxLength={32}
                  />
                  <button
                    type="button"
                    className="win-btn win-btn-primary"
                    onClick={handleSaveEmoticon}
                    disabled={isUploading || !selectedFile}
                  >
                    {isUploading ? 'Chiffrement...' : 'Enregistrer'}
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
              Vos émoticônes personnalisées ({myEmoticons.length} / 100)
            </div>

            {isLoading ? (
              <div style={{ padding: '20px', textAlign: 'center', fontSize: '11px', color: '#666' }}>
                Chargement de vos émoticônes...
              </div>
            ) : myEmoticons.length === 0 ? (
              <div className="wlm-custom-emo-empty">
                Vous n'avez pas encore d'émoticônes personnalisées.<br />
                Ajoutez-en une ci-dessus pour la partager en toute confidentialité !
              </div>
            ) : (
              <div className="wlm-custom-emo-grid">
                {myEmoticons.map(emo => {
                  const url = emoticonUrls[emo.id];
                  return (
                    <div 
                      key={emo.id} 
                      className="wlm-custom-emo-item"
                      title={`Cliquer pour insérer ${emo.shortcut}`}
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
                        title="Supprimer"
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
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
};

export default CustomEmoticonsModal;
