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
  Options → Sécurité → Application Android, ou depuis l'écran hors ligne. L'app vérifie que
  l'adresse répond comme un serveur OpenWLM (`GET /api/push/status`) ; HTTPS uniquement.
- **Hors ligne** : si le serveur est injoignable, l'app affiche une page intégrée
  (`android-web/offline.html`) avec « Réessayer » et « Changer de serveur ».
- **Navigation** : limitée au serveur choisi ; les autres liens s'ouvrent dans le navigateur.
  Pas de contenu mixte, pas de trafic HTTP en clair.

Identifiant de paquet : **`org.openwlm.dev`** (définitif : il identifie l'app sur le téléphone
et pour Firebase).

## Ce que fait l'app native

| Fonction | Détail |
|---|---|
| Verrouillage | Empreinte, visage ou code du téléphone à l'ouverture et après 1 min en arrière-plan. Sans verrouillage d'écran configuré sur le téléphone, l'app ne peut pas être protégée (indiqué dans les Options). L'aperçu dans les applications récentes est masqué (Android 13+). |
| Session | « Se souvenir de cet appareil » garde la session 30 jours glissants (cf. ci-dessous). |
| Appels, messages vocaux | Permissions caméra / micro demandées par Android au premier usage. |
| Fichiers reçus | Enregistrés dans **Téléchargements** (la WebView ignore les liens de téléchargement). |
| Bouton Retour | Revient en arrière dans l'app, sinon la passe en arrière-plan sans la fermer. |
| Sauvegarde Android | Désactivée (y compris transfert d'appareil) : les clés E2EE mémorisées en IndexedDB ne quittent pas le téléphone. |
| Débogage WebView | Uniquement dans l'APK de debug (`chrome://inspect`). |

Dans l'app, l'interface masque ce qui n'existe pas dans une WebView Android : installation
PWA, réglages des notifications du navigateur / Web Push, option « inactivité de tout
l'ordinateur ». Détection : `isNativeApp()` dans `src/utils/platform.ts`.

**Pas encore** (étapes suivantes) : notifications app fermée (Firebase Cloud Messaging), écran
d'appel natif. Pour l'instant, messages et appels arrivent quand l'app est ouverte.

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
- Appel audio puis vidéo, app ouverte : demande des permissions, son et image dans les deux sens.
- Mode avion → page hors ligne → « Réessayer » au retour du réseau.
- Options → Sécurité → Application Android → Changer de serveur.
- Déconnexion.
