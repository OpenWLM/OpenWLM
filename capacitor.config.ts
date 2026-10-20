import type { CapacitorConfig } from '@capacitor/cli';

// Configuration de l'app Android (docs/ANDROID.md).
// L'app charge l'interface depuis le serveur choisi au premier lancement (par défaut
// la prod) : le serveur effectif est fixé à l'exécution par MainActivity, ces valeurs
// ne servent que de repli. webDir ne contient que la page hors ligne.
const config: CapacitorConfig = {
  appId: 'org.openwlm.dev',
  appName: 'OpenWLM',
  webDir: 'android-web',
  server: {
    url: 'https://messenger.guifort.ovh',
    hostname: 'messenger.guifort.ovh',
    androidScheme: 'https',
    allowNavigation: ['messenger.guifort.ovh'],
    errorPath: 'offline.html',
  },
  android: {
    allowMixedContent: false,
    webContentsDebuggingEnabled: false,
  },
};

export default config;
