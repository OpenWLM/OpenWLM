# Sécurité & chiffrement — état réel

> ⚠️ Ce document décrit précisément ce qui est implémenté, ce qui ne l'est pas, et les limites.
> Dernière mise à jour : 2026-10-18 (v1.6.0 : sessions, changement de mot de passe, copie locale des messages privés).

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
| Ancien format non signé (antérieur aux signatures) | **contenu masqué**, bandeau « Message rejeté » (jamais déchiffré) |
| Clé publique de l'expéditeur indisponible | **contenu masqué**, bandeau « Message rejeté » (jamais déchiffré) |
| Signature invalide / incohérente | **contenu masqué**, bandeau « Message rejeté » |
| Message non chiffré | **contenu masqué**, bandeau « Message rejeté » |

**Pas de rétrogradation possible** : seuls les messages signés et vérifiés sont affichés.
Un message à l'ancien format non signé est refusé sans être déchiffré, y compris dans
l'historique (les messages antérieurs aux signatures ne sont donc plus lisibles). Un message
signé dont la clé publique de l'expéditeur est indisponible est aussi refusé, avant tout
déchiffrement : sinon, un serveur qui retiendrait cette clé pourrait faire passer un message
fabriqué. Son `mid`, non authentifié, n'alimente pas l'anti‑rejeu. La clé est
re‑demandée une fois (au plus toutes les 30 s) avant le refus, et un rechargement de
l'historique revérifie le message.

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
- **Statut de présence** (en ligne / occupé / absent / hors ligne), **mode privé** (global et
  par conversation, persistés côté serveur : table `conversation_privacy`).
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
- **Mode privé — fenêtre de perte résiduelle** : voir ci‑dessous.

### Mode privé : sémantique de remise (et fenêtre de perte résiduelle)

Le **mode privé** (par conversation ou global) ne **stocke rien** côté serveur : le message
est seulement relayé aux **sessions connectées** du destinataire.

**Qui décide** : le serveur, à partir de l'état persisté uniquement — mode global de l'un ou
l'autre (`users.global_private`) ou préférence de conversation de l'un ou l'autre
(`conversation_privacy`, une ligne par direction). Le `isPrivate` envoyé par le client est
**ignoré**. `toggle_private_mode` n'écrit que la ligne de l'utilisateur **authentifié**
(`socket.user.id`), jamais celle désignée dans le payload : chacun peut imposer la
confidentialité, personne ne peut retirer celle voulue par l'autre. Les clients relisent cet
état avec la liste des contacts (`my_private` / `their_private`), donc après une reconnexion
sans avoir à rebasculer. Modèle de menace inchangé : cela protège contre un client buggé ou
modifié, pas contre un serveur malveillant qui choisirait de tout stocker.

Conséquence assumée :

- **Destinataire hors ligne** → le serveur **refuse** le message
  (`code: RECIPIENT_OFFLINE_PRIVATE`) ; l'expéditeur le voit « **Non envoyé** » avec un bouton
  **Renvoyer** (le contenu en clair n'est gardé qu'en mémoire, non persisté). Il n'est
  **pas** perdu silencieusement comme avant.
- **Côté appareil** : les messages privés ne sont gardés que dans la **copie locale chiffrée**
  de l'appareil qui les a envoyés ou reçus, si l'option « Garder une copie chiffrée des
  conversations sur cet appareil » est active (par défaut). Sans elle, ils disparaissent au
  rechargement de l'app. Le serveur ne les stocke jamais, dans aucun cas.
- **Fenêtre résiduelle** : la présence est vérifiée **à l'instant de l'envoi**. Si le
  destinataire se déconnecte **juste après** la vérification, le message peut encore être
  perdu (aucune file d'attente). C'est **inhérent** à un mode éphémère ; pour une remise
  garantie, utiliser le **mode normal** (stocké, remis à la reconnexion).
- **Mode normal** : le message est **stocké** puis remis via l'historique (`GET /api/messages`).
  Le serveur ne rejoue pas les messages à la reconnexion socket ; c'est le **client** qui
  rattrape : à chaque reconnexion et au retour au premier plan, il recharge de façon
  incrémentale les conversations ouvertes et interroge `GET /api/conversations/pending`
  (conversations ayant des messages jamais remis) pour ouvrir les onglets correspondants.

### Renvoi « Non envoyé » : idempotence et doublon (traité)

L'accusé d'envoi a un **délai de 15 s côté client uniquement** (`socket.timeout`) : il n'an-
nule pas l'envoi déjà parti. Si le réseau est lent et que l'accusé du serveur arrive **après**
ce délai, le message a en réalité été **accepté et stocké**, mais le client l'affiche
« **Non envoyé** » et propose **Renvoyer**.

Le renvoi **réutilise le `mid` d'origine** de l'enveloppe (même signature logique). Le serveur
**déduplique par `(sender_id, mid)`** à l'écriture (colonne `mid` + index unique partiel) et
répond « **succès** » avec l'`id` existant, **sans rediffuser ni re-notifier** : un renvoi est
donc **idempotent**. Si l'accusé initial s'était perdu alors que le message avait été remis, le
contact ne reçoit **pas** de seconde copie.

Réserves honnêtes :

- **Pas de déduplication en mode privé** (rien n'est persisté, donc rien à comparer). Dans ce
  cas, c'est l'**anti-rejeu du destinataire** (unicité du `mid`) qui écarte une éventuelle
  seconde copie remise en direct.
- Le `mid` est extrait du **clair de l'enveloppe signée** (le serveur ne déchiffre pas) ; un
  émetteur pourrait le réutiliser volontairement pour ses propres messages — l'effet se limite
  à ses propres envois, sans impact sur les autres utilisateurs.
- **Sans `mid` exploitable** (texte non‑enveloppé), aucune déduplication n'a lieu : le
  comportement antérieur subsiste.


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

## 7. Durcissements 2026-10-12

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

> **Limites inchangées** : pas de forward secrecy, métadonnées non protégées, TOFU au
> premier contact, confiance dans le JS servi (cf. §2–§3).

## 8. Changements de la version 1.5.0 (2026-10-16)

- **Messages non signés ou invérifiables refusés** (cf. §2 bis) : seuls les messages signés et
  vérifiés sont affichés ; la liste « contacts qui signent » (anti‑rétrogradation) est supprimée.
- **Mode privé par conversation appliqué côté serveur** (cf. §4) : état persisté, calculé par
  le serveur, le drapeau `isPrivate` du client n'est plus décisionnaire.
- **Authentification HTTP** : un en‑tête `Authorization: Bearer undefined`/`null` (client sans
  JWT en mémoire) est ignoré au profit du cookie `HttpOnly`, au lieu d'un refus 403.
- **Appels** : le signal `media-state` (vidéo activée/coupée) est chiffré comme le reste de la
  signalisation ; la vérification de l'empreinte DTLS reste obligatoire pour toute
  offre/réponse, y compris lors d'une renégociation.

## 9. Version 1.5.1 (2026-10-16)

- **Refus avant déchiffrement** : un message signé dont la clé publique de l'expéditeur est
  indisponible est refusé dès l'étape de vérification, sans passer par la clé privée (il était
  auparavant déchiffré puis refusé, sans que le contenu soit exposé). Son `mid`, non
  authentifié, n'est plus renvoyé et n'alimente donc plus l'anti‑rejeu.

## 10. Version 1.6.0 (2026-10-18)

- **Changement de mot de passe réparé** : la clé privée de la session est une `CryptoKey` non
  exportable ; le changement la re-chiffrait telle quelle et produisait un coffre vide, refusé
  par le serveur (depuis la 1.4.0). La clé est désormais obtenue en déchiffrant le coffre avec
  le mot de passe actuel, puis re-chiffrée avec le nouveau, sur l'appareil. Le mot de passe ne
  quitte toujours pas l'appareil (seule la clé d'authentification dérivée est envoyée).
- **Révocation des sessions** : « Déconnecter mes autres sessions » (`POST /api/sessions/revoke-others`)
  incrémente le compteur de sessions du compte (`token_version`), renouvelle le cookie de
  l'appareil courant, coupe les connexions temps réel des autres appareils et supprime leurs
  abonnements Push. Les appareils révoqués (y compris après un changement de mot de passe ou une
  déconnexion ailleurs) reviennent à l'écran de connexion et effacent leurs clés mémorisées et
  leurs données de session. La copie locale chiffrée des conversations est conservée : elle
  reste illisible sans la clé privée, qui ne revient sur l'appareil qu'après une connexion avec
  le mot de passe. Elle n'est pas effacée, car une révocation suit aussi un changement de mot
  de passe ou une déconnexion sur un autre de ses appareils : l'effacer ferait perdre les
  messages privés, qui n'existent que là.
- **Copie locale des messages privés** : les messages en mode privé, jamais stockés par le
  serveur, sont désormais conservés dans la copie locale (IndexedDB), chiffrée avec la clé
  publique de l'utilisateur comme le reste de l'historique local. L'option peut être désactivée
  (Options → Messages) ; l'effacement ne touche que le compte courant.
- **Réinitialisation des clés** : n'efface plus que les clés mémorisées et la copie locale du
  compte concerné, pas celles des autres comptes utilisés dans le même navigateur.
- **Notifications Push** : elles ne contiennent jamais le contenu des messages ni l'offre
  d'appel, seulement le nom de l'expéditeur ou de l'appelant et un texte générique, traduit par
  le service worker.
