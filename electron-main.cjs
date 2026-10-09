const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const isDev = require('electron-is-dev');

// Origine unique servie par le backend Express (qui sert aussi le build Vite).
// Toute navigation hors de cette origine est considérée comme externe.
const APP_URL = 'http://localhost:3001';
const APP_ORIGIN = new URL(APP_URL).origin;

// Permissions strictement nécessaires à l'application :
// - media : appels audio/vidéo WebRTC (getUserMedia)
// - notifications : alertes système et notifications push
// Tout le reste (géolocalisation, USB, Bluetooth, MIDI, etc.) est refusé.
const ALLOWED_PERMISSIONS = new Set(['media', 'notifications']);

/**
 * Indique si une URL est une URL web externe chargeable dans le navigateur système.
 */
function isExternalWebUrl(rawUrl) {
  try {
    const { protocol, origin } = new URL(rawUrl);
    return (protocol === 'http:' || protocol === 'https:') && origin !== APP_ORIGIN;
  } catch {
    return false;
  }
}

/**
 * Création de la fenêtre principale de l'application
 */
function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'OpenWLM',
    icon: path.join(__dirname, 'public/assets/usertiles/chess.png'),
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
    if (isExternalWebUrl(url)) {
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

  // Chargement de l'URL du serveur Express (qui sert le build Vite)
  win.loadURL(APP_URL);

  // Ouvrir les outils de développement en mode dev si nécessaire
  if (isDev) {
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
