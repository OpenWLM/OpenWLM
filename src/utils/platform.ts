/**
 * Détection de l'app Android (coquille Capacitor, docs/ANDROID.md) et pont vers ses
 * fonctions natives. Dans un navigateur, tout se replie sur le comportement web.
 */
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

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
  saveFile(options: { fileName: string; mimeType: string; data: string }): Promise<{ saved: boolean; location?: string }>;
  getFcmToken(): Promise<{ token: string | null }>;
  getNotificationPermission(): Promise<{ state: NativeNotificationPermission }>;
  requestNotificationPermission(): Promise<{ state: NativeNotificationPermission }>;
  openNotificationSettings(): Promise<void>;
  setLanguage(options: { lang: string }): Promise<void>;
  addListener(event: 'fcmToken', handler: (data: { token: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'openChat', handler: (data: { senderId: number; answer?: boolean }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'hangUp', handler: () => void): Promise<PluginListenerHandle>;
  dismissIncomingCall(options: { callerId: number }): Promise<void>;
  startOngoingCall(options: { peerName: string; video: boolean }): Promise<void>;
  updateOngoingCall(options: { video: boolean }): Promise<void>;
  stopOngoingCall(): Promise<void>;
  setKeepScreenOn(options: { on: boolean }): Promise<void>;
  getCallPermissions(): Promise<NativeCallPermissions>;
  requestCallPermission(options: { kind: 'microphone' | 'camera' | 'fullScreen' }): Promise<void>;
}

const OpenWLMNative = registerPlugin<OpenWLMNativePlugin>('OpenWLMNative');

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

/**
 * Enregistre un fichier sur l'appareil.
 * Navigateur : lien de téléchargement. App Android : la WebView ignore ces liens, le fichier
 * passe par le code natif (dossier Téléchargements). Renvoie false si l'utilisateur a annulé.
 */
export const saveBlob = async (blob: Blob, fileName: string): Promise<boolean> => {
  if (isNativeApp()) {
    const data = await blobToBase64(blob);
    const res = await OpenWLMNative.saveFile({ fileName, mimeType: blob.type || 'application/octet-stream', data });
    return res.saved;
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
  try {
    return (await OpenWLMNative.getFcmToken()).token;
  } catch {
    return null;
  }
};

export const getNativeNotificationPermission = async (): Promise<NativeNotificationPermission | null> =>
  isNativeApp() ? (await OpenWLMNative.getNotificationPermission().catch(() => null))?.state ?? null : null;

export const requestNativeNotificationPermission = async (): Promise<NativeNotificationPermission | null> =>
  isNativeApp() ? (await OpenWLMNative.requestNotificationPermission().catch(() => null))?.state ?? null : null;

export const openNativeNotificationSettings = (): Promise<void> =>
  isNativeApp() ? OpenWLMNative.openNotificationSettings() : Promise.resolve();

/** Langue de l'app, pour les notifications construites par le code natif. */
export const setNativeLanguage = (lang: string): void => {
  if (isNativeApp()) OpenWLMNative.setLanguage({ lang }).catch(() => { /* ignore */ });
};

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

export const getNativeCallPermissions = (): Promise<NativeCallPermissions | null> =>
  isNativeApp() ? OpenWLMNative.getCallPermissions().catch(() => null) : Promise.resolve(null);

export const requestNativeCallPermission = (kind: 'microphone' | 'camera' | 'fullScreen'): Promise<void> =>
  isNativeApp() ? OpenWLMNative.requestCallPermission({ kind }).catch(() => { /* refusé */ }) : Promise.resolve();
