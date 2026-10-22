#!/usr/bin/env bash
# =============================================================================
# OpenWLM — service systemd (utilisateur) : démarrage au boot, relance en cas d'arrêt.
#
#   ./scripts/openwlm-service.sh install     installe et démarre le service « openwlm »
#   ./scripts/openwlm-service.sh status      état du service et réponse HTTP
#   ./scripts/openwlm-service.sh restart     relance (après un déploiement)
#   ./scripts/openwlm-service.sh logs        derniers journaux (logs -f : en continu)
#   ./scripts/openwlm-service.sh uninstall   arrête et supprime le service
#   ./scripts/openwlm-service.sh unit        affiche le fichier de service, sans rien installer
#
# Le service tourne sous le compte propriétaire du dossier, JAMAIS en root : ce script refuse
# root (sudo compris) et tout autre compte. C'est un service *utilisateur* (systemctl --user) :
# le relancer ne demande pas sudo. Seule l'installation demande sudo, une fois, pour
# « loginctl enable-linger » (démarrage au boot sans ouvrir de session).
#
# Remplace pm2 : à l'installation, le processus pm2 « openwlm » est arrêté et retiré.
# =============================================================================
set -euo pipefail

SERVICE="openwlm"
HEALTH_TIMEOUT=30
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_FILE="$UNIT_DIR/$SERVICE.service"

if [ -t 1 ]; then B=$'\033[1;34m' G=$'\033[1;32m' R=$'\033[1;31m' N=$'\033[0m'; else B='' G='' R='' N=''; fi
info() { printf '%s[OpenWLM]%s %s\n' "$B" "$N" "$*"; }
ok()   { printf '%s[OpenWLM]%s %s\n' "$G" "$N" "$*"; }
fail() { printf '%s[OpenWLM] ERREUR :%s %s\n' "$R" "$N" "$*" >&2; exit 1; }

# --- Jamais en root, et seulement sous le compte propriétaire du dossier ------
OWNER="$(stat -c '%U' "$APP_DIR")"
if [ "$(id -u)" -eq 0 ]; then
  fail "ne pas lancer en root (ni avec sudo). Relancez en tant que « $OWNER » : $0 ${1:-}"
fi
[ "$(id -un)" = "$OWNER" ] || fail "lancé par « $(id -un) », mais $APP_DIR appartient à « $OWNER »."

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || fail "node introuvable dans le PATH."
[ -f "$APP_DIR/server/index.js" ] || fail "server/index.js introuvable : $APP_DIR n'est pas un dossier OpenWLM."

PORT="$(grep -E '^PORT=' "$APP_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2 | tr -d "\"' " || true)"
PORT="${PORT:-3001}"

unit_content() {
  cat <<EOF
# Généré par scripts/openwlm-service.sh — ne pas éditer à la main (relancer « install »)
[Unit]
Description=OpenWLM (serveur de messagerie)

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
ExecStart=$NODE_BIN $APP_DIR/server/index.js
Restart=always
RestartSec=2
# Laisse le serveur fermer proprement les connexions (SIGTERM), puis l'arrête
KillSignal=SIGTERM
TimeoutStopSec=15
NoNewPrivileges=yes

[Install]
WantedBy=default.target
EOF
}

# Le serveur répond et sa base est lisible (GET /api/health) ; repli sur / pour un serveur
# antérieur à cette route
responds() {
  curl -fs -o /dev/null --max-time 3 "http://localhost:$PORT/api/health" \
    || { [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://localhost:$PORT/api/health")" = "404" ] \
         && curl -fs -o /dev/null --max-time 3 "http://localhost:$PORT/"; }
}

wait_healthy() {
  info "attente de la réponse de http://localhost:$PORT/api/health (${HEALTH_TIMEOUT} s max)…"
  for _ in $(seq 1 "$HEALTH_TIMEOUT"); do
    if systemctl --user is-active --quiet "$SERVICE" && responds; then
      ok "OpenWLM est en ligne ($(cd "$APP_DIR" && node -p "require('./package.json').version"), port $PORT)."
      return 0
    fi
    sleep 1
  done
  journalctl --user -u "$SERVICE" -n 30 --no-pager || true
  fail "OpenWLM ne répond pas après ${HEALTH_TIMEOUT} s (journaux ci-dessus)."
}

pm2_has_app() { command -v pm2 >/dev/null && pm2 describe "$SERVICE" >/dev/null 2>&1; }

case "${1:-}" in
  unit)
    unit_content
    ;;

  install)
    # Le service tourne depuis le dossier du script : sans .env, c'est sans doute un dépôt
    # de développement et non le dossier de production (secrets et base absents).
    [ -f "$APP_DIR/.env" ] || fail "pas de .env dans $APP_DIR : est-ce bien le dossier de production ? Lancez le script de ce dossier-là (cp .env.example .env pour une nouvelle installation)."
    [ -d "$APP_DIR/node_modules" ] || fail "dépendances absentes : lancez « npm ci » dans $APP_DIR."
    if [ ! -f "$APP_DIR/dist/index.html" ]; then
      info "construction de l'interface (npm run build)…"
      (cd "$APP_DIR" && npm run build)
    fi

    # Démarrage au boot sans session ouverte : seule étape qui demande sudo
    if [ "$(loginctl show-user "$OWNER" -p Linger --value 2>/dev/null)" != "yes" ]; then
      info "activation du démarrage au boot pour « $OWNER » (sudo loginctl enable-linger)…"
      sudo loginctl enable-linger "$OWNER" || fail "impossible d'activer le démarrage au boot (enable-linger)."
    fi

    mkdir -p "$UNIT_DIR"
    unit_content > "$UNIT_FILE"
    systemctl --user daemon-reload

    # Passage de pm2 au service : un seul des deux doit écouter le port
    if pm2_has_app; then
      info "arrêt de l'ancien processus pm2 « $SERVICE » (remplacé par le service)…"
      pm2 delete "$SERVICE" >/dev/null
      pm2 save --force >/dev/null
    fi

    systemctl --user enable "$SERVICE" >/dev/null 2>&1
    systemctl --user restart "$SERVICE"
    wait_healthy
    ok "service installé : démarrage au boot et relance automatique en cas d'arrêt."
    info "relancer : $0 restart · journaux : $0 logs"
    ;;

  restart)
    [ -f "$UNIT_FILE" ] || fail "service non installé (lancez « $0 install »)."
    systemctl --user restart "$SERVICE"
    wait_healthy
    ;;

  status)
    systemctl --user status "$SERVICE" --no-pager -n 5 || true
    if responds; then ok "http://localhost:$PORT/ répond."; else info "http://localhost:$PORT/ ne répond pas."; fi
    ;;

  logs)
    if [ "${2:-}" = "-f" ]; then journalctl --user -u "$SERVICE" -f
    else journalctl --user -u "$SERVICE" -n 100 --no-pager; fi
    ;;

  uninstall)
    systemctl --user disable --now "$SERVICE" >/dev/null 2>&1 || true
    rm -f "$UNIT_FILE"
    systemctl --user daemon-reload
    ok "service supprimé (OpenWLM est arrêté). Le démarrage au boot du compte reste activé :"
    info "  sudo loginctl disable-linger $OWNER   pour le désactiver aussi."
    ;;

  -h|--help|"")
    sed -n '2,19p' "$0"
    ;;

  *)
    fail "commande inconnue : $1 (voir --help)"
    ;;
esac
