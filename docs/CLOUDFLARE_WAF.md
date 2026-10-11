# WAF Cloudflare — Liste blanche OpenWLM

> ⚠️ **NON TESTÉ / NON DÉPLOYÉ — WIP**
> Ces règles sont une **proposition** : elles n'ont **pas encore été appliquées
> ni validées** sur Cloudflare. À déployer d'abord en mode **`Log`**, vérifier
> les Security Events (faux positifs), puis passer en **`Block`**. Les seuils de
> rate limiting sont des ordres de grandeur à ajuster.

> Défense en périphérie (edge) : l'origine tourne derrière un **Tunnel Cloudflare**
> (aucun port exposé), le WAF est donc la première — et principale — couche de
> filtrage. Ce document fige la surface HTTP réelle d'OpenWLM et fournit la
> **liste blanche**, les règles de **rate limiting** et le plan de déploiement.

---

## 1. Surface HTTP réelle (à autoriser)

| Type | Méthode | Chemin |
|---|---|---|
| SPA | GET | `/` (index.html) |
| PWA / statique | GET | `/sw.js`, `/manifest.json`, `/favicon.{png,svg,ico}`, `/icons.svg`, `/apple-touch-icon.png`, `/pwa-*.png` |
| Assets | GET | `/assets/**` |
| Realtime | GET/POST + WS | `/socket.io/**` (polling + upgrade websocket) |
| API | GET | `/api/captcha`, `/api/user/me`, `/api/push/status`, `/api/games/active`, `/api/emoticons/custom/my` |
| API | GET | `/api/user/{id}/public-key`, `/api/contacts/{id}`, `/api/invitations/{id}`, `/api/messages/{id}/{id}`, `/api/files/{download\|info}/{id}`, `/api/emoticons/custom/asset/{id}` |
| API | POST | `/api/signup`, `/api/login`, `/api/logout`, `/api/invite`, `/api/accept-invite`, `/api/decline-invite`, `/api/contacts/block`, `/api/contacts/delete`, `/api/user/update`, `/api/user/change-password`, `/api/user/keys`, `/api/user/reset-e2e-keys`, `/api/user/global-private`, `/api/messages/clear`, `/api/files/upload`, `/api/emoticons/custom/upload`, `/api/push/subscribe`, `/api/push/unsubscribe`, `/api/push/test` |
| API | DELETE | `/api/emoticons/custom/{id}` |

**Aucune route `PUT`/`PATCH`.** Le serveur renvoie actuellement le **fallback SPA**
(200 HTML) pour tout chemin inconnu — donc par exemple `/.env` renvoie l'appli.
Il n'y a **pas de routage côté client** (pas de react-router) : seul `/` doit
servir l'index, ce qui rend une liste blanche stricte pertinente (et supprime au
passage le « 200 fallback »).

---

## 2. Règle « liste blanche » (WAF → Custom Rules)

- **Action** : `Block` (d'abord `Log` pour observer)
- **Expression** = *tout ce qui n'est pas dans l'allowlist* :

```
not (
  http.request.method in {"GET" "HEAD" "OPTIONS" "POST" "DELETE"}
  and (
    http.request.uri.path eq "/"
    or http.request.uri.path eq "/index.html"
    or http.request.uri.path in {
      "/sw.js" "/manifest.json" "/favicon.ico" "/favicon.png" "/favicon.svg"
      "/icons.svg" "/apple-touch-icon.png"
      "/pwa-192x192.png" "/pwa-512x512.png" "/pwa-maskable-192x192.png" "/pwa-maskable-512x512.png"
    }
    or starts_with(http.request.uri.path, "/assets/")
    or starts_with(http.request.uri.path, "/socket.io")
    or ( http.request.method in {"GET" "HEAD" "OPTIONS"}
         and http.request.uri.path in {
           "/api/captcha" "/api/user/me" "/api/push/status" "/api/games/active"
           "/api/emoticons/custom/my"
         } )
    or ( http.request.method in {"GET" "HEAD" "OPTIONS"}
         and (
           matches(http.request.uri.path, "^/api/user/[0-9]+/public-key$")
           or matches(http.request.uri.path, "^/api/contacts/[0-9]+$")
           or matches(http.request.uri.path, "^/api/invitations/[0-9]+$")
           or matches(http.request.uri.path, "^/api/messages/[0-9]+/[0-9]+$")
           or matches(http.request.uri.path, "^/api/files/(download|info)/[A-Za-z0-9_.-]+$")
           or matches(http.request.uri.path, "^/api/emoticons/custom/asset/[A-Za-z0-9_.-]+$")
         ) )
    or ( http.request.method eq "POST"
         and http.request.uri.path in {
           "/api/signup" "/api/login" "/api/logout" "/api/invite" "/api/accept-invite"
           "/api/decline-invite" "/api/contacts/block" "/api/contacts/delete"
           "/api/user/update" "/api/user/change-password" "/api/user/keys"
           "/api/user/reset-e2e-keys" "/api/user/global-private" "/api/messages/clear"
           "/api/files/upload" "/api/emoticons/custom/upload"
           "/api/push/subscribe" "/api/push/unsubscribe" "/api/push/test"
         } )
    or ( http.request.method eq "DELETE"
         and matches(http.request.uri.path, "^/api/emoticons/custom/[0-9]+$") )
  )
)
```

### 2.b Variante « blocage chemins sensibles » (ceinture + bretelles)

Redondant avec la liste blanche, mais utile si un jour l'allowlist est élargie :

```
matches(http.request.uri.path, "(?i)/(\\.env|\\.git|\\.jwt_secret|package(-lock)?\\.json|messenger\\.db|\\.sqlite|server/|scripts/|node_modules/)")
or http.request.uri.path.extension in {"env" "sqlite" "log" "bak" "old"}
```

→ **Block** (priorité plus haute que la règle liste blanche).

---

## 3. Rate limiting (règles séparées)

| Cible | Seuil suggéré | Action |
|---|---|---|
| `/api/login`, `/api/signup` | 10 / min / IP | Managed Challenge puis Block |
| `/api/captcha` | 20 / min / IP | Challenge |
| `/api/files/upload`, `/api/emoticons/custom/upload` | 10 / min / IP | Block |
| `/api/user/change-password`, `/api/user/reset-e2e-keys` | 5 / min / IP | Block |
| `/api/**` (global) | 120 / min / IP | Challenge |
| `/socket.io/**` | **ne pas** limiter finement | seuil de connexion élevé uniquement |

> ⚠️ **`/socket.io/`** fonctionne en **polling** (nombreux GET/POST courts) + un
> upgrade WebSocket. Un rate limiting agressif **casse le temps réel**. Ne pas
> employer la même règle que pour `/api/**`.

---

## 4. Compléments recommandés

- **Managed Rules** : activer *Cloudflare Managed Ruleset* + *OWASP Core Ruleset*.
  → **Commencer en `Log`** : les charges utiles sont des **gros JSON E2EE
  (base64)** qui peuvent déclencher des faux positifs.
- **Bot Fight Mode** (gratuit) ou Bot Management.
- **Turnstile** sur `signup` / `login` (renforce le captcha maths existant, qu'on conserve).
- **Blocage chemins sensibles** (§2.b).
- **Under Attack Mode** : mode incident réversible (bouton Cloudflare).

---

## 5. Pièges & déploiement

1. **Toujours `Log` ≥ 48 h** (Security Events) avant de passer en `Block`,
   surtout pour `/socket.io/**` et `/api/files/download/**`.
2. Vérifier le **preflight CORS `OPTIONS`** sur `/api/**` (autorisé ci-dessus).
3. La liste blanche transforme les chemins inconnus de « **200 SPA** » en
   **403** → comportement voulu (corrige aussi le cache « fallback » observé sur `bow.png`).
4. Autoriser `HEAD` partout où `GET` l'est.
5. Ordre de priorité : *Blocage chemins sensibles* **>** *Liste blanche* **>** *Rate limiting*.

---

## 6. Feuille de route

| Étape | Contenu | Mode |
|---|---|---|
| 0 | Managed Rules (+ OWASP), Bot Fight, blocage paths sensibles, RL auth/upload | Log |
| 1 | Règle « liste blanche » (§2) | Log → Block |
| 2 | Turnstile, durcissement des seuils RL, playbook « Under Attack » | Block |

> Piste complémentaire (indépendante du WAF) : renvoyer un **404 propre** côté
> serveur pour les chemins hors allowlist, au lieu du fallback SPA.
