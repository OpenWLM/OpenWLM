# Client de bureau (Electron)

Le client de bureau est une **coquille [Electron](https://www.electronjs.org/)** durcie
(`electron-main.cjs`) autour de l'interface web. Comme les clients Android et PWA, il ne
contient **pas** l'interface : il la charge depuis le serveur OpenWLM choisi. On ne
réimplémente donc ni l'authentification zero-knowledge ni le chiffrement E2EE — c'est le
même code client que sur le web, servi par le serveur.

## Lancer en développement

```bash
npm start           # build + serveur local (:3001) + fenêtre Electron
# ou, serveur déjà lancé par ailleurs :
npm run electron
```

## Construire les installeurs

L'empaquetage utilise [electron-builder](https://www.electron.build/). La coquille
n'embarque **aucun module natif** (le serveur — `better-sqlite3`, `sharp`… — n'est pas
empaqueté), l'installeur reste donc léger.

```bash
npm run dist          # installeur pour l'OS courant
npm run dist:linux    # AppImage + .deb
npm run dist:win      # installeur NSIS (.exe)   — nécessite Windows ou Wine
npm run dist:mac      # .dmg                      — nécessite macOS
```

Les artefacts sont écrits dans `release/`. Chaque OS doit en principe être construit sur
sa propre plateforme (ou en CI) : un `.dmg` exige macOS, un `.exe` NSIS exige Windows ou
Wine ; Linux (AppImage/.deb) se construit nativement sous Linux.

## Choix du serveur

L'application se connecte à un serveur OpenWLM, résolu dans cet ordre (première valeur
retenue) :

1. **Variable d'environnement** `OPENWLM_URL` (dev, CI, utilisateurs avancés) ;
2. **Fichier de config** `config.json` dans le dossier *userData* de l'application, au
   format `{ "serverUrl": "https://mon-serveur.example" }` ;
3. **Défaut** `http://localhost:3001` (rétro-compatible avec `npm start`).

Le chemin exact de `config.json` est journalisé au démarrage (console du processus
principal). Emplacements habituels de *userData* :

| OS | Chemin |
|---|---|
| Linux | `~/.config/openwlm/config.json` |
| Windows | `%APPDATA%\openwlm\config.json` |
| macOS | `~/Library/Application Support/openwlm/config.json` |

> ⚠️ **Serveur de confiance uniquement**, comme pour l'app Android : le serveur choisi
> affiche l'interface, reçoit l'identifiant et la clé de connexion, et accède aux API
> natives via Electron. Ne pointez l'app que vers un serveur OpenWLM que vous contrôlez ou
> en qui vous avez confiance. (Un sélecteur de serveur au premier lancement, comme sur
> Android, est une évolution naturelle de cette coquille.)

## Durcissement

La coquille conserve le durcissement d'Electron déjà en place : `contextIsolation`,
`sandbox`, `nodeIntegration: false`, `webSecurity`, pas de `webviewTag`. Les permissions
accordées se limitent à `media` (WebRTC), `notifications` et `idle-detection` ; toute
navigation hors de l'origine du serveur est renvoyée vers le navigateur système, et
l'ouverture de nouvelles fenêtres Electron est interdite.
