<p align="center">
  <a href="CHANGELOG.md">English</a> • <b>Français</b>
</p>

# Journal des modifications (Changelog) - OpenWLM

Toutes les modifications notables apportées au projet sont documentées dans ce fichier.
Ce projet respecte les principes de [Semantic Versioning](https://semver.org/lang/fr/).

---

## [Non publié] - 2026-10-08

### 🛡️ Sécurité & Vérification locale de contacts (Safety Number / IndexedDB)
- **Vérification d'empreinte de clé publique (Safety Number)** :
  - Calcul déterministe d'empreinte SHA-256 canonique à partir des composants RSA (`e`, `kty`, `n`) de la clé publique de contact.
  - Formatage en 8 blocs de 4 caractères pour une comparaison ergonomique hors-bande (ex. `A1B2 C3D4 ...`).
  - Détection automatique et instantanée de tout changement de clé publique avec révocation automatique du statut vérifié et bandeau d'alerte.
  - Badge discret en SVG translucide Aero dans le header de conversation (vert avec coche `✓` si vérifié, rouge avec `?` si non vérifié).
  - Modale dédiée Windows Aero pour inspecter l'empreinte et basculer l'état de confiance local.
- **Stockage localisé dans le coffre-fort IndexedDB (`WLM_DeviceVault_v1`)** :
  - Migration intégrale du stockage local depuis `localStorage['wlm_verified_contacts_v1']` vers l'object store `verified_contacts` d'IndexedDB.
  - Migration automatique, idempotente et sans résidu : suppression propre de l'ancienne clé legacy et de tout drapeau dans `localStorage`.
  - Résilience garantie : préservation des données legacy en cas d'erreur IndexedDB, fallback transparent si IndexedDB est désactivé.

## [1.4.0] - 2026-10-05

### 🔔 Notifications & PWA Web Push (Desktop & Mobile)
- **Configuration VAPID de bout en bout (RFC 8291 / RFC 8292)** :
  - Standardisation des variables d'environnement `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` et `VAPID_SUBJECT`.
  - Intégration de la bibliothèque `web-push` avec chiffrement de charge utile RFC 8291 (`aes128gcm`) et signature JWT VAPID RFC 8292 (`ES256`).
  - Validation stricte au démarrage du serveur : chargement prioritaire depuis l'environnement, repli automatique sur le fichier local sécurisé `.vapid_keys.json` (chmod `0600`, exclu de git), désactivation propre sans crash si les clés sont absentes.
  - Protection absolue des secrets : la clé privée `VAPID_PRIVATE_KEY` n'est jamais exposée dans l'API, les réponses HTTP ou le frontend.
  - Endpoint de contrôle d'état `GET /api/push/status` exposant de manière transparente `available`, `hasVapid` et `publicKey`.
  - Endpoint de test authentifié `POST /api/push/test` permettant de tester la réception immédiate d'une notification push sur les appareils du compte connecté.
  - Nettoyage automatique des abonnements expirés ou révoqués (`HTTP 404 / 410 Gone`) dans la base SQLite `push_subscriptions`.
  - Utilitaire dédié `scripts/generate_vapid_keys.js` pour générer des clés VAPID sécurisées avec protection contre l'écrasement involontaire.
- **Expérience PWA Android & Arrière-plan** :
  - Support des notifications en arrière-plan via Service Worker (`push` et `notificationclick`).
  - Redirection et ouverture automatique de la conversation (`OPEN_CHAT`) lors du clic sur une notification push ou système.
  - Intégration d'icônes maskable conformes PWA (`pwa-maskable-192x192.png` et `pwa-maskable-512x512.png`) avec fond plein `#d5e9f8` et zone de sécurité centrale de 80%, éliminant les bordures blanches indésirables sur Android.
- **Notifications Desktop & Toasts In-App Rétro WLM** :
  - Arbitrage intelligent des notifications : toast in-app Aero rétro en avant-plan PC, notification système native en arrière-plan, aucune notification pour ses propres messages ou la conversation activement visible.
  - Parcours d'activation assisté pour Microsoft Edge et les PWA Windows gérant les demandes de notification discrètes.

### 🔄 Synchronisation temps réel multi-session
- **Diffusion des messages vers toutes les sessions actives d'un compte** :
  - Suivi multi-socket côté serveur (`userId → Set<socketId>`) remplaçant l'ancien mapping à socket unique, qui écrasait la session précédente à chaque nouvelle connexion.
  - Rooms Socket.IO par utilisateur (`user:<id>`) rejointes dès l'authentification du handshake et lors de `identify`.
  - Un nouveau message est livré à **toutes** les sessions du destinataire, ainsi qu'aux **autres** sessions de l'expéditeur (sans doublon sur la session d'origine).
  - Wizz, clins d'œil, mode privé, appels WebRTC, jeux et changements de statut migrés vers les rooms utilisateur.
  - Le statut hors ligne n'est diffusé qu'à la fermeture de la **dernière** session du compte.
  - Côté client, les messages synchronisés depuis une autre de ses propres sessions sont rangés dans la bonne conversation (celle du destinataire), sans son, sans notification et sans rejouer wizz/clin d'œil. Chiffrement E2EE inchangé (`keySender` déjà présent).
  - Test d'intégration `tests/test_multi_session_sync.js` (serveur réel sur base isolée, 2 sessions × 2 comptes).

### 🗂️ Onglets de conversation
- **Réorganisation des onglets par glisser-déposer** : déplacement horizontal avec indicateur d'insertion clair, ordre mis à jour au relâchement, sans impact sur l'ouverture, la fermeture, l'onglet actif ni les indicateurs de nouveaux messages (`src/utils/TabUtils.ts`, `tests/test_tabs_drag_and_drop.js`).

### 🔐 Provisioning des secrets
- Script de provisioning `scripts/provision_vapid.sh` et fichier `.env.example` documenté ; les vraies clés ne sont jamais écrites dans un fichier suivi par Git.
- Détecteur de secrets `scripts/check_secrets.js` (exécuté par `npm test`) et hook Git pre-commit installable via `scripts/install_git_hooks.sh`.

## [1.3.0] - 2026-10-03

### 🔒 Sécurité & Persistance Client
- **Architecture de stockage web durcie (surface d'exposition minimale)** :
  - Élimination des jetons JWT, clés privées RSA brutes, JWK, coffres chiffrés et blobs cryptographiques de `localStorage` et `sessionStorage`.
  - Restriction de `wlm_user` dans `localStorage` à une liste blanche stricte de champs d'affichage non sensibles : `{ id, username, nickname, avatar, scene, status, rememberMe }`.
  - Nettoyeur proactif d'hygiène au démarrage purgeant automatiquement tout résidu historique ou clé non autorisée des versions antérieures.
- **Coffre-fort E2EE local (`IndexedDB + Web Crypto`)** :
  - Implémentation du coffre d'appareil `WLM_DeviceVault_v1` utilisant le clonage structuré natif d'IndexedDB pour persister la clé privée sous forme d'objet natif `CryptoKey` avec `extractable: false`.
  - Résistance accrue contre l'exfiltration : le matériel cryptographique de la clé privée est conçu pour ne pas être exportable via les API Web Crypto standard (les appels directs à `crypto.subtle.exportKey()` sont rejetés par le moteur du navigateur), ce qui réduit significativement le risque d'exfiltration directe et améliore la protection contre le vol de stockage par injection de script (XSS).
- **Durcissement des sessions serveur par cookie `HttpOnly; SameSite=Strict`** :
  - Émission automatique par l'endpoint `/api/login` du cookie de session `HttpOnly; SameSite=Strict; Path=/; Max-Age=24h`.
  - Prise en charge transparente et unifiée des cookies sur toutes les routes Express et la négociation WebSocket (`io.use`).
  - Révocation instantanée côté serveur et suppression du cookie lors de la déconnexion (`/api/logout`).
- **Expérience utilisateur robuste "Mémoriser mes clés E2EE sur cet appareil"** :
  - Wording bilingue modernisé et adapté au mobile : *"Mémoriser mes clés E2EE sur cet appareil"* / *"Remember my E2EE keys on this device"*.
  - Approche UX non bloquante : la connexion n'est pas interrompue en cas d'indisponibilité du stockage local (quota dépassé, navigation privée) ; la session se poursuit normalement en mémoire vive avec un toast explicatif.
  - Fonctionnalité *"Oublier cet appareil"* : suppression propre du trousseau IndexedDB, purge des marqueurs locaux et bascule en session mémoire seule sans déconnexion forcée.
- **Indicateur rétro Aero raffiné et discret** :
  - Remplacement du badge texte lourd par une mini-icône cadenas SVG de 12px intégrée à côté du statut utilisateur avec infobulle au survol, respectant l'alignement WLM et le responsive mobile.
- **Mise à niveau du Service Worker** :
  - Incrémentation du cache en `openwlm-v4` pour forcer le rafraîchissement immédiat de la coquille applicative et des bundles JS.

## [1.2.1] - 2026-10-03

### 🎨 Visuel & Assets
- **Vraie transparence alpha pour toutes les émoticônes (PNG & APNG)** :
  - Disparition complète des halos blancs, cadres rectangulaires et contours crénelés autour des émoticônes sur fond coloré (Aero bleu `#3B84D1`) ou sombre.
  - Conversion des 59 émoticônes statiques du format GIF 8-bit opaque vers le format PNG 32-bit RGBA avec anti-aliasing alpha progressif et dé-matting des contours.
  - Conversion des 10 émoticônes animées (`cry_smile`, `wink_smile`, `party`, `Sleepy`, `thinking`, `eye-rolling`, `idk`, `Lightning`, `bat`, `cake`) en Animated PNG (APNG) avec canal alpha 8-bit natif par image et respect strict du nombre de frames et des délais en millisecondes d'origine.
  - Mise à jour du placeholder de la fenêtre d'ajout de contact vers `pseudo@openwlm.dev`.
- **Vraie transparence alpha pour le logo papillon OpenWLM** :
  - Suppression complète du cadre rectangulaire blanc opaque autour de `openwlm_logo.png`, particulièrement visible en mode sombre sur la page de connexion.
  - Détourage précis par inondation BFS et dé-matting multi-passes orthogonal des contours sans altérer la netteté, les reflets gloss supérieurs des ailes, ni l'espace négatif central entre les ailes.

## [1.2.0] - 2026-10-03

### ✨ Fonctionnalités
- **Émoticônes dans les pseudos et messages de statut (PSM)** :
  - Support fidèle et nostalgique des émoticônes rétro emblématiques directement au sein des pseudonymes et messages de statut personnel (PSM).
  - Intégration globale dans toute l'interface : profil personnel, liste de contacts (en ligne, hors ligne, invitations en attente), onglets de conversation, en-tête de chat, nom d'expéditeur des messages, bannières d'invitation, bandeau réduit de jeu (docked pill), tableaux des scores (Puissance 4, Morpion, Dames) et appels audio/vidéo.
  - Formateur modulaire sécurisé sans injection HTML (composants React stricts, zéro risque XSS).
  - Optimisation Fast-Path par expression régulière garantissant un rendu instantané et sans allocation pour les pseudos textuels classiques.
  - Dimensionnement typographique proportionnel en unités relatives `em` (`1.2em`, max 16px, min 11px) et calage vertical `-0.18em` préservant les hauteurs de ligne et l'alignement Aero.
  - Conservation du texte brut pour les codes non reconnus et troncature propre anti-overflow sur mobile.

## [1.1.0] - 2026-10-02

### 🎮 Fonctionnalités
- **Mini-jeu Puissance 4 (Connect Four) 1v1** :
  - Plateau 7x6 avec esthétique rétro Aero authentique (cadre bleu biseauté, jetons 3D brillants rouges et jaunes).
  - Validation faisant autorité côté serveur : respect des tours, calcul de gravité, rejet de colonne pleine, détection automatique des victoires et matchs nuls.
  - Animation fluide de chute de jetons, surbrillance scintillante des 4 pions vainqueurs, et guide visuel au survol.
  - Support bilingue natif (FR/EN) pour les bannières de jeu, les scores et les infobulles.
  - Intégration complète dans le chat (menu Jeux, bannières d'invitation, barre réduite, assistant bot `/p4` ou `/puissance4`).
  - Rendu responsive mobile anti-overflow.
  - Pastilles de couleur discrètes élégamment intégrées sur la ligne du pseudo des joueurs.

## [1.0.0] - 2026-10-02

Cette version majeure consolide la réécriture moderne de la messagerie instantanée rétro fin des années 2000 (thème Aero) avec un durcissement de sécurité de niveau production, un contact d'assistance de test intégré ("OpenWLM"), et une couverture de tests de non-régression automatisée.

### 🚀 Fonctionnalités (Features)

- **Contact système & Assistant de test intégré ("OpenWLM")** :
  - Contact système virtuel dédié (ID `-1`) permettant aux nouveaux utilisateurs de tester immédiatement l'interface sans nécessiter de second compte.
  - État vide central soigné avec bouton interactif *"Démarrer une conversation de test"*.
  - Section *"Bot (1)"* discrète et repliable dans la liste de contacts, badge sobre `BOT`.
  - Commandes de test intégrées : Aide (`aide`), Écho (`echo`), Émoticônes (`emoticones`), Sons (`sons`), Wizz (`wizz`), Morpion solo (`morpion`).
  - Isolation 100% côté client : zéro trafic réseau parasite, zéro écriture en base de données, zéro conflit avec les vrais contacts.
- **Émoticônes personnalisées chiffrées de bout en bout (E2EE)** :
  - Gestion des raccourcis personnalisés avec chiffrement Zero-Knowledge (AES-256-GCM).
  - Support des images statiques (PNG, WebP, JPEG) et animées (GIF).
  - Découpage automatique des tailles d'affichage (inline 19px et standard 50px).
- **Activités & Jeux multijoueurs intégrés** :
  - Morpion classique (Tic-Tac-Toe) temps réel.
  - Jeu de dames (Checkers) temps réel avec validation autoritaire.
  - Réduction de fenêtre de jeu (dock banner) sans interrompre la discussion.
- **Transfert de fichiers chiffré E2EE** :
  - Partage de fichiers volumineux chiffrés avec expiration automatique (4 heures).
  - Aperçu direct des images avec déchiffrement à la volée et zoom lightbox.
- **Expérience Aero fin des années 2000 authentique** :
  - Sons d'origine (connexion, message, wizz, appel, nudge).
  - Clins d'œil animés (Winks), Wizz avec secousse d'écran.
  - Surnom, message personnel (PSM), sélecteur d'avatars et de scènes rétro.
- **Internationalisation Complète (FR / EN)** :
  - Fournisseur réactif `I18nProvider` avec bascule instantanée sans rechargement entre le français et l'anglais.
  - Traduction intégrale de l'authentification, de la liste de contacts, de la barre d'outils, des en-têtes de messages et de la boîte d'options classique rétro.
  - Prise en charge bilingue des mini-jeux (Dames, Morpion), du lecteur de clips vocaux, des appels WebRTC et du gestionnaire d'émoticônes personnalisées.
  - Zéro régression visuelle ni débordement d'interface, préservant scrupuleusement l'esthétique Aero de la fin des années 2000.

---

### 🛡️ Sécurité (Security Hardening)

#### Priorité 1 — Authentification forte & Contrôle des accès
- **Secret JWT robuste** :
  - Élimination de tout secret statique par défaut.
  - Génération automatique d'une clé cryptographique de 256 bits (`.jwt_secret`) avec permissions restrictives (`0600`) et exclusion Git.
- **Helper d'autorisation centralisé `canInteract(senderId, targetId)`** :
  - Contrôle systématique du lien de contact mutuel et de l'absence de blocage.
  - Appliqué avant toute émission de message, Wizz, Clin d'œil, appel WebRTC, invitation de jeu ou transfert de fichier.
- **Prévention de l'usurpation d'identité (Anti-Spoofing)** :
  - Rejet immédiat si `socket.user.id !== senderId`.
  - Recalcul obligatoire du pseudonyme (`senderNickname`) depuis la base de données SQL (aucune confiance accordée au client).
- **Mode Privé (Off-The-Record) autoritaire** :
  - Forçage côté serveur de la non-persistance si l'un des contacts a activé le mode privé global (`global_private = 1`), ignorant tout contournement client.

#### Priorité 2 — Isolation des données & Révocation
- **Sécurisation des transferts de fichiers (`/api/files/upload`)** :
  - Contrôle `canInteract` obligatoire avant acceptation du fichier.
  - Quota de stockage strict de **1 Go** par compte utilisateur pour les fichiers partagés.
  - Rate limiting dédié aux téléversements : maximum 5 uploads par minute par IP (HTTP 429).
  - Jetons d'accès cryptographiques de 24 octets hexadécimaux avec expiration de 4 heures.
- **Révocation instantanée des sessions JWT (`token_version`)** :
  - Colonne `token_version` en base de données, vérifiée dans le middleware Express et WebSocket.
  - Révocation automatique et immédiate lors du changement de mot de passe.
  - Endpoint dédié `POST /api/logout` et événement `manual_disconnect` incrémentant la version côté serveur.
- **Validation stricte des invitations de jeux (`game_accept`)** :
  - Obligation d'une invitation préalable active stockée en mémoire avec expiration TTL de 60 secondes.
  - Consommation unique de l'invitation à l'acceptation (anti-forçage de partie).
- **Protection du cache des émoticônes (`CustomEmoticonsDB`)** :
  - Méthode `clearAll()` purgeant l'IndexedDB locale (clés AES et blobs) et révoquant les URLs mémoire lors de la déconnexion.

#### Priorité 3 — Défense en profondeur
- **Neutralisation des attaques temporelles (Anti-Timing Attacks)** :
  - Utilisation de `crypto.timingSafeEqual` sur les buffers binaires PBKDF2 lors de l'authentification (`/api/login`) et du changement de mot de passe (`/api/user/change-password`).
- **Prévention des fuites mémoire (Anti-DoS RAM)** :
  - Nettoyage périodique automatique toutes les 5 minutes des structures mémoire (`captchas`, `rateLimitStorage`, `uploadRateLimitStorage`).

---

### 🔧 Corrections (Bug Fixes)

- Correction de la mise en cache agressive des raccourcis d'émoticônes personnalisées supprimées.
- Correction de l'attribution des messages de transfert de fichiers (*"[Contact] vous a envoyé un fichier"* au lieu de *"[Contact] dit"*).
- Correction du déclenchement du son de connexion lors de l'arrivée d'un contact en ligne.
- Harmonisation du Content Security Policy (CSP) en production et derrière Cloudflare Tunnel.

---

### 🧪 Infrastructure & Tests

- **Suite de tests d'enforcement (`tests/audit_security_enforcement.js`)** :
  - Vérification automatisée sans interface utilisateur testant le contournement direct des restrictions (messages, invitations, fichiers, jeux, statuts, profils, etc.).
  - Commande intégrée `npm run test:security` / `npm test`.
- **Script de peuplement de démonstration (`scripts/seed-demo.js`)** :
  - Commande `npm run db:seed` créant un environnement de test local propre (Alice & Bob) sans aucune donnée personnelle.
- **Routine de sauvegarde à froid** :
  - Procédure standardisée de snapshot `tar.gz` avant toute opération sensible.
