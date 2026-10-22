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
réservé à un usage local (hors des règles WAF, donc bloqué par Cloudflare).

## Option 3 — Docker

Utiliser une politique de redémarrage : `--restart unless-stopped` (ou
`restart: unless-stopped` dans `docker-compose.yml`).

## Anti-inscription de masse

Voir `.env.example` : `POW_DIFFICULTY` (preuve de travail à l'inscription, défaut 17)
et `SIGNUP_IP_DAILY_LIMIT` (comptes créés par IP sur 24 h, défaut 10). Derrière
Cloudflare, l'IP prise en compte est `CF-Connecting-IP` uniquement si la connexion
provient d'une plage Cloudflare (cf. `server/clientIdentity.js`).
