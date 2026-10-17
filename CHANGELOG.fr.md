<p align="center">
  <a href="CHANGELOG.md">English</a> • <b>Français</b>
</p>

# Journal des modifications (Changelog) - OpenWLM

Toutes les modifications notables apportées au projet sont documentées dans ce fichier.
Ce projet respecte les principes de [Semantic Versioning](https://semver.org/lang/fr/).

---

## [Non publié]

### Correctifs (revue de code du 2026-10-17)
- **Statut sur un second appareil** : un appareil sans préférence mémorisée n'impose plus « Disponible » au statut choisi sur un autre appareil encore connecté ; il adopte le statut en cours (et le mémorise comme sa propre préférence). Le handshake du socket n'impose plus de statut quand l'appareil n'en a pas.
- **Poste partagé** : l'écran de connexion ne présélectionne plus un statut hérité d'un autre compte (le « dernier statut » global est supprimé) ; il ne présélectionne que la préférence du compte mémorisé, et le choix n'est envoyé que si le sélecteur a été modifié. Le champ `status` de la réponse de login n'est plus pris pour un choix de l'utilisateur.
- **Faux « vient de se connecter »** : le serveur marque désormais les vraies connexions (`signedIn`, hors ligne → visible) dans les diffusions de présence ; modifier son pseudo, son message perso ou son avatar ne déclenche plus le toast. Le texte du toast suit un changement de langue en cours de session.
- **Coups de jeu** : chaque gestionnaire de coup (Morpion, Dames, Puissance 4, Démineur) revérifie la relation de contact (un contact bloqué ou supprimé en cours de partie ne peut plus jouer) et est limité en débit (40 coups / 10 s par utilisateur).
- **Client du Démineur** : le plateau ne peut plus rester bloqué après une réponse perdue (déverrouillé après 5 s, à la reconnexion et à la resynchronisation) ; la bombe armée est désarmée au changement de main, à la nouvelle manche et sur erreur ; une erreur de jeu déclenche une resynchronisation. Les règles du plateau (taille, mines, objectif, bombe) viennent de l'état serveur au lieu de constantes dupliquées. La bombe est documentée comme une par manche (comme sur MSN), conformément au comportement.
- **Sons** : les erreurs de reprise du contexte audio sont interceptées ; les minuteries du Démineur sont nettoyées au démontage.
- **Nettoyage** : l'ancien événement socket `identify` est supprimé (gestionnaire serveur, émission client et chemin mort `alwaysBroadcast`) : les sessions sont enregistrées par la connexion authentifiée elle-même.

### Jeux
- **Habillage Minesweeper Flags** : le plateau reprend l'original de MSN — cases bleu ciel à nuages, cases ouvertes dorées avec gros chiffres colorés, fanions bleus/rouges, cadre marine, panneaux BLEU et ROUGE (avatar, compteur de drapeaux, bouton bombe barré quand indisponible, « À vous de jouer ! »), compteur de mines étoilé, contour pointillé du dernier coup à la couleur du joueur et bouton ABANDONNER. Dessiné en CSS et SVG (aucune image reprise).
- **Barre d'outils** : le bouton « Activités », qui n'ouvrait qu'une invitation aux Dames, est supprimé (tous les jeux sont dans le menu Jeux).
- **Sons des jeux** : le Morpion, le Puissance 4 et les Dames ont leurs propres bruitages de coup synthétisés (trait de craie, jeton qui tombe, pion en bois, prise) — leurs coups étaient muets, le fichier son demandé n'existait pas. Tous les jeux partagent une petite fanfare de victoire, un son de défaite et un son neutre de match nul (les Dames n'en avaient pas), joués une fois par manche ; les sons de messagerie ne servent plus dans les jeux.
- **Démineur à deux (Minesweeper Flags)** : la version MSN où il faut TROUVER les mines. Plateau 16×16, 51 mines, le premier à 26 gagne (match nul impossible). Une mine rapporte 1 point et on rejoue ; un chiffre ou une zone vide (remplissage par diffusion) passe la main. Une bombe 5×5 par manche, utilisable avec au moins 3 mines de retard ; on garde la main si elle trouve une mine. Compteur central de mines, score des manches, bruitages dédiés synthétisés avec la Web Audio API (case révélée, cascade, mine trouvée, mine adverse, bombe, victoire, défaite — sans fichier audio, distincts des sons de messagerie), style Aero, accessible depuis le menu Jeux, les invitations, la barre réduite et la reprise de partie.
- **Anti-triche** : le plateau est généré côté serveur (`crypto.randomInt`) et l'emplacement des mines ne quitte jamais le serveur — les clients ne reçoivent que les cases révélées, y compris à la resynchronisation ; les mines restantes ne sont montrées qu'à la fin de la manche.
- **Durcissement** : le gestionnaire des coups du Morpion vérifie désormais le type de partie (il pouvait être envoyé contre un autre jeu). Les panneaux de jeu n'affichent plus d'image cassée pour un contact sans avatar.
- Tests : `tests/test_minesweeper_logic.js` (règles), `tests/test_minesweeper_server.js` (partie complète par sockets, aucune fuite avant la fin), `e2e/minesweeper.spec.ts` (deux navigateurs, plateaux synchronisés, trames WebSocket inspectées).

### Statut de présence
- **Statut restauré au redémarrage** : le statut choisi à la main (menu ou écran de connexion) est mémorisé sur l'appareil et restauré au redémarrage de l'app. L'absence automatique pour inactivité n'est jamais mémorisée : l'app revient « Disponible » ; un « Absent », « Occupé » ou « Apparaître hors ligne » volontaire est conservé. L'écran de connexion présélectionne le dernier statut.
- **Serveur** : à la première connexion d'un compte, le client transmet le statut voulu dans le handshake du socket et le serveur l'applique, au lieu de forcer « en ligne » — « Apparaître hors ligne » ne vous fait plus réapparaître en ligne auprès de vos contacts à la reconnexion.
- **Correctif** : les mises à jour de profil (pseudo, message perso, avatar, scène) ne renvoient plus un statut périmé, qui pouvait vous passer « hors ligne » ou faire clignoter votre statut juste après la connexion.

### Notifications
- **Notification de connexion d'un contact** : quand un contact se connecte, un toast Aero « <pseudo> vient de se connecter » s'affiche (PC, app au premier plan), ou une notification système quand l'app est en arrière-plan et que les notifications sont autorisées — mêmes règles que pour les messages. Un clic ouvre la conversation. Silence pendant 10 s après votre propre (re)connexion, pour éviter une rafale au redémarrage du serveur.

## [1.5.1] - 2026-10-16

### Signature des messages
- **Messages invérifiables refusés avant déchiffrement** : quand la clé publique de l'expéditeur est indisponible, le message est désormais refusé dès l'étape de signature, sans utiliser la clé privée (il était auparavant déchiffré, contrôlé puis refusé ; son contenu n'était jamais exposé). Son `mid`, non authentifié, n'est plus renvoyé : un message forgé ne peut donc pas alimenter l'anti-rejeu. Comportement visible inchangé (bandeau « Message rejeté »).

## [1.5.0] - 2026-10-16

### Interface
- **Version sur la page de connexion** : pied de page « OpenWLM v1.5.0 · GitHub », avec un lien vers le dépôt. La version est lue dans `package.json` au build (`__APP_VERSION__`).

### Mode privé par conversation (côté serveur)
- **État persisté** : nouvelle table `conversation_privacy` (une ligne par direction). `toggle_private_mode` n'écrit que la ligne de l'utilisateur authentifié (`socket.user.id`), jamais celle désignée dans le payload ; le contact et les autres sessions de l'utilisateur sont notifiés (`private_mode_changed`, `private_mode_self_sync`).
- **Le serveur décide** : `send_message` ignore le drapeau `isPrivate` du client et calcule le mode privé à partir du mode global des deux utilisateurs et de leurs deux lignes de conversation ; chacun peut imposer la confidentialité, personne ne peut retirer celle de l'autre.
- **Resynchronisation** : `/api/contacts/:userId` renvoie `my_private` / `their_private`, l'état est donc correct après une reconnexion sans rebasculer. Le basculement est refusé avec une explication quand le contact l'a activé.

### Durcissement serveur & anti-abus
- **Repli sur le cookie** : un en-tête `Authorization: Bearer undefined` / `null` est ignoré au profit du cookie `HttpOnly` (corrige les erreurs « token invalide » intermittentes à l'envoi d'un fichier ou d'une émoticône personnalisée).
- **Hachage asynchrone** : `crypto.pbkdf2` (pool libuv) au lieu de `pbkdf2Sync` — chaque tentative de login bloquait toute la boucle d'événements (~113 ms) ; les paramètres PBKDF2 sont inchangés (hashs existants valides).
- **Login à temps constant** : un calcul PBKDF2 complet est effectué même pour un compte inexistant (anti-énumération temporelle).
- **Inscription** : preuve de travail (hashcash) liée au captcha et à usage unique (`POW_DIFFICULTY`, défaut 17) + plafond des inscriptions réussies par IP sur 24 h glissantes (`SIGNUP_IP_DAILY_LIMIT`, défaut 10).
- **Clés E2EE** : la preuve du mot de passe (`authKeyHex`) est désormais exigée pour toute écriture de clés, y compris la première installation (empêche d'installer une identité d'attaquant sur une session volée).
- **Appels** : `call_accept` / `call_reject` ne sont honorés que pour un appel réellement en attente (anti-DoS « occupé »).
- **Gestion des plantages** : arrêt propre (code 1) sur erreur non gérée pour être relancé par un superviseur ; les exceptions dans les handlers Socket.IO sont confinées à l'événement. Un superviseur (systemd/pm2/Docker) devient obligatoire en production — voir `docs/DEPLOYMENT.md`.
- **Chargement de `.env` corrigé** : déplacé dans un module importé en tout premier (`server/loadEnv.js`), pour qu'un `JWT_SECRET` (ou `VAPID_*`) fourni dans `.env` soit pris en compte avant l'initialisation des modules. Auparavant `.env` était chargé dans le corps de `index.js`, donc après l'évaluation de `middleware/auth.js` (`SECRET = getJwtSecret()`), qui retombait alors sur `.jwt_secret` généré.
- Suppression de la dépendance inutilisée `sqlite3` (−18 paquets).

### Appels (WebRTC) — fiabilité & bout-en-bout
- **Caméra ou partage d'écran pendant un appel audio** : l'appel audio réserve un transceiver vidéo dès l'offre, chacun peut donc activer sa caméra ou partager son écran par `replaceTrack` (sans renégociation ; repli sur une renégociation avec un pair d'une version antérieure). Une caméra ouverte en cours d'appel est libérée quand on la coupe. Un signal chiffré `media-state` prévient le pair quand la vidéo démarre ou s'arrête (« X a coupé sa caméra »).
- **Correctifs d'établissement d'appel** : l'état « connecté » posé à l'arrivée des pistes du pair était écrasé par un « connexion » arrivé plus tard (appel bloqué sur « Connexion... »), et les candidats ICE reçus avant la réponse n'étaient jamais appliqués côté appelant.
- **E2EE** : la signalisation (SDP/ICE) est chiffrée avec l'E2EE existant (le serveur devient un relais aveugle), et l'empreinte DTLS est signée (RSA-PSS) puis vérifiée à la réception (anti-MITM).
- **Réseau** : serveurs ICE configurables via `GET /api/rtc-config` (STUN/TURN — identifiants TURN statiques ou éphémères) ; reprise ICE (`restartIce`) sur `disconnected`/`failed` et sur reconnexion socket ; budgets de débit bornés.
- **UI** : micro/caméra on-off, minuteur, indicateur de qualité, sélecteur micro/caméra/haut-parleur, plein écran/PiP, partage d'écran, responsive ; sonnerie en boucle et notification système sur appel entrant.
- **Fenêtre d'appel non bloquante** : un appel n'est plus un calque plein écran qui captait tous les clics. C'est une petite fenêtre déplaçable (bornée au viewport), réductible/dépliable sans démonter les flux WebRTC, qui laisse la liste de contacts et les autres conversations utilisables pendant l'appel (façon WLM 2009). Seule la décision accepter/refuser d'un appel entrant reste une modale centrée assombrie ; sur mobile la fenêtre démarre réduite (barre au-dessus de la zone de saisie) et la boîte de sonnerie garde accepter/refuser entièrement visibles (correctif d'un rognage dû à la scène vidéo qui s'effondrait à 0 de haut).
- **Adaptation dynamique** du débit/résolution (`getStats`) et *perfect negotiation*.

### Messagerie
- **Rattrapage après une coupure** : les conversations ouvertes se resynchronisent de façon incrémentale à la reconnexion du socket et au retour de l'app au premier plan ; les messages reçus hors ligne d'un contact dont l'onglet est fermé rouvrent cet onglet (nouvelle route `GET /api/conversations/pending`). Les messages purement locaux (mode privé, lignes système) sont conservés.
- **Brouillon par conversation** : le texte non envoyé reste attaché à son onglet au lieu de suivre dans toutes les conversations.
- **Chargement automatique de l'historique** : ouvrir un onglet ne charge plus que cet onglet (auparavant tous les onglets ouverts étaient rechargés, et leurs messages locaux perdus).
- **Champ de saisie riche** : les émoticônes tapées (`:)`, `:D`, `(L)`, perso) s'affichent en image pendant la frappe et poussent le texte (fin du chevauchement).
- **Rate limiting** : compteurs Wizz et Winks désormais séparés (3/min et 7/min indépendants) ; fenêtre de nettoyage alignée sur celle des handlers.
- **« Non envoyé » + Renvoyer** : l'envoi (texte, fichier, vocal) attend désormais l'accusé du serveur (délai 15 s). En cas de refus, de délai dépassé ou de coupure, le message est marqué « ⚠ Non envoyé » (raison en infobulle) avec un bouton Renvoyer, au lieu de rester en attente indéfiniment. Le renvoi re‑signe le message avec le `mid` d'origine et le mode privé actuel ; le clair n'est gardé qu'en mémoire.
- **Mode privé + contact hors ligne** : rien n'étant conservé côté serveur, le message est désormais refusé explicitement (`RECIPIENT_OFFLINE_PRIVATE`) au lieu d'être perdu en silence alors que l'expéditeur voyait « envoyé ». Les messages normaux sont inchangés (stockés, remis à la reconnexion). Les Winks suivent la même règle (un accusé pilote maintenant le retour côté expéditeur).
- **Clips vocaux** : encodage à 32 kbit/s avec arrêt automatique à 90 s (ligne système), gardant le clip sous la limite de 1 Mo des trames socket ; un message trop gros est marqué « trop volumineux » sans bouton de renvoi.
- **Fenêtre de perte résiduelle (limite connue)** : en mode privé, la présence est vérifiée au moment de l'envoi ; si le contact se déconnecte juste après, le message peut encore être perdu (pas de file d'attente). Utiliser le mode normal pour une remise garantie. Cf. `docs/SECURITY_E2E.md`.
- **Renvoi idempotent (plus de doublon)** : le délai de 15 s de l'accusé est côté client uniquement, donc un accusé tardif signifie que le message a bien été accepté. Le renvoi réutilise désormais le `mid` d'origine et le serveur déduplique par `(sender_id, mid)` (index unique partiel), en répondant « succès » avec l'`id` existant sans rediffuser ni re‑notifier — un renvoi ne produit plus de seconde copie. En mode privé il n'y a rien à comparer (non persisté) ; l'anti‑rejeu du destinataire (unicité du `mid`) écarte alors toute seconde copie remise en direct. Cf. `docs/SECURITY_E2E.md`.

### Signature des messages (E2EE authentifié)
- **Messages non signés ou invérifiables refusés** : seuls les messages signés et vérifiés sont affichés. Les messages à l'ancien format non signé (v1) sont refusés sans être déchiffrés, et les messages signés dont la clé de l'expéditeur est indisponible le sont aussi (bandeau « Message rejeté »). La liste anti-rétrogradation « contacts qui signent » est supprimée.
- Les messages sont désormais **signés (RSA‑PSS)** en plus d'être chiffrés : le serveur ne peut plus fabriquer un message « de la part de » un contact. Nouvelle enveloppe v2 (chiffrer‑puis‑signer) : signature sur une chaîne canonique à domaine dédié (`openwlm-msg-v2`), `from`/`to`/`mid` redondés dans le chiffré (anti‑*stripping*), vérification avant déchiffrement, liste blanche des champs de contenu.
- **Affichage** : signé valide = normal ; ancien format / clé de l'émetteur indisponible = « ⚠ non vérifié » ; signature invalide ou texte en clair = « ⛔ rejeté ». Anti‑rejeu par identifiant de message, anti‑rétrogradation.
- **Appels** : la signature de l'empreinte DTLS devient obligatoire (les cas jusqu'ici tolérés refusent désormais la signalisation).

### Winks
- **Pré-rendu** : la boucle de fin (redémarrage du SWF) est supprimée ; audio ré-aligné (offsets recalculés) ; vignette manquante de `bow` ajoutée.

### Documentation
- Nettoyage du ton et de la mise en forme du README, du changelog et des docs ; docs mises à jour pour cette version.
- Nouveaux documents : `docs/SECURITY_E2E.md` (périmètre E2E réel et limites), `docs/CALLS.md`, `docs/DEPLOYMENT.md`, `docs/CLOUDFLARE_WAF.md`.
- **Générateur de règles WAF** (`npm run waf:gen` / `waf:check`) piloté par l'audit des routes, avec auto-contrôle anti-« ouverture en grand » et vérification en CI.

### Interne
- `src/App.tsx` découpé en composants (`ChatWindow`, `ChatMessageLog`, `ChatToolbar`, `ChatTabsBar`, `ContactRoster`, modales) et hooks (`useMessageCrypto`, `useContacts`, `useGames`, `useCalls`, `useWinksAndNudge`, `useProfile`, `useNotifications`) ; aucun changement fonctionnel.
- Paquet npm renommé `openwlm`.
- Tests : suites isolées `tests/test_conversation_privacy.js` et `tests/test_pending_conversations.js` ; E2E Playwright `e2e/calls.spec.ts` (deux navigateurs, appel audio → caméra → partage d'écran) et `e2e/messages.spec.ts`.

### Durcissement du client de bureau (Electron)
- **Isolation du renderer** : `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true` et `webSecurity: true` (auparavant `nodeIntegration: true` / `contextIsolation: false`, ce qui permettait à tout contenu injecté ou chargé à distance d'exécuter du code Node arbitraire sur la machine hôte).
- Désactivation de `nodeIntegrationInWorker`, `allowRunningInsecureContent`, `experimentalFeatures` et `webviewTag`.
- La navigation externe (`will-navigate`) et l'ouverture de nouvelles fenêtres (`window.open`, `target=_blank`) sont bloquées dans l'application et déléguées au navigateur système.
- Permissions de session limitées au nécessaire : `media` (appels WebRTC) et `notifications` (push) ; toute autre demande de permission est refusée.

### Sécurité & vérification locale de contacts (Safety Number / IndexedDB)
- **Vérification d'empreinte de clé publique (Safety Number)** :
  - Calcul déterministe d'empreinte SHA-256 canonique à partir des composants RSA (`e`, `kty`, `n`) de la clé publique du contact.
  - Formatage en 8 blocs de 4 caractères pour une comparaison hors-bande (ex. `A1B2 C3D4 ...`).
  - Détection de tout changement de clé publique, avec révocation automatique du statut vérifié et bandeau d'alerte.
  - Badge SVG Aero dans le header de conversation (vert avec coche `✓` si vérifié, rouge avec `?` si non vérifié).
  - Modale Aero pour inspecter l'empreinte et basculer l'état de confiance local.
- **Stockage dans le coffre IndexedDB (`WLM_DeviceVault_v1`)** :
  - Migration du stockage local depuis `localStorage['wlm_verified_contacts_v1']` vers l'object store `verified_contacts` d'IndexedDB.
  - Migration automatique et idempotente : l'ancienne clé legacy et les drapeaux associés sont supprimés de `localStorage`.
  - En cas d'échec : les données legacy sont conservées si l'écriture IndexedDB échoue, avec un repli si IndexedDB est désactivé.

## [1.4.0] - 2026-10-05

### Notifications & PWA Web Push (Desktop & Mobile)
- **Configuration VAPID de bout en bout (RFC 8291 / RFC 8292)** :
  - Variables d'environnement `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` et `VAPID_SUBJECT`.
  - Bibliothèque `web-push` avec chiffrement de charge utile RFC 8291 (`aes128gcm`) et signature JWT VAPID RFC 8292 (`ES256`).
  - Validation au démarrage du serveur : chargement prioritaire depuis l'environnement, repli sur le fichier local `.vapid_keys.json` (chmod `0600`, exclu de git), push désactivé sans crash si les clés sont absentes.
  - La clé privée `VAPID_PRIVATE_KEY` n'est jamais exposée dans l'API, les réponses HTTP ou le frontend.
  - Endpoint de contrôle d'état `GET /api/push/status` exposant `available`, `hasVapid` et `publicKey`.
  - Endpoint de test authentifié `POST /api/push/test` pour tester la réception d'une notification push sur les appareils du compte connecté.
  - Nettoyage automatique des abonnements expirés ou révoqués (`HTTP 404 / 410 Gone`) dans la base SQLite `push_subscriptions`.
  - Utilitaire `scripts/generate_vapid_keys.js` pour générer des clés VAPID, avec protection contre l'écrasement involontaire.
- **PWA Android & arrière-plan** :
  - Notifications en arrière-plan via Service Worker (`push` et `notificationclick`).
  - Ouverture automatique de la conversation (`OPEN_CHAT`) au clic sur une notification push ou système.
  - Icônes maskable PWA (`pwa-maskable-192x192.png` et `pwa-maskable-512x512.png`) avec fond plein `#d5e9f8` et zone de sécurité centrale de 80 %, pour supprimer les bordures blanches sur Android.
- **Notifications desktop & toasts in-app** :
  - Arbitrage des notifications : toast in-app Aero en avant-plan sur PC, notification système native en arrière-plan, aucune notification pour ses propres messages ou pour la conversation affichée.
  - Parcours d'activation assisté pour Microsoft Edge et les PWA Windows, qui traitent les demandes de notification de façon discrète.

### Synchronisation temps réel multi-session
- **Diffusion des messages vers toutes les sessions actives d'un compte** :
  - Suivi multi-socket côté serveur (`userId → Set<socketId>`) remplaçant l'ancien mapping à socket unique, qui écrasait la session précédente à chaque nouvelle connexion.
  - Rooms Socket.IO par utilisateur (`user:<id>`) rejointes dès l'authentification du handshake et lors de `identify`.
  - Un nouveau message est livré à **toutes** les sessions du destinataire, ainsi qu'aux autres sessions de l'expéditeur (sans doublon sur la session d'origine).
  - Wizz, clins d'œil, mode privé, appels WebRTC, jeux et changements de statut migrés vers les rooms utilisateur.
  - Le statut hors ligne n'est diffusé qu'à la fermeture de la dernière session du compte.
  - Côté client, les messages synchronisés depuis une autre de ses propres sessions sont rangés dans la bonne conversation (celle du destinataire), sans son, sans notification et sans rejouer wizz/clin d'œil. Chiffrement E2EE inchangé (`keySender` déjà présent).
  - Test d'intégration `tests/test_multi_session_sync.js` (serveur réel sur base isolée, 2 sessions × 2 comptes).

### Onglets de conversation
- **Réorganisation des onglets par glisser-déposer** : déplacement horizontal avec indicateur d'insertion, ordre mis à jour au relâchement, sans impact sur l'ouverture, la fermeture, l'onglet actif ni les indicateurs de nouveaux messages (`src/utils/TabUtils.ts`, `tests/test_tabs_drag_and_drop.js`).

### Provisioning des secrets
- Script de provisioning `scripts/provision_vapid.sh` et fichier `.env.example` documenté ; les vraies clés ne sont jamais écrites dans un fichier suivi par Git.
- Détecteur de secrets `scripts/check_secrets.js` (exécuté par `npm test`) et hook Git pre-commit installable via `scripts/install_git_hooks.sh`.

## [1.3.0] - 2026-10-03

### Sécurité & persistance client
- **Stockage web (surface d'exposition minimale)** :
  - Jetons JWT, clés privées RSA brutes, JWK, coffres chiffrés et blobs cryptographiques retirés de `localStorage` et `sessionStorage`.
  - `wlm_user` dans `localStorage` limité à une liste blanche de champs d'affichage non sensibles : `{ id, username, nickname, avatar, scene, status, rememberMe }`.
  - Nettoyage au démarrage qui purge les résidus des versions antérieures et les clés non autorisées.
- **Coffre E2EE local (`IndexedDB + Web Crypto`)** :
  - Coffre d'appareil `WLM_DeviceVault_v1` utilisant le clonage structuré d'IndexedDB pour persister la clé privée sous forme d'objet natif `CryptoKey` avec `extractable: false`.
  - Le matériel cryptographique de la clé privée est conçu pour ne pas être exportable via les API Web Crypto standard (les appels directs à `crypto.subtle.exportKey()` sont rejetés par le moteur du navigateur), ce qui réduit significativement le risque d'exfiltration directe et améliore la protection contre le vol de stockage par injection de script (XSS).
- **Sessions serveur en cookie `HttpOnly; SameSite=Strict`** :
  - L'endpoint `/api/login` émet le cookie de session `HttpOnly; SameSite=Strict; Path=/; Max-Age=24h`.
  - Même prise en charge des cookies sur toutes les routes Express et à la négociation WebSocket (`io.use`).
  - Révocation côté serveur et suppression du cookie lors de la déconnexion (`/api/logout`).
- **« Mémoriser mes clés E2EE sur cet appareil »** :
  - Nouveau libellé bilingue, plus court sur mobile : *"Mémoriser mes clés E2EE sur cet appareil"* / *"Remember my E2EE keys on this device"*.
  - Non bloquant : la connexion n'est pas interrompue si le stockage local est indisponible (quota dépassé, navigation privée) ; la session continue en mémoire vive avec un toast explicatif.
  - *"Oublier cet appareil"* : suppression du trousseau IndexedDB, purge des marqueurs locaux et bascule en session mémoire seule sans déconnexion forcée.
- **Indicateur cadenas** :
  - Remplacement du badge texte par une icône cadenas SVG de 12px à côté du statut utilisateur, avec infobulle au survol ; alignement WLM conservé, fonctionne sur mobile.
- **Mise à niveau du Service Worker** :
  - Cache passé en `openwlm-v4` pour forcer le rafraîchissement de la coquille applicative et des bundles JS.

## [1.2.1] - 2026-10-03

### Visuel & assets
- **Transparence alpha pour toutes les émoticônes (PNG & APNG)** :
  - Suppression des halos blancs, cadres rectangulaires et contours crénelés autour des émoticônes sur fond coloré (Aero bleu `#3B84D1`) ou sombre.
  - Conversion des 59 émoticônes statiques du format GIF 8-bit opaque vers le format PNG 32-bit RGBA avec anti-aliasing alpha progressif et dé-matting des contours.
  - Conversion des 10 émoticônes animées (`cry_smile`, `wink_smile`, `party`, `Sleepy`, `thinking`, `eye-rolling`, `idk`, `Lightning`, `bat`, `cake`) en Animated PNG (APNG) avec canal alpha 8-bit par image, en conservant le nombre de frames et les délais en millisecondes d'origine.
  - Mise à jour du placeholder de la fenêtre d'ajout de contact vers `pseudo@openwlm.dev`.
- **Transparence alpha pour le logo papillon OpenWLM** :
  - Suppression du cadre rectangulaire blanc opaque autour de `openwlm_logo.png`, visible surtout en mode sombre sur la page de connexion.
  - Détourage par inondation BFS et dé-matting multi-passes orthogonal des contours, sans altérer la netteté, les reflets gloss supérieurs des ailes, ni l'espace négatif central entre les ailes.

## [1.2.0] - 2026-10-03

### Fonctionnalités
- **Émoticônes dans les pseudos et messages de statut (PSM)** :
  - Émoticônes rétro prises en charge dans les pseudonymes et messages de statut personnel (PSM).
  - Affichées dans le profil personnel, la liste de contacts (en ligne, hors ligne, invitations en attente), les onglets de conversation, l'en-tête de chat, le nom d'expéditeur des messages, les bannières d'invitation, le bandeau réduit de jeu (docked pill), les tableaux des scores (Puissance 4, Morpion, Dames) et les appels audio/vidéo.
  - Formateur modulaire sans injection HTML (composants React, pas de risque XSS).
  - Chemin rapide par expression régulière : rendu sans allocation pour les pseudos sans émoticône.
  - Dimensionnement en unités relatives `em` (`1.2em`, max 16px, min 11px) et calage vertical `-0.18em`, qui préservent les hauteurs de ligne et l'alignement Aero.
  - Conservation du texte brut pour les codes non reconnus et troncature anti-débordement sur mobile.

## [1.1.0] - 2026-10-02

### Fonctionnalités
- **Mini-jeu Puissance 4 (Connect Four) 1v1** :
  - Plateau 7x6 au style Aero (cadre bleu biseauté, jetons 3D brillants rouges et jaunes).
  - Validation côté serveur faisant autorité : respect des tours, calcul de gravité, rejet de colonne pleine, détection automatique des victoires et matchs nuls.
  - Animation de chute des jetons, surbrillance des 4 pions vainqueurs et guide visuel au survol.
  - Bannières de jeu, scores et infobulles en français et en anglais.
  - Accessible depuis le chat (menu Jeux, bannières d'invitation, barre réduite, assistant bot `/p4` ou `/puissance4`).
  - Rendu mobile sans débordement.
  - Pastilles de couleur sur la ligne du pseudo des joueurs.

## [1.0.0] - 2026-10-02

Cette version consolide la recréation de la messagerie instantanée de la fin des années 2000 (thème Aero) avec un durcissement de sécurité, un contact d'assistance de test intégré ("OpenWLM") et une couverture de tests de non-régression automatisée.

### Fonctionnalités (Features)

- **Contact système & assistant de test intégré ("OpenWLM")** :
  - Contact système virtuel (ID `-1`) permettant aux nouveaux utilisateurs de tester l'interface sans second compte.
  - État vide central avec un bouton *"Démarrer une conversation de test"*.
  - Section *"Bot (1)"* repliable dans la liste de contacts, avec un badge `BOT`.
  - Commandes de test intégrées : Aide (`aide`), Écho (`echo`), Émoticônes (`emoticones`), Sons (`sons`), Wizz (`wizz`), Morpion solo (`morpion`).
  - Fonctionne entièrement côté client : aucun trafic réseau, aucune écriture en base de données, aucun conflit avec les vrais contacts.
- **Émoticônes personnalisées chiffrées de bout en bout (E2EE)** :
  - Gestion des raccourcis personnalisés avec chiffrement Zero-Knowledge (AES-256-GCM).
  - Images statiques (PNG, WebP, JPEG) et animées (GIF).
  - Deux tailles d'affichage générées automatiquement (inline 19px et standard 50px).
- **Activités & jeux multijoueurs** :
  - Morpion (Tic-Tac-Toe) en temps réel.
  - Jeu de dames (Checkers) en temps réel avec validation côté serveur.
  - Réduction de la fenêtre de jeu (dock banner) sans interrompre la discussion.
- **Transfert de fichiers chiffré E2EE** :
  - Partage de fichiers volumineux chiffrés avec expiration automatique (4 heures).
  - Aperçu des images déchiffrées dans le navigateur, avec zoom lightbox.
- **Style Aero fin des années 2000** :
  - Sons d'origine (connexion, message, wizz, appel, nudge).
  - Clins d'œil animés (Winks), Wizz avec secousse d'écran.
  - Surnom, message personnel (PSM), sélecteur d'avatars et de scènes rétro.
- **Interface bilingue (FR / EN)** :
  - Fournisseur `I18nProvider` avec bascule sans rechargement entre le français et l'anglais.
  - Traduction de l'authentification, de la liste de contacts, de la barre d'outils, des en-têtes de messages et de la boîte d'options.
  - Mini-jeux (Dames, Morpion), lecteur de clips vocaux, appels WebRTC et gestionnaire d'émoticônes personnalisées traduits.
  - Pas de débordement d'interface dans l'une ou l'autre langue.

---

### Sécurité (Security Hardening)

#### Priorité 1 — Authentification & contrôle des accès
- **Secret JWT** :
  - Suppression de tout secret statique par défaut.
  - Génération automatique d'une clé cryptographique de 256 bits (`.jwt_secret`) avec permissions `0600` et exclusion Git.
- **Helper d'autorisation centralisé `canInteract(senderId, targetId)`** :
  - Contrôle du lien de contact mutuel et de l'absence de blocage.
  - Appliqué avant toute émission de message, Wizz, Clin d'œil, appel WebRTC, invitation de jeu ou transfert de fichier.
- **Prévention de l'usurpation d'identité (Anti-Spoofing)** :
  - Rejet immédiat si `socket.user.id !== senderId`.
  - Pseudonyme (`senderNickname`) toujours recalculé depuis la base de données SQL (aucune confiance accordée au client).
- **Mode privé (Off-The-Record) appliqué côté serveur** :
  - Aucune persistance côté serveur si l'un des contacts a activé le mode privé global (`global_private = 1`), quels que soient les paramètres envoyés par le client.

#### Priorité 2 — Isolation des données & révocation
- **Sécurisation des transferts de fichiers (`/api/files/upload`)** :
  - Contrôle `canInteract` obligatoire avant acceptation du fichier.
  - Quota de stockage de **1 Go** par compte utilisateur pour les fichiers partagés.
  - Rate limiting dédié aux téléversements : maximum 5 uploads par minute par IP (HTTP 429).
  - Jetons d'accès cryptographiques de 24 octets hexadécimaux avec expiration de 4 heures.
- **Révocation des sessions JWT (`token_version`)** :
  - Colonne `token_version` en base de données, vérifiée dans le middleware Express et WebSocket.
  - Révocation automatique lors du changement de mot de passe.
  - Endpoint `POST /api/logout` et événement `manual_disconnect` incrémentant la version côté serveur.
- **Validation des invitations de jeux (`game_accept`)** :
  - Invitation préalable active obligatoire, stockée en mémoire avec une expiration de 60 secondes.
  - Invitation consommée à l'acceptation (une partie ne peut pas être forcée).
- **Protection du cache des émoticônes (`CustomEmoticonsDB`)** :
  - Méthode `clearAll()` purgeant l'IndexedDB locale (clés AES et blobs) et révoquant les URLs mémoire lors de la déconnexion.

#### Priorité 3 — Défense en profondeur
- **Attaques temporelles (Anti-Timing Attacks)** :
  - Utilisation de `crypto.timingSafeEqual` sur les buffers binaires PBKDF2 lors de l'authentification (`/api/login`) et du changement de mot de passe (`/api/user/change-password`).
- **Prévention des fuites mémoire (Anti-DoS RAM)** :
  - Nettoyage automatique toutes les 5 minutes des structures mémoire (`captchas`, `rateLimitStorage`, `uploadRateLimitStorage`).

---

### Corrections (Bug Fixes)

- Correction de la mise en cache des raccourcis d'émoticônes personnalisées supprimées.
- Correction de l'attribution des messages de transfert de fichiers (*"[Contact] vous a envoyé un fichier"* au lieu de *"[Contact] dit"*).
- Correction du déclenchement du son de connexion lors de l'arrivée d'un contact en ligne.
- Harmonisation du Content Security Policy (CSP) en production et derrière Cloudflare Tunnel.

---

### Infrastructure & tests

- **Suite de tests de sécurité automatisés (`tests/audit_security_enforcement.js`)** :
  - Suite de tests sans interface envoyant des requêtes directes pour vérifier que les principales restrictions côté client sont aussi appliquées côté serveur.
  - Commande `npm run test:security` / `npm test`.
- **Script de peuplement de démonstration (`scripts/seed-demo.js`)** :
  - Commande `npm run db:seed` créant un environnement de test local (Alice & Bob) sans aucune donnée personnelle.
- **Routine de sauvegarde à froid** :
  - Procédure de snapshot `tar.gz` documentée avant toute opération sensible.
