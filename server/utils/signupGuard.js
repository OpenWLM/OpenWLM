/**
 * PROTECTION ANTI-INSCRIPTION DE MASSE
 *
 * Le captcha mathématique (« 3 + 4 ? ») reste affiché pour l'UX, mais il n'arrête
 * aucun script : la question est lisible en clair dans la réponse JSON. Les vraies
 * protections sont ici :
 *
 * 1. Preuve de travail (PoW, type hashcash) liée au captcha :
 *    le client doit trouver `nonce` tel que SHA-256(`${salt}:${nonce}`) commence par
 *    au moins `difficulty` bits à zéro. Coût client ~2^difficulty hachages,
 *    vérification serveur = 1 seul hachage. Le défi est à usage unique (supprimé
 *    avec le captcha).
 *    Limite honnête : à une difficulté supportable par un navigateur (~1-3 s), un
 *    attaquant en code natif paie bien moins. La PoW renchérit l'abus, elle ne
 *    l'empêche pas : c'est le plafond par IP ci-dessous qui borne réellement.
 *
 * 2. Plafond d'inscriptions RÉUSSIES par IP sur une fenêtre glissante (24 h par défaut).
 *
 * Variables d'environnement :
 *   POW_DIFFICULTY          bits à zéro exigés (défaut 17, borné 0..24 ; 0 = désactivé)
 *   SIGNUP_IP_DAILY_LIMIT   inscriptions réussies max par IP et par fenêtre (défaut 10)
 */
import crypto from 'crypto';

export const DEFAULT_POW_DIFFICULTY = 17;
export const MAX_POW_DIFFICULTY = 24;

export const getPowDifficulty = (envValue = process.env.POW_DIFFICULTY) => {
  if (envValue === undefined || envValue === null || String(envValue).trim() === '') {
    return DEFAULT_POW_DIFFICULTY;
  }
  const n = Number(envValue);
  if (!Number.isInteger(n)) return DEFAULT_POW_DIFFICULTY;
  return Math.min(Math.max(n, 0), MAX_POW_DIFFICULTY);
};

export const createPowChallenge = (difficulty = getPowDifficulty()) => ({
  salt: crypto.randomBytes(16).toString('hex'),
  difficulty
});

/** Nombre de bits à zéro en tête d'un buffer. */
export const leadingZeroBits = (buf) => {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) { bits += 8; continue; }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
};

/**
 * Vérifie une solution de PoW. `nonce` doit être un entier décimal (≤ 16 chiffres)
 * transmis sous forme de chaîne ou de nombre.
 */
export const verifyPow = (challenge, nonce) => {
  if (!challenge || typeof challenge.salt !== 'string') return false;
  const difficulty = Number(challenge.difficulty) || 0;
  if (difficulty <= 0) return true;
  const nonceStr = typeof nonce === 'number' ? String(nonce) : nonce;
  if (typeof nonceStr !== 'string' || !/^\d{1,16}$/.test(nonceStr)) return false;
  const digest = crypto.createHash('sha256').update(`${challenge.salt}:${nonceStr}`).digest();
  return leadingZeroBits(digest) >= difficulty;
};

/**
 * Compteur d'événements RÉUSSIS par clé (IP) sur une fenêtre glissante.
 * `check(key)` ne consomme rien ; `record(key)` est appelé après un succès.
 */
export const createSuccessCounter = ({ windowMs, limit, now = () => Date.now() }) => {
  const store = new Map();
  const active = (key) => (store.get(key) || []).filter((ts) => now() - ts < windowMs);
  return {
    check(key) {
      if (!key) return { allowed: false };
      return { allowed: active(key).length < limit };
    },
    record(key) {
      if (!key) return;
      const ts = active(key);
      ts.push(now());
      store.set(key, ts);
    },
    cleanup() {
      for (const key of store.keys()) {
        const ts = active(key);
        if (ts.length === 0) store.delete(key);
        else store.set(key, ts);
      }
    }
  };
};

export const getSignupIpDailyLimit = (envValue = process.env.SIGNUP_IP_DAILY_LIMIT) => {
  const n = Number(envValue);
  return Number.isInteger(n) && n > 0 ? n : 10;
};
