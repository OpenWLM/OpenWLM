/**
 * Détection de l'app Android (coquille Capacitor, docs/ANDROID.md) et pont vers ses
 * fonctions natives. Dans un navigateur, tout se replie sur le comportement web.
 */
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { withTimeout } from './withTimeout';

export interface NativeAppInfo {
  server: string | null;
  defaultServer: string;
  versionName?: string;
  versionCode?: number;
  /** Le téléphone a un verrouillage d'écran : l'app est protégée par empreinte / code. */
  appLock: boolean;
  /** Firebase configuré dans l'APK (notifications app fermée possibles). */
  push?: boolean;
}

export type NativeNotificationPermission = 'granted' | 'denied' | 'prompt';

/** Autorisations utiles aux appels dans l'app (fullScreen : écran d'appel, Android 14+). */
export interface NativeCallPermissions {
  notifications: NativeNotificationPermission;
  fullScreen: 'granted' | 'denied';
  microphone: NativeNotificationPermission;
  camera: NativeNotificationPermission;
}

interface OpenWLMNativePlugin {
  getInfo(): Promise<NativeAppInfo>;
  changeServer(): Promise<void>;
  /** APK v3 : enregistrement en un seul bloc (gardé pour la compatibilité). */
  saveFile(options: { fileName: string; mimeType: string; data: string }): Promise<{ saved: boolean; location?: string }>;
  resetPushToken(): Promise<void>;
  /** APK v6+ : `cancelled` si l'utilisateur refuse la confirmation native (pas d'`id`). */
  beginSave(options: { fileName: string; mimeType: string; size: number }): Promise<{ id?: string; maxChunkBytes?: number; cancelled?: boolean }>;
  appendChunk(options: { id: string; data: string }): Promise<void>;
  finishSave(options: { id: string }): Promise<{ saved: boolean; location?: string }>;
  abortSave(options: { id: string }): Promise<void>;
  getFcmToken(): Promise<{ token: string | null }>;
  getNotificationPermission(): Promise<{ state: NativeNotificationPermission }>;
  requestNotificationPermission(): Promise<{ state: NativeNotificationPermission }>;
  openNotificationSettings(): Promise<void>;
  setLanguage(options: { lang: string }): Promise<void>;
  /** APK v7+ : son des notifications de message et de Wizz (réglages Sons de l'app). */
  setSoundPrefs(options: { message: boolean; nudge: boolean }): Promise<void>;
  addListener(event: 'fcmToken', handler: (data: { token: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'openChat', handler: (data: { senderId: number; answer?: boolean }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'hangUp', handler: () => void): Promise<PluginListenerHandle>;
  addListener(event: 'serverChangeCancelled', handler: () => void): Promise<PluginListenerHandle>;
  dismissIncomingCall(options: { callerId: number }): Promise<void>;
  startOngoingCall(options: { peerName: string; video: boolean }): Promise<void>;
  updateOngoingCall(options: { video: boolean }): Promise<void>;
  stopOngoingCall(): Promise<void>;
  setKeepScreenOn(options: { on: boolean }): Promise<void>;
  getCallPermissions(): Promise<NativeCallPermissions>;
  isAppLocked(): Promise<{ locked: boolean }>;
  requestCallPermission(options: { kind: 'microphone' | 'camera' | 'fullScreen' }): Promise<void>;
  /** APK v11+ : secret de verrouillage des clés, rendu par le Keystore après empreinte / code (cf. DeviceLock.ts). */
  deviceSecretCreate(): Promise<{ secret: string; blob: string }>;
  deviceSecretUnlock(options: { blob: string }): Promise<{ secret: string }>;
}

const OpenWLMNative = registerPlugin<OpenWLMNativePlugin>('OpenWLMNative');

/**
 * Méthodes réellement exposées par l'APK installé (liste publiée par le pont natif de
 * Capacitor). L'interface est servie par le serveur et peut être plus récente que l'APK :
 * elle s'adapte à ce qu'il sait faire (APK v3 : `saveFile`, pas d'enregistrement par morceaux).
 */
export const hasNativeMethod = (name: string): boolean => {
  const headers = (window as unknown as { Capacitor?: { PluginHeaders?: Array<{ name: string; methods: Array<{ name: string }> }> } })
    .Capacitor?.PluginHeaders;
  return !!headers?.find((h) => h.name === 'OpenWLMNative')?.methods.some((m) => m.name === name);
};

/** Vrai dans l'app Android, faux dans un navigateur (y compris la PWA installée). */
export const isNativeApp = (): boolean => Capacitor.isNativePlatform();

export const getNativeAppInfo = (): Promise<NativeAppInfo | null> =>
  isNativeApp() ? OpenWLMNative.getInfo().catch(() => null) : Promise.resolve(null);

/** Ouvre l'écran natif de choix du serveur. */
export const openServerSettings = (): Promise<void> =>
  isNativeApp() ? OpenWLMNative.changeServer() : Promise.resolve();

const blobToBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

/** Taille des morceaux envoyés au code natif (multiple de 3 : base64 sans remplissage au milieu). */
export const SAVE_CHUNK_BYTES = 3 * 512 * 1024;

/** Découpe [0, size) en morceaux de `chunk` octets (dernier morceau plus court). */
export const chunkRanges = (size: number, chunk: number = SAVE_CHUNK_BYTES): Array<[number, number]> => {
  const ranges: Array<[number, number]> = [];
  for (let start = 0; start < size; start += chunk) ranges.push([start, Math.min(size, start + chunk)]);
  return ranges;
};

/**
 * Enregistre un fichier sur l'appareil.
 * Navigateur : lien de téléchargement. App Android : la WebView ignore ces liens, le fichier
 * passe par le code natif (dossier Téléchargements), par morceaux de 1,5 Mo pour ne jamais
 * charger un gros fichier entier dans le pont ni en mémoire native. Renvoie false si
 * l'utilisateur a annulé (Android 8-9 : choix de l'emplacement).
 */
export const saveBlob = async (blob: Blob, fileName: string): Promise<boolean> => {
  if (isNativeApp() && !hasNativeMethod('beginSave')) {
    // APK v3 : pas d'enregistrement par morceaux (fichiers de quelques dizaines de Mo au plus)
    const data = await blobToBase64(blob);
    return (await OpenWLMNative.saveFile({ fileName, mimeType: blob.type || 'application/octet-stream', data })).saved;
  }
  if (isNativeApp()) {
    const { id } = await OpenWLMNative.beginSave({ fileName, mimeType: blob.type || 'application/octet-stream', size: blob.size });
    if (!id) return false; // enregistrement refusé dans la confirmation native
    try {
      for (const [start, end] of chunkRanges(blob.size)) {
        await OpenWLMNative.appendChunk({ id, data: await blobToBase64(blob.slice(start, end)) });
      }
    } catch (err) {
      await OpenWLMNative.abortSave({ id }).catch(() => { /* déjà abandonné côté natif */ });
      throw err;
    }
    return (await OpenWLMNative.finishSave({ id })).saved;
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return true;
};

/** Jeton FCM de cette installation de l'app (null hors app ou sans Firebase). */
export const getNativeFcmToken = async (): Promise<string | null> => {
  if (!isNativeApp()) return null;
  // Firebase peut ne pas répondre hors ligne : ne jamais bloquer (déconnexion, mot de passe…)
  const res = await withTimeout(OpenWLMNative.getFcmToken(), 5000, { token: null });
  return res.token;
};

export const getNativeNotificationPermission = async (): Promise<NativeNotificationPermission | null> =>
  isNativeApp() ? (await OpenWLMNative.getNotificationPermission().catch(() => null))?.state ?? null : null;

export const requestNativeNotificationPermission = async (): Promise<NativeNotificationPermission | null> =>
  isNativeApp() ? (await OpenWLMNative.requestNotificationPermission().catch(() => null))?.state ?? null : null;

export const openNativeNotificationSettings = (): Promise<void> =>
  isNativeApp() ? OpenWLMNative.openNotificationSettings() : Promise.resolve();

/**
 * Session révoquée : le jeton FCM de cette installation est supprimé chez Firebase (il ne
 * sert plus à rien côté serveur, qui l'a déjà effacé). Un nouveau est créé à la connexion.
 */
export const resetNativePushToken = async (): Promise<void> => {
  if (isNativeApp() && hasNativeMethod('resetPushToken')) await withTimeout(OpenWLMNative.resetPushToken(), 5000, undefined);
};

/** Langue de l'app, pour les notifications construites par le code natif. */
export const setNativeLanguage = (lang: string): void => {
  if (isNativeApp()) OpenWLMNative.setLanguage({ lang }).catch(() => { /* ignore */ });
};

/**
 * Réglages Sons de l'app (sons coupés, catégorie, « Occupé ») pour les notifications natives :
 * son de l'app pour un message ou un Wizz reçu app fermée, ou notification silencieuse.
 */
export const setNativeSoundPrefs = (prefs: { message: boolean; nudge: boolean }): void => {
  if (isNativeApp() && hasNativeMethod('setSoundPrefs')) OpenWLMNative.setSoundPrefs(prefs).catch(() => { /* ignore */ });
};

/** Retour de l'écran de choix du serveur sans changement (annulé ou même serveur). */
export const onNativeServerChangeCancelled = (handler: () => void): Promise<PluginListenerHandle> | null =>
  isNativeApp() ? OpenWLMNative.addListener('serverChangeCancelled', handler) : null;

export const onNativeFcmToken = (handler: (token: string) => void): Promise<PluginListenerHandle> | null =>
  isNativeApp() ? OpenWLMNative.addListener('fcmToken', (data) => handler(data.token)) : null;

/** Notification touchée ; `answer` : « Répondre » à l'appel de `senderId`. */
export const onNativeOpenChat = (handler: (senderId: number, answer: boolean) => void): Promise<PluginListenerHandle> | null =>
  isNativeApp() ? OpenWLMNative.addListener('openChat', (data) => handler(Number(data.senderId), !!data.answer)) : null;

// --- Appels (étape 3 : écran d'appel et service d'appel natifs) ---------------------------

/** L'interface affiche l'appel de `callerId` : l'écran d'appel natif et sa sonnerie s'arrêtent. */
export const dismissNativeIncomingCall = (callerId: number): void => {
  if (isNativeApp() && callerId) OpenWLMNative.dismissIncomingCall({ callerId }).catch(() => { /* ignore */ });
};

/**
 * Appel établi ou en cours d'établissement, dans l'app : service d'appel Android (app et audio
 * actifs écran éteint, écouteur + capteur de proximité, notification avec Raccrocher).
 * Remplace startCallKeepAlive. Renvoie la fonction d'arrêt.
 */
export const startNativeCall = (opts: { peerName: string; video: boolean; onHangUp: () => void }): (() => void) => {
  OpenWLMNative.startOngoingCall({ peerName: opts.peerName, video: opts.video }).catch(() => { /* service refusé : l'appel continue */ });
  const listener = OpenWLMNative.addListener('hangUp', () => opts.onHangUp());
  return () => {
    listener.then((h) => h.remove()).catch(() => { /* ignore */ });
    OpenWLMNative.stopOngoingCall().catch(() => { /* ignore */ });
  };
};

/** Vidéo active pendant l'appel : haut-parleur et écran allumé (remplace keepScreenOn). */
export const setNativeCallVideo = (video: boolean): void => {
  if (!isNativeApp()) return;
  OpenWLMNative.updateOngoingCall({ video }).catch(() => { /* ignore */ });
  OpenWLMNative.setKeepScreenOn({ on: video }).catch(() => { /* ignore */ });
};

/** L'app Android affiche son écran de verrouillage (empreinte / code pas encore donnés). */
export const isNativeAppLocked = async (): Promise<boolean> => {
  if (!isNativeApp()) return false;
  try {
    return (await OpenWLMNative.isAppLocked()).locked;
  } catch {
    return false;
  }
};

export const setNativeKeepScreenOn = (on: boolean): void => {
  if (isNativeApp()) OpenWLMNative.setKeepScreenOn({ on }).catch(() => { /* ignore */ });
};

export const getNativeCallPermissions = (): Promise<NativeCallPermissions | null> =>
  isNativeApp() ? OpenWLMNative.getCallPermissions().catch(() => null) : Promise.resolve(null);

export const requestNativeCallPermission = (kind: 'microphone' | 'camera' | 'fullScreen'): Promise<void> =>
  isNativeApp() ? OpenWLMNative.requestCallPermission({ kind }).catch(() => { /* refusé */ }) : Promise.resolve();

// --- Verrouillage des clés (étape 4 : Keystore + empreinte / code, APK v11+) -----------------

/**
 * Nouveau secret aléatoire (base64, 32 octets) et sa copie chiffrée par la clé du Keystore
 * (`blob`, à garder avec la clé scellée). Demande l'empreinte ou le code si besoin. Erreurs :
 * « cancelled », « invalidated », « unavailable », « failed ».
 */
export const nativeDeviceSecretCreate = (): Promise<{ secret: string; blob: string }> => OpenWLMNative.deviceSecretCreate();

/** Rend le secret correspondant à `blob` (demande l'empreinte ou le code si besoin). */
export const nativeDeviceSecretUnlock = (blob: string): Promise<{ secret: string }> => OpenWLMNative.deviceSecretUnlock({ blob });
