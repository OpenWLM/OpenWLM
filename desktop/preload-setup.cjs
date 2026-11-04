// Pont sécurisé de la fenêtre de configuration (1er lancement / changement de serveur).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('openwlmSetup', {
  // URL pré-remplie proposée (dernier serveur, ou défaut).
  defaultUrl: () => ipcRenderer.invoke('openwlm-setup:default-url'),
  // Valide l'adresse, l'enregistre et ouvre l'application. -> { ok } | { ok:false, error }
  save: (url) => ipcRenderer.invoke('openwlm-setup:save', String(url || '')),
});
