import { useSyncExternalStore } from 'react';

/**
 * PRÉFÉRENCES D'AFFICHAGE, DE MESSAGES, DE SONS ET DE SÉCURITÉ (Options → Disposition, Messages, Sons, Sécurité)
 *
 * Stockées sur l'appareil (localStorage, clé `wlm_prefs`), jamais sur le serveur : ce sont des
 * réglages de confort propres à chaque appareil. Lisibles depuis React (`useAppPrefs`) et
 * depuis les modules hors React (SoundManager, GameSfx) via `getAppPrefs`.
 */

export type SoundCategory = 'message' | 'contactOnline' | 'nudge' | 'call' | 'games' | 'winks';

export interface QuickText {
  /** Raccourci sans le « / » : lettres, chiffres, - et _ (1 à 20 caractères). */
  shortcut: string;
  text: string;
}

export const QUICK_TEXT_MAX = 30;
export const QUICK_TEXT_MAX_LENGTH = 1000;
export const QUICK_TEXT_SHORTCUT_RE = /^[a-z0-9_-]{1,20}$/;

// Liste défensive : entrées valides seulement, raccourcis uniques, bornes respectées
const normalizeQuickTexts = (raw: unknown): QuickText[] => {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: QuickText[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const shortcut = String((item as QuickText).shortcut ?? '').toLowerCase();
    const text = String((item as QuickText).text ?? '').slice(0, QUICK_TEXT_MAX_LENGTH);
    if (!QUICK_TEXT_SHORTCUT_RE.test(shortcut) || !text.trim() || seen.has(shortcut)) continue;
    seen.add(shortcut);
    out.push({ shortcut, text });
    if (out.length >= QUICK_TEXT_MAX) break;
  }
  return out;
};

export interface AppPrefs {
  sounds: {
    enabled: boolean;
    /** Volume général, de 0 à 1. */
    volume: number;
    message: boolean;
    contactOnline: boolean;
    nudge: boolean;
    call: boolean;
    games: boolean;
    winks: boolean;
    /** Couper les sons de notification en statut « Occupé » (les appels sonnent toujours). */
    muteWhenBusy: boolean;
  };
  messages: {
    /** Émoticônes affichées en images (sinon le texte du raccourci, ex. « :) »). */
    emoticonImages: boolean;
    showTimestamps: boolean;
    /** Wizz reçus : secousse + son. Désactivé : une simple ligne dans la conversation. */
    receiveNudges: boolean;
    /** Clins d'œil reçus joués automatiquement. Désactivé : ligne avec un bouton « Voir ». */
    autoPlayWinks: boolean;
    /** Copie chiffrée des conversations sur cet appareil (affichage immédiat à l'ouverture). */
    keepLocalHistory: boolean;
    /** Afficher la mise en forme ([c=4], [b]…) des pseudos, messages perso et messages. Sinon, texte simple. */
    showFormatting: boolean;
    /** Textes rapides : « /raccourci » envoie le texte associé ((!N) = nom du contact). */
    quickTexts: QuickText[];
  };
  layout: {
    showOffline: boolean;
    showPsm: boolean;
    sortBy: 'status' | 'name';
    /** Contact de test « OpenWLM » dans la liste. */
    showBot: boolean;
    /** Largeur de la liste de contacts sur ordinateur (px), réglée en faisant glisser son bord. */
    rosterWidth: number;
  };
  security: {
    /**
     * Clés mémorisées scellées par l'appareil (Windows Hello, Touch ID, empreinte / code
     * Android, cf. DeviceLock.ts) : réglé dans Options → Sécurité, appliqué aussi à la
     * prochaine connexion avec « Mémoriser mes clés ».
     */
    deviceLock: boolean;
    /** Minutes sans activité avant de redemander l'appareil (0 : seulement à l'ouverture). */
    relockMinutes: number;
  };
}

/** Liste de contacts : largeur d'origine et bornes du redimensionnement (ordinateur). */
export const ROSTER_WIDTH_DEFAULT = 310;
export const ROSTER_WIDTH_MIN = 260;
export const ROSTER_WIDTH_MAX = 640;
export const clampRosterWidth = (w: number) =>
  Math.round(Math.min(ROSTER_WIDTH_MAX, Math.max(ROSTER_WIDTH_MIN, Number.isFinite(w) ? w : ROSTER_WIDTH_DEFAULT)));

export const DEFAULT_PREFS: AppPrefs = {
  sounds: { enabled: true, volume: 1, message: true, contactOnline: true, nudge: true, call: true, games: true, winks: true, muteWhenBusy: false },
  messages: { emoticonImages: true, showTimestamps: true, receiveNudges: true, autoPlayWinks: true, keepLocalHistory: true, showFormatting: true, quickTexts: [] },
  layout: { showOffline: true, showPsm: true, sortBy: 'status', showBot: true, rosterWidth: ROSTER_WIDTH_DEFAULT },
  security: { deviceLock: false, relockMinutes: 5 }
};

const STORAGE_KEY = 'wlm_prefs';

// Fusion défensive : seules les clés connues, avec le bon type, sont reprises du stockage
const mergeSection = <T extends object>(defaults: T, raw: unknown): T => {
  const out = { ...defaults };
  if (!raw || typeof raw !== 'object') return out;
  for (const key of Object.keys(defaults) as (keyof T)[]) {
    const v = (raw as Record<string, unknown>)[key as string];
    if (typeof v === typeof defaults[key]) (out as Record<string, unknown>)[key as string] = v;
  }
  return out;
};

const normalize = (raw: unknown): AppPrefs => {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const prefs: AppPrefs = {
    sounds: mergeSection(DEFAULT_PREFS.sounds, r.sounds),
    messages: mergeSection(DEFAULT_PREFS.messages, r.messages),
    layout: mergeSection(DEFAULT_PREFS.layout, r.layout),
    security: mergeSection(DEFAULT_PREFS.security, r.security)
  };
  prefs.sounds.volume = Math.min(1, Math.max(0, Number.isFinite(prefs.sounds.volume) ? prefs.sounds.volume : 1));
  if (prefs.layout.sortBy !== 'status' && prefs.layout.sortBy !== 'name') prefs.layout.sortBy = 'status';
  prefs.layout.rosterWidth = clampRosterWidth(prefs.layout.rosterWidth);
  prefs.security.relockMinutes = [1, 5, 15, 30, 0].includes(prefs.security.relockMinutes) ? prefs.security.relockMinutes : 5;
  prefs.messages.quickTexts = normalizeQuickTexts((r.messages as Record<string, unknown> | undefined)?.quickTexts);
  return prefs;
};

const load = (): AppPrefs => {
  try {
    return normalize(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'));
  } catch {
    return normalize({});
  }
};

let current: AppPrefs = typeof window !== 'undefined' ? load() : DEFAULT_PREFS;
const listeners = new Set<() => void>();

export const getAppPrefs = (): AppPrefs => current;

/** Met à jour une section (fusion superficielle), enregistre et prévient les abonnés. */
export const updateAppPrefs = <K extends keyof AppPrefs>(section: K, patch: Partial<AppPrefs[K]>) => {
  current = normalize({ ...current, [section]: { ...current[section], ...patch } });
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(current)); } catch { /* stockage indisponible */ }
  listeners.forEach((l) => l());
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** Hook React : se met à jour dès qu'une préférence change (y compris depuis les Options). */
export const useAppPrefs = (): AppPrefs => useSyncExternalStore(subscribe, getAppPrefs, getAppPrefs);

// --- Sons -------------------------------------------------------------------------

let presenceStatus = 'online';
/** Statut courant de l'utilisateur, pour « couper les sons en Occupé ». */
export const setPresenceForSounds = (status: string) => { presenceStatus = status; };

/** Un son de cette catégorie peut-il être joué maintenant ? */
export const isSoundAllowed = (category: SoundCategory): boolean => {
  const s = current.sounds;
  if (!s.enabled || !s[category]) return false;
  if (s.muteWhenBusy && presenceStatus === 'busy' && category !== 'call') return false;
  return true;
};

export const soundVolume = (): number => current.sounds.volume;
