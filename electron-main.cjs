const { app, BrowserWindow } = require('electron');
const path = require('path');
const isDev = require('electron-is-dev');

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
      // Note de sécurité : nodeIntegration est activé pour simplifier le développement
      // Dans une application de production, il serait préférable d'utiliser contextIsolation: true
      nodeIntegration: true,
      contextIsolation: false,
    },
    // WLM 2009 avait un cadre personnalisé (custom frame), désactivé ici pour la stabilité
    // frame: false, 
  });

  // Chargement de l'URL du serveur Express (qui sert le build Vite)
  win.loadURL('http://localhost:3001');

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
