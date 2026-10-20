/**
 * Détection de l'app Android (coquille Capacitor, docs/ANDROID.md) et pont vers ses
 * fonctions natives. Dans un navigateur, tout se replie sur le comportement web.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';

export interface NativeAppInfo {
  server: string | null;
  defaultServer: string;
  versionName?: string;
  versionCode?: number;
  /** Le téléphone a un verrouillage d'écran : l'app est protégée par empreinte / code. */
  appLock: boolean;
}

interface OpenWLMNativePlugin {
  getInfo(): Promise<NativeAppInfo>;
  changeServer(): Promise<void>;
  saveFile(options: { fileName: string; mimeType: string; data: string }): Promise<{ saved: boolean; location?: string }>;
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
