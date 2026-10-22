# Application Android

L'app Android est une coquille native [Capacitor](https://capacitorjs.com/) autour de
l'interface web. Elle ne contient **pas** l'interface : elle la charge depuis le serveur
OpenWLM choisi au premier lancement (par défaut `messenger.guifort.ovh`).

- **Pourquoi depuis le serveur** : la session repose sur un cookie `HttpOnly; SameSite=Strict`.
  Servie depuis une autre origine (`https://localhost`), l'app ne serait plus sur le même site
  que l'API et le cookie ne passerait pas. Chargée depuis le serveur, elle se comporte comme
  le navigateur, sans CORS ni changement des en-têtes, et reçoit les mises à jour de
  l'interface sans nouvel APK.
- **Choix du serveur** : écran natif au premier lancement ; à changer ensuite dans
  Options → Sécurité → Application Android, ou depuis l'écran hors ligne. L'app vérifie
  seulement que l'adresse répond comme un serveur OpenWLM (`GET /api/push/status`, HTTPS) :
  **ce n'est pas une authentification**, n'importe quel serveur peut imiter cette réponse. Or le
  serveur choisi affiche l'interface, reçoit l'identifiant et la clé de connexion (qu'il
  pourrait rejouer sur le vrai serveur) et accède au pont natif. L'écran le dit donc
  explicitement (« serveur de confiance uniquement »), et tout serveur autre que celui par
  défaut demande une confirmation la première fois. Durcissement possible plus tard : empreinte
  ou QR code du serveur, ou liste de serveurs autorisés.
  Changer de serveur coupe tout lien avec l'ancien : l'interface retire le jeton FCM du compte
  sur l'ancien serveur avant d'ouvrir l'écran, puis, si le serveur change vraiment, l'app
  supprime ce jeton chez Firebase (même si le retrait a échoué hors ligne), arrête toute
  sonnerie ou tout appel en cours et retire ses notifications. Les identifiants de contacts
  n'ont pas le même sens d'un serveur à l'autre. Annulé (ou même serveur) : le jeton est
  réenregistré.
- **Hors ligne** : si le serveur est injoignable, l'app affiche une page intégrée
  (`android-web/offline.html`) avec « Réessayer » et « Changer de serveur ».
- **Navigation** : limitée au serveur choisi ; les autres liens s'ouvrent dans le navigateur.
  Pas de contenu mixte, pas de trafic HTTP en clair.

Identifiant de paquet : **`org.openwlm.dev`** (définitif : il identifie l'app sur le téléphone
et pour Firebase).

## Ce que fait l'app native

| Fonction | Détail |
|---|---|
| Verrouillage | Empreinte, visage ou code du téléphone à l'ouverture et après 1 min en arrière-plan. Sans verrouillage d'écran configuré sur le téléphone, l'app ne peut pas être protégée (indiqué dans les Options). Contenu masqué (captures, aperçu des applications récentes) quand l'app est verrouillée, et en arrière-plan (Android 13+ : aperçu désactivé ; avant : `FLAG_SECURE` en arrière-plan). App ouverte et déverrouillée : captures possibles (partage d'écran en appel). |
| Session | « Se souvenir de cet appareil » garde la session 30 jours glissants (cf. ci-dessous). |
| Appels | Écran d'appel Android, même téléphone verrouillé ; service d'appel pendant la conversation (cf. « Appels natifs »). |
| Messages vocaux | Permission micro demandée par Android au premier usage. |
| Fichiers reçus | Enregistrés dans **Téléchargements** (la WebView ignore les liens de téléchargement), par morceaux de 1,5 Mo (`beginSave` / `appendChunk` / `finishSave`, `ChunkedFileSaver.java`) : jusqu'à 100 Mo sans charger le fichier entier en mémoire ; marqué « en cours » pendant l'écriture, supprimé en cas d'échec. Android 10+ : chaque enregistrement est **confirmé dans une fenêtre native** (nom, taille) ; Android 8-9 : le sélecteur d'emplacement du système en tient lieu. |
| Bouton Retour | Revient en arrière dans l'app (ferme par exemple la visionneuse d'image, qui ajoute une étape à l'historique), sinon la passe en arrière-plan sans la fermer. |
| Sauvegarde Android | Désactivée (y compris transfert d'appareil) : les clés E2EE mémorisées en IndexedDB ne quittent pas le téléphone. |
| Débogage WebView | Uniquement dans l'APK de debug (`chrome://inspect`). |

Dans l'app, l'interface masque ce qui n'existe pas dans une WebView Android : installation
PWA, réglages des notifications du navigateur / Web Push, option « inactivité de tout
l'ordinateur ». Détection : `isNativeApp()` dans `src/utils/platform.ts`.

## Pont natif : ce que la page peut demander

La page vient du serveur ; le plugin `OpenWLMNative` (Java) n'a accès ni aux fichiers internes
ni aux clés, mais certaines méthodes sont sensibles (jeton FCM, enregistrement dans
Téléchargements, service d'appel micro / caméra, écran allumé, autorisations). Durcissements :

- **Origine vérifiée** : chacune de ces méthodes refuse (`untrusted_origin`) si la page chargée
  n'est pas le serveur choisi en HTTPS (`BridgeTrust`, testé : `BridgeTrustTest`), en plus de la
  navigation déjà limitée à cet hôte.
- **Micro / caméra** (`GuardedWebChromeClient`, avant Capacitor) : accordés seulement à
  l'origine du serveur choisi, et seulement si l'app est visible et déverrouillée, si un appel
  est en cours (service d'appel), ou dans la minute qui suit « Répondre ». Une page compromise
  ne peut pas ouvrir le micro en arrière-plan ni derrière l'écran de verrouillage de l'app.
  Limite : un flux déjà ouvert avant le verrouillage continue (c'est le cas voulu d'un appel en
  cours, qui doit continuer écran éteint).
- **Fichiers** : confirmation native avant chaque enregistrement (Android 10+), 2 à la fois.
- **Changement de serveur** : écran non exporté (`ServerSettingsActivity`) ; le lanceur
  exporté (`ServerActivity`) ne sert qu'au premier choix et ne transmet aucune URI reçue.
  Écrans de choix du serveur, de verrouillage et d'appel protégés contre le « tapjacking »
  (`filterTouchesWhenObscured`).
- **Service d'appel** arrêté si l'app est retirée des applications récentes (`onTaskRemoved`).

## Appels natifs

Le serveur n'est pas modifié : il envoie le FCM d'appel (« data », priorité haute, TTL 45 s)
quand aucun appareil connecté n'a confirmé l'appel, puis le FCM `call_cancel` à la fin, et
redonne l'appel en attente à l'appareil qui se connecte (cf. docs/CALLS.md).

**Appel entrant** (`IncomingCallService`, service de premier plan « phoneCall ») :
- notification `CallStyle` avec intention plein écran : écran d'appel (`IncomingCallActivity`)
  par-dessus l'écran verrouillé, bandeau d'appel si le téléphone est utilisé ;
- sonnerie du téléphone en boucle et vibration, selon son mode : sonnerie, vibreur seul,
  silencieux ou « Ne pas déranger » (écran d'appel sans son) ;
- **Répondre** : l'app s'ouvre sur la conversation et **prend l'appel automatiquement** dès que le
  serveur le lui redonne (pas de second appui). Téléphone verrouillé : Android demande d'abord
  de le déverrouiller. L'app ne redemande pas son propre déverrouillage **seulement** si le
  téléphone exigeait réellement un code ou une empreinte quand l'appel a sonné
  (`isDeviceLocked` : faux pendant le délai de grâce ou en Smart Lock), n'en exige plus, et que
  la réponse concerne l'appel qui sonne encore ; ce passe-droit sert une seule fois et dure
  10 s (`AppLockPolicy`, testé : `AppLockPolicyTest`). Sinon, l'écran de verrouillage de l'app
  s'affiche normalement, et un appel **vidéo** pris derrière lui démarre **caméra coupée**
  (le correspondant en est informé ; bouton caméra pour l'allumer après déverrouillage) ;
- **Refuser** : `POST /api/calls/decline` avec le cookie de session et l'agent de la WebView
  (lus sur le thread principal),
  sans ouvrir l'app ; le code HTTP reçu est journalisé (`adb logcat -s OpenWLM`) ;
- arrêt de la sonnerie : `call_cancel` reçu (« Appel manqué », « Appel pris sur un autre
  appareil », « Appel refusé »), appel affiché par l'interface (app ouverte), ou expiration de
  l'appel → « Appel manqué ». Durée de sonnerie : `expiresAt` (horloge du serveur) moins
  l'heure d'envoi Firebase, donc indépendante de l'horloge du téléphone, bornée entre 5 et
  90 s ; un appel dont la fin est dépassée de plus d'une minute est ignoré (`CallTiming`,
  testé : `CallTimingTest`).

**Pendant l'appel** (`OngoingCallService`, types « phoneCall », « microphone » et, en vidéo,
« camera ») : démarré par l'interface quand l'appel s'établit (`startNativeCall`,
`src/utils/platform.ts`), il garde l'app et l'audio actifs écran éteint. Audio en mode
communication : **écouteur + capteur de proximité** (écran éteint contre l'oreille) en appel
audio, **haut-parleur + écran allumé** en vidéo ; casque ou Bluetooth utilisés s'ils sont
branchés. Notification d'appel en cours : durée, **Raccrocher**, **Haut-parleur / Écouteur**.
Dans l'app, les contournements web (`src/utils/callKeepAlive.ts` : piste quasi silencieuse +
Media Session, Screen Wake Lock) ne sont pas utilisés.

**Autorisations** : après la connexion, une fois par appareil, une fenêtre explique puis
demande le micro et l'autorisation « écran d'appel plein écran » (Android 14+ : à activer dans
les réglages, Android ne la donne d'office qu'aux applications de téléphone). État et boutons :
Options → Alertes → Appels. Sans l'autorisation plein écran, un appel téléphone verrouillé
s'affiche en notification (avec sonnerie) au lieu de l'écran d'appel.

Journaux utiles : `adb logcat | grep -iE "openwlm|IncomingCall|OngoingCall|FirebaseMessaging|chromium"`.

## Notifications (Firebase Cloud Messaging)

Le Web Push ne fonctionne pas dans une WebView Android : l'app reçoit ses notifications par
FCM, même fermée ou téléphone en veille. Le serveur envoie **les deux** (Web Push pour les
navigateurs, FCM pour l'app) à chaque `dispatchPushNotification`.

- **Contenu** : le même que le Web Push — nom de l'expéditeur et clé de traduction (`l10n`),
  jamais le texte d'un message ni l'offre d'un appel. Messages FCM « data » uniquement : c'est
  l'app qui construit la notification, dans la langue choisie dans l'app
  (`OpenWLMNotifications.java`).
- **Appels** : priorité haute, durée de vie 45 s (`CALL_PUSH_TTL_S`) ; écran d'appel natif,
  cf. « Appels natifs » ci-dessous.
- **App à l'écran** : pas de notification système, l'interface affiche ses propres alertes.
- **Toucher** : ouvre la conversation de l'expéditeur.
- **Jetons** : table `fcm_tokens` (un par installation). L'interface enregistre le jeton après la
  connexion (`POST /api/push/fcm/register`) et à chaque renouvellement, **seulement si les
  notifications sont autorisées** ; sinon elle le retire (`POST /api/push/fcm/unregister`) :
  le serveur ne compte pas un appareil qui ne peut rien afficher comme « réveillable » pour un
  appel. L'état est revérifié au retour dans l'app et au retour du réseau ; un enregistrement
  ou un retrait qui échoue (hors ligne, serveur indisponible) n'est pas mémorisé et sera
  réessayé ; une seule synchronisation à la fois. Un jeton repris par un autre compte
  (changement de compte sur le téléphone) change de propriétaire. 20 appareils au plus.
- **Révocation** : les notifications suivent les sessions (`server/utils/pushTargets.js`).
  Déconnexion (`/api/logout`, qui révoque toutes les sessions du compte) : tous les abonnements
  Web Push et jetons FCM du compte sont supprimés. Changement de mot de passe et « Déconnecter
  mes autres sessions » : ceux des autres appareils (l'appareil courant envoie les siens,
  `keepPushEndpoint` / `keepFcmToken`). Un appareil dont la session a été révoquée se désabonne
  aussi de son côté (Web Push `unsubscribe`, jeton FCM supprimé chez Firebase). Ces étapes
  locales sont bornées dans le temps (le service worker peut ne jamais s'activer) et passent
  après `/api/logout` ; la purge de la session (clés E2EE, stockage) a lieu dans tous les cas.
- **Autorisation** (Android 13+) : demandée une fois après la connexion ; état, bouton et test
  dans Options → Alertes.

### Mise en place

1. **Projet Firebase** (console.firebase.google.com) : ajouter une app Android
   `org.openwlm.dev`, télécharger `google-services.json`.
2. **App** : copier ce fichier dans `~/.openwlm/google-services.json` sur la machine de
   compilation (ou variable `OPENWLM_GOOGLE_SERVICES`). `android/app/build.gradle` le copie dans
   `android/app/` à chaque compilation (ignoré par Git). Sans lui, l'APK fonctionne sans
   notifications app fermée (indiqué dans les Options).
3. **Serveur** : Paramètres du projet → Comptes de service → **Générer une nouvelle clé
   privée**. Ce JSON est un **secret** : uniquement sur la machine de prod, hors du dépôt,
   droits 600, puis dans `.env` :
   ```
   FIREBASE_SERVICE_ACCOUNT=/chemin/absolu/vers/firebase-service-account.json
   ```
   Sans cette variable (ou si le fichier est invalide), le serveur démarre normalement, sans
   FCM. Au démarrage, le journal indique `[FCM] Configuré (projet …)` ou la raison de
   l'absence. `GET /api/push/status` renvoie `hasFcm`.

### Session d'un appareil mémorisé

Côté serveur (`issueSessionCookie`, `server/middleware/auth.js`) : à la connexion avec « se
souvenir de cet appareil », le jeton vaut 30 jours (sinon 24 h). `GET /api/user/me` le réémet
dès qu'il a plus de 12 h ; l'interface appelle cette route au démarrage puis toutes les heures.
La session reste donc ouverte tant que l'appareil sert au moins une fois par mois. Cela
s'applique aussi aux navigateurs. La révocation (changement de mot de passe, « Déconnecter mes
autres sessions », déconnexion) reste immédiate.

## Outils (une fois, sans droits administrateur)

Capacitor 8 demande **JDK 21** et le SDK Android **36** (minSdk 26).

```bash
# JDK 21 (Temurin)
mkdir -p ~/.local/jdk21
curl -fsSL "https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse" \
  | tar -xz -C ~/.local/jdk21 --strip-components=1

# Android command-line tools (prendre le dernier lien sur developer.android.com/studio#command-line-tools-only)
mkdir -p ~/Android/sdk/cmdline-tools
unzip commandlinetools-linux-*_latest.zip -d /tmp/ct && mv /tmp/ct/cmdline-tools ~/Android/sdk/cmdline-tools/latest

# ~/.bashrc
export JAVA_HOME="$HOME/.local/jdk21"
export ANDROID_HOME="$HOME/Android/sdk"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"

# Paquets du SDK (affiche les licences à accepter)
android --sdk="$ANDROID_HOME" sdk install platform-tools platforms/android-36 build-tools/36.0.0
```

Gradle utilise jusqu'à 4 Go (`android/gradle.properties`).

## Compatibilité entre l'interface et l'APK

L'interface est servie par le serveur et peut être plus récente (ou plus ancienne, en cache)
que l'APK installé. Elle teste les méthodes réellement exposées par l'APK
(`hasNativeMethod`, liste publiée par le pont natif de Capacitor) au lieu de supposer une
version : APK v3 → enregistrement des fichiers en un bloc (`saveFile`). Le changement de
serveur est le même pour toutes les versions : le jeton est retiré du compte avant d'ouvrir
l'écran, puis réenregistré au retour dans l'app si rien n'a changé (synchronisation au retour
au premier plan, sans dépendre de l'événement `serverChangeCancelled`, absent de la v3).
Limite de la v3 : elle ne supprime pas le jeton chez Firebase quand le serveur change ; si le
retrait a échoué (hors ligne), l'ancien serveur peut encore notifier ce téléphone. Côté natif, les méthodes des versions précédentes sont
gardées (`saveFile` en v5). Règle pour la suite : **ne jamais retirer une méthode native
utilisée par une interface déjà déployée**, et tester toute nouvelle méthode avant de
l'appeler.

## Tests

- Serveur : `npm test` (dont `tests/test_fcm_push.js`, `tests/test_push_revocation.js`,
  `tests/test_session_renewal.js`).
- Web : `npm run test:e2e` ; `e2e/android-save.spec.ts` simule le pont natif (plugin
  OpenWLMNative) : enregistrement par morceaux (APK v4+) et repli sur `saveFile` (APK v3).
  `e2e/image-viewer.spec.ts` couvre la visionneuse d'image au format téléphone (pincement,
  double-tap, Retour) : le zoom y est géré par la page, le pincement de la page restant désactivé.
- Natif (JVM, sans téléphone) : `cd android && ./gradlew :app:testDebugUnitTest`
  (`AppLockPolicyTest`, `CallTimingTest`, `FileNamesTest`) ; lint : `./gradlew :app:lintDebug`.
- Sur le téléphone : `adb logcat` et `chrome://inspect` (APK de debug).

## Signature

Le keystore et ses mots de passe sont **hors du dépôt**, dans `~/.openwlm/` (droits 600) :

- `~/.openwlm/openwlm-release.jks` — clé RSA 4096, alias `openwlm`, valable 30 ans ;
- `~/.openwlm/keystore.properties` — `storeFile`, `storePassword`, `keyAlias`, `keyPassword`.

`android/app/build.gradle` lit ce fichier (autre emplacement : variable
`OPENWLM_KEYSTORE_PROPERTIES`). Sans lui, l'APK de publication n'est pas signé.

> ⚠️ **Sauvegardez ces deux fichiers** hors de cette machine (gestionnaire de mots de passe,
> support chiffré). Sans le keystore, impossible de publier une mise à jour : Android refuse
> d'installer un APK signé par une autre clé par-dessus l'app existante (il faudrait la
> désinstaller, et perdre les données de l'app).

Créer un nouveau keystore (seulement s'il n'y en a pas déjà un) :

```bash
umask 077; mkdir -p ~/.openwlm
keytool -genkeypair -storetype PKCS12 -keystore ~/.openwlm/openwlm-release.jks -alias openwlm \
  -keyalg RSA -keysize 4096 -validity 10950 -dname "CN=OpenWLM, O=OpenWLM"
```

Les fichiers `*.jks`, `*.keystore` et `keystore.properties` sont ignorés par Git et refusés
par `npm run check:secrets`.

## Compiler

```bash
npm ci
npm run android:apk        # = cap sync android && ./gradlew assembleRelease
# → android/app/build/outputs/apk/release/app-release.apk (signé)
```

APK de debug (débogage WebView actif) : `npm run android:sync && cd android && ./gradlew assembleDebug`.

Avant chaque livraison : incrémenter `versionCode` dans `android/app/build.gradle`.
`versionName` reprend automatiquement la version de `package.json`.

Les icônes viennent de `public/pwa-*.png` (dont l'icône maskable pour l'icône adaptative) :
`npm run android:icons` après un changement d'icône.

Une modification de l'interface web ne demande **pas** de nouvel APK : il suffit de la
déployer sur le serveur. Un nouvel APK n'est nécessaire que pour le code natif (`android/`).

## Installer sur le téléphone

**Sans câble** : copier l'APK sur le téléphone (ou le télécharger), l'ouvrir, autoriser
l'installation depuis cette source quand Android le demande.

```bash
# Depuis votre PC, si l'APK a été compilé sur une autre machine :
scp utilisateur@machine:OpenWLM/android/app/build/outputs/apk/release/app-release.apk .
```

**Avec adb** (options développeur + débogage USB, ou débogage sans fil) :

```bash
adb devices                       # le téléphone doit apparaître
adb install -r app-release.apk    # -r : mise à jour en gardant les données
adb logcat | grep -iE "capacitor|openwlm|chromium"
```

Empreinte du certificat (pour vérifier un APK) :
`apksigner verify --print-certs app-release.apk`.

## Vérifications sur le téléphone

- Premier lancement : écran de choix du serveur, puis connexion.
- « Se souvenir de cet appareil » : fermer l'app (balayer), la rouvrir, redémarrer le
  téléphone → toujours connecté, messages lisibles (clés E2EE en IndexedDB conservées).
- Verrouillage : empreinte / code à l'ouverture ; rien après moins d'une minute en
  arrière-plan ; de nouveau après plus d'une minute.
- Messages, fichiers (envoi, réception → Téléchargements), clins d'œil, jeux, Options.
- Appel audio puis vidéo, app ouverte : son et image dans les deux sens ; écran éteint
  (bouton marche) → l'appel continue ; appel audio contre l'oreille → écran éteint.
- Appels app fermée / téléphone verrouillé : cf. la procédure de test de la livraison
  (Répondre, Refuser, appel manqué, pris sur un autre appareil).
- Mode avion → page hors ligne → « Réessayer » au retour du réseau.
- Options → Sécurité → Application Android → Changer de serveur.
- Déconnexion.
