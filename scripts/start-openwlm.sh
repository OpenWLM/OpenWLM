#!/usr/bin/env bash
# =============================================================================
# OpenWLM — (re)lancement du serveur de production avec pm2, après un redémarrage
# de la machine par exemple.
#
#   ./scripts/start-openwlm.sh            démarre (ou relance) OpenWLM et vérifie qu'il répond
#   ./scripts/start-openwlm.sh --build    reconstruit d'abord l'interface (npm run build)
#   ./scripts/start-openwlm.sh --status   affiche seulement l'état
#
# Sécurité : refuse de tourner en root (sudo compris). Le serveur doit tourner sous le
# compte propriétaire du dossier : c'est lui qui possède la base, les secrets (.env,
# .jwt_secret, .vapid_keys.json) et la liste des processus pm2 (~/.pm2).
#
# Lancement automatique au démarrage (sans root) : ajouter cette ligne avec `crontab -e`
#   @reboot /chemin/vers/OpenWLM/scripts/start-openwlm.sh >> $HOME/openwlm-boot.log 2>&1
# =============================================================================
set -euo pipefail

APP_NAME="openwlm"
HEALTH_TIMEOUT=30   # secondes d'attente pour que le serveur réponde

# Racine du projet : le dossier parent de scripts/
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Couleurs seulement dans un terminal (pas dans le journal du lancement automatique)
if [ -t 1 ]; then B=$'\033[1;34m' G=$'\033[1;32m' R=$'\033[1;31m' N=$'\033[0m'; else B='' G='' R='' N=''; fi
info()  { printf '%s[%s]%s %s\n' "$B" "$(date '+%F %T')" "$N" "$*"; }
ok()    { printf '%s[%s]%s %s\n' "$G" "$(date '+%F %T')" "$N" "$*"; }
fail()  { printf '%s[%s] ERREUR :%s %s\n' "$R" "$(date '+%F %T')" "$N" "$*" >&2; exit 1; }

# --- 1. Jamais en root -------------------------------------------------------
if [ "$(id -u)" -eq 0 ]; then
  fail "ne pas lancer en root (ni avec sudo). Relancez en tant que « $(stat -c '%U' "$APP_DIR") » : $0"
fi

# --- 2. Bon utilisateur : le propriétaire du dossier ---------------------------
OWNER="$(stat -c '%U' "$APP_DIR")"
CURRENT="$(id -un)"
if [ "$CURRENT" != "$OWNER" ]; then
  fail "lancé par « $CURRENT », mais $APP_DIR appartient à « $OWNER ». Connectez-vous en « $OWNER »."
fi

# Au démarrage (cron @reboot), le PATH est minimal
export PATH="/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin:$PATH"

MODE="start"
case "${1:-}" in
  "")        ;;
  --build)   MODE="build" ;;
  --status)  MODE="status" ;;
  -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
  *)         fail "option inconnue : $1 (voir --help)" ;;
esac

cd "$APP_DIR"

# --- 3. Pré-requis -------------------------------------------------------------
command -v node >/dev/null || fail "node introuvable dans le PATH."
command -v pm2  >/dev/null || fail "pm2 introuvable (npm install -g pm2)."
[ -f server/index.js ] || fail "server/index.js introuvable : $APP_DIR n'est pas un dossier OpenWLM."
[ -d node_modules ]    || fail "dépendances absentes : lancez « npm ci » dans $APP_DIR."
[ -f .env ]            || info "attention : pas de fichier .env (TURN, etc. non configurés)."

# Port (PORT dans .env, sinon 3001), sans afficher le reste du fichier
PORT="$(grep -E '^PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '"'"'"' ' || true)"
PORT="${PORT:-3001}"

is_online() { pm2 jlist 2>/dev/null | node -e "
  const l = JSON.parse(require('fs').readFileSync(0, 'utf8') || '[]');
  const p = l.find(x => x.name === '$APP_NAME');
  process.exit(p && p.pm2_env.status === 'online' ? 0 : 1);"; }
is_known() { pm2 describe "$APP_NAME" >/dev/null 2>&1; }
responds() { curl -fs -o /dev/null --max-time 3 "http://localhost:$PORT/"; }

if [ "$MODE" = "status" ]; then
  pm2 list
  if responds; then ok "http://localhost:$PORT/ répond."; else info "http://localhost:$PORT/ ne répond pas."; fi
  exit 0
fi

# --- 4. Interface construite ---------------------------------------------------
if [ "$MODE" = "build" ] || [ ! -f dist/index.html ]; then
  info "construction de l'interface (npm run build)…"
  npm run build
fi

# --- 5. Démarrage / relance ----------------------------------------------------
if is_known; then
  info "relance du processus pm2 « $APP_NAME »…"
  NODE_ENV=production pm2 restart "$APP_NAME" --update-env >/dev/null
else
  info "premier démarrage du processus pm2 « $APP_NAME »…"
  NODE_ENV=production pm2 start server/index.js --name "$APP_NAME" --cwd "$APP_DIR" --time >/dev/null
fi
pm2 save >/dev/null   # mémorise la liste des processus (pm2 resurrect)

# --- 6. Vérification ---------------------------------------------------------
info "attente de la réponse de http://localhost:$PORT/ (${HEALTH_TIMEOUT} s max)…"
for _ in $(seq 1 "$HEALTH_TIMEOUT"); do
  if is_online && responds; then
    ok "OpenWLM est en ligne ($(node -p "require('./package.json').version"), port $PORT)."
    exit 0
  fi
  sleep 1
done

echo
pm2 logs "$APP_NAME" --lines 30 --nostream || true
fail "OpenWLM ne répond pas après ${HEALTH_TIMEOUT} s (journaux ci-dessus)."
