#!/usr/bin/env node
/**
 * scripts/gen_waf_rules.mjs
 *
 * Audit du code → génération des règles WAF Cloudflare (liste blanche) d'OpenWLM.
 *
 *  - Scanne `server/routes/*.js` (routes API) + les routes statiques/PWA/socket.
 *  - Produit l'expression Cloudflare « block-all-except » + un manifeste JSON.
 *  - Met à jour les blocs auto-générés de `docs/CLOUDFLARE_WAF.md`.
 *  - **Auto-contrôle anti-« ouverture en grand »** : échoue si une règle est trop
 *    large (préfixe `/api`, `/`, joker `*`, `.*`, méthode inattendue, route non
 *    classée, paramètre inconnu…).
 *
 * Usage :
 *   node scripts/gen_waf_rules.mjs            # contrôle + affiche (dry-run)
 *   node scripts/gen_waf_rules.mjs --write     # écrit doc + JSON
 *   node scripts/gen_waf_rules.mjs --check     # CI : échoue si le doc/JSON est périmé
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const routesDir = path.join(root, 'server', 'routes');
const docPath = path.join(root, 'docs', 'CLOUDFLARE_WAF.md');
const jsonPath = path.join(root, 'docs', 'cloudflare-waf.generated.json');

const MODE = process.argv.includes('--write') ? 'write'
  : process.argv.includes('--check') ? 'check'
  : 'dry';

// ---------------------------------------------------------------------------
// Formes de paramètres : STRICTEMENT bornées (jamais .* / .+)
// ---------------------------------------------------------------------------
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const PARAM_PATTERNS = {
  userId: '[0-9]+',
  contactId: '[0-9]+',
  receiverId: '[0-9]+',
  senderId: '[0-9]+',
  id: '[0-9]+',
  fileId: UUID,          // crypto.randomUUID()
  assetId: `emo_${UUID}`, // 'emo_' + crypto.randomUUID()
};

// Routes non-API (statiques / PWA / assets / realtime) — GET, sauf socket (GET+POST)
const STATIC_GET = [
  '/', '/index.html', '/sw.js', '/manifest.json',
  '/favicon.ico', '/favicon.png', '/favicon.svg', '/icons.svg', '/apple-touch-icon.png',
  '/pwa-192x192.png', '/pwa-512x512.png', '/pwa-maskable-192x192.png', '/pwa-maskable-512x512.png',
];
const ASSET_PREFIXES = ['/assets/'];
const SOCKET_PREFIX = '/socket.io';

const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'POST', 'DELETE']);
const FORBIDDEN_PATTERNS = [/\*/, /\.\*/, /\.\+/, /\.\./];

// ---------------------------------------------------------------------------
// Extraction des routes API depuis le code
// ---------------------------------------------------------------------------
function extractRoutes() {
  if (!fs.existsSync(routesDir)) throw new Error(`Dossier introuvable: ${routesDir}`);
  const files = fs.readdirSync(routesDir).filter((f) => f.endsWith('.js'));
  const routes = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(routesDir, f), 'utf8');
    const re = /router\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      routes.push({ file: f, method: m[1].toUpperCase(), routePath: m[2] });
    }
  }
  return routes;
}

function routeToRegex(routePath) {
  const segs = routePath.split('/').filter(Boolean);
  const parts = segs.map((seg) => {
    if (seg.startsWith(':')) {
      const name = seg.slice(1);
      if (!PARAM_PATTERNS[name]) {
        throw new Error(`Paramètre inconnu ':${name}' dans '${routePath}' — ajoute-le à PARAM_PATTERNS`);
      }
      return PARAM_PATTERNS[name];
    }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  return `^/api/${parts.join('/')}$`;
}

// ---------------------------------------------------------------------------
// Construction de la liste blanche + de l'expression
// ---------------------------------------------------------------------------
function build() {
  const routes = extractRoutes();
  if (routes.length === 0) throw new Error('Aucune route trouvée — parser à revoir');

  const model = { staticGet: [...STATIC_GET].sort(), assetPrefixes: ASSET_PREFIXES, socketPrefix: SOCKET_PREFIX, api: [], methods: [] };
  const methodsUsed = new Set();

  for (const r of routes) {
    if (!ALLOWED_METHODS.has(r.method)) throw new Error(`Méthode non autorisée détectée: ${r.method} (${r.routePath})`);
    methodsUsed.add(r.method);
    const full = `/api${r.routePath}`;
    const dynamic = r.routePath.includes(':');
    const entry = { method: r.method, path: full, dynamic, matcher: dynamic ? routeToRegex(r.routePath) : full };
    // sécurité : pas de joker / pas de préfixe large
    for (const bad of FORBIDDEN_PATTERNS) if (bad.test(full)) throw new Error(`Route suspecte (joker/..): ${full}`);
    model.api.push(entry);
  }
  model.api.sort((a, b) => a.path.localeCompare(b.path));
  model.methods = [...methodsUsed].sort();

  const exact = (m) => model.api.filter((e) => e.method === m && !e.dynamic).map((e) => e.path).sort();
  const dynamic = (m) => model.api.filter((e) => e.method === m && e.dynamic).map((e) => e.matcher).sort();

  const q = (list) => list.map((p) => `"${p}"`).join(' ');

  // Bloc GET : statiques + assets + API GET (exacts + regex)
  const getLines = [];
  getLines.push(`http.request.uri.path in { ${q([...model.staticGet, ...exact('GET')])} }`);
  for (const p of model.assetPrefixes) getLines.push(`starts_with(http.request.uri.path, "${p}")`);
  for (const rx of dynamic('GET')) getLines.push(`matches(http.request.uri.path, "${rx}")`);

  const groups = [];
  groups.push(`( http.request.method in {"GET" "HEAD" "OPTIONS"} and (\n      ` + getLines.join('\n      or ') + `\n  ) )`);
  groups.push(`( http.request.method in {"GET" "POST"} and starts_with(http.request.uri.path, "${model.socketPrefix}") )`);

  if (exact('POST').length || dynamic('POST').length) {
    const postLines = [];
    if (exact('POST').length) postLines.push(`http.request.uri.path in { ${q(exact('POST'))} }`);
    for (const rx of dynamic('POST')) postLines.push(`matches(http.request.uri.path, "${rx}")`);
    groups.push(`( http.request.method eq "POST" and (\n      ` + postLines.join('\n      or ') + `\n  ) )`);
  }
  if (exact('DELETE').length || dynamic('DELETE').length) {
    const delLines = [];
    if (exact('DELETE').length) delLines.push(`http.request.uri.path in { ${q(exact('DELETE'))} }`);
    for (const rx of dynamic('DELETE')) delLines.push(`matches(http.request.uri.path, "${rx}")`);
    groups.push(`( http.request.method eq "DELETE" and (\n      ` + delLines.join('\n      or ') + `\n  ) )`);
  }

  const expression = `not (\n  ` + groups.join('\n  or ') + `\n)`;
  model.expression = expression;
  return model;
}

// ---------------------------------------------------------------------------
// Auto-contrôle anti-« ouverture en grand »
// ---------------------------------------------------------------------------
function audit(model) {
  const problems = [];
  const expr = model.expression;

  // 1) Aucune autorisation de préfixe trop large
  if (/starts_with\(http\.request\.uri\.path,\s*"\/api/.test(expr)) problems.push('Préfixe "/api" autorisé (trop large)');
  if (/uri\.path\s+eq\s+"\/api"/.test(expr)) problems.push('Chemin "/api" autorisé (trop large)');
  if (/starts_with\(http\.request\.uri\.path,\s*"\/"\)/.test(expr)) problems.push('Préfixe "/" autorisé (ouvre tout)');
  if (expr.includes('*')) problems.push('Joker "*" présent dans l\'expression');

  // 2) Chemins/valeurs interdits
  for (const e of model.api) {
    for (const bad of FORBIDDEN_PATTERNS) if (bad.test(e.path)) problems.push(`Route avec joker/..: ${e.path}`);
  }

  // 3) Méthodes : uniquement GET/POST/DELETE (+ HEAD/OPTIONS via GET)
  const gate = [...expr.matchAll(/"([A-Z]+)"/g)].map((m) => m[1]).filter((x) => ALLOWED_METHODS.has(x) || ['PUT', 'PATCH'].includes(x));
  if (gate.includes('PUT') || gate.includes('PATCH')) problems.push('Méthode PUT/PATCH présente');

  // 4) Les chemins statiques ne doivent pas contenir d'API (inversion)
  if (model.staticGet.some((p) => p.startsWith('/api'))) problems.push('Chemin API classé en statique');

  // 5) Couverture : le nombre de routes du manifeste == routes extraites
  const extracted = extractRoutes().length;
  if (model.api.length !== extracted) problems.push(`Couverture incomplète: ${model.api.length}/${extracted} routes classées`);

  // 6) Déduplication : pas de doublon (méthode+chemin)
  const seen = new Set();
  for (const e of model.api) {
    const k = `${e.method} ${e.path}`;
    if (seen.has(k)) problems.push(`Doublon de route: ${k}`);
    seen.add(k);
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Rendu (surface + expression + JSON)
// ---------------------------------------------------------------------------
function renderSurface(model) {
  const rows = [];
  rows.push('| Type | Méthode | Chemin |');
  rows.push('|---|---|---|');
  const byM = (m) => model.api.filter((e) => e.method === m).map((e) => '`' + e.path + '`');
  rows.push(`| SPA | GET | \`/\` |`);
  rows.push(`| PWA / statique | GET | ${model.staticGet.filter((p) => p !== '/').map((p) => '`' + p + '`').join(', ')} |`);
  rows.push(`| Assets | GET | \`/assets/**\` |`);
  rows.push(`| Realtime | GET/POST + WS | \`/socket.io/**\` |`);
  for (const m of ['GET', 'POST', 'DELETE']) {
    const list = byM(m);
    if (list.length) rows.push(`| API | ${m} | ${list.join(', ')} |`);
  }
  return rows.join('\n');
}

function renderExpression(model) {
  return '```\n' + model.expression + '\n```';
}

function replaceBlock(content, name, body) {
  const start = `<!-- WAF-GEN:${name}:START -->`;
  const end = `<!-- WAF-GEN:${name}:END -->`;
  const re = new RegExp(start.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?' + end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!re.test(content)) throw new Error(`Marqueurs manquants dans le doc: ${name}`);
  return content.replace(re, `${start}\n${body}\n${end}`);
}

// ---------------------------------------------------------------------------
function main() {
  const model = build();

  const problems = audit(model);
  if (problems.length) {
    console.error('\n❌ AUTO-CONTRÔLE ÉCHOUÉ — la règle pourrait ouvrir trop large :');
    for (const p of problems) console.error('   - ' + p);
    process.exit(1);
  }

  const surface = renderSurface(model);
  const expression = renderExpression(model);
  const json = JSON.stringify({
    note: 'Généré par scripts/gen_waf_rules.mjs — NE PAS éditer à la main',
    methods: model.methods,
    staticGet: model.staticGet,
    assetPrefixes: model.assetPrefixes,
    socketPrefix: model.socketPrefix,
    routes: model.api,
    expression: model.expression,
  }, null, 2) + '\n';

  const doc = fs.readFileSync(docPath, 'utf8');
  const nextDoc = replaceBlock(replaceBlock(doc, 'SURFACE', surface), 'EXPRESSION', expression);

  console.log(`✅ Auto-contrôle OK — ${model.api.length} routes API, méthodes: ${model.methods.join(', ')}`);

  if (MODE === 'dry') {
    console.log('\n--- Expression (dry-run, non écrite) ---\n');
    console.log(expression);
    console.log('\n(Astuce : `npm run waf:gen` pour écrire, `npm run waf:check` pour vérifier en CI.)');
    return;
  }

  if (MODE === 'check') {
    const docUpToDate = fs.existsSync(docPath) && fs.readFileSync(docPath, 'utf8') === nextDoc;
    const jsonUpToDate = fs.existsSync(jsonPath) && fs.readFileSync(jsonPath, 'utf8') === json;
    if (!docUpToDate || !jsonUpToDate) {
      console.error('\n❌ Règles WAF périmées : lance `npm run waf:gen` et commit le résultat.');
      process.exit(1);
    }
    console.log('✅ Règles WAF à jour (doc + JSON).');
    return;
  }

  // write
  fs.writeFileSync(docPath, nextDoc);
  fs.writeFileSync(jsonPath, json);
  console.log(`✅ Écrit : ${path.relative(root, docPath)} + ${path.relative(root, jsonPath)}`);
}

try {
  main();
} catch (e) {
  console.error('\n❌ ÉCHEC : ' + (e && e.message ? e.message : e));
  process.exit(1);
}
