# Guide de Configuration et Provisioning des Clés VAPID — OpenWLM

Ce guide détaille la mise en place sécurisée des clés Web Push (RFC 8292 VAPID) pour OpenWLM, en garantissant l'étanchéité absolue des secrets vis-à-vis des dépôts Git.

---

## 1. Principes de Sécurité

1. **Aucun secret dans Git :** Les clés privées (`VAPID_PRIVATE_KEY`), le fichier `.env` réel et `.vapid_keys.json` sont strictement ignorés par `.gitignore`.
2. **Cloisonnement client :** Seule la clé publique (`VAPID_PUBLIC_KEY`) est transmise aux navigateurs/PWA via l'endpoint `/api/push/status`. La clé privée n'est jamais injectée dans le code frontend.
3. **Persistance locale sécurisée :** Les clés stockées sur le serveur sont verrouillées avec les droits d'accès UNIX `0600` (lecture/écriture uniquement par l'utilisateur propriétaire).

---

## 2. Génération des Clés VAPID

OpenWLM fournit un utilitaire de provisioning versionné dans le dépôt :

```bash
# Génération automatique et stockage dans .vapid_keys.json (chmod 0600)
node scripts/generate_vapid_keys.js

# Alternative via script shell
./scripts/provision_vapid.sh
```

### Options utiles :
* `--print-only` : Affiche les variables générées dans la console pour inspection sans écrire sur le disque.
* `--write-env` : Écrit directement les clés dans le fichier local `.env` (chmod `0600`).
* `--show-private` : Affiche la clé privée en clair si vous devez la configurer manuellement dans un gestionnaire de secrets ou systemd.
* `--subject <uri>` : Spécifie l'adresse de contact du serveur (ex: `mailto:admin@mon-domaine.com`).
* `--force` : Force la régénération de nouvelles clés (*Attention : révoque les abonnements push des navigateurs existants*).

---

## 3. Emplacement des Clés (Local & Production)

Deux options équivalentes sont prises en charge par le serveur :

### Option A — Fichier local automatique (Recommandé)
Le script crée automatiquement le fichier `.vapid_keys.json` à la racine du projet :
```json
{
  "publicKey": "BLrLczzVnyM8v1nz-HN74Lpzuw-JEIreF0SUWqbmtHNrasL-IEifiLrD-g3UjcPJZNnPN06-LJqV3s55j4SRAok",
  "privateKey": "...",
  "subject": "mailto:admin@openwlm.dev",
  "createdAt": "2026-10-05T12:10:11.000Z"
}
```
OpenWLM charge automatiquement ce fichier au démarrage sans configuration supplémentaire.

### Option B — Fichier `.env` ou Variables d'Environnement
Vous pouvez renseigner les clés dans un fichier `.env` local (copié depuis `.env.example`) :
```ini
VAPID_PUBLIC_KEY="BLrLczzVnyM8v1nz-HN74Lpzuw-JEIreF0SUWqbmtHNrasL-IEifiLrD-g3UjcPJZNnPN06-LJqV3s55j4SRAok"
VAPID_PRIVATE_KEY="<clé-privée-43-caractères>"
VAPID_SUBJECT="mailto:admin@openwlm.dev"
```
Ou les injecter dans un service systemd / Docker / conteneur :
```bash
export VAPID_PUBLIC_KEY="..."
export VAPID_PRIVATE_KEY="..."
export VAPID_SUBJECT="mailto:admin@openwlm.dev"
```

---

## 4. Vérification du Serveur

Après démarrage ou redémarrage du serveur, interrogez l'endpoint public de statut :

```bash
curl -s http://localhost:3001/api/push/status
```

### Réponse attendue (Web Push actif) :
```json
{
  "available": true,
  "hasVapid": true,
  "publicKey": "BLrLczzVnyM8v1nz-HN74Lpzuw-JEIreF0SUWqbmtHNrasL-IEifiLrD-g3UjcPJZNnPN06-LJqV3s55j4SRAok",
  "subject": "mailto:admin@openwlm.dev"
}
```

*Note : Si les clés sont absentes, `hasVapid` vaut `false` et le serveur fonctionne normalement sans déclencher d'erreur bloquante.*

---

## 5. Procédure de Rotation Immédiate (en cas de fuite accidentelle)

Si une clé privée venait à être exposée ou committée par inadvertance :

1. **Régénérer immédiatement une nouvelle paire de clés :**
   ```bash
   node scripts/generate_vapid_keys.js --force
   ```
2. **Redémarrer le serveur OpenWLM :**
   ```bash
   NODE_ENV=production node server/index.js
   ```
3. **Purger les anciens abonnements dans la base SQLite :**
   Les anciens abonnements deviendront invalides auprès des services push (Google FCM / Mozilla Autopush retourneront `401 Unauthorized` ou `410 Gone`). Le serveur OpenWLM purgera automatiquement ces entrées obsolètes de la table `push_subscriptions`.
4. **Si un commit Git local non poussé contient la clé :**
   * Annuler le commit sans perdre les modifications : `git reset HEAD~1`
   * Supprimer le fichier sensible ou retirer la valeur.
   * Lancer l'audit de sécurité : `npm run check:secrets`
