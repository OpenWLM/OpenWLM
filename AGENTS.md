# AGENTS.md — OpenWLM

Conventions de travail pour les agents/contributeurs.

## ⚠️ Règle WAF Cloudflare (à ne jamais oublier)

Toute modification de la **surface HTTP** — routes API (`server/routes/*.js`) ou
routes statiques/PWA/socket (`server/index.js`) — **doit** être suivie de :

```
npm run waf:gen     # régénère docs/CLOUDFLARE_WAF.md + docs/cloudflare-waf.generated.json
```

puis **commit** du résultat. La CI exécute `npm run waf:check` et **échoue** si
les règles sont périmées.

- Ne jamais éditer à la main les blocs `<!-- WAF-GEN:…:START/END -->`.
- Le générateur (`scripts/gen_waf_rules.mjs`) refait un **auto-contrôle
  anti-« ouverture en grand »** : il échoue si une règle autorise un préfixe trop
  large (`/api`, `/`), un joker (`*`, `.*`), une méthode inattendue, ou une route
  non classée (paramètre inconnu → à ajouter à `PARAM_PATTERNS`).

## Commandes

- Lint : `npm run lint`
- Build : `npm run build`
- Tests unitaires + sécurité : `npm test` *(bloqué hors dépôt Git — cf. `scripts/test_preflight.js`)*
- E2E : `npm run test:e2e`
- Secrets : `npm run check:secrets`
- WAF : `npm run waf:gen` (écrit) / `npm run waf:check` (vérifie)
