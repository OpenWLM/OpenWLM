/**
 * ENVELOPPE DE MESSAGE E2EE SIGNÉE (v2)
 *
 * Problème corrigé : en v1, les messages étaient chiffrés (AES-GCM + RSA-OAEP) mais
 * PAS authentifiés. Le serveur connaissant toutes les clés publiques, il pouvait
 * fabriquer un message chiffré valide « de la part de » n'importe quel contact.
 *
 * Format v2 (chiffrer-puis-signer) :
 *   {
 *     v: 2, from, to, mid, ts,                 // métadonnées liées par la signature
 *     iv, payload, keyReceiver, keySender,     // chiffrement hybride inchangé
 *     sig                                      // RSA-PSS(SHA-256) de l'émetteur
 *   }
 * - La signature couvre une chaîne canonique préfixée par un séparateur de domaine
 *   (`openwlm-msg-v2`) : elle ne peut pas être confondue avec une autre signature
 *   produite par la même clé (ex. empreintes DTLS des appels).
 * - `from` et `to` sont AUSSI placés dans le contenu chiffré et revérifiés après
 *   déchiffrement : un tiers qui retirerait la signature pour re-signer avec sa
 *   propre clé (« signature stripping ») produirait une incohérence détectée.
 * - `mid` (128 bits aléatoires) permet au destinataire d'écarter les rejeux.
 *
 * Module autonome (aucun import) : testable sous Node (tests/test_message_envelope.js).
 */

export const ENVELOPE_VERSION = 2;
const SIGNATURE_DOMAIN = 'openwlm-msg-v2';
const RSA_OAEP = { name: 'RSA-OAEP', hash: 'SHA-256' } as const;
const RSA_PSS = { name: 'RSA-PSS', hash: 'SHA-256' } as const;
const PSS_SALT_LENGTH = 32;

export interface SignedEnvelope {
  v: 2;
  from: number;
  to: number;
  mid: string;
  ts: number;
  iv: string;
  payload: string;
  keyReceiver: string;
  keySender: string;
  sig: string;
}

export type EnvelopeStatus =
  | 'verified'          // v2, signature valide et cohérente
  | 'unsigned-legacy'   // v1 (ancien format non signé) : REFUSÉ, jamais déchiffré
  | 'unverifiable'      // v2 mais clé publique de l'émetteur indisponible : REFUSÉ
  | 'invalid'           // signature fausse, métadonnées incohérentes : contenu rejeté
  | 'plaintext'         // message non chiffré : contenu rejeté
  | 'undecryptable';    // chiffré mais impossible à déchiffrer

export interface OpenedMessage<T = Record<string, unknown>> {
  status: EnvelopeStatus;
  payload: T | null;
  mid?: string;
  ts?: number;
  reason?: string;
}

export interface OpenContext {
  /** Identifiants tels qu'annoncés par le serveur. */
  serverSenderId: number;
  serverReceiverId: number;
  /** Utilisateur courant. */
  myId: number;
  /** Ma clé privée RSA-OAEP (CryptoKey non extractible ou JWK). */
  myPrivateKey: CryptoKey | JsonWebKey;
  /** Clé publique JWK de l'émetteur (moi-même si le message vient d'une autre de mes sessions). */
  senderPublicKeyJwk: JsonWebKey | null | undefined;
  /**
   * Date de réception annoncée par le serveur (ms). Si elle est fournie, un écart de plus de
   * `clockToleranceMs` (15 min par défaut) avec l'horodatage SIGNÉ par l'émetteur rejette le
   * message : un serveur malveillant ne peut pas re-présenter un vieux message comme nouveau.
   */
  serverTimestamp?: number;
  clockToleranceMs?: number;
}

export const DEFAULT_CLOCK_TOLERANCE_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------- utilitaires

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;

const toBase64 = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
};

const fromBase64 = (b64: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** Retire alg/key_ops/use/ext pour réimporter un JWK RSA sous un autre algorithme. */
const stripJwkMeta = (jwk: JsonWebKey): JsonWebKey => {
  const rest: Record<string, unknown> = { ...(jwk as Record<string, unknown>) };
  delete rest.alg; delete rest.key_ops; delete rest.use; delete rest.ext;
  return rest as JsonWebKey;
};

const isCryptoKey = (k: unknown): k is CryptoKey =>
  typeof CryptoKey !== 'undefined' && k instanceof CryptoKey;

const isPositiveInt = (n: unknown): n is number => Number.isInteger(n) && (n as number) > 0;
const isB64 = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(s);

/** Chaîne canonique signée. Tous les champs sont des entiers ou du base64 (aucun '\n'). */
export const canonicalSigningString = (e: Omit<SignedEnvelope, 'sig'>): string =>
  [SIGNATURE_DOMAIN, e.v, e.from, e.to, e.mid, e.ts, e.iv, e.payload, e.keyReceiver, e.keySender].join('\n');

export const generateMessageId = (): string =>
  toBase64(globalThis.crypto.getRandomValues(new Uint8Array(16)));

/** Analyse le champ `text` d'un message serveur : enveloppe v2, v1, ou rien (texte clair). */
export const parseEnvelope = (raw: unknown): { kind: 'v2'; env: SignedEnvelope } | { kind: 'v1'; env: Record<string, string> } | { kind: 'plaintext' } => {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return { kind: 'plaintext' }; }
  }
  if (!obj || typeof obj !== 'object') return { kind: 'plaintext' };
  const o = obj as Record<string, unknown>;
  if (o.v === ENVELOPE_VERSION) return { kind: 'v2', env: o as unknown as SignedEnvelope };
  if (o.keyReceiver || o.keySender) return { kind: 'v1', env: o as Record<string, string> };
  return { kind: 'plaintext' };
};

// ---------------------------------------------------------------- chiffrement

const importOaepPublic = (jwk: JsonWebKey) =>
  subtle().importKey('jwk', stripJwkMeta(jwk), RSA_OAEP, false, ['encrypt']);

const importOaepPrivate = async (k: CryptoKey | JsonWebKey): Promise<CryptoKey> =>
  isCryptoKey(k) ? k : subtle().importKey('jwk', k, RSA_OAEP, false, ['decrypt']);

const importPssPublic = (jwk: JsonWebKey) =>
  subtle().importKey('jwk', stripJwkMeta(jwk), RSA_PSS, false, ['verify']);

/**
 * Chiffre `payload` pour le destinataire ET l'émetteur (historique multi-session),
 * puis signe l'enveloppe avec la clé de signature RSA-PSS de l'émetteur.
 */
export const sealMessage = async (
  payload: unknown,
  opts: {
    from: number;
    to: number;
    receiverPublicKeyJwk: JsonWebKey;
    senderPublicKeyJwk: JsonWebKey;
    signingKey: CryptoKey;
    now?: number;
    mid?: string;
  }
): Promise<SignedEnvelope> => {
  if (!isPositiveInt(opts.from) || !isPositiveInt(opts.to)) throw new Error('Identifiants émetteur/destinataire invalides');
  if (!opts.signingKey) throw new Error('Clé de signature indisponible');

  const mid = opts.mid ?? generateMessageId();
  const ts = opts.now ?? Date.now();

  const aesKey = await subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const inner = new TextEncoder().encode(JSON.stringify({ f: opts.from, t: opts.to, m: mid, p: payload }));
  const ciphertext = await subtle().encrypt({ name: 'AES-GCM', iv }, aesKey, inner);
  const rawAes = await subtle().exportKey('raw', aesKey);

  const [receiverKey, senderKey] = await Promise.all([
    importOaepPublic(opts.receiverPublicKeyJwk),
    importOaepPublic(opts.senderPublicKeyJwk)
  ]);
  const [wrappedForReceiver, wrappedForSender] = await Promise.all([
    subtle().encrypt({ name: 'RSA-OAEP' }, receiverKey, rawAes),
    subtle().encrypt({ name: 'RSA-OAEP' }, senderKey, rawAes)
  ]);

  const unsigned = {
    v: ENVELOPE_VERSION as 2,
    from: opts.from,
    to: opts.to,
    mid,
    ts,
    iv: toBase64(iv),
    payload: toBase64(ciphertext),
    keyReceiver: toBase64(wrappedForReceiver),
    keySender: toBase64(wrappedForSender)
  };
  const sig = await subtle().sign(
    { name: 'RSA-PSS', saltLength: PSS_SALT_LENGTH },
    opts.signingKey,
    new TextEncoder().encode(canonicalSigningString(unsigned))
  );
  return { ...unsigned, sig: toBase64(sig) };
};

const decryptHybrid = async (
  env: { iv: string; payload: string; keyReceiver?: string; keySender?: string },
  myPrivateKey: CryptoKey | JsonWebKey,
  isSender: boolean
): Promise<unknown> => {
  const wrapped = isSender ? env.keySender : env.keyReceiver;
  if (!wrapped) throw new Error('Clé AES absente pour ce destinataire');
  const priv = await importOaepPrivate(myPrivateKey);
  const rawAes = await subtle().decrypt({ name: 'RSA-OAEP' }, priv, fromBase64(wrapped));
  const aesKey = await subtle().importKey('raw', rawAes, { name: 'AES-GCM' }, false, ['decrypt']);
  const plain = await subtle().decrypt({ name: 'AES-GCM', iv: fromBase64(env.iv) }, aesKey, fromBase64(env.payload));
  return JSON.parse(new TextDecoder().decode(plain));
};

/**
 * Ouvre un message reçu (direct ou historique) et renvoie un verdict.
 * Seul 'verified' renvoie un payload : un message non signé (ancien format v1) ou dont
 * la signature ne peut pas être vérifiée (clé de l'émetteur indisponible) est refusé,
 * au même titre qu'une signature invalide — son contenu n'est jamais exposé.
 */
export const openMessage = async <T = Record<string, unknown>>(
  rawText: unknown,
  ctx: OpenContext
): Promise<OpenedMessage<T>> => {
  const parsed = parseEnvelope(rawText);
  if (parsed.kind === 'plaintext') {
    return { status: 'plaintext', payload: null, reason: 'Message non chiffré' };
  }

  // La conversation doit concerner l'utilisateur courant
  const isSender = ctx.serverSenderId === ctx.myId;
  if (!isSender && ctx.serverReceiverId !== ctx.myId) {
    return { status: 'invalid', payload: null, reason: 'Message non destiné à cet utilisateur' };
  }

  // Ancien format non signé : son authenticité ne peut pas être établie (le serveur
  // connaît nos clés publiques et pourrait en fabriquer un) → refusé sans déchiffrement.
  if (parsed.kind === 'v1') {
    return { status: 'unsigned-legacy', payload: null, reason: 'Ancien format non signé : refusé' };
  }

  const env = parsed.env;
  // 1) Forme stricte
  if (!isPositiveInt(env.from) || !isPositiveInt(env.to) || !Number.isFinite(env.ts) ||
      !isB64(env.mid) || !isB64(env.iv) || !isB64(env.payload) || !isB64(env.sig) ||
      !isB64(env.keyReceiver) || !isB64(env.keySender)) {
    return { status: 'invalid', payload: null, reason: 'Enveloppe malformée' };
  }
  // 2) Les métadonnées signées doivent correspondre à ce qu'annonce le serveur
  if (env.from !== ctx.serverSenderId || env.to !== ctx.serverReceiverId) {
    return { status: 'invalid', payload: null, reason: 'Émetteur/destinataire incohérents avec la signature' };
  }

  // 3) Signature (avant tout déchiffrement)
  let signatureChecked = false;
  if (ctx.senderPublicKeyJwk) {
    try {
      const vk = await importPssPublic(ctx.senderPublicKeyJwk);
      const { sig, ...unsigned } = env;
      const ok = await subtle().verify(
        { name: 'RSA-PSS', saltLength: PSS_SALT_LENGTH },
        vk,
        fromBase64(sig),
        new TextEncoder().encode(canonicalSigningString(unsigned))
      );
      if (!ok) return { status: 'invalid', payload: null, reason: 'Signature invalide' };
      signatureChecked = true;
    } catch {
      return { status: 'invalid', payload: null, reason: 'Signature invalide' };
    }
  }

  // Signature non vérifiable (clé de l'émetteur indisponible) : un serveur qui retiendrait
  // la clé publique pourrait sinon faire passer un message fabriqué → refusé AVANT tout
  // déchiffrement (aucun contenu non authentifié ne passe par notre clé privée). Le `mid`
  // n'étant pas authentifié, il n'est pas renvoyé (il ne doit pas alimenter l'anti-rejeu).
  if (!signatureChecked) {
    return { status: 'unverifiable', payload: null, reason: 'Clé publique de l\'émetteur indisponible : refusé' };
  }

  // 3 bis) Horodatage signé cohérent avec la date de réception annoncée par le serveur
  if (typeof ctx.serverTimestamp === 'number' && Number.isFinite(ctx.serverTimestamp)) {
    const tolerance = ctx.clockToleranceMs ?? DEFAULT_CLOCK_TOLERANCE_MS;
    if (Math.abs(env.ts - ctx.serverTimestamp) > tolerance) {
      return { status: 'invalid', payload: null, reason: 'Horodatage signé incohérent avec la date du serveur (message rejoué ou re-daté)' };
    }
  }

  // 4) Déchiffrement + cohérence interne (anti « signature stripping »)
  let inner: unknown;
  try {
    inner = await decryptHybrid(env, ctx.myPrivateKey, isSender);
  } catch {
    return { status: 'undecryptable', payload: null };
  }
  const i = inner as { f?: unknown; t?: unknown; m?: unknown; p?: unknown } | null;
  if (!i || i.f !== env.from || i.t !== env.to || i.m !== env.mid) {
    return { status: 'invalid', payload: null, reason: 'Contenu chiffré incohérent avec l\'enveloppe signée' };
  }

  return {
    status: 'verified',
    payload: (i.p ?? null) as T,
    mid: env.mid,
    ts: env.ts
  };
};

// ---------------------------------------------------------------- payload

const ALLOWED_TYPES = new Set(['text', 'audio', 'file', 'wink']);
const STRING_FIELDS = ['text', 'audio', 'winkId', 'fileId', 'token', 'downloadUrl', 'fileName', 'fileType'] as const;

/**
 * Ne conserve que les champs de contenu attendus d'un payload déchiffré.
 * Empêche un payload d'écraser des champs de contrôle (id, senderId, timestamp,
 * delivery_status, sender…) lors de la fusion avec le message serveur.
 */
// Formes attendues des champs qui deviennent des adresses chargées par l'app : un pair ne doit
// pas pouvoir faire charger un autre chemin du serveur (`/api/files/download/../../user/me`)
// ni une source audio arbitraire.
const FIELD_PATTERNS: Partial<Record<(typeof STRING_FIELDS)[number], RegExp>> = {
  downloadUrl: /^\/api\/files\/download\/[0-9a-f-]{36}\?token=[0-9a-f]{16,128}$/,
  fileId: /^[0-9a-f-]{36}$/,
  token: /^[0-9a-f]{16,128}$/,
  winkId: /^[\w-]{1,64}$/,
  audio: /^data:audio\/[\w.+-]{1,32}(;[\w.+-]+=[\w.+-]+)*;base64,[A-Za-z0-9+/]+=*$/
};

/**
 * Style d'affichage choisi par l'expéditeur (FontModal) : bornes de l'interface. Sinon un pair
 * pouvait afficher un texte de 900 pt qui casse la conversation, ou transparent (invisible mais
 * notifié).
 */
const sanitizeStyle = (raw: unknown): Record<string, unknown> | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof s.family === 'string' && /^[\w .'-]{1,48}$/.test(s.family)) out.family = s.family;
  if (s.weight === 'normal' || s.weight === 'bold') out.weight = s.weight;
  if (s.style === 'normal' || s.style === 'italic') out.style = s.style;
  if (typeof s.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(s.color)) out.color = s.color;
  const size = Number(s.size);
  if (Number.isFinite(size)) out.size = String(Math.min(20, Math.max(8, Math.round(size))));
  if (s.underline === true) out.underline = true;
  if (s.strikeout === true) out.strikeout = true;
  return out;
};

export const sanitizeDecryptedPayload = (raw: unknown): Record<string, unknown> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const p = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof p.type === 'string' && ALLOWED_TYPES.has(p.type)) out.type = p.type;
  for (const f of STRING_FIELDS) {
    if (typeof p[f] !== 'string') continue;
    const pattern = FIELD_PATTERNS[f];
    if (pattern && !pattern.test(p[f] as string)) continue;
    out[f] = p[f];
  }
  if (typeof p.fileSize === 'number' && Number.isFinite(p.fileSize)) out.fileSize = p.fileSize;
  if (typeof p.expiresAt === 'number' && Number.isFinite(p.expiresAt)) out.expiresAt = p.expiresAt;
  // /me : message d'action (« * Pseudo texte »)
  if (p.action === true) out.action = true;
  const style = sanitizeStyle(p.style);
  if (style) out.style = style;
  for (const f of ['fileKeys', 'customEmoticons'] as const) {
    if (p[f] && typeof p[f] === 'object' && !Array.isArray(p[f])) out[f] = p[f];
  }
  return out;
};
