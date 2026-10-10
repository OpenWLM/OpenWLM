# Architecture Serveur Modulaire d'OpenWLM

Ce document décrit l'organisation et le fonctionnement du backend modulaire d'**OpenWLM** après le découpage du monolithe historique `server/index.js` (~3 380 lignes) en modules spécialisés et découplés.

---

## 1. Arborescence des modules (`server/`)

```
server/
├── index.js                  # Point d'entrée principal, configuration Express & Socket.io (220 lignes)
├── db.js                     # Connexion SQLite, création du schéma & DTOs sanitaires
├── sessionStore.js           # Gestion des sessions mémoire Socket.io & rooms multi-appareils
├── clientIdentity.js         # Résolution certifiée de l'IP cliente (Cloudflare CIDRs)
├── accountRateLimiter.js     # Rate limiting logique par compte utilisateur
│
├── middleware/
│   └── auth.js               # authenticateToken, hash/verify Password, canInteract, rate limiters IP
│
├── routes/
│   ├── auth.js               # /api/login, /api/signup, /api/logout, /api/captcha, /api/user/me
│   ├── users.js              # Contacts, invitations, profil, clés E2E, reset d'urgence, mot de passe
│   ├── messages.js           # Historique des messages, curseurs de lecture, purge
│   ├── files.js              # Téléversement et téléchargement de fichiers E2EE (Multer, quotas, CSP)
│   ├── emoticons.js          # Émoticônes personnalisées E2EE (stockage, quotas, assets)
│   ├── push.js               # Passerelle Web Push VAPID (Android/PWA)
│   └── games.js              # /api/games/active et structures d'état de jeux
│
└── sockets/
    ├── index.js              # Handshake, authentification des sockets et routage des événements
    ├── messages.js           # send_message, wizz, wink, accusés remis/lu, mode privé
    ├── webrtc.js             # Signalisation audio/vidéo P2P WebRTC
    └── games.js              # Moteur temps réel : Morpion, Puissance 4 et Dames (anti-triche serveur)
```

---

## 2. Responsabilité de chaque composant

### A. Base de données & DTOs ([`server/db.js`](file:///home/guifort-adm/OpenWLM/server/db.js))
- Initialise l'instance SQLite `messenger.db` via `better-sqlite3`.
- Assure la création idempotente des tables : `users`, `contacts`, `invitations`, `messages`, `shared_files`, `custom_emoticons`, `push_subscriptions`, `conversation_read_cursors`.
- Exporte les fonctions sanitaires de transformation :
  - `toPublicUserDTO(user)` : Ne transmet que les attributs publics (`id`, `username`, `nickname`, `avatar`, `status`, `public_key`).
  - `toPrivateUserDTO(user)` : Transmet les attributs publics ainsi que `encrypted_private_key`, mais **jamais** `password_hash` ou `salt`.

### B. Authentification & Sécurité ([`server/middleware/auth.js`](file:///home/guifort-adm/OpenWLM/server/middleware/auth.js))
- **`authenticateToken`** : Vérifie la validité du JWT dans l'en-tête `Authorization` ou le cookie `token` (`HttpOnly; SameSite=Strict`). Vérifie formellement la concordance avec `token_version` en base de données pour appliquer la révocation immédiate des sessions.
- **`canInteract(senderId, targetId)`** : Fonction centrale d'autorisation vérifiant l'existence du destinataire, la relation mutuelle d'amitié dans `contacts`, et l'absence de blocage dans les deux sens.
- **Rate Limiters** :
  - `authRateLimiter` (10 tentatives / min par IP)
  - `uploadRateLimiter` (5 uploads / min par IP)
  - `sensitiveRateLimiter`, `inviteRateLimiter`, `captchaRateLimiter`
  - Limiteurs par compte (`loginAccountLimiter`, `signupAccountLimiter`, etc.)

### C. Gestion des sessions Socket ([`server/sessionStore.js`](file:///home/guifort-adm/OpenWLM/server/sessionStore.js))
- Associe chaque socket connecté à une room utilisateur `user:<userId>`.
- Maintient en mémoire vive les correspondances `userSockets` (un utilisateur peut avoir plusieurs onglets ou appareils ouverts) et `socketToUser`.
- Permet la diffusion ciblée (« fanout ») vers toutes les sessions d'un même compte.

### D. Routeurs Express (`server/routes/`)
Chaque domaine métier est encapsulé dans une fonction usine injectant les dépendances nécessaires (`io`, `broadcastStatusToContacts`, `isProd`) :
- `createAuthRouter`
- `createUsersRouter`
- `createMessagesRouter`
- `createFilesRouter` (inclut les crons de nettoyage des fichiers expirés et orphelins)
- `createEmoticonsRouter`
- `createPushRouter`
- `createGamesRouter`

### E. Gestionnaires Socket.IO (`server/sockets/`)
- `registerMessageHandlers` : Contrôle de débit, validation de taille (< 5 Mo), persistance conditionnelle (neutralisée si l'un des contacts est en mode privé global), émission des notifications Web Push.
- `registerWebRtcHandlers` : Validation stricte des trames SDP / ICE (taille <= 64 Ko, structure autorisée) et relais vers le pair.
- `registerGameHandlers` : Validation autoritaire côté serveur pour les jeux de Dames (déplacements diagonaux, sauts, prises, promotions en dame, fin de partie).

---

## 3. Avantages techniques apportés par ce découpage

1. **Testabilité unitaire et ciblée** : Chaque routeur et chaque module socket peut être importé et testé isolément sans instancier tout le serveur.
2. **Maintenance et lisibilité** : `server/index.js` passe de **3 379 lignes à ~220 lignes**, se concentrant uniquement sur la configuration du serveur et la composition des modules.
3. **Zéro régression** : Les contrats d'API HTTP, les événements WebSocket, les clés de base de données et les règles de sécurité demeurent **strictement identiques**.
