# Sécurité & chiffrement — état réel

> ⚠️ Ce document décrit précisément ce qui est implémenté, ce qui ne l'est pas, et les limites.
> Dernière mise à jour : 2026-10-12 (signatures des messages, vérification stricte des appels).

---

## 1. Ce qui EST chiffré de bout en bout (E2E)

| Contenu | Chiffrement | Où c'est fait |
|---|---|---|
| **Messages texte** | AES‑GCM 256 + clé AES emballée **RSA‑OAEP 2048/SHA‑256** pour le destinataire **et** l'expéditeur, puis enveloppe **signée RSA‑PSS** par l'expéditeur (cf. §2 bis) | Client (`src/utils/MessageEnvelope.ts`) — le serveur ne stocke que l'enveloppe `{v,from,to,mid,ts,iv,payload,keyReceiver,keySender,sig}` |
| **Clips vocaux** | inclus dans le **payload chiffré** du message | Client |
| **Fichiers / pièces jointes** | **chiffrés côté client avant upload** (AES‑GCM 256 + clé RSA‑OAEP), serveur = coffre opaque | `encryptFileBinary` (client) |
| **Émoticônes personnalisées** | **chiffrées côté client avant upload** ; la clé AES voyage dans le message E2EE | `encryptCustomEmoticon` (client) |
| **Appels — média** | **DTLS‑SRTP** (imposé par WebRTC) : chiffré **pair‑à‑pair** ; TURN et Tunnel ne voient que du chiffré | Navigateur (WebRTC) |
| **Appels — signalisation (SDP/ICE)** | **chiffrée E2EE** + **empreinte DTLS signée RSA‑PSS**, vérification **obligatoire** : une offre/réponse non signée ou invérifiable est refusée (anti‑MITM) | `src/components/VideoCall.tsx` |

**Primitives utilisées** : AES‑GCM 256, RSA‑OAEP 2048 (SHA‑256), RSA‑PSS (SHA‑256, salt 32), PBKDF2‑HMAC‑SHA256 **600 000** itérations, HKDF‑SHA256, DTLS‑SRTP.

**Dérivation des clés (zero‑knowledge)** : le **mot de passe ne quitte jamais le navigateur**.
`PBKDF2(600k)` → *MasterKey* → `HKDF` → `authKey` (transport) + `vaultKey` (AES‑GCM) qui
**chiffre la clé privée RSA** avant son stockage serveur. Le serveur détient le **coffre
chiffré**, jamais la clé en clair.

---

## 2 bis. Authentification des messages (signatures)

Depuis l'enveloppe v2, chaque message (texte, vocal, fichier, wink) est **chiffré puis
signé** par l'expéditeur. Avant, les messages étaient chiffrés mais **pas authentifiés** :
le serveur, qui connaît toutes les clés publiques, pouvait fabriquer un message chiffré
valide « de la part de » n'importe quel contact, et le client affichait aussi le texte non
chiffré tel quel.

**Ce que vérifie le client à la réception** (`openMessage`) :

- la **signature RSA‑PSS** de l'expéditeur sur l'enveloppe complète (préfixe de domaine
  `openwlm-msg-v2`, distinct des signatures d'appel) ;
- que l'**émetteur et le destinataire signés** correspondent à ceux annoncés par le serveur
  (pas de réacheminement) ;
- que `from`/`to`/`mid`, **répétés dans le contenu chiffré**, correspondent à l'enveloppe
  (un tiers ne peut pas retirer la signature et re‑signer avec sa propre clé) ;
- l'**unicité du `mid`** (128 bits aléatoires) : un message rejoué est ignoré.

**Ce que voit l'utilisateur :**

| Verdict | Affichage |
|---|---|
| Signé et valide | normal |
| Ancien format non signé (antérieur aux signatures) | contenu affiché avec **⚠ « non vérifié »** |
| Clé publique de l'expéditeur indisponible | contenu affiché avec **⚠ « non vérifié »** |
| Signature invalide / incohérente | **contenu masqué**, bandeau « Message rejeté » |
| Message non chiffré | **contenu masqué**, bandeau « Message rejeté » |

**Anti‑rétrogradation** : dès qu'un contact a envoyé un message signé valide, un message
**non signé** reçu en direct de sa part est rejeté (son client signe toujours). Les anciens
messages de l'historique restent lisibles, avec l'avertissement.

**Limites :**

- **TOFU** : la signature prouve que le message vient du **détenteur de la clé publique
  distribuée par le serveur**. Sans vérification manuelle du code de sécurité, un serveur
  compromis peut toujours substituer la clé d'un contact **avant** le premier échange (ou
  après une réinitialisation, ce qui déclenche l'alerte de changement d'empreinte).
- La **même paire RSA** sert au chiffrement (OAEP) et à la signature (PSS). Aucune attaque
  pratique connue sur cette combinaison, et le code de sécurité couvre ainsi les deux usages ;
  des clés séparées restent la pratique recommandée (évolution future, nécessite un
  changement de schéma serveur).
- L'**anti‑rejeu** porte sur la session (et sur chaque chargement d'historique) ; `ts` est
  signé mais pas contrôlé par rapport à l'horloge locale.
- Les **métadonnées** (cf. §2) restent visibles du serveur.

---

## 2. Ce qui N'EST PAS chiffré de bout en bout (visible par le serveur)

- **Pseudo (nickname)**, **PSM / statut perso**, **avatar**.
- **Statut de présence** (en ligne / occupé / absent / hors ligne), **mode privé**.
- **Métadonnées des messages** : **type** (`text`/`audio`/`sound`…), **horodatages**,
  **qui parle à qui**, tailles.
- **Nom de fichier d'origine**, type MIME et taille (`originalName`, `fileType` envoyés
  **en clair** avec l'upload — seul le contenu est chiffré).
- **Graphe social** : liste de contacts, invitations (qui invite qui).
- **Clés publiques** (par nature publiques).

Le **contenu** est chiffré ; **les métadonnées et le profil ne le sont pas** — c'est la
limite habituelle de ce type d'application.

---

## 3. Modèle de menace : protège / protège pas

**Ce que l'E2E protège**
- Un serveur « curieux » (qui stocke/lit ce qu'il reçoit) ne peut **pas** lire le contenu
  des messages, clips vocaux, fichiers, émoticônes, ni le média des appels.

**Ce que l'E2E ne protège PAS**
- **Un serveur compromis qui sert du JavaScript malveillant** : l'app est une **web app** ;
  si le serveur (ou son hébergeur/CDN) sert du code piégé, il peut exfiltrer les clés.
  Autrement dit, l'E2E fait **confiance au code livré**.
- **MITM au premier contact (TOFU)** : la clé publique d'un contact est récupérée **du
  serveur**. Sans **vérification manuelle** (empreinte / code de sécurité), un serveur
  compromis pourrait substituer une clé → écoute. La **vérification de contact** (déjà
  présente) permet de détecter/valider la clé. Pour les appels, la **signature de
  l'empreinte DTLS** bloque le MITM **une fois les clés publiques établies/vérifiées**.
- **Pas de forward secrecy (PFS)** : chaque message a une clé AES éphémère, mais elle est
  **emballée avec la clé RSA statique** du destinataire. Si la **clé privée RSA fuite** (ou
  si le mot de passe est cassé puis le coffre déchiffré), les **anciens messages/fichiers
  déjà stockés pourraient être déchiffrés**. Pas de ratchet type Signal.

---

## 4. Limites et éléments NON couverts (backlog honnête)

- **Pas de forward secrecy / ratchet** (Signal‑like).
- **Vérification des clés non obligatoire** (manuelle, à l'initiative de l'utilisateur).
- **Métadonnées non protégées** (nom/type de fichier en clair, horodatages, graphe social).
- Le **TURN** relaie du média chiffré mais **voit les adresses IP** des pairs (et le
  trafic). C'est le prix de la traversée NAT.
- **Pas d'audit externe** / pas de revue par un tiers.
- **Dépendance au JS servi** (cf. §3) — inhérent au modèle web.
- **Sauvegardes serveur** : contiennent le **chiffré** (OK) mais aussi la base de
  **métadonnées en clair**.

---

## 5. Sécurité réseau / plateforme (contexte)

- **Transport** : HTTPS/WSS via **Cloudflare Tunnel** (aucun port d'origine exposé) ;
  en‑têtes de sécurité (CSP, HSTS, X‑Frame‑Options, COOP/CORP…).
- **Auth** : JWT (HS256) + `token_version` (révocation), sessions, login **zero‑knowledge**.
- **Anti‑abus** : limiteurs serveur + **WAF Cloudflare en liste blanche** → voir
  `docs/CLOUDFLARE_WAF.md`. Appels : rate limiting signalisation, suivi « occupé ».

---

## 6. Références code

- `src/utils/Security.ts` — primitives E2EE (AES‑GCM, RSA‑OAEP, RSA‑PSS, PBKDF2/HKDF).
- `src/utils/MessageEnvelope.ts` — enveloppe de message signée v2 (scellement, vérification, verdicts) ; tests : `tests/test_message_envelope.js`, `tests/test_signed_messages_server.js`.
- `src/utils/E2EEKeyStorage.ts` — stockage local des clés (non extractibles).
- `src/components/VideoCall.tsx` — signalisation E2EE + signature/vérif de l'empreinte DTLS.
- `src/components/CustomEmoticonsModal.tsx` — chiffrement des émoticônes avant upload.
- `server/routes/rtc.js` — config STUN/TURN (`/api/rtc-config`).
- `docs/CALLS.md`, `docs/CLOUDFLARE_WAF.md`, `docs/SERVER_ARCHITECTURE.md`.

---

## 7. Durcissements récents (2026-10-12)

Ces changements **ne modifient pas** le périmètre E2E ci‑dessus (§1–§2) ; ils durcissent
l'authentification et l'abus côté serveur :

- **PBKDF2 asynchrone** (`crypto.pbkdf2`, pool libuv) : la vérification d'un login ne bloque
  plus la boucle d'événements. Paramètres **inchangés** (hashs existants valides).
- **Login à temps constant** : un calcul PBKDF2 est fait même pour un compte inexistant
  (anti‑énumération de comptes).
- **Inscription** : **preuve de travail** (hashcash) liée au captcha et à usage unique
  (`POW_DIFFICULTY`, défaut 17) + **plafond par IP** (24 h glissantes, `SIGNUP_IP_DAILY_LIMIT`,
  défaut 10). Le captcha mathématique reste, mais **n'est pas** une protection anti‑robot.
- **Écriture de clés E2EE** : la preuve du mot de passe (`authKeyHex`) est exigée pour **toute**
  installation/rotation de clés (empêche l'injection d'identité via une session volée).
- **Appels** : `call_accept`/`call_reject` seulement pour un appel réellement en attente.
- **Erreurs fatales** : arrêt propre (code 1) + **superviseur obligatoire** (systemd/pm2/Docker),
  cf. `docs/DEPLOYMENT.md` ; exceptions des handlers Socket.IO confinées à l'événement.
- Retrait de la dépendance inutilisée `sqlite3`.

> ⚠️ **Limites inchangées** : pas de forward secrecy, métadonnées non protégées, TOFU au
> premier contact, confiance dans le JS servi (cf. §2–§3).
