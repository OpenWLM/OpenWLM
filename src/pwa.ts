/**
 * Gestionnaire PWA pour l'enregistrement du Service Worker
 * et la capture de l'événement d'installation native (beforeinstallprompt)
 */

let deferredInstallPrompt: any = null;
const installListeners: Array<(canInstall: boolean) => void> = [];

export function initPWA() {
  if (typeof window === 'undefined') return;

  // Enregistrer le Service Worker uniquement en environnement navigateur supporté
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('/sw.js', { scope: '/' })
        .then((registration) => {
          console.log('[PWA] Service Worker enregistré avec succès, scope:', registration.scope);

          registration.onupdatefound = () => {
            const installingWorker = registration.installing;
            if (installingWorker) {
              installingWorker.onstatechange = () => {
                if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
                  console.log('[PWA] Nouvelle version disponible.');
                }
              };
            }
          };
        })
        .catch((error) => {
          console.error('[PWA] Échec enregistrement Service Worker:', error);
        });
    });
  }

  // Capturer l'événement d'installation PWA
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    installListeners.forEach(listener => listener(true));
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    installListeners.forEach(listener => listener(false));
    console.log('[PWA] OpenWLM installé avec succès.');
  });
}

export function onInstallAvailabilityChange(callback: (canInstall: boolean) => void): () => void {
  installListeners.push(callback);
  callback(deferredInstallPrompt !== null);
  return () => {
    const index = installListeners.indexOf(callback);
    if (index !== -1) installListeners.splice(index, 1);
  };
}

export async function promptPWAInstall(): Promise<boolean> {
  if (!deferredInstallPrompt) return false;
  try {
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    installListeners.forEach(listener => listener(false));
    return outcome === 'accepted';
  } catch (err) {
    console.error('[PWA] Erreur lors du prompt d\'installation:', err);
    return false;
  }
}
