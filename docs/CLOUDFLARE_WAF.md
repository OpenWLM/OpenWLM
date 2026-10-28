# WAF Cloudflare — Liste blanche OpenWLM

> ⚠️ **NON TESTÉ / NON DÉPLOYÉ — WIP**
> Ces règles sont une **proposition** : elles n'ont **pas encore été appliquées
> ni validées** sur Cloudflare. À déployer d'abord en mode **`Log`**, vérifier
> les Security Events (faux positifs), puis passer en **`Block`**. Les seuils de
> rate limiting sont des ordres de grandeur à ajuster.

> **Sections §1 et §2 auto-générées** par `scripts/gen_waf_rules.mjs`.
> Régénérer avec `npm run waf:gen` (et vérifier avec `npm run waf:check`).
> Toute modification des routes serveur **doit** être suivie d'une régénération.

> Défense en périphérie (edge) : l'origine tourne derrière un **Tunnel Cloudflare**
> (aucun port exposé), le WAF est donc la première — et principale — couche de
> filtrage.

---

## 1. Surface HTTP réelle (à autoriser)

<!-- WAF-GEN:SURFACE:START -->
| Type | Méthode | Chemin |
|---|---|---|
| SPA | GET | `/` |
| PWA / statique | GET | `/apple-touch-icon.png`, `/favicon.ico`, `/favicon.png`, `/favicon.svg`, `/icons.svg`, `/index.html`, `/manifest.json`, `/pwa-192x192.png`, `/pwa-512x512.png`, `/pwa-maskable-192x192.png`, `/pwa-maskable-512x512.png`, `/sw.js` |
| Assets | GET | `/assets/**` |
| Realtime | GET/POST + WS | `/socket.io/**` |
| API | GET | `/api/auth/scope`, `/api/captcha`, `/api/contacts/:userId`, `/api/conversations/pending`, `/api/emoticons/custom/asset/:assetId`, `/api/emoticons/custom/my`, `/api/files/download/:fileId`, `/api/files/info/:fileId`, `/api/games/active`, `/api/invitations/:userId`, `/api/messages/:userId/:contactId`, `/api/push/status`, `/api/rtc-config`, `/api/user/:userId/public-key`, `/api/user/me` |
| API | POST | `/api/accept-invite`, `/api/auth/recovery/challenge`, `/api/auth/recovery/complete`, `/api/calls/decline`, `/api/contacts/block`, `/api/contacts/delete`, `/api/decline-invite`, `/api/emoticons/custom/key`, `/api/emoticons/custom/upload`, `/api/files/upload`, `/api/invite`, `/api/login`, `/api/logout`, `/api/logout-device`, `/api/messages/clear`, `/api/push/fcm/register`, `/api/push/fcm/unregister`, `/api/push/subscribe`, `/api/push/test`, `/api/push/unsubscribe`, `/api/sessions/revoke-others`, `/api/signup`, `/api/user/change-password`, `/api/user/global-private`, `/api/user/keys`, `/api/user/migrate-auth-key`, `/api/user/reset-e2e-keys`, `/api/user/update`, `/api/user/vault` |
| API | DELETE | `/api/emoticons/custom/:assetId` |
<!-- WAF-GEN:SURFACE:END -->

**Aucune route `PUT`/`PATCH`.** Le serveur renvoie actuellement le **fallback SPA**
(200 HTML) pour tout chemin inconnu — donc par exemple `/.env` renvoie l'appli.
Il n'y a **pas de routage côté client** (pas de react-router) : seul `/` doit
servir l'index, ce qui rend une liste blanche stricte pertinente (et supprime au
passage le « 200 fallback »).

---

## 2. Règle « liste blanche » (WAF → Custom Rules)

- **Action** : `Block` (d'abord `Log` pour observer)
- **Expression** = *tout ce qui n'est pas dans l'allowlist* (auto-générée) :

<!-- WAF-GEN:EXPRESSION:START -->
```
not (
  ( http.request.method in {"GET" "HEAD" "OPTIONS"} and (
      http.request.uri.path in { "/" "/apple-touch-icon.png" "/favicon.ico" "/favicon.png" "/favicon.svg" "/icons.svg" "/index.html" "/manifest.json" "/pwa-192x192.png" "/pwa-512x512.png" "/pwa-maskable-192x192.png" "/pwa-maskable-512x512.png" "/sw.js" "/api/auth/scope" "/api/captcha" "/api/conversations/pending" "/api/emoticons/custom/my" "/api/games/active" "/api/push/status" "/api/rtc-config" "/api/user/me" }
      or starts_with(http.request.uri.path, "/assets/")
      or matches(http.request.uri.path, "^/api/contacts/[0-9]+$")
      or matches(http.request.uri.path, "^/api/emoticons/custom/asset/emo_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
      or matches(http.request.uri.path, "^/api/files/download/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
      or matches(http.request.uri.path, "^/api/files/info/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
      or matches(http.request.uri.path, "^/api/invitations/[0-9]+$")
      or matches(http.request.uri.path, "^/api/messages/[0-9]+/[0-9]+$")
      or matches(http.request.uri.path, "^/api/user/[0-9]+/public-key$")
  ) )
  or ( http.request.method in {"GET" "POST"} and starts_with(http.request.uri.path, "/socket.io") )
  or ( http.request.method eq "POST" and (
      http.request.uri.path in { "/api/accept-invite" "/api/auth/recovery/challenge" "/api/auth/recovery/complete" "/api/calls/decline" "/api/contacts/block" "/api/contacts/delete" "/api/decline-invite" "/api/emoticons/custom/key" "/api/emoticons/custom/upload" "/api/files/upload" "/api/invite" "/api/login" "/api/logout" "/api/logout-device" "/api/messages/clear" "/api/push/fcm/register" "/api/push/fcm/unregister" "/api/push/subscribe" "/api/push/test" "/api/push/unsubscribe" "/api/sessions/revoke-others" "/api/signup" "/api/user/change-password" "/api/user/global-private" "/api/user/keys" "/api/user/migrate-auth-key" "/api/user/reset-e2e-keys" "/api/user/update" "/api/user/vault" }
  ) )
  or ( http.request.method eq "DELETE" and (
      matches(http.request.uri.path, "^/api/emoticons/custom/emo_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
  ) )
)
```
<!-- WAF-GEN:EXPRESSION:END -->

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

> **`/socket.io/`** fonctionne en polling (nombreux GET/POST courts) + un
> upgrade WebSocket. Un rate limiting agressif casse le temps réel. Ne pas
> employer la même règle que pour `/api/**`.
>
> Note : le serveur applique déjà ses propres limiteurs (`authRateLimiter`,
> `uploadRateLimiter`, `sensitiveRateLimiter`, `inviteRateLimiter`) — le WAF les
> complète, il ne les remplace pas.

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
5. Ordre de priorité : *Blocage chemins sensibles* > *Liste blanche* > *Rate limiting*.

---

## 6. Feuille de route

| Étape | Contenu | Mode |
|---|---|---|
| 0 | Managed Rules (+ OWASP), Bot Fight, blocage paths sensibles, RL auth/upload | Log |
| 1 | Règle « liste blanche » (§2) | Log → Block |
| 2 | Turnstile, durcissement des seuils RL, playbook « Under Attack » | Block |

> Piste complémentaire (indépendante du WAF) : renvoyer un **404 propre** côté
> serveur pour les chemins hors allowlist, au lieu du fallback SPA.
