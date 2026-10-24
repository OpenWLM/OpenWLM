# Déploiement en production — superviseur obligatoire

Le serveur OpenWLM **s'arrête volontairement** (code de sortie `1`) après une erreur
non gérée (`uncaughtException` / `unhandledRejection`). Après une telle erreur, l'état
du processus (Maps en mémoire, verrous, transactions, sockets) n'est plus fiable :
continuer à servir serait plus dangereux que redémarrer.

**Conséquence : il faut lancer le serveur sous un superviseur qui le relance
automatiquement.** Sans superviseur, une erreur fatale laisse le service arrêté.

Les erreurs dans les routes HTTP (gérées par Express 5) et dans les handlers
d'événements Socket.IO (confinées par `server/sockets/index.js`) ne déclenchent **pas**
cet arrêt : elles sont journalisées et seule la requête ou l'événement concerné échoue.

> ℹ️ L'état en mémoire (limiteurs de débit, captchas, parties et appels en cours) est
> perdu à chaque redémarrage. Les comptes, contacts et messages (SQLite) sont conservés.

## Option 1 — systemd (recommandé sur un serveur Linux)

`/etc/systemd/system/openwlm.service` :

```ini
[Unit]
Description=OpenWLM
After=network.target

[Service]
Type=simple
User=openwlm
WorkingDirectory=/opt/openwlm
Environment=NODE_ENV=production
EnvironmentFile=/opt/openwlm/.env
ExecStart=/usr/bin/node server/index.js
Restart=on-failure
RestartSec=2
# Évite une boucle de redémarrage infinie si le serveur plante au démarrage
StartLimitIntervalSec=60
StartLimitBurst=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now openwlm
journalctl -u openwlm -f        # journaux (les lignes [FATAL] indiquent un redémarrage)
```

## Option 2 — pm2

```bash
NODE_ENV=production pm2 start server/index.js --name openwlm --restart-delay 2000
pm2 save && pm2 startup
```

## Option 2 bis — service systemd (recommandé sur un serveur Linux)

`scripts/openwlm-service.sh install` installe OpenWLM comme **service systemd utilisateur** :
démarrage au boot, relance automatique en cas d'arrêt (2 s), journaux dans journald. Il
remplace pm2 (le processus pm2 `openwlm` est arrêté et retiré à l'installation).

- Le service tourne sous le compte propriétaire du dossier, **jamais en root** : le script
  refuse root (sudo compris) et tout autre compte.
- Service *utilisateur* : le relancer ne demande pas sudo. Seule l'installation demande sudo,
  une fois, pour `loginctl enable-linger` (démarrage au boot sans ouvrir de session).

```bash
./scripts/openwlm-service.sh install     # installe et démarre
./scripts/openwlm-service.sh restart     # après un déploiement (npm ci + npm run build d'abord)
./scripts/openwlm-service.sh status      # état + réponse HTTP
./scripts/openwlm-service.sh logs [-f]   # journaux
./scripts/openwlm-service.sh uninstall   # arrête et supprime
./scripts/openwlm-service.sh unit        # affiche le fichier de service sans rien installer
```

`restart` relance seulement le processus : il ne reconstruit pas l'interface. Après une mise à
jour des fichiers, faire `npm ci` (si `package-lock.json` a changé) puis `npm run build` (si
`src/` ou `public/` ont changé) **avant** `restart`. Une modification limitée à `src/` ne demande
même pas de redémarrage : le serveur sert `dist/` tel quel. Le serveur s'arrête proprement sur
SIGTERM (connexions temps réel et base fermées). Santé : `GET /api/health` (`{ "ok": true }`
si le serveur répond et que la base est lisible, 503 sinon), utilisé par `openwlm-service.sh` ;
réservé aux appels faits sur la machine même (adresse de bouclage, sans en-têtes Cloudflare) :
404 sinon.

**Exposition du port** : le serveur écoute sur toutes les interfaces (port 3001). Le tunnel
Cloudflare s'y connecte en local (`http://localhost:3001`), mais le port est aussi joignable
depuis le réseau local, en HTTP, sans Cloudflare ni WAF. À fermer par le pare-feu de la
machine (n'autoriser le port 3001 que depuis la boucle locale).

## Déploiement d'une version : `scripts/deploy.sh`

La prod (`~/OpenWLM`) n'est pas un dépôt git : on y **déploie** une version du clone git
(`~/OpenWLM_github_prep`), sans jamais y développer. Sur la machine de prod :

```bash
cd ~/OpenWLM_github_prep
git pull --ff-only                      # ou intégration d'un bundle / de patches
scripts/deploy.sh --dry-run             # ce qui changerait (HEAD par défaut)
scripts/deploy.sh                       # déploie, après confirmation
scripts/deploy.sh v1.7.1                # une version précise (tag, branche, commit)
scripts/deploy.sh <commit précédent>    # retour arrière
```

- Le contenu déployé est celui du **commit** (`git archive`), pas l'état du dossier de travail.
- Jamais touchés : `.env*` (sauf `.env.example`), `.jwt_secret`, `.vapid_keys.json`,
  `messenger.db*`, `uploads/`, `node_modules/`, `dist/`, `.ruffle/`, `public/ruffle/`.
- Copie les fichiers suivis par git qui diffèrent et supprime ceux que git a supprimés depuis
  la version déployée, notée dans `~/OpenWLM/.deployed-version` (commit, date, sauvegarde).
  Premier déploiement sans ce fichier : `--from <commit actuellement en prod>`.
- Avant d'écrire : sauvegarde des fichiers remplacés / supprimés et de la base (copie
  cohérente SQLite) dans `~/Archives/deploiements/<date>-<commit>/` (droits 600).
- Puis seulement si nécessaire (d'après l'écart git avec la version déployée) : `npm ci`
  (package*.json), build de l'interface (src/, public/…) **dans `dist.next` puis échangé d'un
  coup avec `dist/`** (jamais d'interface partielle ; l'ancienne va dans la sauvegarde),
  redémarrage (`server/`, dépendances) via `openwlm-service.sh restart`, qui attend
  `/api/health`.
- `.deployed-version` n'est écrit qu'une fois tout réussi (redémarrage et santé compris) : après
  un échec, relancer la même commande reprend ce qui manque (le build ou le redémarrage). Avec
  `--no-restart`, la version n'est pas enregistrée si un redémarrage était nécessaire.
- Rappel si `docs/cloudflare-waf.generated.json` a changé : mettre à jour Cloudflare d'abord.
- Prérequis : bash, git, tar, Node.js/npm (ceux du service). L'échange atomique de `dist/`
  utilise `mv --exchange` (GNU coreutils 9.5 ou plus récent) ; sur une distribution plus
  ancienne, le script fait deux renommages consécutifs (`dist/` absent quelques millisecondes).
- Options : `--yes` (sans confirmation), `--no-restart`, `--target <dossier>` (ex. une copie
  de test), `--from <commit>`.

## Option 3 — Docker

Utiliser une politique de redémarrage : `--restart unless-stopped` (ou
`restart: unless-stopped` dans `docker-compose.yml`).

## Anti-inscription de masse

Voir `.env.example` : `POW_DIFFICULTY` (preuve de travail à l'inscription, défaut 17)
et `SIGNUP_IP_DAILY_LIMIT` (comptes créés par IP sur 24 h, défaut 10). Derrière
Cloudflare, l'IP prise en compte est `CF-Connecting-IP` uniquement si la connexion
provient d'une plage Cloudflare (cf. `server/clientIdentity.js`).

**Tunnel cloudflared sur la même machine** (cas de la prod) : les requêtes arrivent de
l'adresse de bouclage, qui n'est pas une plage Cloudflare publique. Il faut donc, dans `.env` :

```
CLOUDFLARE_IP_RANGES=127.0.0.1/32,::1/128
```

Sans cette ligne, `CF-Connecting-IP` est ignoré, tous les visiteurs partagent l'IP
`127.0.0.1` et toutes les limites par IP (10 connexions/min, inscriptions par jour, uploads…)
s'appliquent au monde entier : quelques requêtes par minute suffisent à bloquer tout le monde.
Le serveur le signale au démarrage (`[IP client] … tunnel local NON reconnu`) et dans le
journal à la première requête Cloudflare concernée (`[Sécurité] Requête Cloudflare (cf-ray)
reçue depuis 127.0.0.1, hors des plages de confiance`).

## Portée de la clé d'authentification (`AUTH_KEY_SCOPE`) et changement de domaine

Le mot de passe ne quitte jamais l'appareil : le client en dérive une clé d'authentification
**liée à ce serveur**, pour qu'elle ne puisse pas être rejouée sur une autre instance
OpenWLM. Le serveur n'en garde qu'une empreinte.

La portée vaut `AUTH_KEY_SCOPE` (dans `.env`, annoncée par `GET /api/auth/scope`) ou, si elle
n'est pas définie, le nom d'hôte de la page (sans `www.`, port compris). **Définissez-la dès
l'installation** avec un nom stable (le nom de domaine actuel, par exemple) et ne la changez
plus :

```
AUTH_KEY_SCOPE=messenger.example.org
```

Avec elle, changer de nom de domaine, de port ou passer derrière un autre proxy ne change pas
la clé. Sans elle (ou si vous la modifiez), plus aucun compte déjà connecté une fois ne peut se
connecter : il faut alors ouvrir une **récupération**, avec un code par compte, valable pour une seule récupération réussie :

```bash
node scripts/auth-recovery.mjs alice@example.org          # 24 h ; affiche le code d'Alice
node scripts/auth-recovery.mjs --all --hours 72           # codes dans recovery-codes-<date>.txt (600)
node scripts/auth-recovery.mjs --close <identifiant|--all> # refermer avant l'échéance
node scripts/auth-recovery.mjs --log [identifiant]         # journal : ouvertures, essais, réussites
```

Remettez chaque code à son titulaire par un canal sûr (en personne, messagerie déjà de
confiance), puis supprimez le fichier de codes. L'utilisateur saisit sur l'écran de connexion
son identifiant, son mot de passe et le code (« J'ai un code de récupération ») : l'app prouve
le mot de passe en ouvrant le coffre de clés du compte (qui ne dépend pas de la portée) et
enregistre la nouvelle clé. Mot de passe, clés de chiffrement et historique sont conservés ;
**toutes les autres sessions du compte sont révoquées** et ses anciens appareils ne reçoivent
plus de notifications (utile aussi après la perte d'un appareil).

Garanties et limites :
- Sans le code, le serveur ne remet jamais le coffre (pas d'attaque hors ligne sur le mot de
  passe à partir du seul identifiant). Le code n'est stocké que sous forme d'empreinte et ne
  permet **qu'un seul changement de clé** : la récupération réussie l'efface. Jusque-là, il
  peut redemander le coffre plusieurs fois (mot de passe mal tapé, nouvel essai) : c'est le
  porteur du code qui est autorisé, d'où l'importance de le garder confidentiel. Les codes erronés sont limités à 5 par 15 minutes **par compte et par adresse
  IP**, sans refermer la fenêtre : un tiers qui connaît l'identifiant ne peut pas bloquer la
  récupération légitime (seule son adresse est bloquée). Chaque échec et chaque blocage sont
  journalisés (`--log`, et un avertissement dans le journal du service).
- Avec le code, le coffre chiffré est remis : quiconque obtient le code peut tenter une attaque
  hors ligne sur le mot de passe (PBKDF2 600 000 itérations). Gardez les fenêtres courtes et les
  codes confidentiels ; refermez-les (`--close`) dès que possible. Le fichier produit par
  `--all` (mode 600) contient les codes de tous les comptes : supprimez-le dès qu'ils sont
  distribués (le script le rappelle).
- Chaque étape est journalisée (table `auth_recovery_log` et journal du service), avec
  l'utilisateur système qui a ouvert la fenêtre.

La liaison au serveur protège contre une fuite **passive** (journaux d'un proxy, d'un WAF,
d'un opérateur) : la clé lue ne sert sur aucune autre instance. Elle ne protège pas contre un
serveur **actif** malveillant, qui sert lui-même le code de l'interface et peut lire le mot de
passe tapé ; d'où l'avertissement de l'app Android avant de faire confiance à un serveur.

