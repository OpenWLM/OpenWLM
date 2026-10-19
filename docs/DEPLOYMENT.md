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

Ou, plus simple, `scripts/start-openwlm.sh` : démarre (ou relance) le processus pm2
`openwlm` en production, reconstruit l'interface si `dist/` manque (`--build` pour forcer),
attend que le serveur réponde et affiche les journaux sinon (`--status` : état seulement).
Il **refuse de tourner en root** (sudo compris) et sous un autre compte que le propriétaire du
dossier (celui qui possède la base, les secrets et `~/.pm2`).

Relance automatique au démarrage de la machine, sans root (`crontab -e`) :

```
@reboot /chemin/vers/OpenWLM/scripts/start-openwlm.sh >> /chemin/vers/OpenWLM/logs/boot.log 2>&1
```

## Option 3 — Docker

Utiliser une politique de redémarrage : `--restart unless-stopped` (ou
`restart: unless-stopped` dans `docker-compose.yml`).

## Anti-inscription de masse

Voir `.env.example` : `POW_DIFFICULTY` (preuve de travail à l'inscription, défaut 17)
et `SIGNUP_IP_DAILY_LIMIT` (comptes créés par IP sur 24 h, défaut 10). Derrière
Cloudflare, l'IP prise en compte est `CF-Connecting-IP` uniquement si la connexion
provient d'une plage Cloudflare (cf. `server/clientIdentity.js`).
