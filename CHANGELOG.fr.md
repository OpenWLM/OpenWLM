<p align="center">
  <a href="CHANGELOG.md">English</a> • <b>Français</b>
</p>

# Journal des modifications (Changelog) - OpenWLM

Toutes les modifications notables apportées au projet sont documentées dans ce fichier.
Ce projet respecte les principes de [Semantic Versioning](https://semver.org/lang/fr/).

---

## [1.2.1] - 2026-10-03

### 🎨 Visuel & Assets
- **Vraie transparence alpha pour toutes les émoticônes (PNG & APNG)** :
  - Disparition complète des halos blancs, cadres rectangulaires et contours crénelés autour des émoticônes sur fond coloré (Aero bleu `#3B84D1`) ou sombre.
  - Conversion des 59 émoticônes statiques du format GIF 8-bit opaque vers le format PNG 32-bit RGBA avec anti-aliasing alpha progressif et dé-matting des contours.
  - Conversion des 10 émoticônes animées (`cry_smile`, `wink_smile`, `party`, `Sleepy`, `thinking`, `eye-rolling`, `idk`, `Lightning`, `bat`, `cake`) en Animated PNG (APNG) avec canal alpha 8-bit natif par image et respect strict du nombre de frames et des délais en millisecondes d'origine.
  - Préservation intégrale du pixel-art rétro des années 2000, des éléments intérieurs blancs (dents, yeux, ailes, reflets, rayons lumineux), des dimensions et du responsive mobile.
  - Mise à jour du placeholder de la fenêtre d'ajout de contact vers `pseudo@openwlm.dev`.

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
