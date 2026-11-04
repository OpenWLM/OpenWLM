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

Au **premier lancement**, la version installée affiche une **fenêtre de configuration** :
l'utilisateur saisit l'adresse de son serveur OpenWLM, qui est validée (test de
joignabilité `GET /api/push/status`) puis enregistrée dans `config.json`. L'adresse est
modifiable ensuite via le menu **Serveur → Changer de serveur…**.

L'adresse est résolue dans cet ordre (première valeur retenue) :

1. **Variable d'environnement** `OPENWLM_URL` (dev, CI, utilisateurs avancés) ;
2. **Fichier de config** `config.json` dans le dossier *userData*, au format
   `{ "serverUrl": "https://mon-serveur.example" }` (écrit par la fenêtre de configuration) ;
3. **Développement uniquement** (`npm run electron` non empaqueté) : `http://localhost:3001`
   (compat `npm start`) ;
4. **Version installée sans config** : fenêtre de configuration au premier lancement.

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
> en qui vous avez confiance. Changer de serveur ferme toutes les fenêtres ouvertes sur
> l'ancien.

## Conversations en fenêtres séparées

Comme le vrai WLM, une conversation peut s'afficher dans **sa propre fenêtre**.

- **Option globale** : *Options → Mise en page → Conversations → « Ouvrir chaque conversation
  dans sa propre fenêtre »*. Activée, ouvrir une conversation ouvre une fenêtre ; désactivée,
  on reste en onglets. (Visible uniquement dans le client de bureau.)
- **Au cas par cas** : chaque onglet porte un bouton « détacher » (⧉) qui sort la
  conversation dans une fenêtre indépendante.

- Le processus principal ouvre une fenêtre chargeant la SPA avec `?detached=<id>` ; cette
  fenêtre n'affiche que la conversation (ni liste de contacts, ni onglets).
- Les fenêtres **partagent la session** (cookie + coffre IndexedDB) : pas de
  réauthentification, le chiffrement E2EE fonctionne à l'identique.
- Seul le processus principal crée des fenêtres (via un pont `preload` minimal) ; le
  contenu de la page ne peut pas en ouvrir (`setWindowOpenHandler` refuse tout).
- Le bouton n'apparaît que dans le client de bureau ; sur le web, rien ne change.
- Une fenêtre détachée ne réagit qu'à sa propre conversation : sons, wizz des autres
  contacts et notifications de connexion restent gérés par la fenêtre principale.
- Le pont `preload` n'accepte les demandes que du cadre principal servi par le serveur
  configuré ; la fenêtre de configuration a son propre pont, inaccessible aux autres fenêtres.

## Durcissement

La coquille conserve le durcissement d'Electron déjà en place : `contextIsolation`,
`sandbox`, `nodeIntegration: false`, `webSecurity`, pas de `webviewTag`.

- **HTTPS obligatoire** : comme l'app Android, l'adresse du serveur doit être en `https://`.
  HTTP n'est accepté que pour un serveur sur la machine elle-même (`localhost`, `127.0.0.1`,
  `[::1]`). Une adresse HTTP distante dans `OPENWLM_URL` ou `config.json` est ignorée
  (avertissement dans la console) ; la fenêtre de configuration la refuse.
- **Navigation** : seule l'origine du serveur reste dans l'application (navigations et
  redirections). Un lien web externe s'ouvre dans le navigateur système ; tout autre schéma
  (`file:`, `data:`, `javascript:`…) est refusé. L'ouverture de nouvelles fenêtres Electron
  par la page est interdite.
- **Permissions** : seulement `media` (WebRTC), `notifications` et `idle-detection`, et
  seulement pour l'origine du serveur configuré (ni la page de configuration locale, ni un
  cadre d'une autre origine).
