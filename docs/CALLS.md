# Appels audio/vidéo (WebRTC) — configuration & feuille de route

> Appels audio/vidéo testés en conditions réelles derrière Cloudflare (2026-10-16).
> **Aucun TURN n'est configuré par défaut** (STUN seul) : à renseigner par déploiement (§1) ;
> sans TURN, certains réseaux (NAT symétrique, CGNAT, 4G/5G) peuvent empêcher l'appel.

## 1. Configuration ICE (STUN / TURN)

L'application récupère sa configuration via **`GET /api/rtc-config`** (authentifié).
Côté serveur (`server/routes/rtc.js`), tout est piloté par variables d'environnement
(voir `.env.example`) :

| Variable | Défaut | Rôle |
|---|---|---|
| `STUN_URLS` | `stun:stun.l.google.com:19302` | Liste d'URLs STUN (séparées par des virgules) |
| `TURN_URLS` | *(vide)* | Liste d'URLs TURN (`turn:host:3478?transport=udp,turns:host:5349`) |
| `TURN_USERNAME` / `TURN_PASSWORD` | *(vide)* | Identifiants **statiques** (ex : Metered.ca, Twilio « standard ») |
| `TURN_SECRET` | *(vide)* | Secret partagé → identifiants **éphémères** (TURN REST API / coturn). Ignoré si USERNAME/PASSWORD fournis |
| `TURN_TTL` | `3600` | Durée de vie des identifiants TURN (s) |
| `ICE_TRANSPORT_POLICY` | `all` | `all` ou `relay` (forcer le passage par TURN) |

Tant que `TURN_URLS` **et** `TURN_SECRET` sont vides, **seul STUN** est renvoyé.

### Identifiants TURN éphémères
Quand TURN est configuré, le serveur génère à la volée :
```
username   = <timestamp_expiration>:<userId>
credential = base64(HMAC-SHA1(TURN_SECRET, username))
```
(mécanisme standard *TURN REST API*, compatible **coturn** via `use-auth-secret`).

### Hébergement du TURN
Un serveur TURN **ne peut pas** passer par le Tunnel Cloudflare (HTTP uniquement :
il faudrait de l'UDP et une plage de ports). Options :
1. **VPS dédié** `coturn` — IP publique, ports 3478/5349 (UDP/TCP) + plage de relais (ex. 49152–65535) ouverts.
2. **TURN hébergé** (Cloudflare Calls, Metered, Twilio, …) → renseigner `TURN_URLS`/`TURN_SECRET`.

> Recommandation : sans TURN, ~10–20 % des appels échouent (NAT symétrique, CGNAT,
> 4G/5G, réseaux d'entreprise). C'est la priorité #1 pour la stabilité.

### Où mettre les secrets
Les identifiants TURN (et éventuels secrets) vont dans le fichier **`.env`** à la racine
du projet — **non versionné** (`.gitignore`), chargé automatiquement par le serveur au
démarrage par `server/loadEnv.js` (`process.loadEnvFile`, importé avant tout autre module). Ne **jamais** commiter `.env`.

Exemple (Metered.ca, identifiants statiques) :
```
STUN_URLS=stun:stun.relay.metered.ca:80,stun:stun.l.google.com:19302
TURN_URLS=turn:standard.relay.metered.ca:80,turn:standard.relay.metered.ca:80?transport=tcp,turn:standard.relay.metered.ca:443,turns:standard.relay.metered.ca:443?transport=tcp
TURN_USERNAME=<username>
TURN_PASSWORD=<credential>
```

## 2. P0 — implémenté
- **Config ICE configurable** (`/api/rtc-config`, STUN + TURN optionnel, creds éphémères).
- **Reprise ICE** : `disconnected` → tentative `restartIce()` après 4 s ; `failed` → reprise immédiate (max 3) ; état « Reconnexion… » ; abandon après 15 s.
- **Reprise sur reconnexion socket** (mobile / bascule réseau).
- **Budgets de débit** : audio ~32 kb/s, vidéo ~1,2 Mb/s, `degradationPreference: 'balanced'`.
- **Contraintes médias** bornées (640×360@24, echoCancellation/noiseSuppression/autoGainControl).
- **Signalisation** : serveur `call_ringing` / `call_waking` / `call_accepted` / `call_rejected` / `call_busy` / `call_unavailable` ; suivi « occupé » + notification au pair en cas de déconnexion brutale.
- **« Ça sonne » confirmé** : le serveur présente l'appel aux appareils de l'appelé en exigeant
  un **accusé de réception** (`incoming_call` avec acquittement, 4 s). L'appelant ne voit
  « ça sonne » (`call_ringing`) qu'une fois un appareil confirmé. Un téléphone en veille garde
  une connexion « fantôme » (~45 s avant détection) qui ne répond pas : sans accusé, l'appelant
  voit « X ne semble pas disponible sur ses appareils » (`call_waking`).
- **Réveil par Push** : sans accusé (ou si l'appelé n'a aucune connexion mais un abonnement
  Push), le serveur envoie une **notification Push d'appel** (urgence haute, durée de vie 45 s).
  Le service worker l'affiche avec « Répondre » / « Refuser » et la réaffiche toutes les 4 s
  (son et vibration du système) pendant 30 s au plus, pour imiter une sonnerie. « Refuser »
  appelle `POST /api/calls/decline` sans ouvrir l'application ; « Répondre » (ou un clic) ouvre
  la conversation. L'offre d'appel (chiffrée) est gardée pendant la sonnerie (60 s) et
  **redonnée** à tout appareil de l'appelé qui se (re)connecte : l'appel s'affiche alors et
  l'appelant passe à « ça sonne ». Si l'appelant raccroche, la notification devient « Appel manqué ».
- **Limites du réveil** : le son est celui des notifications du système (pas de sonnerie en
  boucle sur un téléphone en veille, ce qui demanderait une application native). Sur iPhone, le
  Push ne fonctionne que pour l'app installée sur l'écran d'accueil (iOS 16.4+), et la
  répétition y est peu fiable ; sur Android avec Chrome, ça fonctionne bien. La notification
  d'appel contient le nom de l'appelant (comme celles des messages), jamais l'offre.
- **Écran éteint (Android)** : Chromium (Chrome, Brave…) suspend une page écran éteint au bout
  de quelques secondes, sauf si elle joue un « vrai » média (c'est ce qui permet à YouTube de
  continuer). L'audio d'un appel WebRTC n'en bénéficie pas. Pendant l'appel, l'application joue
  donc en boucle un fichier quasi silencieux (environ -90 dB, généré à la volée) et affiche
  « Conversation audio avec X » dans la notification multimédia : la page reste active et l'appel
  continue écran éteint. Le bouton pause de la notification est ignoré (il ne coupe pas
  l'appel). Uniquement sur Android : sur iPhone, iOS coupe le micro des pages web écran
  verrouillé, seule une application native peut l'éviter. La caméra se coupe toujours écran
  éteint. Code : `src/utils/callKeepAlive.ts`.
- **Timeout « pas de réponse »** (45 s) côté appelant.
- **Erreurs média explicites** (permission refusée / aucun périphérique / déjà utilisé).
- **Signalisation WebRTC centralisée** dans `<VideoCall/>` (fin du buffer ICE global fuyant).
- **État « connecté »** posé à la réception des pistes du pair ou à la connexion ICE, sans être écrasé ensuite par un « connexion » arrivé plus tard (correctif 1.5.0).
- **Candidats ICE reçus avant la réponse** : mis en file puis appliqués des deux côtés, y compris chez l'appelant (correctif 1.5.0).

## 3. P2 — implémenté (interface)
- **Boutons micro et caméra** on/off (bascule `track.enabled` en appel vidéo).
- **Passage en vidéo depuis un appel audio** : un appel audio réserve dès l'offre un
  transceiver vidéo (l'appelé le passe en `sendrecv` avant de répondre). Activer la caméra
  ou partager l'écran branche la piste par `replaceTrack`, sans renégociation ; une caméra
  ouverte en cours d'appel audio est libérée (piste arrêtée) quand on la coupe. Avec un pair
  d'une version antérieure (pas de transceiver vidéo), repli sur `addTrack` + renégociation.
- **Signal `media-state`** (chiffré comme le reste de la signalisation) : indique au pair si
  l'on envoie de la vidéo ; la fenêtre bascule entre l'écran audio et la vidéo, et affiche
  « X a coupé sa caméra » en appel vidéo.
- **Minuteur d'appel** et indicateur de qualité (RTT/perte lus via `getStats`, en lecture seule).
- **Sélecteur de périphériques** : micro / caméra / haut-parleur (`enumerateDevices`, `RTCRtpSender.replaceTrack`, `setSinkId`).
- **Plein écran** et image dans l'image (PiP).
- **Responsive mobile** (modale plein écran, contrôles adaptés) ; vidéo distante en `object-fit: contain`.
- États d'appel enrichis : Sonnerie / Connexion / Reconnexion / terminaison avec motif.
- **Sonnerie en boucle** (élément audio, non affecté par le throttling des minuteries
  en arrière-plan) + notification système sur appel entrant (alerte même onglet caché).

## 4. P1 — implémenté
- **Adaptation dynamique** : la boucle `getStats()` (RTT + perte) ajuste `maxBitrate` et
  `scaleResolutionDownBy` de la piste vidéo (good / fair / poor), avec hystérésis
  (2 mesures consécutives) pour éviter le flapping.
- **Renégociation (*perfect negotiation*)** : `onnegotiationneeded` + traitement des
  `offer` entrants (avec gestion du *glare* polite/impolite). Actif une fois la
  négociation initiale terminée.
- **Partage d'écran** (`getDisplayMedia`) via `RTCRtpSender.replaceTrack` (donc sans
  renégociation), aussi depuis un appel audio ; à l'arrêt, retour à la caméra si elle est
  active, sinon plus de vidéo envoyée ; bouton masqué si le navigateur ne le permet pas.
- **Opus FEC/DTX** : `useinbandfec=1` / `usedtx=1` posés par *SDP munging* sur la ligne
  `fmtp` d'Opus, avec repli si le SDP modifié est refusé.

> Le test E2E `e2e/calls.spec.ts` couvre, entre deux navigateurs Chromium avec médias
> factices : appel audio, caméra activée/coupée dans les deux sens, partage d'écran.
> Non couverts par les tests automatisés : Safari/iOS et le repli par renégociation (pair
> d'une version antérieure).

## 5. Sécurité des appels (E2E)
- **Média** : chiffré de bout en bout par DTLS-SRTP (natif WebRTC). Le TURN et le Tunnel
  ne voient que du chiffré.
- **Signalisation (SDP/ICE)** : chiffrée E2EE avant transport, avec le même schéma
  que les messages (`encryptMessagePayload` : AES-GCM + clé AES emballée RSA-OAEP pour les
  deux pairs). Le serveur devient un relais aveugle — il ne peut plus lire les SDP/ICE.
- **Anti-MITM** : l'empreinte DTLS (`a=fingerprint:`) de chaque offer/answer est
  signée (RSA-PSS) par la clé du pair (même matériel RSA que l'E2EE, réimporté en PSS)
  et vérifiée à la réception. Une offre forgée par un serveur compromis est rejetée.
  Vérifié en isolation : signature valide OK, altération rejetée, MITM rejeté.
- **Confiance des clés publiques** : TOFU + vérification de contact (déjà en place) ; une
  fois l'identité du contact vérifiée, le binding média↔identité est authentifié.
- **Vérification obligatoire** : une offre/réponse sans signature d'empreinte, ou dont la
  signature ne peut pas être vérifiée (clé du pair indisponible, RSA-PSS non supporté), est
  refusée et l'appel échoue. Les signaux `ice-candidate` et `media-state` ne portent pas
  d'empreinte et ne sont que chiffrés.
- **Validation des appels** : `call_accept` / `call_reject` ne sont honorés que pour un appel
  réellement en attente (TTL 60 s) ; raccrocher pendant la sonnerie l'annule ; les appels
  en attente sont purgés à la déconnexion (anti‑DoS « occupé »).
- **Format de signalisation changé** : les deux pairs doivent recharger l'app
  (Ctrl+F5). Un client ancien (signalisation non chiffrée) ne peut pas établir d'appel avec
  un client récent.
