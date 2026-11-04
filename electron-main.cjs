const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Origine du serveur OpenWLM
// ---------------------------------------------------------------------------
// L'application de bureau est un client : elle n'embarque PAS le serveur, elle
// s'y connecte. L'URL est résolue dans cet ordre (la première valeur gagne) :
//   1. Variable d'environnement OPENWLM_URL  (dev, CI, utilisateurs avancés)
//   2. config.json dans le dossier userData  ({ "serverUrl": "https://..." })
//   3. Défaut http://localhost:3001          (rétro-compatible : `npm start`)
//
// Pour pointer vers une instance OpenWLM auto-hébergée, l'utilisateur crée
// <userData>/config.json avec { "serverUrl": "https://mon-serveur.example" }.
// Le chemin exact de userData est journalisé au démarrage.
const DEFAULT_URL = 'http://localhost:3001';

function readConfigUrl() {
  try {
    const cfgPath = path.join(app.getPath('userData'), 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (cfg && typeof cfg.serverUrl === 'string' && cfg.serverUrl.trim()) {
      return cfg.serverUrl.trim();
    }
  } catch {
    // pas de config.json lisible : on passe au défaut
  }
  return null;
}

function resolveAppUrl() {
  const fromEnv = (process.env.OPENWLM_URL || '').trim();
  if (fromEnv) return fromEnv;
  const fromCfg = readConfigUrl();
  if (fromCfg) return fromCfg;
  return DEFAULT_URL;
}

// Permissions strictement nécessaires à l'application :
// - media : appels audio/vidéo WebRTC (getUserMedia)
// - notifications : alertes système et notifications push
// - idle-detection : option « inactivité de tout l'ordinateur » (statut Absent automatique)
// Tout le reste (géolocalisation, USB, Bluetooth, MIDI, etc.) est refusé.
const ALLOWED_PERMISSIONS = new Set(['media', 'notifications', 'idle-detection']);

/**
 * Indique si une URL est une URL web externe chargeable dans le navigateur système.
 */
function isExternalWebUrl(rawUrl, appOrigin) {
  try {
    const { protocol, origin } = new URL(rawUrl);
    return (protocol === 'http:' || protocol === 'https:') && origin !== appOrigin;
  } catch {
    return false;
  }
}

/**
 * Création de la fenêtre principale de l'application
 */
function createWindow() {
  const appUrl = resolveAppUrl();
  let appOrigin;
  try {
    appOrigin = new URL(appUrl).origin;
  } catch {
    console.error(`[OpenWLM] URL de serveur invalide : "${appUrl}" — repli sur ${DEFAULT_URL}`);
    appOrigin = new URL(DEFAULT_URL).origin;
  }
  console.log(`[OpenWLM] Serveur : ${appUrl}`);
  console.log(`[OpenWLM] Config utilisateur : ${path.join(app.getPath('userData'), 'config.json')}`);

  const win = new BrowserWindow({
    width: 1000,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'OpenWLM',
    icon: path.join(__dirname, 'build/icon.png'),
    webPreferences: {
      // Durcissement du renderer : la web app ne requiert aucun accès natif.
      // Le contenu distant (messages, fichiers, liens) ne doit jamais pouvoir
      // atteindre Node ni l'API Electron.
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
    },
    // WLM 2009 avait un cadre personnalisé (custom frame), désactivé ici pour la stabilité
    // frame: false,
  });

  // Toute navigation hors de l'origine de l'application est déviée vers le
  // navigateur système au lieu d'être chargée dans la fenêtre Electron.
  win.webContents.on('will-navigate', (event, url) => {
    if (isExternalWebUrl(url, appOrigin)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // Interdit l'ouverture de nouvelles fenêtres Electron (window.open, target=_blank).
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // N'accorde que les permissions nécessaires ; tout le reste est refusé.
  const { session } = win.webContents;
  session.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });
  session.setPermissionCheckHandler((_webContents, permission) => {
    return ALLOWED_PERMISSIONS.has(permission);
  });

  // Chargement de l'URL du serveur OpenWLM (local ou distant selon la config)
  win.loadURL(appUrl);

  // Ouvrir les outils de développement en mode dev si nécessaire
  if (!app.isPackaged) {
    // win.webContents.openDevTools();
  }
}

/**
 * Initialisation de l'application Electron
 */
app.whenReady().then(createWindow);

/**
 * Gestion de la fermeture de toutes les fenêtres
 */
app.on('window-all-closed', () => {
  // Sur macOS, l'application reste généralement active jusqu'à ce que l'utilisateur quitte explicitement
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

/**
 * Réactivation de l'application (macOS)
 */
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
