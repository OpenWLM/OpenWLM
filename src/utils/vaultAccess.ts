import axios from 'axios';

/**
 * Coffre de clés (clé privée chiffrée par le mot de passe) demandé au serveur avec la PREUVE du
 * mot de passe (POST /api/user/vault). Le profil (GET /api/user/me) ne le contient plus : une
 * session volée ne permet pas d'emporter le coffre pour attaquer le mot de passe hors ligne.
 */
export interface VaultBlob {
  encryptedKeyBase64: string;
  ivBase64: string;
}

export type VaultFetchResult =
  | { vault: VaultBlob }
  | { error: 'wrongPassword' | 'limited' | 'failed' };

/** Coffre déjà connu (réponse de connexion), sous forme d'objet, sinon null. */
export const parseVault = (source: unknown): VaultBlob | null => {
  try {
    const v = typeof source === 'string' ? JSON.parse(source) : source;
    return v && typeof v === 'object' && typeof v.encryptedKeyBase64 === 'string' && typeof v.ivBase64 === 'string' ? v as VaultBlob : null;
  } catch {
    return null;
  }
};

export const fetchVault = async (authKeyHex: string, legacyAuthKeyHex?: string): Promise<VaultFetchResult> => {
  try {
    const res = await axios.post('/api/user/vault', { authKeyHex, legacyAuthKeyHex });
    const vault = parseVault(res.data?.vault);
    return vault ? { vault } : { error: 'failed' };
  } catch (err) {
    const status = (err as { response?: { status?: number } }).response?.status;
    return { error: status === 401 ? 'wrongPassword' : status === 429 ? 'limited' : 'failed' };
  }
};
