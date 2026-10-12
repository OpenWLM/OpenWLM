/**
 * PREUVE DE TRAVAIL (hashcash) pour l'inscription.
 * Trouve `nonce` tel que SHA-256(`${salt}:${nonce}`) commence par `difficulty` bits à zéro.
 * Calcul par lots asynchrones (Web Crypto) : l'interface reste réactive.
 * Doit rester aligné avec `server/utils/signupGuard.js` (verifyPow).
 */

export interface PowChallenge {
  salt: string;
  difficulty: number;
}

const BATCH_SIZE = 512;
const MAX_NONCE = 1e15; // ≤ 16 chiffres décimaux, comme exigé par le serveur

const leadingZeroBits = (bytes: Uint8Array): number => {
  let bits = 0;
  for (const byte of bytes) {
    if (byte === 0) { bits += 8; continue; }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
};

export const solveProofOfWork = async (
  challenge: PowChallenge | null | undefined,
  signal?: AbortSignal
): Promise<string> => {
  if (!challenge || !challenge.salt || !(challenge.difficulty > 0)) return '0';

  const encoder = new TextEncoder();
  const subtle = window.crypto.subtle;

  for (let base = 0; base < MAX_NONCE; base += BATCH_SIZE) {
    if (signal?.aborted) throw new DOMException('Preuve de travail annulée', 'AbortError');

    const digests = await Promise.all(
      Array.from({ length: BATCH_SIZE }, (_, i) =>
        subtle.digest('SHA-256', encoder.encode(`${challenge.salt}:${base + i}`))
      )
    );

    for (let i = 0; i < digests.length; i++) {
      if (leadingZeroBits(new Uint8Array(digests[i])) >= challenge.difficulty) {
        return String(base + i);
      }
    }
  }
  throw new Error('Preuve de travail introuvable');
};
