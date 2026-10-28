/**
 * Primitives du verrouillage des clés par l'appareil (cf. DeviceLock.ts) : dérivation de la
 * clé de scellement et scellement / ouverture du JWK de la clé privée. Web Crypto seulement,
 * sans dépendance au navigateur ni au pont Android : testées sous Node
 * (tests/test_device_lock.js).
 */

export type DeviceLockMethod = 'webauthn' | 'android';

/** Clé privée scellée, telle que rangée dans le coffre d'appareil (E2EEKeyStorage). */
export interface ProtectedKeyBlob {
  version: 1;
  method: DeviceLockMethod;
  /** WebAuthn : identifiant de la passkey ; Android : secret chiffré par le Keystore. */
  handle: string;
  /** Sel du PRF (WebAuthn) et de la dérivation HKDF (base64, 32 octets). */
  salt: string;
  iv: string;
  /** JWK de la clé privée, chiffré AES-GCM. */
  ciphertext: string;
}

const HKDF_INFO = 'openwlm-device-lock-v1';
const subtle = () => globalThis.crypto.subtle;
export const randomBytes = (n: number): Uint8Array => globalThis.crypto.getRandomValues(new Uint8Array(n));

export const bytesToBase64 = (bytes: ArrayBuffer | Uint8Array): string => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.byteLength; i++) binary += String.fromCharCode(view[i]);
  return globalThis.btoa(binary);
};

export const base64ToBytes = (base64: string): Uint8Array => {
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

/** Clé AES-GCM 256 (non exportable) dérivée du secret rendu par l'appareil. */
export const deriveWrapKey = async (secret: Uint8Array, salt: Uint8Array): Promise<CryptoKey> => {
  const base = await subtle().importKey('raw', secret as BufferSource, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: new TextEncoder().encode(HKDF_INFO) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
};

export const sealPrivateJwk = async (privateJwk: JsonWebKey, secret: Uint8Array, salt: Uint8Array): Promise<{ salt: string; iv: string; ciphertext: string }> => {
  const key = await deriveWrapKey(secret, salt);
  const iv = randomBytes(12);
  const ciphertext = await subtle().encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, new TextEncoder().encode(JSON.stringify(privateJwk)));
  return { salt: bytesToBase64(salt), iv: bytesToBase64(iv), ciphertext: bytesToBase64(ciphertext) };
};

/** Null si le secret n'est pas le bon (ou le scellé altéré). */
export const openPrivateJwk = async (blob: Pick<ProtectedKeyBlob, 'salt' | 'iv' | 'ciphertext'>, secret: Uint8Array): Promise<JsonWebKey | null> => {
  try {
    const key = await deriveWrapKey(secret, base64ToBytes(blob.salt));
    const plain = await subtle().decrypt({ name: 'AES-GCM', iv: base64ToBytes(blob.iv) as BufferSource }, key, base64ToBytes(blob.ciphertext) as BufferSource);
    const jwk = JSON.parse(new TextDecoder().decode(plain));
    return jwk && typeof jwk === 'object' && typeof jwk.d === 'string' ? (jwk as JsonWebKey) : null;
  } catch {
    return null;
  }
};

/** Un scellé bien formé (champs présents, base64 valide). */
export const isProtectedKeyBlob = (v: unknown): v is ProtectedKeyBlob => {
  if (!v || typeof v !== 'object') return false;
  const b = v as Record<string, unknown>;
  if (b.version !== 1 || (b.method !== 'webauthn' && b.method !== 'android')) return false;
  for (const f of ['handle', 'salt', 'iv', 'ciphertext']) {
    if (typeof b[f] !== 'string' || !(b[f] as string)) return false;
    try { globalThis.atob(b[f] as string); } catch { return false; }
  }
  return true;
};
