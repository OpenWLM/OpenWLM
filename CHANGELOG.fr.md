<p align="center">
  <a href="CHANGELOG.md">English</a> • <b>Français</b>
</p>

# Journal des modifications (Changelog) - OpenWLM

Toutes les modifications notables apportées au projet sont documentées dans ce fichier.
Ce projet respecte les principes de [Semantic Versioning](https://semver.org/lang/fr/).

---

## [Non publié]

### Mise à jour du serveur
- **Dépendances (sécurité)** : multer 2.5.0 et body-parser 2.4.0 (deux dénis de service, avis GHSA-q7qp-rjg7-q26m et GHSA-27r3-jxmh-p828) : `npm ci`, puis redémarrer le service.
- **Récupération de compte** : `server/db.js` (colonnes `auth_recovery_code_hash`, `auth_recovery_attempts`, table `auth_recovery_log`, créées au démarrage) et `server/routes/auth.js` modifiés : redémarrer le service. Les routes ne changent pas (règles WAF inchangées).
- **Relecture externe** : `server/db.js` (colonne `users.auth_recovery_until`, créée au démarrage), `server/routes/auth.js` (**nouvelles routes** `GET /api/auth/scope`, `POST /api/auth/recovery/challenge`, `POST /api/auth/recovery/complete` ; `/api/logout-device` exige maintenant une session — règles WAF régénérées) et `server/index.js` : redémarrer le service. **Ajouter `AUTH_KEY_SCOPE=<domaine actuel>` dans `.env`** (cf. docs/DEPLOYMENT.md) : sans elle, un changement de domaine ou de port empêcherait toutes les connexions. Nouveau script d'administration `scripts/auth-recovery.mjs`.
- **Relecture sécurité, lot 5** : `server/routes/messages.js` (historique paginé : 300 derniers messages, `?before=` et `?limit=`, en-tête `X-Has-More`) et `server/routes/auth.js` (**nouvelle route `POST /api/logout-device`**, règle WAF régénérée à reporter dans Cloudflare) : redémarrer le service.
- **Relecture sécurité, lot 4** : `server/middleware/auth.js`, `server/routes/{auth,users}.js`, `server/sockets/messages.js`, `server/db.js` (nouvel index `messages(sender_id)`, créé au démarrage) modifiés : redémarrer le service. **Nouvelle route `POST /api/user/migrate-auth-key`** : règle WAF régénérée, à reporter dans Cloudflare depuis `docs/cloudflare-waf.generated.json`.
- **Relecture sécurité, lot 2 (interface + serveur)** : `server/db.js` (nouvelle colonne `custom_emoticons.encrypted_key`, créée automatiquement au démarrage), `server/routes/emoticons.js` (champ `encryptedKey` à l'upload, **nouvelle route `POST /api/emoticons/custom/key`** : règle WAF régénérée, à reporter dans Cloudflare depuis `docs/cloudflare-waf.generated.json`) : redémarrer le service.
- **Relecture sécurité d'octobre 2026, lot 1 (serveur)** : `server/index.js`, `server/db.js`, `server/clientIdentity.js`, `server/routes/{auth,users,files,emoticons}.js`, `server/sockets/{messages,games,webrtc}.js` modifiés : redémarrer le service. **Derrière un tunnel cloudflared local, ajouter `CLOUDFLARE_IP_RANGES=127.0.0.1/32,::1/128` dans `.env`** (cf. docs/DEPLOYMENT.md) : sans cela, toutes les limites par IP étaient globales. **Règle WAF modifiée** : `DELETE /api/emoticons/custom/:assetId` attend désormais un id `emo_<uuid>` (avant : un nombre, ce qui aurait bloqué la suppression d'émoticônes en mode Block) — mettre à jour la règle Cloudflare depuis `docs/cloudflare-waf.generated.json`.
- **Node.js 22.23.4 requis** (mise à jour de sécurité du 21/10/2026, dont CVE-2026-111497 : décodeur Brotli, exécution de code possible, atteignable car Express décompresse les corps de requête `Content-Encoding: br`). Avec NodeSource : `sudo apt update && sudo apt install --only-upgrade nodejs`, puis redémarrer le service. Vite 8.3.5 (outil de build, faille du serveur de développement corrigée) : `npm ci`.
- `server/routes/users.js` et `server/middleware/auth.js` modifiés (réinitialisation E2E, blocage, limite des modifications de profil) : redémarrer le service. Aucune route ni règle WAF nouvelle.
- `GET /api/health` (nouvelle route, réservée aux appels locaux), `server/routes/auth.js` (déconnexion) et `server/index.js` modifiés : copier, puis redémarrer le service.
- Déconnexion et changement de mot de passe suppriment les abonnements Push / jetons FCM concernés : fichiers serveur `server/routes/auth.js`, `server/routes/users.js`, `server/index.js`, nouveau `server/utils/pushTargets.js`. Aucune route ni variable nouvelle (règles WAF inchangées). `package-lock.json` change (`npm ci`), puis redémarrer le service.
- Nouvelle table `fcm_tokens`, créée automatiquement au démarrage.
- Nouvelles routes `POST /api/push/fcm/register` et `POST /api/push/fcm/unregister` : **mettre à jour les règles WAF Cloudflare** ([docs/CLOUDFLARE_WAF.md](docs/CLOUDFLARE_WAF.md)).
- Nouvelle variable facultative `FIREBASE_SERVICE_ACCOUNT` (chemin de la clé de compte de service Firebase, hors dépôt) pour les notifications de l'app Android. Sans elle, le serveur fonctionne comme avant.
- Nouvelle dépendance `firebase-admin` (`npm ci`). Redémarrer le service après le déploiement.
- npm 12 et plus n'exécutent que les scripts d'installation autorisés : `package.json` autorise celui de `better-sqlite3` (`allowScripts`). Sans lui, `npm ci` installait la base de données sans la compiler et le serveur ne démarrait plus.

### Nouveautés
- **Sons de l'app dans les notifications Android** (APK v7+) : un message reçu app fermée ou en arrière-plan fait entendre le son de message d'OpenWLM, et un Wizz le son du Wizz, au lieu du son de notification du téléphone. Le mode du téléphone (silencieux, vibreur, Ne pas déranger) est respecté, et les réglages Sons de l'app aussi (sons coupés, son des messages ou des Wizz décoché, sons coupés en Occupé : notification silencieuse). Deux canaux Android, « Messages » et « Wizz », modifiables dans les réglages du téléphone ; l'ancien canal « Messages » est remplacé. Les autres sons ne sont joués que l'app ouverte. Une interface déjà déployée fonctionne avec les APK précédents.
- **Application Android** (première étape) : coquille native Capacitor qui charge l'interface depuis le serveur choisi au premier lancement (par défaut messenger.guifort.ovh), modifiable dans Options → Sécurité ou depuis l'écran hors ligne. Verrouillage par empreinte, visage ou code du téléphone à l'ouverture et après une minute en arrière-plan ; fichiers reçus enregistrés dans Téléchargements ; sauvegarde Android désactivée pour que les clés mémorisées restent sur le téléphone. Dans l'app, l'installation PWA, les réglages Web Push et l'option d'inactivité de tout l'ordinateur sont masqués. Compilation, signature et installation : [docs/ANDROID.md](docs/ANDROID.md).
- **Appels natifs dans l'app Android** : un appel entrant affiche l'écran d'appel d'Android, même téléphone verrouillé, avec la sonnerie du téléphone en boucle (selon son mode : sonnerie, vibreur, silencieux, Ne pas déranger). « Répondre » ouvre la conversation et prend l'appel sans second appui ; « Refuser » refuse sans ouvrir l'app ; sans réponse, l'appel devient « Appel manqué ». Pendant l'appel, un service d'appel garde le son écran éteint, avec l'écouteur et le capteur de proximité en audio, le haut-parleur et l'écran allumé en vidéo, et une notification avec Raccrocher et Haut-parleur. Les autorisations (micro, écran d'appel plein écran) sont expliquées puis demandées après la connexion, et visibles dans Options → Alertes → Appels. Aucun changement côté serveur.
- **Notifications de l'app Android** (Firebase Cloud Messaging) : messages, Wizz, fichiers et appels notifiés même app fermée ou téléphone en veille, avec le même contenu que le Web Push (nom et type, jamais le texte), traduits dans la langue de l'app. Toucher une notification ouvre la conversation. Autorisation demandée après la connexion, état et test dans Options → Alertes. « Déconnecter mes autres sessions » arrête aussi les notifications des autres téléphones.
- **« Se souvenir de cet appareil » garde la session 30 jours glissants** (au lieu de 24 h) : le serveur renouvelle le cookie de session tant que l'appareil sert au moins une fois par mois, dans l'app comme dans le navigateur. Sans cette option, la session dure toujours 24 h. La révocation des sessions reste immédiate.
- **Visionneuse d'image agrandie et zoomable** : une image reçue ou envoyée s'ouvre presque en plein écran sur ordinateur, en plein écran sur téléphone (sans barre d'outils, avec une simple croix rouge Aero pour fermer), entière au départ. Zoom à la molette (centré sur le pointeur), au pincement à deux doigts, au double-clic ou double-tap (taille réelle sur le point visé, puis retour), aux boutons − / + / Ajuster / 100 % et au clavier (+, -, 0, 1) ; l'image zoomée se déplace à la souris ou au doigt sans sortir de l'écran. Le bouton Retour d'Android ferme la visionneuse au lieu de quitter la conversation. Une capture d'écran se lit sans l'enregistrer. Interface seulement : ni serveur ni APK à mettre à jour.

### Tests
- `tests/test_auth_scope_recovery.js` (portée, récupération, script, `logout-device`), `e2e/auth-recovery.spec.ts` (changement de portée puis récupération), émoticônes par expéditeur dans `e2e/peer-payload.spec.ts`, test JVM `BridgeTrustTest.cheminsLocauxNormalisesAvantComparaison` ; en échec sur la version précédente.
- `tests/test_history_pagination.js` (pagination, `logout-device`), test de payload d'un pair dans `tests/test_message_envelope.js`, `e2e/peer-payload.spec.ts` (IME, connexion abandonnée, « Messages précédents ») ; en échec sur la version précédente.
- `tests/test_lot4_hardening.js` (verrouillage par IP, migration de clé, quota), test d'horodatage dans `tests/test_message_envelope.js`, `e2e/auth-key-scope.spec.ts` (compte à l'ancienne clé migré ; clavier des fenêtres et du menu) ; tous en échec sur la version précédente.
- Tests JVM `BridgeTrustTest.cheminsLocauxCapacitorRefuses` et `FileNamesTest.typeMimeControle`.
- `e2e/session-robustness.spec.ts` (démarrage hors ligne, session expirée, message reçu pendant le chargement, accusé de lecture en arrière-plan), `e2e/account-scoped-data.spec.ts` (clé d'émoticône après déconnexion, contacts vérifiés par compte), `tests/test_emoticon_key_backup.js` ; tous en échec sur la version précédente.
- `tests/test_lot1_hardening.js` (serveur isolé, 11 tests : multipart, présence, invitations, bornes et budget des messages, accusé, jeux, appels) et 3 tests de tunnel dans `tests/test_client_ip_resolution.js` ; tous échouent sur la version précédente. `test_call_delivery.js` et `test_route_authorization.js` adaptés (délai après refus, « Rejouer » en fin de partie).
- `e2e/android-sounds.spec.ts` : réglages Sons (sons coupés, Wizz décoché, Occupé) transmis à l'APK v7 simulé, rien envoyé à un APK v6.
- `e2e/image-viewer.spec.ts` : grande capture reçue, visionneuse en grand (ordinateur) et plein écran (téléphone), vue ajustée, double-clic taille réelle, déplacement borné, molette, touche 0, pincement, double-tap, Retour.
- `e2e/emoticon-insert.spec.ts` : émoticône insérée au curseur (fin et milieu du texte), format ordinateur et téléphone, sélection perdue comme sur Android (échoue sur la version précédente).
- Tests JVM `BridgeTrustTest` (origine de la page, règles micro / caméra) ; `e2e/android-save.spec.ts` : confirmation native refusée.
- `tests/test_review_hardening.js` : cibles Push supprimées par la réinitialisation E2E, blocage d'un non-contact refusé sans événement, déblocage, limite des modifications de profil.
- `e2e/push-robustness.spec.ts` : déconnexion refusée puis annulée (le temps réel fonctionne toujours, réponse lente simulée), session déjà terminée (401).
- `e2e/push-robustness.spec.ts` : déconnexion refusée par le serveur (session conservée, nouvel essai) ; jeton réenregistré après « Déconnecter mes autres sessions ». `tests/test_push_revocation.js` : `/api/health` refusée à un appel non local.
- `e2e/socket-resilience.spec.ts` : connexion muette au retour au premier plan, accusé perdu (renvoi automatique sans doublon) ; les deux échouent sur la version précédente.
- `e2e/push-robustness.spec.ts` : déconnexion avec un service worker qui ne s'active jamais ; jeton FCM réessayé après un échec réseau, sans envoi en double. `tests/test_push_revocation.js` : `/api/health`.
- `tests/test_push_revocation.js` : abonnements Web Push et jetons FCM supprimés à la déconnexion (tout le compte) et au changement de mot de passe (sauf l'appareil courant), autres comptes intacts. `e2e/android-save.spec.ts` : repli sur `saveFile` avec un APK v3. Test JVM `FileNamesTest`.
- `e2e/android-save.spec.ts` : app Android simulée, fichier reçu enregistré par morceaux et identique à l'original. Tests JVM de l'app (`AppLockPolicyTest`, `CallTimingTest`).
- `tests/test_fcm_push.js` : format des messages FCM (jamais de contenu, priorité, durée de vie des appels), jetons expirés supprimés, routes d'enregistrement (authentification, format, changement de compte, plafond), révocation des autres sessions, démarrage du serveur avec et sans clé Firebase.
- `tests/test_session_renewal.js` : durée du cookie selon « se souvenir », renouvellement après 12 h, jamais pour une session normale ni pour un jeton révoqué.

### Corrections
- **Suite à une seconde relecture externe** :
  - **Dépendances** : deux vulnérabilités hautes en production corrigées (multer, body-parser) ; `npm audit --omit=dev` ne signale plus rien.
  - **Récupération de compte durcie** : `scripts/auth-recovery.mjs` génère un **code à usage unique** par compte (100 bits, seule son empreinte est stockée ; fichier en 600 pour `--all`), exigé à chaque étape : sans lui, le coffre n'est jamais remis (plus d'attaque hors ligne à partir du seul identifiant). 5 codes erronés referment la fenêtre. Le défi en cours n'est plus remplacé par une seconde demande. À la réussite : **toutes les sessions du compte sont révoquées**, ses cibles Web Push et FCM supprimées et ses connexions temps réel coupées (un appareil perdu ne garde ni accès ni notifications). Journal d'audit (`auth_recovery_log`, `--log`) : ouverture (avec l'utilisateur système), coffres remis, codes erronés, réussites, fermetures. Écran de connexion : lien « J'ai un code de récupération ».
  - **Lecture de la portée de la clé bornée à 8 s** : un serveur qui ne répond pas ne bloque plus la connexion indéfiniment, et aucune portée n'est devinée en cas d'échec.
  - **Émoticônes personnalisées** : le trousseau local est rangé par compte (sur un navigateur partagé, la déconnexion de l'un n'efface plus les clés de l'autre) ; un raccourci tapé pendant le traitement de l'image n'est plus écrasé par celui tiré du nom du fichier ; un texte tapé avant le chargement des émoticônes est reconverti dès qu'elles arrivent (le message partait sans l'émoticône).
  - **Tests** : `tests/test_route_authorization.js` tourne sur son propre serveur isolé, et les 15 autres tests « live » chargent eux-mêmes le garde-fou (ils s'arrêtent aussi lancés à la main face à un serveur qui n'est pas celui de test) ; test E2E des émoticônes stabilisé (cause réelle corrigée dans l'interface).
  - **Documentation** : README nuancé sur la portée de la clé (fuite passive, pas serveur actif) ; docs/DEPLOYMENT.md : procédure avec code, garanties et limites de la récupération.
- **Suite à une relecture externe** :
  - **Clé d'authentification : plus de verrouillage au changement de domaine.** Sa portée est désormais un identifiant stable du serveur (`AUTH_KEY_SCOPE`, annoncé par `GET /api/auth/scope`), à défaut l'hôte sans `www.`. Si la portée change quand même, l'administrateur ouvre une fenêtre de récupération (`node scripts/auth-recovery.mjs <identifiant>` ou `--all`) : chacun se reconnecte avec son mot de passe, l'app le prouve en ouvrant le coffre de clés du compte, et enregistre la nouvelle clé (mot de passe, clés de chiffrement et historique conservés). Documentation du modèle de menace : la portée protège contre une fuite passive (journaux), pas contre un serveur malveillant actif, qui sert lui-même le code de l'interface.
  - **Émoticônes reçues limitées à leur expéditeur** : elles ne s'appliquent qu'aux messages de ce contact ; un raccourci reçu doit contenir un symbole (plus de « le » ou « ok ») et ne peut pas reprendre une émoticône standard (`:)`, `:D`…).
  - **Message rejeté pour horodatage** : motif explicite (« date signée différente de plus de 15 min de celle du serveur : horloge décalée ou message re-daté ») au lieu de « signature invalide » ; documentation corrigée (un vieux message avec sa vraie date reste accepté, seul un message re-daté est refusé).
  - `/api/logout-device` exige une session (plus de déconnexion provoquée par un autre site).
  - **App Android (APK v10)** : dialogues « Faire confiance à ce serveur » et confirmation d'enregistrement protégés contre le recouvrement par une autre app (touches ignorées, fenêtres superposées masquées sur Android 12+), comme l'écran d'appel et l'écran de choix du serveur ; chemins locaux de Capacitor normalisés avant le contrôle (`/a/../_capacitor_file_/…`, `//…`, `%2e%2e` refusés) ; notification d'appel de secours avec la sonnerie du téléphone au lieu du son de message.
  - **Documentation** : README (sessions 24 h / 30 jours, Node.js 22, app Android, visionneuse d'images, clé liée au serveur, lancement en production, tests E2E, versionCode), docs/ANDROID.md (liste exacte des méthodes du pont contrôlées ou non), docs/DEPLOYMENT.md (`AUTH_KEY_SCOPE`, procédure de changement de domaine), docs/SECURITY_E2E.md.
- **Relecture sécurité, lot 5** :
  - **Style d'un message reçu borné** (taille 8 à 20, couleur `#RRGGBB`, police, gras/italique) : un contact ne peut plus afficher un texte géant qui casse la conversation, ni un texte transparent.
  - **Adresses fournies par un contact** : lien de téléchargement, identifiant de clin d'œil et son de message vocal acceptés seulement sous leur forme exacte ; un contact ne peut plus faire charger un autre chemin du serveur. Un clin d'œil inconnu n'est pas joué.
  - **Journal** : chaque ligne a une clé stable ; après un tri ou une insertion, la miniature d'une image ne s'affiche plus sous le mauvais message.
  - **Entrée pendant une saisie IME** (claviers japonais, chinois, coréen, certaines complétions Android) : valide le candidat au lieu d'envoyer le message incomplet.
  - **Connexion abandonnée** (clés de chiffrement impossibles à mettre en place) : le cookie de session est retiré de ce navigateur, sans déconnecter vos autres appareils.
  - **Historique paginé** : une conversation s'ouvre avec ses 300 derniers messages ; « Messages précédents » charge la page d'avant (une longue conversation avec des messages vocaux était envoyée en entier).
- **Relecture sécurité, lot 4** :
  - **Clé d'authentification liée au serveur** : elle est maintenant dérivée avec l'adresse du serveur (nom et port). Avant, la même clé servait sur toute instance OpenWLM où l'on utilisait le même identifiant et mot de passe : l'opérateur d'une instance tierce pouvait la rejouer ailleurs. Les comptes existants se connectent comme avant avec leur mot de passe et sont migrés sans rien demander (même mot de passe, même coffre, autres appareils toujours connectés) ; le changement de mot de passe et la réinitialisation E2E acceptent l'ancienne clé tant que la migration n'a pas eu lieu.
  - **Verrouillage de connexion** : 10 échecs par identifiant **et** adresse IP (plus un plafond large par identifiant) ; un tiers ne peut plus bloquer votre compte en tapant dix mauvais mots de passe depuis chez lui.
  - **Messages rejoués par un serveur** : l'horodatage signé par l'expéditeur est comparé à la date de réception du serveur (15 min de tolérance) ; un vieux message re-présenté comme nouveau est rejeté.
  - **Quota de stockage** : 512 Mo de messages persistés par compte ; au-delà, l'envoi est refusé avec un message explicite (effacer d'anciennes conversations libère de la place).
  - **Appel vidéo sans caméra** (PC sans webcam, caméra refusée ou occupée) : l'appel continue en audio, caméra coupée, au lieu de raccrocher des deux côtés.
  - **Journal de la conversation** : plus de défilement automatique pendant que vous relisez l'historique (seulement si vous étiez en bas, ou pour vos propres messages) ; le journal n'est plus recalculé à chaque caractère tapé (saisie plus fluide sur téléphone).
  - **Clavier** : Échap ferme la fenêtre du numéro de sécurité et celle de réinitialisation E2E, Tab reste à l'intérieur ; le menu de statut se parcourt aux flèches et se valide par Entrée.
- **App Android (APK v9, relecture lot 3)** :
  - La page ne peut plus lire les fichiers du téléphone par le serveur local de Capacitor (`/_capacitor_file_/…`, `/_capacitor_content_/…`) : réponse 404. Une page compromise ou un serveur personnalisé malveillant y aurait lu les cookies de session et les clés E2EE de la WebView.
  - Sous l'écran de verrouillage de l'app, la conversation n'est plus lisible par les services d'accessibilité ni accessible à un clavier physique (focus retiré).
  - Deuxième appel entrant pendant qu'un premier sonne (rare) : l'écran d'appel affiche le nouvel appelant au lieu de rester sur l'ancien (« Répondre » visait le mauvais contact).
  - Mineur : type MIME des fichiers enregistrés contrôlé ; au plus deux confirmations d'enregistrement affichées à la fois ; sur Android 8-9, deux enregistrements rapprochés ne s'écrasent plus ; `saveFile` (interface ancienne) borné à 20 Mo ; ouverture d'un écran système absent (profil restreint) sans plantage ; affinité de tâche vide (détournement de tâche sur Android 8-10).
- **Interface (relecture, lot 2)** :
  - **Émoticônes personnalisées perdues à la déconnexion** : leur clé n'existait que sur l'appareil et était effacée en se déconnectant ; elles restaient listées mais ne s'affichaient plus. La clé est désormais aussi sauvegardée sur le serveur, chiffrée pour votre propre clé publique (le serveur ne peut pas la lire), et retrouvée à la connexion sur n'importe quel appareil ; les émoticônes créées avant reçoivent leur copie au premier chargement.
  - **Ouvrir l'app sans réseau n'oublie plus l'appareil mémorisé** : seule une réponse du serveur (session expirée ou refusée) l'invalide ; hors ligne, l'écran de connexion l'explique et la connexion automatique revient avec le réseau.
  - **Session expirée** : l'app restait affichée mais morte (liste figée, « Non envoyé »). Elle revient à l'écran de connexion avec un message ; une erreur réseau pendant la vérification est réessayée (5 s, 15 s, 45 s, 60 s).
  - **Message reçu pendant le chargement d'une conversation** : il disparaissait de l'écran (et de la copie locale) une fois l'historique arrivé ; il est conservé.
  - **Rattrapage après une coupure** : les messages manqués déclenchent le compteur non-lu, le son et l'accusé « remis » (avant : silencieux, et l'expéditeur ne les voyait jamais « remis »), et sont insérés à leur place chronologique.
  - **Accusé de lecture** : plus envoyé quand la fenêtre est réduite ou qu'un autre onglet est au premier plan ; il part au retour.
  - **Appels** : impossible de lancer un second appel pendant un appel (message explicite) ; un appel entrant pendant un appel est refusé au lieu d'écraser l'appel en cours ; l'écran d'appel est recréé à chaque appel.
  - **Texte des messages** : `&`, `<` et `>` s'affichaient `&amp;`, `&lt;`, `&gt;` (échappement HTML inutile avant chiffrement).
  - **Émoticônes reçues d'un contact** : raccourci et identifiant contrôlés (même forme qu'à la création) et jamais prioritaires sur vos propres raccourcis ; avant, un contact pouvait remplacer chaque lettre ou espace de toutes vos conversations par son image.
  - **Contacts vérifiés** (numéro de sécurité) : rangés par compte ; sur un navigateur partagé, un badge « vérifié » posé par un compte ne s'affiche plus chez un autre, et « Réinitialiser E2E » n'efface plus les vérifications des autres comptes. Les vérifications existantes sont reprises par le premier compte qui se connecte.
  - **Clic sur une notification système** (PWA, navigateurs Chromium) : ouvre la conversation au lieu de seulement afficher la fenêtre.
- **Sécurité serveur (relecture, lot 1)** :
  - Limites par IP derrière un tunnel cloudflared local : le serveur signale au démarrage et dans le journal quand des requêtes Cloudflare arrivent d'une adresse hors des plages de confiance (tous les visiteurs partageaient alors l'IP 127.0.0.1 : 10 connexions/min pour tout le monde). Variable `CLOUDFLARE_IP_RANGES` documentée dans `.env.example`.
  - Upload de fichiers et d'émoticônes : nombre et taille des champs texte bornés (un compte pouvait épuiser la mémoire du serveur avec une seule requête multipart de milliers de champs).
  - Présence et profil : un contact que vous avez bloqué ou retiré de votre liste ne reçoit plus vos changements de statut, pseudo, message perso, avatar ou clé en temps réel.
  - Invitations : impossible d'inviter quelqu'un qui vous a bloqué (même réponse qu'un compte inexistant), plus de doublon d'invitation ni de réponse révélant l'existence d'un compte.
  - Messages : destinataire exigé entier, texte borné à 64 Ko (900 Ko pour un message vocal), identifiant `mid` borné, type sur liste blanche, style assaini, et budget de volume par expéditeur (24 Mo glissants sur 10 min) : deux comptes ne peuvent plus remplir le disque à 1 Mo par message.
  - Accusé « remis » : le drapeau « privé » envoyé par le client ne contourne plus la vérification d'existence du message ; accusés et bascule du mode privé limités en débit.
  - Jeux : invitations, acceptations, refus, rejouer, quitter et resynchronisation limités à 15 par 10 s ; « Rejouer » refusé tant que la partie n'est pas finie ; au Morpion, le perdant commence la manche suivante (avant, si le gagnant cliquait « Rejouer », aucun des deux ne pouvait jouer) ; identifiants normalisés ; acceptation d'une invitation dont l'auteur s'est déconnecté : réponse explicite.
  - Appels : un appelant ne peut plus faire sonner et notifier le même contact en boucle (un seul appel en attente par paire, 10 s de délai après un refus) ; avec plusieurs appareils, la coupure d'un appareil secondaire ne raccroche plus l'appel en cours sur l'autre ; appelant déconnecté pendant la sonnerie : l'appelé est prévenu et sa notification devient « manqué » ; un tiers ne reste plus « occupé » après un appel écrasé.
  - Inscription : identifiant normalisé une seule fois (un identifiant entouré d'espaces était accepté puis introuvable à la connexion).
  - Erreurs HTTP : réponse JSON courte (400/413/500) au lieu de la page HTML par défaut d'Express ; CORS déclare `DELETE` ; clés étrangères SQLite activées (les `ON DELETE CASCADE` déclarés étaient sans effet).
- **App Android (APK v8)** : le réglage de langue des notifications (`setLanguage`) n'est plus accepté que de la page du serveur choisi, comme les autres méthodes du pont natif qui agissent ou enregistrent un réglage ; les exceptions voulues (page hors ligne, lectures d'état, arrêts) sont documentées.
- **Le mot « MSN » retiré du code** : commentaires et noms de classes CSS (`msn-butterfly` → `wlm-logo`, `msn-game-icon` → `wlm-game-icon`), sans changement visible.
- **Audit de sécurité autonome** : `npm run test:security` démarre son propre serveur isolé (dossier temporaire, port libre) au lieu d'exiger un serveur lancé à la main et d'ouvrir le `messenger.db` du dépôt (qu'il créait vide en l'absence de serveur, puis échouait). Il tourne désormais aussi dans la CI.
- **Émoticône insérée au début du message** (surtout dans l'app Android) : en ouvrant le menu des émoticônes, le champ de saisie perdait sa sélection (et son contenu pouvait être reconstruit à la fermeture du clavier) ; en reprenant le focus, le curseur revenait au début et l'émoticône s'y insérait. La position du curseur est maintenant mémorisée en continu et restaurée : l'émoticône (ou la mise en forme 🎨) s'insère là où l'on écrivait.
- **App Android (APK v6), durcissement du pont natif** : les méthodes sensibles du pont (jeton de notifications, enregistrement de fichiers, service d'appel, écran allumé, autorisations) vérifient que la page est bien le serveur choisi en HTTPS ; le micro et la caméra ne sont accordés à la page que si l'app est visible et déverrouillée, pendant un appel, ou juste après « Répondre » ; chaque enregistrement dans Téléchargements est confirmé dans une fenêtre native. Le changement de serveur passe par un écran que les autres applications ne peuvent pas ouvrir ; écrans sensibles protégés contre le « tapjacking ». Contenu masqué (captures, applications récentes) quand l'app est verrouillée et, sur Android 12 et avant, en arrière-plan. Le service d'appel s'arrête si l'app est retirée des applications récentes ; « Refuser » lit le cookie de session de façon sûre.
- **Sécurité, suite de la revue** : la réinitialisation d'urgence des clés E2E supprime aussi les abonnements Web Push et jetons de l'app Android de tous les appareils du compte (un appareil hors ligne au moment du reset ne reçoit plus de notifications). Bloquer / débloquer n'accepte plus qu'un contact existant (plus d'événement de statut envoyé vers un identifiant arbitraire) et est limité en débit. Les modifications de profil, de statut et du mode privé, diffusées à tous les contacts, sont limitées à 30 par minute et par compte.
- **Déconnexion, suite** : si le serveur n'a pas pu révoquer la session, la connexion temps réel (fermée au début de la déconnexion) est rétablie aussitôt, que l'on réessaie ou non ; si la session n'existait déjà plus (401 / 403 : expirée, ou révoquée depuis un autre appareil), la déconnexion locale va à son terme au lieu de proposer un nouvel essai inutile. Abonnement Web Push borné dans le temps lui aussi. `scripts/deploy.sh` construit l'interface avec `npm run build` lui-même (dossier de sortie via `OPENWLM_BUILD_OUT_DIR`) et se passe de `mv --exchange` sur un coreutils ancien.
- **Suite de la revue** : la déconnexion vérifie la réponse du serveur (délai de 10 s) ; s'il n'a pas pu révoquer la session, l'app reste connectée et propose de réessayer au lieu de faire comme si tout était fini. Après « Déconnecter mes autres sessions » ou un changement de mot de passe, cet appareil réenregistre ses notifications (Web Push et app Android), au cas où leur lecture aurait échoué. Délais bornés pour les appels liés aux notifications. Noms de fichiers affichés sans séparateurs de chemin. `GET /api/health` exige désormais un appel local (adresse de bouclage). `scripts/deploy.sh` n'enregistre la version qu'après un redémarrage réussi, reprend un déploiement interrompu, et construit l'interface à côté avant de l'échanger avec `dist/`.
- **Messages « Non envoyé » par intermittence (surtout sur mobile)** : au retour de veille ou après un changement de réseau, la connexion temps réel pouvait paraître ouverte sans plus rien transmettre, jusqu'à 85 s ; un message envoyé dans cet intervalle échouait au bout de 15 s et il fallait le renvoyer. Au retour dans l'app (ou du réseau), la connexion est maintenant contrôlée en 3 s et rétablie aussitôt si elle ne répond pas ; un message envoyé pendant une reconnexion attend la connexion (30 s au plus) au lieu d'échouer ; un accusé qui n'arrive pas déclenche une reconnexion et un nouvel envoi automatique du même message (dédupliqué, pas de doublon chez le destinataire). Aucun changement serveur.
- **Notifications, suite de la revue** : un enregistrement du jeton de l'app qui échoue (hors ligne, serveur indisponible) n'est plus considéré comme réussi : il est réessayé au retour du réseau ou dans l'app, une synchronisation à la fois. La déconnexion n'attend plus indéfiniment le service worker (navigation privée, enregistrement échoué) : la révocation côté serveur passe d'abord, les désabonnements locaux sont bornés à quelques secondes et la purge des clés a lieu dans tous les cas ; le changement de mot de passe n'est plus bloqué non plus. Changement de serveur depuis l'APK v3 : le jeton est désormais retiré de l'ancien serveur, et réenregistré si l'on annule.
- **Fichiers reçus** : le nom affiché dans la conversation est nettoyé des caractères invisibles et bidirectionnels (une extension ne peut plus être déguisée).
- **Serveur** : `/api/logout` renvoie une erreur si la révocation échoue en base au lieu de l'ignorer ; nouvelle route `GET /api/health` (base lisible), réservée aux appels locaux (404 pour une requête venue de Cloudflare), utilisée par `openwlm-service.sh`. CI : job Android (tests JVM, lint Android, APK de debug).
- **Notifications et sessions** : la déconnexion supprime désormais tous les abonnements Web Push et jetons de l'app Android du compte (elle révoque déjà toutes ses sessions), et le changement de mot de passe ceux des autres appareils, comme « Déconnecter mes autres sessions ». Un appareil déconnecté ne reçoit plus le nom des expéditeurs ni la sonnerie des appels. L'appareil se désabonne aussi de son côté, y compris quand sa session a été révoquée ailleurs.
- **App Android, après la seconde revue** :
  - L'interface s'adapte à l'APK installé : avec l'APK v3, les fichiers reçus sont de nouveau enregistrés (en un bloc) et le changement de serveur garde les notifications ; l'APK v5 garde aussi l'ancienne méthode pour une interface en cache.
  - Le jeton de notifications n'est enregistré que si les notifications sont autorisées : un appel ne « sonne » plus dans le vide sur un téléphone qui les a coupées.
  - Choix du serveur : avertissement « serveur de confiance uniquement » et confirmation pour tout serveur autre que celui par défaut (la vérification de l'adresse n'est pas une authentification).
  - Fichiers : deux enregistrements simultanés au plus, caractères invisibles et bidirectionnels retirés des noms (un nom comme « facture » + U+202E + « gnp.exe » ne peut plus se faire passer pour une image), copie hors du fil de l'interface sur Android 8-9.
  - L'écran peut de nouveau s'éteindre après un appel vidéo ; la durée d'appel ne repart plus de zéro quand on bascule le haut-parleur.
- **Profil** : l'édition en place du pseudo et du message perso respecte les limites de 50 et 150 caractères visibles (message si trop long, au lieu d'un refus silencieux du serveur) ; un échec d'enregistrement du profil est signalé.
- **Aperçus** : les balises de mise en forme ne s'affichent plus dans les notifications et toasts de message.
- **Échap** dans le sélecteur de couleur ne ferme plus aussi la fenêtre Options.
- **Serveur** : arrêt propre sur SIGTERM / SIGINT (connexions et base fermées). `follow-redirects` mis à jour (vulnérabilité haute signalée par `npm audit`), vérification `npm audit` ajoutée à la CI. `npm run winks:prerender` explique comment récupérer les sources `.swf` au lieu de ne rien faire.
- **App Android, après revue de code** :
  - « Répondre » à un appel ne dispense plus du déverrouillage de l'app que si le téléphone exigeait vraiment un code ou une empreinte à la sonnerie (pas pendant le délai de grâce ni en Smart Lock), une seule fois et pour l'appel qui sonne encore ; un appel vidéo pris derrière l'écran de verrouillage de l'app démarre caméra coupée.
  - Changer de serveur retire le jeton de notifications du compte sur l'ancien serveur et le supprime chez Firebase, arrête sonnerie et appel en cours et retire les notifications : l'ancien serveur ne peut plus réveiller le téléphone ni faire refuser un appel sur le nouveau.
  - Les fichiers reçus sont enregistrés par morceaux de 1,5 Mo : un fichier de 100 Mo ne risque plus de faire planter l'app.
  - La durée de sonnerie ne dépend plus de l'horloge du téléphone (5 à 90 s) ; un appel n'est plus ignoré quand le téléphone avance.
  - « Refuser » journalise la réponse du serveur ; le partage de fichiers interne (FileProvider) est limité aux photos prises depuis l'app.
- **Inactivité de tout l'ordinateur** (Chrome / Edge) : quand le navigateur refusait de démarrer la détection alors que l'autorisation était accordée (PWA ouverte au démarrage de Windows ou à la sortie de veille, par exemple), l'option restait inopérante jusqu'à ce qu'on retire puis rende l'autorisation, et annonçait à tort une autorisation retirée. La détection est maintenant relancée quand la fenêtre revient au premier plan (et après 5 s, 15 s et 60 s), les Options affichent un message dédié et l'erreur du navigateur est écrite dans la console.
- `scripts/openwlm-service.sh install` refuse un dossier sans `.env` : lancé depuis un dépôt de développement, il faisait tourner le service depuis ce dossier (sans secrets ni base de prod).

---

## [1.7.0] - 2026-10-19

### Mise à jour depuis la 1.6.x
- Aucune migration de base, aucune nouvelle variable d'environnement, aucune nouvelle route HTTP (règles WAF Cloudflare inchangées), pas de nouveau service worker.
- Les utilisateurs obtiennent la nouvelle version en rechargeant l'application. Tant qu'un contact n'a pas rechargé, son ancienne version affiche les balises de mise en forme telles quelles (`[c=4]Salut[/c]`) et les actions `/me` comme des messages normaux ; rien n'est perdu.
- Le serveur ne compte plus que les caractères **visibles** des pseudos (50) et des messages perso (150) ; les balises sont permises en plus, dans la limite de 300 / 600 caractères au total.

### Nouveautés
- **Mise en forme** des pseudos, messages perso et messages : gras, italique, souligné, barré, 16 couleurs classiques ou n'importe quel `#RRGGBB`, couleurs de fond, dégradés de texte et de fond (`[c=4]rouge[/c]`, `[c=4]dégradé[/c=12]`, codes courts `·$4`). Bouton 🎨 à côté du champ de saisie et des champs pseudo / message perso (avec aperçu). Rendu par React sans aucun HTML injecté ; les balises sont retirées là où elles ne peuvent pas s'afficher (notifications, titres, infobulles). Option pour tout afficher en texte simple (Options → Messages). Le pseudo et le message perso gardent leurs limites de 50 et 150 caractères **visibles** (vérifiées aussi par le serveur).
- **Commandes `/`** dans les conversations : `/me`, `/clear`, `/online`, `/busy`, `/away`, `/offline`, `/nick`, `/psm`, `/all`, `/signout`, `/help`, avec liste de suggestions (Tab pour compléter) ; `//` envoie un message qui commence par `/`.
- **Textes rapides** (Options → Messages) : `/raccourci` envoie un message tout prêt, `(!N)` est remplacé par le nom du contact. Enregistrés sur l'appareil.
- **Rappel des messages** avec Ctrl+↑ / Ctrl+↓.
- **Recherche dans une conversation** avec Ctrl+F (résultats surlignés, compteur, précédent / suivant).
- **Fenêtre d'aide** : menu principal → Aide, lien **Aide** sur l'écran de connexion, `/help`. Documentation : [docs/FORMATTING_AND_COMMANDS.fr.md](docs/FORMATTING_AND_COMMANDS.fr.md).

### Correctifs
- Un champ de saisie vidé avec Ctrl+A puis Suppr gardait un saut de ligne invisible, ajouté au début du message suivant.
- **Mobile** : le panneau de couleurs 🎨 de la conversation était coupé par la barre d'outils (on n'en voyait que le bord derrière le champ de saisie) ; il s'affiche maintenant par-dessus toute la page. Dans la fenêtre d'aide, le menu de gauche se replie (bouton ☰, repli automatique après le choix d'une rubrique) pour laisser toute la largeur au texte, et les tableaux larges défilent.
- **Clic droit sur le contact de test « OpenWLM »** : il ouvre maintenant son menu — envoyer un message, effacer l'historique (sur l'appareil seulement), masquer le contact de test (à réafficher dans Options → Disposition). Supprimer et Bloquer, sans objet pour ce contact virtuel, ne sont pas proposés.

### Ménage
- Ménage des ressources non utilisées.
- **Correctif** : la scène du contact de test pointait vers un fichier qui n'a jamais existé (`0002.png` au lieu de `0002.jpg`).

### Tests
- **Nouveaux scénarios E2E** pour cette version : `e2e/extras.spec.ts` (mise en forme, commandes, textes rapides, rappel, recherche, aide, menu du contact de test, sur deux comptes) et `e2e/extras-mobile.spec.ts` (format téléphone : panneau 🎨, menu de l'aide). Serveur : limites du pseudo et du message perso avec balises (`tests/test_profile_limits.js`).
- **Fiabilité de la suite E2E** : les scénarios ouvraient une session de navigateur par compte sans la fermer ; dans le navigateur partagé, des dizaines de sessions connectées s'accumulaient jusqu'à ce qu'une page ne réponde plus (`unread.spec.ts` échouait dans la suite complète, jamais seul). Une fixture commune (`e2e/test.ts`) les ferme désormais après chaque test : 27/27, et la suite complète prend 3,6 min au lieu de 7,8.
- **Nouveaux tests E2E du transfert de fichier et des messages vocaux** (`e2e/files-voice.spec.ts`), qui n'avaient jusqu'ici aucun test de bout en bout (leur chiffrement de bout en bout existait déjà). Fichier : envoyé par A, stocké chiffré sur le serveur (le texte n'apparaît pas dans le fichier stocké), téléchargé par B avec exactement le même contenu. Message vocal : enregistré avec le faux micro de Chromium, reçu par B, chiffré dans l'historique du serveur (aucun son en clair), et réellement lu (minuteur qui avance).

## [1.6.2] - 2026-10-19

### Correctifs
- **Les comptes de démonstration (`npm run db:seed`) ne pouvaient pas se connecter** : le script enregistrait une empreinte de SHA-256(mot de passe), alors que l'app envoie une clé dérivée par PBKDF2-SHA256 (600 000 itérations) puis HKDF. Il reproduit désormais la dérivation de l'app et le stockage du serveur, utilise le vrai schéma du serveur (`server/db.js`) et n'insère plus de message de bienvenue en clair (l'app n'affiche que des messages signés et chiffrés). Le serveur E2E lance désormais le script et `e2e/auth.spec.ts` se connecte au compte de démo par l'interface.
- **Changement de mot de passe avec une session révoquée entre-temps** : un 401 `session_revoked` s'affichait comme « Mot de passe actuel incorrect » ; l'app revient désormais à l'écran de connexion.
- La minuterie de fermeture automatique de la fenêtre de mot de passe est annulée si la fenêtre disparaît avant.
- Doc : un appareil révoqué efface ses clés mémorisées et ses données de session ; la copie locale chiffrée est conservée (illisible jusqu'à la prochaine connexion), pour qu'un changement de mot de passe ou une déconnexion sur un autre de ses appareils n'efface pas les messages privés.

### Traduction (interface anglaise)
- **Plus de français dans l'interface anglaise** : 39 alertes du navigateur et 1 confirmation, les lignes système des conversations (mode privé, Wizz, clins d'œil), le contact de test « OpenWLM » (accueil, écho, aide, jeux solo, son message perso), les aperçus de notification (« [Fichier] », « [Message vocal] », « [Clin d'œil] »), les noms des arrière-plans de conversation, le résultat du test Push et le message perso par défaut (« Disponible » est désormais vide, ce qui affiche l'invite traduite « Entrez votre message perso ») étaient écrits en français en dur. Ils passent désormais par les fichiers de traduction (nouveaux groupes `notices` et `errors`).
- **Lignes système repérées par le drapeau `system`** au lieu de l'expéditeur « Système », qui apparaissait en français dans l'interface anglaise.
- **Erreurs du serveur traduites** : les erreurs de connexion, d'inscription et d'invitation portent désormais un code (`invalid_credentials`, `username_taken`, `captcha_wrong`, `invite_self`…) traduit par l'app ; un 429 affiche « Trop de tentatives ». Les autres erreurs restent rédigées en français par le serveur : l'interface française les affiche telles quelles, l'interface anglaise affiche son propre message traduit.
- Test E2E `e2e/i18n-en.spec.ts` (interface anglaise : mauvais mot de passe, contact de test, erreur d'invitation, lignes de mode privé et de Wizz des deux côtés).

### Menu principal et fenêtre Options
- **Langue** : se choisit uniquement dans Options → Personnel (retirée du menu de la liste de contacts).
- **Sessions dans le menu** : « Se déconnecter » devient **Se déconnecter de partout**, suivi de **Se déconnecter des autres appareils** (avec confirmation ; même action que dans Options → Sécurité, renommée là aussi). « Oublier cet appareil » devient **Supprimer mes clés de cet appareil**, qui dit ce que fait l'action.
- **Fenêtre Options** : plus de OK / Annuler / Appliquer, puisque chaque réglage est enregistré dès qu'il change ; le pseudo et le message perso sont enregistrés en quittant le champ (ou Entrée) et à la fermeture. Fermeture par ✕, Échap ou un clic à côté. Habillage Aero (barre de titre en dégradé, coins arrondis, colonne d'onglets bleue) comme les autres boîtes de dialogue, avec la mention « Les modifications sont enregistrées automatiquement ».
- Test E2E : plus de langue dans le menu, déconnexion des autres appareils depuis le menu, pseudo enregistré à la fermeture, message perso enregistré en quittant le champ.
- **Liste de contacts redimensionnable (ordinateur)** : faire glisser le bord droit de la liste pour l'élargir (de 260 à 640 px, en laissant toujours au moins 420 px à la conversation) ; la largeur est mémorisée sur l'appareil (`wlm_prefs`), un double-clic revient à la taille d'origine, les flèches ←/→ fonctionnent aussi sur la poignée sélectionnée. Pas sur mobile, où la liste occupe tout l'écran. Test E2E.

### Fenêtres Aero au lieu des fenêtres du navigateur
- **Plus de fenêtres natives du navigateur** : les 41 `alert()` et les 2 `window.confirm()` (supprimer un contact, supprimer une émoticône perso) sont remplacés par de petites fenêtres Aero comme le reste de l'app (`notify()` / `askConfirm()` dans `src/utils/dialogs.ts`, affichées par `<DialogHost />` monté une seule fois à la racine, donc aussi sur l'écran de connexion). Les messages sont mis en file et affichés un par un ; Entrée valide, Échap ferme ou annule ; les erreurs ont une icône ⚠️, les confirmations destructrices un bouton rouge.
- **La réussite de l'inscription** s'affiche désormais dans le formulaire (message vert) au lieu d'une fenêtre, puisqu'on enchaîne directement sur la connexion.
- E2E : le test en interface anglaise lit les fenêtres Aero, vérifie la confirmation (Annuler, Échap, Supprimer) et échoue si une fenêtre native du navigateur s'ouvre.

### Correctifs
- **Onglets de conversation** : retour de la flèche normale sur les onglets (ils affichaient une main ouverte depuis qu'on peut les déplacer) ; la main fermée n'apparaît que pendant le déplacement d'un onglet, le ✕ garde sa main.

## [1.6.1] - 2026-10-19

### Correctifs (revue de la 1.6.0)
- **Messages privés reçus pendant le chargement d'une conversation** : un message privé reçu (ou envoyé) entre la lecture de la copie locale et la réponse du serveur pouvait manquer à la copie réécrite, et être perdu au rechargement suivant. Les messages purement locaux enregistrés depuis la dernière réécriture complète sont désormais gardés de côté et repris dans la suivante.
- **Effacement de la copie locale** : les enregistrements sont supprimés à partir de la liste de leurs clés lue d'abord (`getAllKeys`), et non pendant le parcours d'un curseur d'index (effacement du compte et réécriture d'une conversation).
- **Push après « Déconnecter mes autres sessions »** : si l'abonnement Push de cet appareil n'avait pas pu être lu à temps, il était supprimé avec les autres ; l'app le réenregistre désormais ensuite (seulement si les notifications sont déjà autorisées).
- **Plus de jeton périmé après une révocation** : après « Déconnecter mes autres sessions » ou un changement de mot de passe, tout jeton gardé en mémoire est abandonné et seul le cookie renouvelé est utilisé (le serveur n'expose aujourd'hui aucun jeton à la page ; cela évite qu'un appareil se révoque lui-même si cela changeait).
- **`diag_ping` limité en débit** (20 par 10 s et par connexion), comme les autres événements temps réel. Test serveur ajouté.

## [1.6.0] - 2026-10-18

Des appels qui atteignent un téléphone en veille et continuent écran éteint, la fenêtre Options complétée (Disposition, Messages, Sons, Sécurité, Connexion), des indicateurs de messages non lus, des messages privés conservés au rechargement, le Démineur à deux, et une série de correctifs issus de deux revues de code.

**En bref**
- **Appels** : « ça sonne » seulement quand un appareil du contact confirme ; un téléphone en veille est réveillé par une notification d'appel (Répondre / Refuser) dans la langue de l'app ; les appels continuent écran éteint sur Android ; écran maintenu allumé pendant la vidéo ; son corrigé en appel audio.
- **Options** : réglages Disposition, Messages et Sons par appareil ; un onglet Sécurité (contacts bloqués, déconnecter mes autres sessions, changement de mot de passe redessiné — il était cassé depuis la 1.4.0…) ; un onglet Connexion avec un diagnostic et un rapport à copier.
- **Messages** : onglet, badge et titre de page pour les non-lus ; messages privés plus perdus et conservés dans la copie locale chiffrée.
- **Présence** : inactivité de tout l'ordinateur en option (Idle Detection), statut restauré au redémarrage, notification de connexion d'un contact.
- **Jeux** : le Démineur à deux (Minesweeper Flags, mines gardées côté serveur) et des sons pour tous les jeux.

### Mise à jour depuis la 1.5.x
- Aucune migration de base, aucune nouvelle variable d'environnement.
- Deux nouvelles routes HTTP : `POST /api/calls/decline` et `POST /api/sessions/revoke-others`. Si vous utilisez les règles WAF Cloudflare, réimportez `docs/cloudflare-waf.generated.json` (ou ajoutez les deux routes), sinon Cloudflare les bloque.
- Nouveau service worker (cache `openwlm-v7`) : les utilisateurs doivent recharger l'app (sur mobile, fermer complètement l'app installée) pour recevoir les nouvelles notifications d'appel.
- Les tests serveur exigent désormais un serveur lancé avec `NODE_ENV=test` depuis la racine du dépôt (voir le README).

### Appels
- **« Ça sonne » seulement quand l'appareil de l'appelé confirme** : le serveur annonçait « ça sonne » à l'appelant dès qu'il avait transmis l'appel, même si le téléphone de l'appelé était en veille avec une connexion périmée. L'appel est désormais remis avec un accusé de réception (4 s) ; « ça sonne » ne s'affiche qu'une fois un appareil confirmé. Sinon l'appelant voit « X ne semble pas disponible sur ses appareils » (`call_waking`).
- **Réveil par Push d'appel** : sans accusé (ou sans connexion mais avec un abonnement Push), le serveur envoie une notification Push d'appel en urgence haute (durée de vie 45 s). Le service worker l'affiche avec Répondre / Refuser et la réaffiche toutes les 4 s pendant 30 s au plus (son et vibration du système) pour imiter une sonnerie. Refuser appelle la nouvelle route `POST /api/calls/decline` sans ouvrir l'application ; Répondre ouvre la conversation.
- **Appel redonné à l'appareil qui se réveille** : l'appel en attente (offre chiffrée gardée 60 s) est présenté à tout appareil de l'appelé qui se connecte, ou qui revient au premier plan sans avoir été déconnecté (page suspendue dont la connexion a survécu : l'application envoie `call_resync`). Cet appareil sonne alors réellement, et l'application ferme la notification qui sonne.
- **Fin de la notification d'appel** : « Appel manqué » quand l'appelant raccroche, « Appel pris sur un autre appareil » / « Appel refusé » quand l'appel est pris ou refusé ailleurs (rien n'est affiché sur l'appareil où l'application est ouverte), et « Appel manqué » d'elle-même quand l'appel expire sans réponse (elle restait affichée).
- **Un seul appel présenté à la fois** : un second appelant reçoit « occupé » quand un appel sonne déjà chez le contact.
- **Notifications dans la langue de l'app** : le serveur ne connaît pas la langue de l'app (réglage propre à l'appareil). Il envoie une clé avec un texte français de repli ; la page enregistre sa langue dans le cache `openwlm-prefs` et le service worker affiche les textes, Répondre / Refuser compris, dans cette langue.
- **Appels qui continuent écran éteint (Android)** : Chromium (Chrome, Brave…) suspendait la page quelques secondes après l'extinction de l'écran et l'appel devenait muet. Comme YouTube, l'application joue désormais une piste quasi silencieuse en boucle pendant l'appel et affiche « Conversation audio avec X » dans la notification multimédia, ce qui garde la page active. Le bouton pause de la notification est ignoré. Pas sur iPhone (iOS coupe le micro des pages web écran verrouillé).
- **Écran maintenu allumé pendant la vidéo** : tant que de la vidéo circule (ma caméra, mon partage d'écran ou la vidéo du correspondant), l'application demande au système de garder l'écran allumé (API Screen Wake Lock), redemandé au retour dans l'application et relâché dès que la vidéo s'arrête. En appel audio, l'écran peut s'éteindre.
- **Pas de son en appel audio (corrigé)** : depuis que les appels audio réservent un canal vidéo (pour activer la caméra plus tard), le son distant était joué par le même élément `<video>` que cette piste vidéo vide. Chrome et Safari (sur mobile surtout) ne démarrent pas la lecture avant la première image vidéo : l'appel restait muet jusqu'à ce que quelqu'un active sa caméra. Le son distant passe désormais par un élément `<audio>` dédié, indépendant de la vidéo ; le choix du haut-parleur s'y applique. Si le navigateur bloque la lecture automatique, un bouton « 🔊 Activer le son » apparaît dans la fenêtre d'appel.
- **Limites** : la sonnerie utilise le son des notifications du système (pas de sonnerie en boucle sur un téléphone en veille sans application native) ; sur iPhone, le Push ne fonctionne que pour l'app installée sur l'écran d'accueil (iOS 16.4+) et la répétition y est peu fiable.
- Tests : `tests/test_call_delivery.js` (sonnerie après accusé, appareil périmé, appel redonné à la reconnexion et au retour au premier plan, route de refus, raccroché pendant le réveil, appelé injoignable, second appelant occupé) ; E2E : son distant réellement joué des deux côtés en appel audio, maintien et notification multimédia avec un user agent Android, écran maintenu allumé uniquement quand de la vidéo circule.

### Messages
- **Indicateur de non-lu** : une conversation avec des messages non lus a un onglet orange qui clignote avec un compteur, son contact est en gras avec un badge « ✉ n » dans la liste, et le titre de la page affiche le total (« (2) OpenWLM »). Tout s'efface quand la conversation est affichée avec la fenêtre au premier plan ; un message reçu dans la conversation que vous regardez n'est jamais compté comme non lu. Le clignotement est désactivé quand le système demande de réduire les animations.
- **Onglet visible même sans conversation ouverte** : un message reçu alors qu'aucune conversation n'était ouverte créait un onglet qui restait invisible derrière l'écran d'accueil. La barre d'onglets reste maintenant visible au-dessus.
- À savoir : le toast Aero n'apparaît que lorsque la fenêtre d'OpenWLM a le focus sur ordinateur ; sinon une notification système est utilisée (si elle est autorisée), et sur mobile la conversation s'ouvre directement.
- **Messages privés plus perdus** : le chargement de l'historique d'une conversation remplaçait la liste affichée par l'historique du serveur, donc les messages purement locaux disparaissaient — un message privé reçu dans un onglet qui venait de s'ouvrir pouvait disparaître aussitôt (le son jouait, rien ne s'affichait), et les messages privés ne survivaient jamais à un rechargement. Le chargement fusionne désormais l'historique serveur avec ce qui n'existe que sur l'appareil (messages privés, lignes système, envois en cours), dans l'ordre chronologique (`src/utils/historyMerge.ts`).
- **Messages privés conservés au rechargement** : ils font désormais partie de la copie locale chiffrée (Options → Messages, activée par défaut). Le serveur ne les stocke toujours jamais ; sans la copie locale, ils sont perdus au rechargement, comme l'indique l'option. Les messages privés envoyés gardent leur marqueur « privé » une fois confirmés par le serveur.
- **Copie locale écrite depuis ce qui est affiché** : elle était reconstruite depuis une liste qui pouvait ne pas encore contenir les messages tout juste lus dans la copie (aucun rendu entre-temps) : des messages privés pouvaient en disparaître au rechargement suivant. Elle est désormais écrite depuis la même liste fusionnée que l'affichage.
- **Copie locale effacée pour ce compte seulement, après confirmation** : décocher l'option ou « Effacer la copie locale » vidait aussitôt la copie de tous les comptes utilisés dans le navigateur. Seule la copie de ce compte est désormais effacée, après une confirmation dans l'onglet (les messages privés n'existent que là).
- Tests : E2E `e2e/unread.spec.ts`, `e2e/private-history.spec.ts` (message reçu onglet fermé, rechargement, jamais stocké par le serveur, option désactivée avec confirmation).

### Options
- **Disposition, Messages, Sons** : ces onglets, vides et non cliquables jusqu'ici, fonctionnent. Les réglages sont enregistrés sur l'appareil (`wlm_prefs`), pas sur le serveur.
  - **Disposition** : afficher ou masquer les contacts hors ligne (les contacts bloqués restent toujours visibles), les messages personnels et le contact de test « OpenWLM » ; tri par statut puis par nom, ou par nom.
  - **Messages** : émoticônes en images ou en texte ; heure des messages ; secousse de la fenêtre à la réception d'un Wizz (sinon une simple ligne) ; lecture automatique des clins d'œil reçus (sinon un bouton « Voir » dans la conversation) ; copie locale chiffrée des conversations et bouton « Effacer la copie locale ».
  - **Sons** : activation générale, volume avec un bouton Tester (il joue même si sa catégorie est coupée ou si le statut est Occupé), un interrupteur par événement (message, connexion d'un contact, Wizz, clin d'œil, sonnerie d'appel, jeux) et « couper les sons en Occupé » (la sonnerie reste active). Tous les sons de l'app passent par ces règles : SoundManager, sons des jeux, sonnerie d'appel, son des clins d'œil.
- **Sécurité** : regroupe ce qui était éparpillé entre le menu principal et le clic droit — changer de mot de passe, clés mémorisées sur cet appareil (« Oublier cet appareil »), mode privé global, mon code de sécurité, « Réinitialiser mes clés » — et ajoute une **liste des contacts bloqués** avec un bouton Débloquer. Les entrées du menu principal restent en place.
- **Déconnecter mes autres sessions** (onglet Sécurité) : nouvelle route `POST /api/sessions/revoke-others` (connexion requise, limitée à 10 par quart d'heure et par compte). Même mécanisme que le changement de mot de passe : le compteur de sessions du compte augmente, ce qui invalide toutes les sessions ouvertes, et cet appareil reçoit aussitôt un nouveau cookie valide. Les connexions temps réel des autres appareils reçoivent `session_revoked` et sont coupées ; leurs abonnements Push sont supprimés (un téléphone perdu ne reçoit plus de notifications), sauf celui de cet appareil. Confirmation dans l'onglet, sans mot de passe. Se déconnecter sur un appareil déconnecte toujours tous les autres.
- **Les appareils révoqués reviennent à l'écran de connexion** : un appareil dont la session avait été révoquée (changement de mot de passe, déconnexion sur un autre appareil) restait sur un écran inerte. Le serveur renvoie désormais un code `session_revoked` (HTTP 401 et erreur de connexion temps réel) ; l'application vérifie sa session : toujours valide (autre onglet du même navigateur, dont le cookie vient d'être renouvelé) → reconnexion ; révoquée → déconnexion locale (clés mémorisées et données de session effacées ; la copie locale chiffrée des conversations est conservée mais reste illisible jusqu'à la prochaine connexion avec le mot de passe ; sans appeler `/api/logout`, qui révoquerait aussi l'appareil à l'origine de la demande), avec une explication sur l'écran de connexion.
- **Réinitialiser mes clés** n'efface plus que les clés mémorisées et la copie locale de ce compte ; les autres comptes utilisés dans le même navigateur gardent les leurs.
- **Changer de mot de passe (corrigé et redessiné)** : le changement de mot de passe échouait depuis la 1.4.0 (« coffre de clés invalide ») : l'app tentait de re-chiffrer la clé privée de la session, qui n'est pas exportable, et produisait un coffre vide. La clé est désormais obtenue en déchiffrant le coffre avec le mot de passe actuel (ce qui vérifie aussi ce mot de passe sur l'appareil). La fenêtre est redessinée dans le style Aero : mot de passe actuel, nouveau mot de passe avec les mêmes règles et la même jauge de robustesse qu'à l'inscription (12 caractères minimum), champ de confirmation, vérification que le nouveau mot de passe diffère de l'actuel, et erreurs affichées dans la fenêtre au lieu d'alertes du navigateur. Cet appareil reste connecté (sa connexion temps réel est conservée), les autres reviennent à l'écran de connexion.
- **Les appareils coupés par le serveur reviennent à l'écran de connexion** : après un changement de mot de passe ou une déconnexion sur un autre appareil, le serveur coupe les connexions temps réel des autres appareils, et Socket.IO ne se reconnecte pas seul dans ce cas : ces appareils restaient sur un écran inerte. L'app vérifie désormais sa session dès que le serveur coupe la connexion (valide → reconnexion, révoquée → écran de connexion), avec une seconde vérification 1,5 s plus tard pour laisser à un autre onglet du même navigateur le temps de recevoir un cookie renouvelé.
- **Connexion (diagnostic)** : connexion temps réel (état, WebSocket ou repli HTTP, temps de réponse du serveur, bouton **Se reconnecter**), notifications (permission du navigateur, Push configuré sur le serveur, Push activé sur cet appareil, version du service worker), appels (à la demande, un test du réseau avec la configuration d'appel du serveur, sans appeler personne : relais TURN configuré ou non, et si les appels devraient passer par Internet) et navigateur (version de l'app, HTTPS, stockage local, détection d'inactivité, écran maintenu allumé, appel actif écran éteint). **Copier le rapport** donne un texte à coller pour demander de l'aide, sans secret (ni identifiants TURN, ni adresse Push, ni adresse IP). Le temps de réponse passe par la connexion temps réel existante (`diag_ping`) : aucune nouvelle route HTTP.
- La fenêtre Options ne dépasse plus la hauteur de l'écran (le contenu de l'onglet défile, OK / Annuler restent visibles) et sa colonne d'onglets est plus étroite sur petit écran. La case « webcam », jamais enregistrée ni utilisée, est supprimée.
- Code : `src/utils/appPrefs.ts`, `src/components/OptionsModal.tsx`, `src/components/ConnectionDiagnostics.tsx`. Tests : `tests/test_revoke_sessions.js` ; E2E `e2e/options-prefs.spec.ts` (effet réel de chaque réglage, liste des bloqués, « téléphone » et « PC » à deux onglets, diagnostic, réinitialisation des clés avec les données d'un autre compte sur l'appareil).

### Statut de présence
- **Inactivité de tout l'ordinateur (API Idle Detection)** : nouvelle option à activer, *Détecter l'inactivité de tout l'ordinateur*. Au lieu de l'activité dans la fenêtre OpenWLM, l'« Absent » automatique suit l'utilisation du clavier et de la souris dans n'importe quelle application, et un écran verrouillé fait passer « Absent » immédiatement ; l'activité ramène « Disponible ». Un statut choisi à la main n'est jamais modifié.
  - Disponibilité : navigateurs Chromium sur ordinateur (Chrome, Edge, Opera) et client Electron ; ni Firefox ni Safari. HTTPS requis.
  - Autorisation : `idle-detection`, demandée quand l'option est cochée ; reprise automatiquement au démarrage si elle est déjà accordée. Refusée ou retirée — même en cours de session — → retour automatique à l'inactivité dans la fenêtre, expliqué dans les Options ; la détection reprend d'elle-même si la permission est de nouveau accordée.
  - Confidentialité : la page ne reçoit que *actif/inactif* et *verrouillé/déverrouillé* ; seul le statut obtenu parvient au serveur. Le serveur envoie `Permissions-Policy: idle-detection=(self)` ; le client Electron autorise la permission `idle-detection`.
  - Correctif trouvé pendant les tests : le détecteur était relancé à chaque mise à jour du profil, et le détecteur relancé signalait d'abord « actif », annulant l'« Absent » qu'il venait de poser.
  - Code : `src/utils/systemIdle.ts`, `src/hooks/useProfile.ts` ; test E2E simulant inactivité, activité, écran verrouillé et permission retirée puis rendue via le protocole DevTools de Chromium.
- **Réglage de l'absence automatique** : le champ du délai d'inactivité peut être effacé et retapé (il revenait aussitôt à 1, donnant « 15 » ou « 110 »), est borné entre 1 et 120 minutes (une valeur négative passait « Absent » presque immédiatement) et se désactive quand l'option est décochée. Le toucher, la molette et le défilement dans la conversation ou la liste de contacts comptent comme activité (mobile). Le suivi de l'activité ne re-rend plus toute l'application à chaque mouvement de souris.
- **Statut restauré au redémarrage** : le statut choisi à la main (menu ou écran de connexion) est mémorisé sur l'appareil et restauré au redémarrage de l'app. L'absence automatique pour inactivité n'est jamais mémorisée : l'app revient « Disponible » ; un « Absent », « Occupé » ou « Apparaître hors ligne » volontaire est conservé.
- **Serveur** : le client transmet le statut voulu dans le handshake du socket et le serveur l'applique, au lieu de forcer « en ligne » — « Apparaître hors ligne » ne vous fait plus réapparaître en ligne auprès de vos contacts à la reconnexion. Les mises à jour de profil (pseudo, message perso, avatar, scène) ne renvoient plus un statut périmé.
- **Second appareil** : un appareil sans préférence mémorisée n'impose plus « Disponible » au statut choisi sur un autre appareil encore connecté ; il adopte le statut en cours.
- **Poste partagé** : l'écran de connexion ne présélectionne que le statut du compte mémorisé (plus de « dernier statut » global hérité d'un autre compte), et ne l'envoie que si le sélecteur a été modifié. Le champ `status` de la réponse de connexion n'est plus pris pour un choix de l'utilisateur.

### Notifications
- **Notification de connexion d'un contact** : quand un contact se connecte, un toast Aero « <pseudo> vient de se connecter » s'affiche (PC, app au premier plan), ou une notification système quand l'app est en arrière-plan et que les notifications sont autorisées — mêmes règles que pour les messages. Un clic ouvre la conversation. Silence pendant 10 s après votre propre (re)connexion, pour éviter une rafale au redémarrage du serveur. Seules les vraies connexions la déclenchent (marqueur `signedIn`) : modifier son pseudo, son message perso ou son avatar ne le fait plus. Le texte suit un changement de langue en cours de session.
- **Notifications Push dans la langue de l'app** : les notifications de message, de Wizz et de test Push suivent la langue de l'app, comme celles des appels.

### Jeux
- **Démineur à deux (Minesweeper Flags)** : la version où il faut TROUVER les mines. Plateau 16×16, 51 mines, le premier à 26 gagne (match nul impossible). Une mine rapporte 1 point et on rejoue ; un chiffre ou une zone vide (remplissage par diffusion) passe la main. Une bombe 5×5 par manche, utilisable avec au moins 3 mines de retard ; on garde la main si elle trouve une mine. Compteur central de mines, score des manches, style Aero, accessible depuis le menu Jeux, les invitations, la barre réduite et la reprise de partie.
- **Habillage** : le plateau reprend l'original — cases bleu ciel à nuages, cases ouvertes dorées avec gros chiffres colorés, fanions bleus/rouges, cadre marine, panneaux BLEU et ROUGE (avatar, compteur de drapeaux, bouton bombe barré quand indisponible, « À vous de jouer ! »), compteur de mines étoilé, contour pointillé du dernier coup à la couleur du joueur et bouton ABANDONNER. Dessiné en CSS et SVG (aucune image reprise).
- **Anti-triche** : le plateau est généré côté serveur (`crypto.randomInt`) et l'emplacement des mines ne quitte jamais le serveur — les clients ne reçoivent que les cases révélées, y compris à la resynchronisation ; les mines restantes ne sont montrées qu'à la fin de la manche.
- **Sons** : bruitages dédiés au Démineur synthétisés avec la Web Audio API (case révélée, cascade, mine trouvée, mine adverse, bombe — sans fichier audio). Le Morpion, le Puissance 4 et les Dames ont leurs propres bruitages de coup (trait de craie, jeton qui tombe, pion en bois, prise) — leurs coups étaient muets, le fichier son demandé n'existait pas. Tous les jeux partagent une fanfare de victoire, un son de défaite et un son neutre de match nul, joués une fois par manche ; les sons de messagerie ne servent plus dans les jeux.
- **Robustesse** : chaque gestionnaire de coup revérifie la relation de contact (un contact bloqué ou supprimé en cours de partie ne peut plus jouer) et est limité en débit (40 coups / 10 s par utilisateur) ; celui du Morpion vérifie le type de partie. Le plateau du Démineur ne peut plus rester bloqué après une réponse perdue ; la bombe armée est désarmée au changement de main, à la nouvelle manche et sur erreur ; les règles du plateau viennent de l'état serveur. Les panneaux de jeu n'affichent plus d'image cassée pour un contact sans avatar.
- **Barre d'outils** : le bouton « Activités », qui n'ouvrait qu'une invitation aux Dames, est supprimé (tous les jeux sont dans le menu Jeux).
- Tests : `tests/test_minesweeper_logic.js` (règles), `tests/test_minesweeper_server.js` (partie complète par sockets, aucune fuite avant la fin), `e2e/minesweeper.spec.ts` (deux navigateurs, plateaux synchronisés, trames WebSocket inspectées).

### Interne & tests
- **Les tests ne peuvent plus écrire dans une base de production** : les tests qui parlent à `localhost:3001` utilisaient ce port même quand c'était le serveur de production de la même machine, et leurs inscriptions y créaient de vrais comptes. Un serveur lancé avec `NODE_ENV=test` envoie désormais une empreinte de sa base (`X-OpenWLM-Test-Db`, uniquement en mode test) ; `scripts/live_server_guard.mjs` (chargé dans chaque fichier de test et par le contrôle préalable) arrête les tests si le serveur sur :3001 n'est pas le serveur de test de ce dépôt.
- Deux tests serveur utilisaient le même identifiant d'utilisateur et pouvaient se gêner en parallèle ; le test de déconnexion / `manual_disconnect` a son propre identifiant et un nettoyage complet.
- E2E : des échecs au hasard venaient de la preuve de travail de l'inscription (durée aléatoire, parfois au-delà du délai d'inscription des specs sous charge) ; le serveur E2E utilise la difficulté 10 au lieu de 17, la difficulté réelle reste couverte par `tests/test_signup_guard.js`.
- L'ancien événement socket `identify` est supprimé (gestionnaire serveur, émission client et chemin mort `alwaysBroadcast`) : les sessions sont enregistrées par la connexion authentifiée elle-même. Les erreurs de reprise du contexte audio sont interceptées ; les minuteries du Démineur sont nettoyées au démontage.
- Règles WAF régénérées (deux nouvelles routes) ; `npm audit` : aucune vulnérabilité connue.

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
