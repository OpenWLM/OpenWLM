const { app, BrowserWindow, shell, ipcMain, Menu, session } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');

// ---------------------------------------------------------------------------
// Origine du serveur OpenWLM
// ---------------------------------------------------------------------------
// L'application de bureau est un client : elle n'embarque PAS le serveur, elle
// s'y connecte. L'adresse est résolue dans cet ordre :
//   1. Variable d'environnement OPENWLM_URL        (dev, CI, utilisateurs avancés)
//   2. config.json dans le dossier userData        ({ "serverUrl": "https://..." })
//   3. En DÉVELOPPEMENT uniquement : http://localhost:3001 (compat `npm start`)
//   4. En version installée sans config : fenêtre de configuration au 1er lancement
//
// L'adresse saisie au 1er lancement est enregistrée dans <userData>/config.json et
// modifiable ensuite via le menu « Serveur → Changer de serveur… ».
const DEFAULT_URL = 'http://localhost:3001';

// Résolus une fois l'app prête, réutilisés par toutes les fenêtres.
let APP_URL = DEFAULT_URL;
let APP_ORIGIN = new URL(DEFAULT_URL).origin;

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function readConfigUrl() {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    if (cfg && typeof cfg.serverUrl === 'string' && cfg.serverUrl.trim()) {
      return cfg.serverUrl.trim();
    }
  } catch {
    // pas de config.json lisible
  }
  return null;
}

function writeConfigUrl(url) {
  fs.writeFileSync(configPath(), JSON.stringify({ serverUrl: url }, null, 2), 'utf8');
}

/** Hôte de la machine locale (seul cas où HTTP reste accepté). */
function isLoopbackHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/**
 * Ajoute https:// si le schéma est absent, valide la forme et impose HTTPS hors de la
 * machine locale (comme l'app Android) : en HTTP, l'interface et la clé de connexion
 * transiteraient en clair. Renvoie { url } (l'origine seule) ou { error }.
 */
function normalizeUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return { error: 'Adresse invalide.' };
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try {
    u = new URL(s);
  } catch {
    return { error: 'Adresse invalide.' };
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopbackHost(u.hostname))) {
    return { error: 'HTTPS obligatoire (HTTP seulement pour un serveur sur cet ordinateur).' };
  }
  // On retire un éventuel chemin / slash final superflu : on garde l'origine.
  return { url: u.origin };
}

/** Adresse déjà configurée (env ou config.json) et acceptable, ou null. */
function configuredUrl() {
  for (const [source, raw] of [['OPENWLM_URL', (process.env.OPENWLM_URL || '').trim()], ['config.json', readConfigUrl()]]) {
    if (!raw) continue;
    const { url, error } = normalizeUrl(raw);
    if (url) return url;
    console.warn(`[OpenWLM] Adresse ignorée (${source}) : ${error}`);
  }
  return null;
}

/**
 * Vérifie que l'adresse répond comme un serveur OpenWLM (GET /api/push/status).
 * Comme l'app Android, ce n'est PAS une authentification : juste un test de joignabilité.
 */
function probeServer(originUrl) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL('/api/push/status', originUrl);
    } catch {
      resolve({ ok: false, error: 'Adresse invalide.' });
      return;
    }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(
      u,
      { method: 'GET', timeout: 8000 },
      (res) => {
        // On consomme et on ignore le corps ; un code HTTP = serveur joignable.
        res.resume();
        if (res.statusCode && res.statusCode < 500) {
          resolve({ ok: true });
        } else {
          resolve({ ok: false, error: `Le serveur a répondu ${res.statusCode}.` });
        }
      }
    );
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Délai dépassé.' }); });
    req.on('error', (e) => resolve({ ok: false, error: `Injoignable : ${e.message}` }));
    req.end();
  });
}

function applyUrl(url) {
  APP_URL = url;
  try {
    APP_ORIGIN = new URL(url).origin;
  } catch {
    APP_URL = DEFAULT_URL;
    APP_ORIGIN = new URL(DEFAULT_URL).origin;
  }
}

// Permissions strictement nécessaires :
// - media : appels audio/vidéo WebRTC (getUserMedia)
// - notifications : alertes système et notifications push
// - idle-detection : statut Absent automatique (inactivité de tout l'ordinateur)
const ALLOWED_PERMISSIONS = new Set(['media', 'notifications', 'idle-detection']);

function originOf(rawUrl) {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return null;
  }
}

function isWebUrl(rawUrl) {
  try {
    const { protocol } = new URL(rawUrl);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Navigation du cadre principal : seule l'origine du serveur reste dans l'application.
 * Un lien web externe s'ouvre dans le navigateur système ; tout autre schéma (file:, data:,
 * javascript:, schémas d'applications…) est simplement refusé.
 */
function guardNavigation(event, url) {
  if (originOf(url) === APP_ORIGIN) return;
  event.preventDefault();
  if (isWebUrl(url)) shell.openExternal(url);
}

/** Durcissement commun à toutes les fenêtres de l'application. */
function hardenWindow(win) {
  win.webContents.on('will-navigate', guardNavigation);
  win.webContents.on('will-redirect', guardNavigation);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

/**
 * Permissions de la session (partagée par toutes les fenêtres) : uniquement celles de
 * ALLOWED_PERMISSIONS, et uniquement pour l'origine du serveur configuré (pas pour la page
 * de configuration locale ni pour un éventuel cadre d'une autre origine).
 */
function installPermissionHandlers() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const origin = originOf(details && (details.requestingUrl || details.securityOrigin));
    callback(ALLOWED_PERMISSIONS.has(permission) && origin === APP_ORIGIN);
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    return ALLOWED_PERMISSIONS.has(permission) && originOf(requestingOrigin) === APP_ORIGIN;
  });
}

const COMMON_WEB_PREFERENCES = {
  preload: path.join(__dirname, 'preload.cjs'),
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  webviewTag: false,
};

let setupWindow = null;

/** Fenêtre principale (liste de contacts + conversations en onglets). */
function createMainWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'OpenWLM',
    icon: path.join(__dirname, 'build/icon.png'),
    webPreferences: COMMON_WEB_PREFERENCES,
  });
  hardenWindow(win);
  win.loadURL(APP_URL);
  return win;
}

/**
 * Fenêtre de conversation détachée (« une fenêtre par conversation » du vrai WLM).
 * On recharge la même SPA avec ?detached=<id> : la session (cookie + coffre IndexedDB)
 * étant partagée entre fenêtres, auth et chiffrement fonctionnent à l'identique.
 */
function openConversationWindow(contactId) {
  const id = Number(contactId);
  if (!Number.isInteger(id) || id <= 0) return;

  const existing = BrowserWindow.getAllWindows().find((w) => w.openwlmChatId === id);
  if (existing) { existing.focus(); return; }

  const sep = APP_URL.includes('?') ? '&' : '?';
  const win = new BrowserWindow({
    width: 420,
    height: 640,
    minWidth: 320,
    minHeight: 420,
    title: 'OpenWLM',
    icon: path.join(__dirname, 'build/icon.png'),
    webPreferences: COMMON_WEB_PREFERENCES,
  });
  win.openwlmChatId = id;
  hardenWindow(win);
  win.loadURL(`${APP_URL}${sep}detached=${id}`);
}

/** Fenêtre de configuration du serveur (1er lancement ou changement). */
function openSetupWindow() {
  if (setupWindow && !setupWindow.isDestroyed()) { setupWindow.focus(); return; }
  setupWindow = new BrowserWindow({
    width: 480,
    height: 440,
    resizable: false,
    title: 'OpenWLM — Configuration',
    icon: path.join(__dirname, 'build/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'desktop/preload-setup.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  setupWindow.setMenuBarVisibility(false);
  // Page locale sans contenu distant : aucune navigation ni nouvelle fenêtre autorisée.
  setupWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  setupWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  setupWindow.loadFile(path.join(__dirname, 'desktop/setup.html'));
  setupWindow.on('closed', () => { setupWindow = null; });
}

/** L'IPC applicatif n'est accepté que depuis le cadre principal servi par le serveur configuré. */
function isTrustedAppSender(event) {
  try {
    const frame = event.senderFrame;
    return !!frame && frame === event.sender.mainFrame && new URL(frame.url).origin === APP_ORIGIN;
  } catch {
    return false;
  }
}

/** L'IPC de configuration n'est accepté que depuis la fenêtre de configuration locale. */
function isSetupSender(event) {
  return !!setupWindow && !setupWindow.isDestroyed() && event.sender === setupWindow.webContents;
}

// --- IPC : conversations détachées ---------------------------------------------------------
ipcMain.on('open-conversation-window', (event, contactId) => {
  if (!isTrustedAppSender(event)) return;
  openConversationWindow(contactId);
});

// --- IPC : fenêtre de configuration --------------------------------------------------------
ipcMain.handle('openwlm-setup:default-url', (event) => {
  if (!isSetupSender(event)) return '';
  return configuredUrl() || (app.isPackaged ? '' : DEFAULT_URL);
});

ipcMain.handle('openwlm-setup:save', async (event, rawUrl) => {
  if (!isSetupSender(event)) return { ok: false, error: 'Requête refusée.' };
  const { url, error } = normalizeUrl(rawUrl);
  if (!url) return { ok: false, error };
  const probe = await probeServer(url);
  if (!probe.ok) return probe;
  try {
    writeConfigUrl(url);
  } catch (e) {
    return { ok: false, error: `Impossible d'enregistrer : ${e.message}` };
  }
  // Changement de serveur : on ferme les fenêtres pointant vers l'ancienne origine
  // (fenêtre principale et conversations détachées) avant d'ouvrir la nouvelle.
  const toClose = setupWindow;
  setupWindow = null;
  const stale = BrowserWindow.getAllWindows().filter((w) => w !== toClose);
  applyUrl(url);
  createMainWindow();
  for (const w of stale) if (!w.isDestroyed()) w.close();
  if (toClose && !toClose.isDestroyed()) toClose.close();
  return { ok: true };
});

/** Menu applicatif minimal : changer de serveur + rôles d'édition usuels. */
function buildMenu() {
  const template = [
    {
      label: 'Serveur',
      submenu: [
        { label: 'Changer de serveur…', click: () => openSetupWindow() },
        { type: 'separator' },
        { role: 'quit', label: 'Quitter' },
      ],
    },
    { label: 'Édition', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ] },
    { label: 'Affichage', submenu: [
      { role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' }, { role: 'togglefullscreen' },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  installPermissionHandlers();
  buildMenu();
  const existing = configuredUrl();
  if (existing) {
    applyUrl(existing);
    console.log(`[OpenWLM] Serveur : ${APP_URL}`);
    createMainWindow();
  } else if (!app.isPackaged) {
    // Développement : connexion directe au serveur local (compat `npm start`).
    applyUrl(DEFAULT_URL);
    console.log(`[OpenWLM] Serveur (dev) : ${APP_URL}`);
    createMainWindow();
  } else {
    // Version installée sans configuration : demander l'adresse au 1er lancement.
    console.log(`[OpenWLM] Aucun serveur configuré — fenêtre de configuration (${configPath()})`);
    openSetupWindow();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    if (configuredUrl() || !app.isPackaged) createMainWindow();
    else openSetupWindow();
  }
});
