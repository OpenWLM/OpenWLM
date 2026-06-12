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

/**
 * Génère une paire de clés RSA-OAEP pour le chiffrement E2EE
 */
export const generateKeyPair = async () => {
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
export const encryptMessagePayload = async (payloadObj: any, receiverPubKeyJwk: any, senderPubKeyJwk: any) => {
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

/**
 * Déchiffre un payload de message reçu
 */
export const decryptMessagePayload = async (encryptedData: any, myPrivateKeyJwk: any, isSender: boolean) => {
  try {
    // 1. Importer notre clé privée
    const myKey = await window.crypto.subtle.importKey('jwk', myPrivateKeyJwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);

    // 2. Sélectionner la clé AES chiffrée nous concernant
    const encryptedAesKeyBase64 = isSender ? encryptedData.keySender : encryptedData.keyReceiver;
    if (!encryptedAesKeyBase64) return null;

    const encryptedAesKey = base64ToArrayBuffer(encryptedAesKeyBase64);

    // 3. Déchiffrer la clé AES avec RSA
    let rawAesKey;
    try {
      rawAesKey = await window.crypto.subtle.decrypt({ name: 'RSA-OAEP' }, myKey, encryptedAesKey);
    } catch (e) {
      console.warn("Échec du déchiffrement RSA de la clé AES - Discordance de clé ?");
      return null;
    }

    // 4. Importer la clé AES et déchiffrer le payload final
    const aesKey = await window.crypto.subtle.importKey('raw', rawAesKey, { name: 'AES-GCM' }, false, ['decrypt']);

    const iv = base64ToArrayBuffer(encryptedData.iv);
    const payload = base64ToArrayBuffer(encryptedData.payload);

    const decryptedPayload = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv }, aesKey, payload);
    const decodedPayload = new TextDecoder().decode(decryptedPayload);

    return JSON.parse(decodedPayload);
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
 * Dérive une clé AES à partir d'un mot de passe utilisateur (PBKDF2)
 * Utilisé pour protéger le coffre-fort de clés privées.
 */
export const deriveKeyFromPassword = async (password: string, salt: Uint8Array) => {
  const enc = new TextEncoder();
  const keyMaterial = await window.crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits", "deriveKey"]
  );
  
  return window.crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as any,
      iterations: 100000, // Nombre d'itérations élevé pour la sécurité
      hash: "SHA-256"
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
};

/**
 * Chiffre la clé privée E2EE avec le mot de passe utilisateur
 * pour un stockage sécurisé sur le serveur (Vault)
 */
export const encryptPrivateKeyVault = async (privateKeyJwk: any, password: string) => {
  const salt = window.crypto.getRandomValues(new Uint8Array(16));
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await deriveKeyFromPassword(password, salt);

  const enc = new TextEncoder();
  const encodedJwk = enc.encode(JSON.stringify(privateKeyJwk));

  const encrypted = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, encodedJwk);

  return {
    encryptedKeyBase64: arrayBufferToBase64(encrypted),
    saltBase64: arrayBufferToBase64(salt.buffer || salt),
    ivBase64: arrayBufferToBase64(iv.buffer || iv)
  };
};

/**
 * Déchiffre la clé privée à partir du mot de passe
 */
export const decryptPrivateKeyVault = async (encryptedKeyBase64: string, saltBase64: string, ivBase64: string, password: string) => {
  try {
    const salt = new Uint8Array(base64ToArrayBuffer(saltBase64));
    const iv = new Uint8Array(base64ToArrayBuffer(ivBase64));
    const encryptedKey = base64ToArrayBuffer(encryptedKeyBase64);

    const aesKey = await deriveKeyFromPassword(password, salt);
    const decrypted = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv }, aesKey, encryptedKey);

    const dec = new TextDecoder();
    return JSON.parse(dec.decode(decrypted));
  } catch (e) {
    console.error("Échec du déchiffrement du coffre-fort (Vault)", e);
    return null;
  }
};

/**
 * Chiffre des données pour le stockage local (IndexedDB)
 * Utilise la clé publique de l'utilisateur pour une sécurité maximale.
 */
export const encryptForLocal = async (dataObj: any, publicKeyJwk: any) => {
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
 */
export const decryptFromLocal = async (localData: any, privateKeyJwk: any) => {
  try {
    const privKey = await window.crypto.subtle.importKey('jwk', privateKeyJwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
    const encryptedKey = base64ToArrayBuffer(localData.key);
    const rawAesKey = await window.crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privKey, encryptedKey);
    const aesKey = await window.crypto.subtle.importKey('raw', rawAesKey, { name: 'AES-GCM' }, false, ['decrypt']);
    const iv = base64ToArrayBuffer(localData.iv);
    const data = base64ToArrayBuffer(localData.data);
    const decrypted = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, data);
    return JSON.parse(new TextDecoder().decode(decrypted));
  } catch (e) {
    console.warn("Échec du déchiffrement local.");
    return null;
  }
};
