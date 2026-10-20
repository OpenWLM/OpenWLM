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
  addListener(event: 'openChat', handler: (data: { senderId: number }) => void): Promise<PluginListenerHandle>;
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

export const onNativeOpenChat = (handler: (senderId: number) => void): Promise<PluginListenerHandle> | null =>
  isNativeApp() ? OpenWLMNative.addListener('openChat', (data) => handler(Number(data.senderId))) : null;
