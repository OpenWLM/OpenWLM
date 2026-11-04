// Pont sécurisé renderer <-> processus principal (contextIsolation + sandbox).
// N'expose qu'une surface minuscule et typée : rien de Node, rien d'Electron brut.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('openwlmDesktop', {
  // Permet au client web de détecter qu'il tourne dans la coquille de bureau
  // (pour afficher l'action « détacher en fenêtre »).
  isDesktop: true,

  // Demande au processus principal d'ouvrir une conversation dans une fenêtre
  // séparée (comme le vrai WLM). Seul un identifiant entier positif est transmis.
  openConversation: (contactId) => {
    const id = Number(contactId);
    if (Number.isInteger(id) && id > 0) {
      ipcRenderer.send('open-conversation-window', id);
    }
  },
});
