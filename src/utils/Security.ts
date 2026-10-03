/**
 * UTILITAIRES DE SÉCURITÉ ET CHIFFREMENT (E2EE)
 * Ce module gère le chiffrement de bout en bout (End-to-End Encryption)
 * ainsi que le coffre-fort local des clés privées.
 */

/**
 * Convertit un ArrayBuffer en chaîne Base64
 */
export const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
};

/**
 * Convertit une chaîne Base64 en ArrayBuffer
 */
export const base64ToArrayBuffer = (base64: string) => {
  const binary_string = window.atob(base64);
  const len = binary_string.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary_string.charCodeAt(i);
  }
  return bytes.buffer;
};

export interface KeyPairJwk {
  publicKeyJwk: JsonWebKey;
  privateKeyJwk: JsonWebKey;
}

export interface EncryptedMessagePayload {
  iv: string;
  payload: string;
  keyReceiver: string;
  keySender: string;
}

export interface VaultData {
  encryptedKeyBase64: string;
  ivBase64: string;
  saltBase64?: string;
}

export interface ZeroKnowledgeKeys {
  authKeyHex: string;
  vaultKey: CryptoKey;
}

export interface LocalEncryptedData {
  iv: string;
  data: string;
  key: string;
}

/**
 * Génère une paire de clés RSA-OAEP pour le chiffrement E2EE
 */
export const generateKeyPair = async (): Promise<KeyPairJwk> => {
  const keyPair = await window.crypto.subtle.generateKey(
    { 
      name: 'RSA-OAEP', 
      modulusLength: 2048, 
      publicExponent: new Uint8Array([1, 0, 1]), 
      hash: 'SHA-256' 
    },
    true,
    ['encrypt', 'decrypt']
  );
  
  // Export au format JWK (JSON Web Key) pour le stockage
  const publicKeyJwk = await window.crypto.subtle.exportKey('jwk', keyPair.publicKey);
  const privateKeyJwk = await window.crypto.subtle.exportKey('jwk', keyPair.privateKey);
  
  return { publicKeyJwk, privateKeyJwk };
};

/**
 * Chiffre un message pour le destinataire ET l'expéditeur (pour l'historique)
 * Utilise AES-GCM pour le contenu et RSA-OAEP pour protéger la clé AES.
 */
export const encryptMessagePayload = async (
  payloadObj: unknown, 
  receiverPubKeyJwk: JsonWebKey, 
  senderPubKeyJwk: JsonWebKey
): Promise<EncryptedMessagePayload> => {
  // 1. Générer une clé AES-GCM aléatoire pour ce message unique
  const aesKey = await window.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  
  // 2. Chiffrer le payload avec AES
  const encodedPayload = new TextEncoder().encode(JSON.stringify(payloadObj));
  const encryptedPayload = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, encodedPayload);
  
  // 3. Exporter la clé AES brute pour pouvoir la chiffrer avec RSA
  const rawAesKey = await window.crypto.subtle.exportKey('raw', aesKey);
  
  // 4. Importer les clés publiques RSA
  const receiverKey = await window.crypto.subtle.importKey('jwk', receiverPubKeyJwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const senderKey = await window.crypto.subtle.importKey('jwk', senderPubKeyJwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  
  // 5. Chiffrer la clé AES avec les deux clés RSA (Destinataire et Expéditeur)
  const encryptedKeyReceiver = await window.crypto.subtle.encrypt({ name: 'RSA-OAEP' }, receiverKey, rawAesKey);
  const encryptedKeySender = await window.crypto.subtle.encrypt({ name: 'RSA-OAEP' }, senderKey, rawAesKey);
  
  return {
    iv: arrayBufferToBase64(iv.buffer),
    payload: arrayBufferToBase64(encryptedPayload),
    keyReceiver: arrayBufferToBase64(encryptedKeyReceiver),
    keySender: arrayBufferToBase64(encryptedKeySender)
  };
};

export type PrivateKeySource = JsonWebKey | CryptoKey;

/**
 * Importe un JWK de clé privée RSA en tant que CryptoKey native.
 * Par défaut, extractable est mis à false pour empêcher toute exfiltration hors du navigateur.
 */
export const importPrivateCryptoKey = async (
  privateKeyJwk: JsonWebKey,
  extractable: boolean = false
): Promise<CryptoKey> => {
  return await window.crypto.subtle.importKey(
    'jwk',
    privateKeyJwk,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    extractable,
    ['decrypt']
  );
};

export const isPrivateKeyCryptoKey = (key: unknown): key is CryptoKey =>
  (typeof CryptoKey !== 'undefined' && key instanceof CryptoKey) ||
  (typeof key === 'object' && key !== null && 'type' in key && (key as { type: string }).type === 'private');

/**
 * Déchiffre un payload de message reçu.
 * Accepte indifféremment un JsonWebKey ou une CryptoKey native (déjà importée/non extractible).
 */
export const decryptMessagePayload = async <T = Record<string, unknown>>(
  encryptedData: EncryptedMessagePayload, 
  myPrivateKey: PrivateKeySource, 
  isSender: boolean
): Promise<T | null> => {
  try {
    // 1. Obtenir la CryptoKey (réutilisation directe si déjà une CryptoKey)
    const myKey: CryptoKey = isPrivateKeyCryptoKey(myPrivateKey)
      ? myPrivateKey
      : await window.crypto.subtle.importKey('jwk', myPrivateKey as JsonWebKey, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);

    // 2. Sélectionner la clé AES chiffrée nous concernant
    const encryptedAesKeyBase64 = isSender ? encryptedData.keySender : encryptedData.keyReceiver;
    if (!encryptedAesKeyBase64) return null;

    const encryptedAesKey = base64ToArrayBuffer(encryptedAesKeyBase64);

    // 3. Déchiffrer la clé AES avec RSA
    let rawAesKey: ArrayBuffer;
    try {
      rawAesKey = await window.crypto.subtle.decrypt({ name: 'RSA-OAEP' }, myKey, encryptedAesKey);
    } catch {
      console.warn("Échec du déchiffrement RSA de la clé AES - Discordance de clé ?");
      return null;
    }

    // 4. Importer la clé AES et déchiffrer le payload final
    const aesKey = await window.crypto.subtle.importKey('raw', rawAesKey, { name: 'AES-GCM' }, false, ['decrypt']);

    const iv = base64ToArrayBuffer(encryptedData.iv);
    const payload = base64ToArrayBuffer(encryptedData.payload);

    const decryptedPayload = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv }, aesKey, payload);
    const decodedPayload = new TextDecoder().decode(decryptedPayload);

    return JSON.parse(decodedPayload) as T;
  } catch (e) {
    console.error("Échec global du déchiffrement E2EE", e);
    return null;
  }
};

/**
 * Sanitisation simple contre les injections HTML/XSS
 */
export const sanitize = (str: string) => {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
};

/**
 * DÉRIVATION STRICTEMENT ZERO-KNOWLEDGE (Web Crypto API native)
 * Le mot de passe brut NE QUITTE JAMAIS le navigateur de l'utilisateur.
 * - PBKDF2-HMAC-SHA256 (600 000 itérations) -> MasterKey (256 bits)
 * - HKDF-SHA256 (RFC 5869, sel fixe 32 octets de zéros) :
 *   * info: 'openwlm-auth-key-v1' -> authKeyHex (256 bits en hex pour transport HTTP)
 *   * info: 'openwlm-vault-encryption-key-v1' -> vaultKey (CryptoKey AES-GCM 256 bits non exportable)
 */
export const deriveZeroKnowledgeKeys = async (
  username: string, 
  masterPassword: string
): Promise<ZeroKnowledgeKeys> => {
  const enc = new TextEncoder();
  const salt = enc.encode('openwlm-salt:' + username.trim().toLowerCase());

  // 1. Importation du mot de passe brut en tant que matériel de clé PBKDF2
  const passwordMaterial = await window.crypto.subtle.importKey(
    'raw',
    enc.encode(masterPassword),
    { name: 'PBKDF2' },
    false,
    ['deriveBits', 'deriveKey']
  );

  // 2. Dérivation de la MasterKey (600 000 itérations PBKDF2-HMAC-SHA256)
  const masterKeyBits = await window.crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: 600000,
      hash: 'SHA-256'
    },
    passwordMaterial,
    256 // 32 octets (256 bits)
  );

  // 3. Importation de la MasterKey pour HKDF
  const masterCryptoKey = await window.crypto.subtle.importKey(
    'raw',
    masterKeyBits,
    { name: 'HKDF' },
    false,
    ['deriveBits', 'deriveKey']
  );

  const fixedHkdfSalt = new Uint8Array(32); // Sel fixe 32 octets à zéro (RFC 5869)

  // 4. Dérivation de authKeyHex (pour transport HTTP)
  const authKeyBits = await window.crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: fixedHkdfSalt,
      info: enc.encode('openwlm-auth-key-v1')
    },
    masterCryptoKey,
    256
  );

  const authKeyHex = Array.from(new Uint8Array(authKeyBits))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // 5. Dérivation de vaultKey (CryptoKey AES-GCM 256 bits non exportable)
  const vaultKey = await window.crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: fixedHkdfSalt,
      info: enc.encode('openwlm-vault-encryption-key-v1')
    },
    masterCryptoKey,
    { name: 'AES-GCM', length: 256 },
    false, // NON EXPORTABLE pour une sécurité maximale en mémoire
    ['encrypt', 'decrypt']
  );

  return { authKeyHex, vaultKey };
};

/**
 * Chiffre la clé privée RSA avec vaultKey en AES-GCM 256 bits (IV 12 octets aléatoires)
 */
export const encryptPrivateKeyVault = async (
  privateKeyJwk: JsonWebKey, 
  vaultKey: CryptoKey
): Promise<VaultData> => {
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const encodedJwk = enc.encode(JSON.stringify(privateKeyJwk));

  const encrypted = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv }, vaultKey, encodedJwk);

  return {
    encryptedKeyBase64: arrayBufferToBase64(encrypted),
    ivBase64: arrayBufferToBase64(iv.buffer)
  };
};

/**
 * Déchiffre la clé privée RSA à partir de vaultKey en AES-GCM
 */
export const decryptPrivateKeyVault = async (
  encryptedKeyBase64: string, 
  ivBase64: string, 
  vaultKey: CryptoKey
): Promise<JsonWebKey | null> => {
  try {
    const iv = new Uint8Array(base64ToArrayBuffer(ivBase64));
    const encryptedKey = base64ToArrayBuffer(encryptedKeyBase64);

    const decrypted = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv }, vaultKey, encryptedKey);
    const dec = new TextDecoder();
    return JSON.parse(dec.decode(decrypted)) as JsonWebKey;
  } catch (e) {
    console.error("Échec du déchiffrement du coffre-fort (Vault) : clé incorrecte ou données altérées.", e);
    return null;
  }
};

/**
 * Chiffre des données pour le stockage local (IndexedDB)
 * Utilise la clé publique de l'utilisateur pour une sécurité maximale.
 */
export const encryptForLocal = async (dataObj: unknown, publicKeyJwk: JsonWebKey): Promise<LocalEncryptedData> => {
  const aesKey = await window.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(dataObj));
  const encrypted = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, encoded);
  const rawAesKey = await window.crypto.subtle.exportKey('raw', aesKey);
  const pubKey = await window.crypto.subtle.importKey('jwk', publicKeyJwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const encryptedKey = await window.crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pubKey, rawAesKey);
  
  return {
    iv: arrayBufferToBase64(iv.buffer),
    data: arrayBufferToBase64(encrypted),
    key: arrayBufferToBase64(encryptedKey)
  };
};

/**
 * Déchiffre des données depuis le stockage local
 * Accepte indifféremment un JsonWebKey ou une CryptoKey native.
 */
export const decryptFromLocal = async <T = unknown>(localData: LocalEncryptedData, privateKey: PrivateKeySource): Promise<T | null> => {
  try {
    const privKey: CryptoKey = isPrivateKeyCryptoKey(privateKey)
      ? privateKey
      : await window.crypto.subtle.importKey('jwk', privateKey as JsonWebKey, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
    const encryptedKey = base64ToArrayBuffer(localData.key);
    const rawAesKey = await window.crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privKey, encryptedKey);
    const aesKey = await window.crypto.subtle.importKey('raw', rawAesKey, { name: 'AES-GCM' }, false, ['decrypt']);
    const iv = base64ToArrayBuffer(localData.iv);
    const data = base64ToArrayBuffer(localData.data);
    const decrypted = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, data);
    return JSON.parse(new TextDecoder().decode(decrypted)) as T;
  } catch {
    console.warn("Échec du déchiffrement local.");
    return null;
  }
};

export interface EncryptedFileKeys {
  iv: string;
  keyReceiver: string;
  keySender: string;
}

/**
 * Chiffre un fichier binaire (ArrayBuffer) de bout en bout (E2EE)
 * Génère une clé AES-GCM 256 bits aléatoire et la protège par RSA-OAEP avec les clés de l'expéditeur et du destinataire.
 */
export const encryptFileBinary = async (
  fileBuffer: ArrayBuffer,
  receiverPubKeyJwk: JsonWebKey,
  senderPubKeyJwk: JsonWebKey
): Promise<{ encryptedBlob: Blob; fileKeys: EncryptedFileKeys }> => {
  // 1. Clé AES-GCM 256 bits unique pour ce fichier
  const aesKey = await window.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const iv = window.crypto.getRandomValues(new Uint8Array(12));

  // 2. Chiffrer le contenu binaire du fichier
  const encryptedBuffer = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, fileBuffer);

  // 3. Exporter la clé AES brute et la chiffrer avec les clés publiques RSA de chacun
  const rawAesKey = await window.crypto.subtle.exportKey('raw', aesKey);
  const receiverKey = await window.crypto.subtle.importKey('jwk', receiverPubKeyJwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const senderKey = await window.crypto.subtle.importKey('jwk', senderPubKeyJwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);

  const encryptedKeyReceiver = await window.crypto.subtle.encrypt({ name: 'RSA-OAEP' }, receiverKey, rawAesKey);
  const encryptedKeySender = await window.crypto.subtle.encrypt({ name: 'RSA-OAEP' }, senderKey, rawAesKey);

  return {
    encryptedBlob: new Blob([encryptedBuffer], { type: 'application/octet-stream' }),
    fileKeys: {
      iv: arrayBufferToBase64(iv.buffer),
      keyReceiver: arrayBufferToBase64(encryptedKeyReceiver),
      keySender: arrayBufferToBase64(encryptedKeySender)
    }
  };
};

/**
 * Déchiffre un fichier binaire reçu depuis le serveur via la clé privée de l'utilisateur (RSA)
 * Accepte indifféremment un JsonWebKey ou une CryptoKey native.
 */
export const decryptFileBinary = async (
  encryptedBuffer: ArrayBuffer,
  fileKeys: EncryptedFileKeys,
  myPrivateKey: PrivateKeySource,
  isSender: boolean
): Promise<ArrayBuffer | null> => {
  try {
    const myKey: CryptoKey = isPrivateKeyCryptoKey(myPrivateKey)
      ? myPrivateKey
      : await window.crypto.subtle.importKey('jwk', myPrivateKey as JsonWebKey, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
    const encryptedAesKeyBase64 = isSender ? fileKeys.keySender : fileKeys.keyReceiver;
    if (!encryptedAesKeyBase64) return null;

    const encryptedAesKey = base64ToArrayBuffer(encryptedAesKeyBase64);
    const rawAesKey = await window.crypto.subtle.decrypt({ name: 'RSA-OAEP' }, myKey, encryptedAesKey);

    const aesKey = await window.crypto.subtle.importKey('raw', rawAesKey, { name: 'AES-GCM' }, false, ['decrypt']);
    const iv = base64ToArrayBuffer(fileKeys.iv);

    return await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, encryptedBuffer);
  } catch (err) {
    console.error("Échec du déchiffrement du fichier:", err);
    return null;
  }
};

/**
 * Validation de la signature binaire (magic bytes) des images
 */
export const validateImageSignature = (buffer: ArrayBuffer): { valid: boolean; detectedMime?: string } => {
  if (buffer.byteLength < 12) return { valid: false };
  const bytes = new Uint8Array(buffer.slice(0, 12));
  // PNG: 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
    return { valid: true, detectedMime: 'image/png' };
  }
  // JPEG: FF D8 FF
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
    return { valid: true, detectedMime: 'image/jpeg' };
  }
  // GIF: 47 49 46 38 (GIF87a / GIF89a)
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return { valid: true, detectedMime: 'image/gif' };
  }
  // WEBP: 52 49 46 46 (RIFF) ... 57 45 42 50 (WEBP)
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return { valid: true, detectedMime: 'image/webp' };
  }
  return { valid: false };
};

/**
 * Chiffre un asset d'émoticône personnalisée avec AES-GCM 256 bits.
 * Chaque appel génère un IV unique aléatoire de 12 octets préfixé au blob.
 * Format du blob : [12 octets IV] + [Données chiffrées + Tag d'authentification GCM]
 */
export const encryptCustomEmoticon = async (
  imageBuffer: ArrayBuffer
): Promise<{ encryptedBlob: Blob; keyBase64: string }> => {
  const key = await window.crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );

  const iv = window.crypto.getRandomValues(new Uint8Array(12));

  const ciphertext = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    imageBuffer
  );

  const combined = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.byteLength);

  const encryptedBlob = new Blob([combined], { type: 'application/octet-stream' });
  const rawKey = await window.crypto.subtle.exportKey('raw', key);
  const keyBase64 = arrayBufferToBase64(rawKey);

  return { encryptedBlob, keyBase64 };
};

/**
 * Déchiffre un asset d'émoticône personnalisée avec sa clé AES-256 (en base64).
 * Extrait les 12 premiers octets (IV) et déchiffre le reste.
 */
export const decryptCustomEmoticon = async (
  encryptedBuffer: ArrayBuffer,
  keyBase64: string,
  mimeType: string = 'image/png'
): Promise<Blob | null> => {
  try {
    if (encryptedBuffer.byteLength <= 12) {
      throw new Error("Blob chiffré invalide ou incomplet.");
    }

    const iv = new Uint8Array(encryptedBuffer.slice(0, 12));
    const ciphertext = encryptedBuffer.slice(12);

    const rawKey = base64ToArrayBuffer(keyBase64);
    const key = await window.crypto.subtle.importKey(
      'raw',
      rawKey,
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );

    const decrypted = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
    );

    return new Blob([decrypted], { type: mimeType });
  } catch (err) {
    console.error("Échec du déchiffrement de l'émoticône personnalisée:", err);
    return null;
  }
};


