/**
 * PROFIL & PRÉFÉRENCES LOCALES (localStorage)
 *
 * Regroupe les accès `localStorage` qui étaient dispersés dans `App.tsx` : navigation
 * (onglets ouverts / conversation active), mode privé (par contact et global),
 * notifications bureau et absence automatique.
 *
 * Chaque fonction est défensive (try/catch) et sans effet de bord : les valeurs invalides
 * ou un stockage indisponible retombent sur des valeurs par défaut sûres. Le profil
 * utilisateur (`wlm_user`) n'est PAS géré ici : il reste soumis à `sanitizeUserForStorage`
 * et à son contrôle de sécurité dédié.
 */

export const STORAGE_KEYS = {
  openChats: 'wlm_open_chats',
  activeChat: 'wlm_active_chat',
  privateModes: 'wlm_private_modes',
  globalPrivate: 'wlm_global_private',
  enableToasts: 'wlm_enable_toasts',
  awayTimeout: 'wlm_away_timeout',
  enableAutoAway: 'wlm_enable_auto_away',
  statusPref: 'wlm_status_pref',
  user: 'wlm_user'
} as const;

/**
 * SANITISATION STRICTE DU PROFIL UTILISATEUR POUR LE STOCKAGE WEB
 * `wlm_user` ne peut contenir au maximum que :
 * id, username, nickname, avatar, scene, status, rememberMe.
 * AUCUN token, AUCUNE clé, AUCUN coffre, AUCUN payload crypto.
 */
export const sanitizeUserForStorage = (u: any): Record<string, any> => {
  if (!u) return {};
  const sanitized: Record<string, any> = {
    id: Number(u.id),
    username: String(u.username || '')
  };
  if (u.nickname !== undefined) sanitized.nickname = String(u.nickname);
  if (u.avatar !== undefined) sanitized.avatar = String(u.avatar);
  if (u.scene !== undefined) sanitized.scene = String(u.scene);
  if (u.status !== undefined) sanitized.status = String(u.status);
  if (u.rememberMe !== undefined) sanitized.rememberMe = Boolean(u.rememberMe);
  return sanitized;
};

// --- Navigation (onglets ouverts / conversation active) ---------------------------

export function loadOpenChatIds(): number[] {
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.openChats);
    return saved ? JSON.parse(saved) : [];
  } catch {
    return [];
  }
}

export function saveOpenChatIds(ids: number[]): void {
  try {
    localStorage.setItem(STORAGE_KEYS.openChats, JSON.stringify(ids));
  } catch { /* stockage indisponible : silencieux */ }
}

export function loadActiveChatId(): number {
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.activeChat);
    return saved ? parseInt(saved) : 0;
  } catch {
    return 0;
  }
}

export function saveActiveChatId(id: number): void {
  try {
    localStorage.setItem(STORAGE_KEYS.activeChat, id.toString());
  } catch { /* ignore */ }
}

// --- Mode privé --------------------------------------------------------------------

export function loadPrivateModes(): Record<number, boolean> {
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.privateModes);
    return saved ? JSON.parse(saved) : {};
  } catch {
    return {};
  }
}

export function savePrivateModes(modes: Record<number, boolean>): void {
  try {
    localStorage.setItem(STORAGE_KEYS.privateModes, JSON.stringify(modes));
  } catch { /* ignore */ }
}

export function loadGlobalPrivateMode(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEYS.globalPrivate) === 'true';
  } catch {
    return false;
  }
}

export function saveGlobalPrivateMode(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEYS.globalPrivate, enabled.toString());
  } catch { /* ignore */ }
}

// --- Notifications bureau ----------------------------------------------------------

export function loadEnableDesktopToasts(defaultValue = true): boolean {
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.enableToasts);
    return saved === null ? defaultValue : saved === 'true';
  } catch {
    return defaultValue;
  }
}

export function saveEnableDesktopToasts(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEYS.enableToasts, enabled.toString());
  } catch { /* ignore */ }
}

// --- Statut choisi (restauré au redémarrage) -----------------------------------------
// Seul un statut choisi À LA MAIN (menu ou écran de connexion) est mémorisé : l'absence
// automatique pour inactivité ne l'est jamais, l'app repart donc « Disponible » après une
// inactivité, mais reste « Absent » / « Occupé » / « Apparaître hors ligne » si c'était voulu.
// Format : { "<userId>": statut } — par compte, jamais global (sur un poste partagé, un compte
// n'hérite pas du statut d'un autre).

export type PresenceStatus = 'online' | 'busy' | 'away' | 'offline';
const PRESENCE_STATUSES: readonly string[] = ['online', 'busy', 'away', 'offline'];
export const isPresenceStatus = (s: unknown): s is PresenceStatus =>
  typeof s === 'string' && PRESENCE_STATUSES.includes(s);

const readStatusPrefs = (): Record<string, string> => {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEYS.statusPref) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

export function loadPreferredStatus(userId: number | undefined): PresenceStatus | null {
  if (!userId) return null;
  const s = readStatusPrefs()[String(userId)];
  return isPresenceStatus(s) ? s : null;
}

export function savePreferredStatus(userId: number | undefined, status: string): void {
  if (!userId || !isPresenceStatus(status)) return;
  try {
    const prefs = readStatusPrefs();
    prefs[String(userId)] = status;
    delete prefs.last; // ancienne clé globale (versions précédentes)
    localStorage.setItem(STORAGE_KEYS.statusPref, JSON.stringify(prefs));
  } catch { /* ignore */ }
}

// --- Absence automatique (auto-away) ------------------------------------------------

// Délai d'inactivité borné : une valeur invalide, nulle ou négative (qui passait « Absent »
// presque immédiatement) retombe sur une valeur sûre.
export const AWAY_TIMEOUT_MIN = 1;
export const AWAY_TIMEOUT_MAX = 120;
export const clampAwayTimeout = (minutes: unknown, fallback = 5): number => {
  const n = typeof minutes === 'number' ? minutes : parseInt(String(minutes), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(AWAY_TIMEOUT_MAX, Math.max(AWAY_TIMEOUT_MIN, Math.round(n)));
};

export function loadAwayTimeout(defaultMinutes = 5): number {
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.awayTimeout);
    return saved ? clampAwayTimeout(saved, defaultMinutes) : defaultMinutes;
  } catch {
    return defaultMinutes;
  }
}

export function saveAwayTimeout(minutes: number): void {
  try {
    localStorage.setItem(STORAGE_KEYS.awayTimeout, clampAwayTimeout(minutes).toString());
  } catch { /* ignore */ }
}

export function loadEnableAutoAway(defaultEnabled = true): boolean {
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.enableAutoAway);
    return saved === null ? defaultEnabled : saved !== 'false';
  } catch {
    return defaultEnabled;
  }
}

export function saveEnableAutoAway(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEYS.enableAutoAway, enabled.toString());
  } catch { /* ignore */ }
}
