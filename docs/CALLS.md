# Appels audio/vidéo (WebRTC) — configuration & feuille de route

> ⚠️ **NON TESTÉ sur Cloudflare / WIP** : les changements P0 sont dans le code
> mais n'ont pas encore été validés en conditions réelles (réseaux variés).
> **Aucun TURN n'est configuré pour l'instant** (STUN seul).

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

### ⚠️ Hébergement du TURN
Un serveur TURN **ne peut pas** passer par le **Tunnel Cloudflare** (HTTP uniquement :
il faudrait de l'UDP et une plage de ports). Options :
1. **VPS dédié** `coturn` — IP publique, ports **3478/5349** (UDP/TCP) + **plage de relais** (ex. 49152–65535) ouverts.
2. **TURN hébergé** (Cloudflare Calls, Metered, Twilio, …) → renseigner `TURN_URLS`/`TURN_SECRET`.

> Recommandation : sans TURN, ~10–20 % des appels échouent (NAT symétrique, CGNAT,
> 4G/5G, réseaux d'entreprise). C'est la priorité #1 pour la stabilité.

### 🔒 Où mettre les secrets
Les identifiants TURN (et éventuels secrets) vont dans le fichier **`.env`** à la racine
du projet — **non versionné** (`.gitignore`), chargé automatiquement par le serveur au
démarrage (`process.loadEnvFile`). Ne **jamais** commiter `.env`.

Exemple (Metered.ca, identifiants statiques) :
```
STUN_URLS=stun:stun.relay.metered.ca:80,stun:stun.l.google.com:19302
TURN_URLS=turn:standard.relay.metered.ca:80,turn:standard.relay.metered.ca:80?transport=tcp,turn:standard.relay.metered.ca:443,turns:standard.relay.metered.ca:443?transport=tcp
TURN_USERNAME=<username>
TURN_PASSWORD=<credential>
```

## 2. P0 — implémenté
- **Config ICE configurable** (`/api/rtc-config`, STUN + TURN optionnel, creds éphémères).
- **Reprise ICE** : `disconnected` → tentative `restartIce()` après 4 s ; `failed` → reprise immédiate (max 3) ; état **« Reconnexion… »** ; abandon après 15 s.
- **Reprise sur reconnexion socket** (mobile / bascule réseau).
- **Budgets de débit** : audio ~32 kb/s, vidéo ~1,2 Mb/s, `degradationPreference: 'balanced'`.
- **Contraintes médias** bornées (640×360@24, echoCancellation/noiseSuppression/autoGainControl).
- **Signalisation complète** : serveur `call_ringing` / `call_accepted` / `call_rejected` / `call_busy` / `call_unavailable` ; suivi « occupé » + notification au pair en cas de **déconnexion brutale**.
- **Timeout « pas de réponse »** (45 s) côté appelant.
- **Erreurs média explicites** (permission refusée / aucun périphérique / déjà utilisé).
- **Signalisation WebRTC centralisée** dans `<VideoCall/>` (fin du buffer ICE global fuyant).
- **État « connecté » affiché seulement à la connexion réelle** (plus de faux « connecté »).

## 3. P2 — implémenté (interface)
- Boutons **micro on/off** et **caméra on/off** (bascule `track.enabled`).
- **Minuteur d'appel** et **indicateur de qualité** (RTT/perte lus via `getStats`, en lecture seule).
- **Sélecteur de périphériques** : micro / caméra / haut-parleur (`enumerateDevices`, `RTCRtpSender.replaceTrack`, `setSinkId`).
- **Plein écran** et **image dans l'image (PiP)**.
- **Responsive mobile** (modale plein écran, contrôles adaptés) ; vidéo distante en `object-fit: contain`.
- États d'appel enrichis : Sonnerie / Connexion / Reconnexion / terminaison avec motif.

## 4. P1 — implémenté
- **Adaptation dynamique** : la boucle `getStats()` (RTT + perte) ajuste `maxBitrate` et
  `scaleResolutionDownBy` de la piste vidéo (good / fair / poor), avec **hystérésis**
  (2 mesures consécutives) pour éviter le flapping.
- **Renégociation (*perfect negotiation*)** : `onnegotiationneeded` + traitement des
  `offer` entrants (avec gestion du *glare* polite/impolite). Actif une fois la
  négociation initiale terminée.
- **Partage d'écran** (`getDisplayMedia`) via `RTCRtpSender.replaceTrack` (donc **sans
  renégociation**) ; retour caméra automatique à l'arrêt ; bouton d'arrêt.
- **Opus FEC/DTX** : `useinbandfec=1` / `usedtx=1` posés par *SDP munging* sur la ligne
  `fmtp` d'Opus, avec **repli sûr** si le SDP modifié est refusé.

> ⚠️ Ces fonctions restent à **valider par un appel réel à 2 pairs** (le partage d'écran
> et la renégociation ne sont pas couverts par les tests automatisés).
