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
  enableAutoAway: 'wlm_enable_auto_away'
} as const;

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

// --- Absence automatique (auto-away) ------------------------------------------------

export function loadAwayTimeout(defaultMinutes = 5): number {
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.awayTimeout);
    return saved ? parseInt(saved) : defaultMinutes;
  } catch {
    return defaultMinutes;
  }
}

export function saveAwayTimeout(minutes: number): void {
  try {
    localStorage.setItem(STORAGE_KEYS.awayTimeout, minutes.toString());
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
