/**
 * VERROUILLAGE DES CLÉS PAR L'APPAREIL (Windows Hello, Touch ID, empreinte / code Android)
 *
 * Sans cette protection, « Mémoriser mes clés » garde la clé privée en IndexedDB sous forme de
 * CryptoKey non exportable : impossible à copier, mais utilisable par quiconque ouvre la
 * session du système d'exploitation. Ici, la clé privée (JWK) est chiffrée AU REPOS avec une
 * clé AES dérivée d'un secret que l'appareil ne rend qu'après authentification de son
 * propriétaire :
 *  - ordinateur : passkey WebAuthn de l'authentificateur de la plateforme (Windows Hello,
 *    Touch ID…) avec l'extension PRF : le secret est calculé par l'authentificateur (TPM /
 *    enclave), lié à la passkey et au site, et n'existe qu'après visage, empreinte ou code ;
 *  - app Android : secret aléatoire chiffré par une clé AES du Keystore matériel qui exige une
 *    authentification de l'utilisateur (empreinte, visage ou code du téléphone).
 * Une copie du profil du navigateur (ou des données de l'app) ne sert donc à rien sans
 * l'appareil et son propriétaire. Le coffre chiffré par le mot de passe reste sur le serveur :
 * sans l'appareil, on se reconnecte avec le mot de passe.
 *
 * Ce que cela ne couvre pas : un logiciel malveillant actif pendant que l'app est déverrouillée
 * (la clé est alors en mémoire, non exportable comme avant).
 */
import { hasNativeMethod, isNativeApp, nativeDeviceSecretCreate, nativeDeviceSecretUnlock } from './platform';
import {
  base64ToBytes, bytesToBase64, openPrivateJwk, randomBytes, sealPrivateJwk,
  type DeviceLockMethod, type ProtectedKeyBlob
} from './deviceLockCrypto';

export type { DeviceLockMethod, ProtectedKeyBlob } from './deviceLockCrypto';

export type DeviceLockFailure = 'cancelled' | 'unsupported' | 'invalidated' | 'failed';

export class DeviceLockError extends Error {
  readonly reason: DeviceLockFailure;
  constructor(reason: DeviceLockFailure, message?: string) {
    super(message || reason);
    this.name = 'DeviceLockError';
    this.reason = reason;
  }
}

export const deviceLockFailure = (err: unknown): DeviceLockFailure =>
  err instanceof DeviceLockError ? err.reason : 'failed';

// --- WebAuthn (Windows Hello, Touch ID…) --------------------------------------------------

type PrfExtensionResults = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } };

const webauthnFailure = (err: unknown): DeviceLockError => {
  const name = (err as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'AbortError') return new DeviceLockError('cancelled');
  if (name === 'NotSupportedError' || name === 'SecurityError') return new DeviceLockError('unsupported', String(err));
  return new DeviceLockError('failed', String(err));
};

/** Secret PRF pour cette passkey et ce sel (demande visage, empreinte ou code). */
const webauthnSecret = async (credentialId: Uint8Array, salt: Uint8Array): Promise<Uint8Array> => {
  let assertion: Credential | null;
  try {
    assertion = await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(32) as BufferSource,
        rpId: location.hostname,
        allowCredentials: [{ type: 'public-key', id: credentialId as BufferSource, transports: ['internal'] }],
        userVerification: 'required',
        timeout: 120000,
        extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs
      }
    });
  } catch (err) {
    throw webauthnFailure(err);
  }
  const results = (assertion as PublicKeyCredential | null)?.getClientExtensionResults() as PrfExtensionResults | undefined;
  const secret = results?.prf?.results?.first;
  if (!secret) throw new DeviceLockError('unsupported', 'PRF non évalué');
  return new Uint8Array(secret);
};

/** L'authentificateur de la plateforme (Hello, Touch ID…) est là et vérifie l'utilisateur. */
const webauthnAvailable = async (): Promise<boolean> => {
  try {
    if (typeof PublicKeyCredential === 'undefined' || !navigator.credentials?.create) return false;
    if (!window.isSecureContext) return false;
    // Adresse IP : WebAuthn refuse (identifiant de partie utilisatrice invalide)
    if (/^[\d.]+$|^\[/.test(location.hostname)) return false;
    const caps = await (PublicKeyCredential as unknown as { getClientCapabilities?: () => Promise<Record<string, boolean>> }).getClientCapabilities?.();
    if (caps && caps['extension:prf'] === false) return false;
    if (caps && caps.userVerifyingPlatformAuthenticator === false) return false;
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
};

/**
 * Passkey déjà créée pour ce compte sur ce navigateur (identifiant seulement : il ne permet rien
 * sans Windows Hello). Réactiver le verrouillage la réutilise au lieu d'en créer une de plus
 * dans Windows à chaque fois.
 */
const passkeyStorageKey = (userId: number) => `wlm_passkey_${userId}`;
const rememberedPasskey = (userId: number): Uint8Array | null => {
  try {
    const v = localStorage.getItem(passkeyStorageKey(userId));
    return v ? base64ToBytes(v) : null;
  } catch {
    return null;
  }
};
const rememberPasskey = (userId: number, rawId: Uint8Array | null) => {
  try {
    if (rawId) localStorage.setItem(passkeyStorageKey(userId), bytesToBase64(rawId));
    else localStorage.removeItem(passkeyStorageKey(userId));
  } catch { /* stockage indisponible : une passkey sera créée */ }
};

const webauthnProtect = async (userId: number, username: string, privateJwk: JsonWebKey): Promise<ProtectedKeyBlob> => {
  const salt = randomBytes(32);
  const known = rememberedPasskey(userId);
  if (known) {
    try {
      const secret = await webauthnSecret(known, salt);
      const sealed = await sealPrivateJwk(privateJwk, secret, salt);
      return { version: 1, method: 'webauthn', handle: bytesToBase64(known), ...sealed };
    } catch {
      // Passkey supprimée de Windows, autre authentificateur, ou demande annulée (le navigateur
      // ne distingue pas ces cas) : une nouvelle passkey est créée
      rememberPasskey(userId, null);
    }
  }
  let created: Credential | null;
  try {
    created = await navigator.credentials.create({
      publicKey: {
        rp: { name: 'OpenWLM', id: location.hostname },
        user: { id: new TextEncoder().encode(`openwlm:${userId}`), name: username, displayName: username },
        challenge: randomBytes(32) as BufferSource,
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' },
        timeout: 120000,
        // Aucune attestation : la passkey ne sert qu'ici, jamais au serveur
        attestation: 'none',
        extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs
      }
    });
  } catch (err) {
    throw webauthnFailure(err);
  }
  const credential = created as PublicKeyCredential | null;
  if (!credential) throw new DeviceLockError('failed');
  const ext = credential.getClientExtensionResults() as PrfExtensionResults;
  if (!ext.prf?.enabled) throw new DeviceLockError('unsupported', 'PRF non pris en charge par cet authentificateur');
  const rawId = new Uint8Array(credential.rawId);
  // Certaines plateformes n'évaluent pas le PRF à la création : une assertion le fait
  const secret = ext.prf.results?.first ? new Uint8Array(ext.prf.results.first) : await webauthnSecret(rawId, salt);
  rememberPasskey(userId, rawId);
  const sealed = await sealPrivateJwk(privateJwk, secret, salt);
  return { version: 1, method: 'webauthn', handle: bytesToBase64(rawId), ...sealed };
};

// --- App Android (Keystore + empreinte / code) ------------------------------------------------

const androidFailure = (err: unknown): DeviceLockError => {
  const msg = String((err as { message?: string })?.message ?? err);
  if (msg.includes('cancelled')) return new DeviceLockError('cancelled');
  if (msg.includes('invalidated')) return new DeviceLockError('invalidated');
  if (msg.includes('unavailable')) return new DeviceLockError('unsupported');
  return new DeviceLockError('failed', msg);
};

const androidProtect = async (privateJwk: JsonWebKey): Promise<ProtectedKeyBlob> => {
  let created: { secret: string; blob: string };
  try {
    created = await nativeDeviceSecretCreate();
  } catch (err) {
    throw androidFailure(err);
  }
  const sealed = await sealPrivateJwk(privateJwk, base64ToBytes(created.secret), randomBytes(32));
  return { version: 1, method: 'android', handle: created.blob, ...sealed };
};

// --- API ----------------------------------------------------------------------------------

/** Méthode de verrouillage possible sur cet appareil (null : aucune). */
export const detectDeviceLock = async (): Promise<DeviceLockMethod | null> => {
  if (isNativeApp()) return hasNativeMethod('deviceSecretCreate') ? 'android' : null;
  return (await webauthnAvailable()) ? 'webauthn' : null;
};

/** Scelle la clé privée pour cet appareil (demande l'authentification de son propriétaire). */
export const protectPrivateKey = async (userId: number, username: string, privateJwk: JsonWebKey): Promise<ProtectedKeyBlob> => {
  const method = await detectDeviceLock();
  if (method === 'android') return androidProtect(privateJwk);
  if (method === 'webauthn') return webauthnProtect(userId, username, privateJwk);
  throw new DeviceLockError('unsupported');
};

/** Rend la clé privée (demande l'authentification). Lève DeviceLockError sinon. */
export const unlockPrivateKey = async (blob: ProtectedKeyBlob): Promise<JsonWebKey> => {
  let secret: Uint8Array;
  if (blob.method === 'android') {
    if (!isNativeApp() || !hasNativeMethod('deviceSecretUnlock')) throw new DeviceLockError('unsupported');
    try {
      secret = base64ToBytes((await nativeDeviceSecretUnlock(blob.handle)).secret);
    } catch (err) {
      throw androidFailure(err);
    }
  } else {
    if (typeof PublicKeyCredential === 'undefined') throw new DeviceLockError('unsupported');
    secret = await webauthnSecret(base64ToBytes(blob.handle), base64ToBytes(blob.salt));
  }
  const jwk = await openPrivateJwk(blob, secret);
  // Secret différent : passkey ou clé Keystore remplacée (réinstallation, autre appareil)
  if (!jwk) throw new DeviceLockError('invalidated');
  return jwk;
};

/** Nom affiché de la méthode (« Windows Hello / Touch ID », « le verrouillage du téléphone »). */
export const methodName = (t: { deviceLock: { methodAndroid: string; methodWebauthn: string } }, method: DeviceLockMethod): string =>
  method === 'android' ? t.deviceLock.methodAndroid : t.deviceLock.methodWebauthn;

/** Délais de re-verrouillage proposés (minutes ; 0 = seulement à l'ouverture). */
export const RELOCK_CHOICES = [1, 5, 15, 30, 0] as const;

/** Canal entre onglets : « Verrouiller maintenant » verrouille tous les onglets du compte. */
export const DEVICE_LOCK_CHANNEL = 'openwlm-device-lock';
