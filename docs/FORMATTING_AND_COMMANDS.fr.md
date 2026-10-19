<p align="center">
  <a href="FORMATTING_AND_COMMANDS.md">English</a> • <b>Français</b>
</p>

# Mise en forme, commandes, textes rapides et recherche

Cette page décrit les outils de conversation d'OpenWLM. Les mêmes informations sont dans
l'application : **menu principal → Aide**, le lien **Aide** de l'écran de connexion, ou la
commande `/help`.

- [Mise en forme](#mise-en-forme)
- [Commandes](#commandes)
- [Textes rapides](#textes-rapides)
- [Rappel des messages](#rappel-des-messages)
- [Recherche dans une conversation](#recherche-dans-une-conversation)
- [Raccourcis clavier](#raccourcis-clavier)
- [Notes techniques](#notes-techniques)

---

## Mise en forme

Votre **pseudo**, votre **message perso** et vos **messages** peuvent avoir des couleurs, des
dégradés et des styles. Tapez les balises vous-même, ou utilisez le bouton **🎨** : à côté du
champ de saisie de la conversation, et à côté des champs pseudo et message perso dans
Options → Personnel (avec un aperçu). Avec une sélection, 🎨 l'entoure des balises ; sans
sélection, il insère les balises et place le curseur entre les deux.

| Vous tapez | Résultat |
|---|---|
| `[b]gras[/b]` | **gras** |
| `[i]italique[/i]` | *italique* |
| `[u]souligné[/u]` | souligné |
| `[s]barré[/s]` | ~~barré~~ |
| `[c=4]rouge[/c]` | texte rouge (couleur n° 4) |
| `[c=#1E90FF]bleu[/c]` | n'importe quelle couleur en `#RRGGBB` |
| `[a=8]fond jaune[/a]` | couleur de fond |
| `[c=4]dégradé[/c=12]` | dégradé de texte de la couleur 4 à la couleur 12 (la couleur de fin va sur la balise fermante) |
| `[a=4]fond[/a=12]` | dégradé de fond |
| `[c=3][b]Vert gras[/b][/c]` | les balises se combinent |

**Couleurs** : un numéro de la palette ci-dessous, ou n'importe quelle couleur `#RRGGBB`.

| N° | Couleur | N° | Couleur | N° | Couleur | N° | Couleur |
|---|---|---|---|---|---|---|---|
| 0 | `#FFFFFF` blanc | 4 | `#FF0000` rouge | 8 | `#FFFF00` jaune | 12 | `#0000FC` bleu |
| 1 | `#000000` noir | 5 | `#7F0000` bordeaux | 9 | `#00FC00` vert vif | 13 | `#FF00FF` magenta |
| 2 | `#00007F` bleu marine | 6 | `#9C009C` violet | 10 | `#009393` bleu canard | 14 | `#7F7F7F` gris |
| 3 | `#009300` vert | 7 | `#FC7F00` orange | 11 | `#00FFFF` cyan | 15 | `#D2D2D2` gris clair |

**Codes courts** avec le point médian `·` (Alt+0183 sous Windows) : `·$4` couleur 4, `·#FF0000` n'importe quelle couleur, `·b` `·i` `·u`
`·s` activent/désactivent un style, `·0` réinitialise tout. Exemple : `·$12bleu·0 normal`.

**Règles**

- Le pseudo est limité à **50 caractères visibles** et le message perso à **150** : les balises
  ne comptent pas. Le texte brut (balises comprises) est limité à 300 et 600 caractères.
- Les balises invalides ou inconnues (`[c=99]`, `[x]`…) s'affichent telles quelles.
- Les émoticônes fonctionnent aussi dans un texte mis en forme.
- Là où la mise en forme ne peut pas s'afficher (notifications système, titres de fenêtre,
  infobulles), les balises sont retirées et le texte simple est affiché.
- **Texte simple** : décochez *Afficher la mise en forme des pseudos, messages perso et messages*
  dans Options → Messages. Tout s'affiche alors sans couleurs ni styles (et sans balises).

## Commandes

Tapez une commande dans une conversation puis **Entrée**. La liste des commandes correspondantes
apparaît dès que vous tapez `/` ; **Tab** complète la première.

| Commande | Effet |
|---|---|
| `/me <texte>` | Action : votre contact voit `* VotreNom texte` |
| `/clear` | Vide l'affichage de cette conversation (l'historique n'est pas supprimé) |
| `/online` | Statut En ligne |
| `/busy` | Statut Occupé |
| `/away` | Statut Absent |
| `/offline` | Apparaître hors ligne |
| `/nick <texte>` | Change votre pseudo (mise en forme permise) |
| `/psm <texte>` | Change votre message perso (mise en forme permise) |
| `/all <texte>` | Envoie le message à toutes les conversations ouvertes (sauf le contact de test) |
| `/signout` | Se déconnecter (partout, comme le menu) |
| `/help` | Ouvre la fenêtre d'aide |

- Pour envoyer un message qui commence vraiment par `/`, tapez `//` : un seul `/` est envoyé
  (`//chemin` → `/chemin`).
- Une commande inconnue n'est pas envoyée : une fenêtre le signale.
- Dans la conversation avec le **contact de test OpenWLM**, ses propres commandes (`/help`,
  `/wizz`, `/p4`, `/morpion`…) restent adressées au contact de test.

## Textes rapides

Des messages tout prêts, envoyés avec `/raccourci`. Créez-les dans
**Options → Messages → Textes rapides**.

- Raccourci : 1 à 20 caractères parmi `a-z`, `0-9`, `-` et `_` ; il ne peut pas être le nom d'une
  commande.
- `(!N)` dans le texte est remplacé par le nom du contact (sans mise en forme).
- Le texte tapé après le raccourci est ajouté à la suite : `/salut à plus` envoie le texte rapide
  suivi de `à plus`.
- Les textes rapides apparaissent dans la liste des commandes, après les commandes.
- Jusqu'à 30 textes rapides de 1 000 caractères. Ils sont enregistrés **sur l'appareil**
  (`wlm_prefs`), jamais sur le serveur.

Exemple : raccourci `salut`, texte `Salut (!N), ça va ?` → taper `/salut` dans une conversation
avec Alice envoie `Salut Alice, ça va ?`.

## Rappel des messages

**Ctrl+↑** remet vos messages (et commandes) précédents dans le champ de saisie, un par un ;
**Ctrl+↓** repart dans l'autre sens et, après le plus récent, rend ce que vous étiez en train de
taper. Les 50 dernières saisies sont gardées pendant la session, en mémoire seulement (rien n'est
enregistré).

## Recherche dans une conversation

**Ctrl+F** (Cmd+F sur macOS) dans une conversation ouvre une barre de recherche à la place de
celle du navigateur. Les résultats sont surlignés dans les messages, avec un compteur (`2/5`), en commençant par le
plus récent. **Entrée** passe au résultat précédent (plus ancien) et **Maj+Entrée** revient vers
le plus récent, comme les boutons ▲ / ▼ ; **Échap** ferme la recherche. Seuls les messages affichés sont parcourus (après `/clear`, il n'y a plus rien
à chercher).

## Raccourcis clavier

| Touches | Action |
|---|---|
| Entrée | Envoyer le message |
| Maj+Entrée | Nouvelle ligne |
| Ctrl+↑ / Ctrl+↓ | Rappeler vos messages précédents |
| Tab | Compléter une commande |
| Ctrl+F | Chercher dans la conversation |
| Échap | Fermer la fenêtre ou la recherche |

## Notes techniques

- **Rendu** (`src/utils/plusFormat.tsx`) : le texte est découpé en segments rendus par React —
  aucun HTML n'est injecté. Seules des couleurs validées (palette ou `#RRGGBB`) arrivent dans les
  styles. Les dégradés utilisent un `linear-gradient` CSS avec `background-clip: text`.
- **Messages** : la mise en forme fait partie du texte du message ; elle est donc chiffrée de bout
  en bout comme le reste. Une action `/me` ajoute un champ `action: true` à l'enveloppe signée
  (`src/utils/MessageEnvelope.ts`).
- **Serveur** (`server/utils/plusText.js`) : même grammaire, utilisée seulement pour retirer les
  balises — vérifier la longueur visible des pseudos et messages perso (`server/routes/users.js`,
  `server/routes/auth.js`) et construire les titres des notifications Push.
- **Commandes** (`src/utils/chatCommands.ts`) : analyse seulement ; les actions sont exécutées par
  `src/App.tsx`.
- **Recherche** (`src/components/ConversationSearch.tsx`) : API CSS Custom Highlight
  (`::highlight(wlm-search)`), sans toucher au DOM des messages.
- **Tests** : `e2e/extras.spec.ts` (scénario de bout en bout sur deux comptes),
  `tests/test_profile_limits.js` (limites côté serveur).
