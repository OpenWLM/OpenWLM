#!/usr/bin/env bash
# =============================================================================
# OpenWLM — déploiement d'une version du dépôt git vers le dossier de production
#
# À lancer sur la machine de prod, depuis le clone git (ex. ~/OpenWLM_github_prep) :
#   scripts/deploy.sh --dry-run [<ref>]   # ce qui changerait, sans rien toucher
#   scripts/deploy.sh [<ref>]             # déploie (confirmation demandée)
#   scripts/deploy.sh <ancienne ref>      # retour arrière : même commande
#
# <ref> : tag, branche ou commit (défaut : HEAD). Le contenu déployé est celui du COMMIT
# (git archive), pas l'état du dossier de travail.
#
# Ne touche JAMAIS : .env*, .jwt_secret, .vapid_keys.json, messenger.db*, uploads/,
# node_modules/, dist/, .ruffle/, public/ruffle/ (secrets, données, fichiers générés).
# Copie les fichiers suivis par git qui diffèrent, supprime ceux que git a supprimés depuis la
# version déployée (lue dans .deployed-version), puis npm ci / npm run build / redémarrage
# seulement si nécessaire. Avant d'écrire : sauvegarde des fichiers remplacés ou supprimés et
# de la base dans ~/Archives/deploiements/<date>-<commit>/ (droits 600).
#
# Options :
#   --dry-run          afficher seulement
#   --yes              pas de confirmation
#   --no-restart       ne pas redémarrer le service (copie de test) ; la version n'est alors
#                      pas enregistrée si un redémarrage était nécessaire
#   --target <dir>     dossier de prod (défaut : $OPENWLM_PROD_DIR ou ~/OpenWLM)
#   --from <commit>    version actuellement déployée, si .deployed-version manque (1er déploiement)
# =============================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="${OPENWLM_PROD_DIR:-$HOME/OpenWLM}"
ARCHIVE_ROOT="${OPENWLM_ARCHIVE_DIR:-$HOME/Archives/deploiements}"
DRY_RUN=0
ASSUME_YES=0
RESTART=1
FROM=""
REF="HEAD"

info() { printf '\033[1;34m•\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✔\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m✘\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --yes) ASSUME_YES=1 ;;
    --no-restart) RESTART=0 ;;
    --target) TARGET_DIR="${2:?--target <dossier>}"; shift ;;
    --from) FROM="${2:?--from <commit>}"; shift ;;
    -h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) fail "option inconnue : $1 (--help)" ;;
    *) REF="$1" ;;
  esac
  shift
done

# Chemins jamais écrits ni supprimés par le déploiement
is_protected() {
  case "$1" in
    .env.example) return 1 ;;
    .env|.env.*|.jwt_secret|.vapid_keys.json|messenger.db*|.deployed-version) return 0 ;;
    uploads|uploads/*|node_modules|node_modules/*|dist|dist/*|.ruffle|.ruffle/*|public/ruffle|public/ruffle/*) return 0 ;;
  esac
  return 1
}

# --- Vérifications ------------------------------------------------------------------------
git -C "$REPO_DIR" rev-parse --git-dir >/dev/null 2>&1 || fail "$REPO_DIR n'est pas un dépôt git."
COMMIT="$(git -C "$REPO_DIR" rev-parse --verify --quiet "$REF^{commit}")" || fail "version introuvable : $REF"
SHORT="$(git -C "$REPO_DIR" rev-parse --short "$COMMIT")"
TARGET_DIR="$(cd "$TARGET_DIR" 2>/dev/null && pwd)" || fail "dossier de prod introuvable : $TARGET_DIR"
[ "$TARGET_DIR" != "$REPO_DIR" ] || fail "le dossier de prod ne peut pas être le dépôt lui-même."
[ -f "$TARGET_DIR/.env" ] && [ -f "$TARGET_DIR/server/index.js" ] \
  || fail "$TARGET_DIR ne ressemble pas à une installation OpenWLM (.env et server/index.js attendus)."

PREVIOUS="$FROM"
if [ -z "$PREVIOUS" ] && [ -f "$TARGET_DIR/.deployed-version" ]; then
  PREVIOUS="$(sed -n 's/^commit=//p' "$TARGET_DIR/.deployed-version" | head -1)"
fi
if [ -n "$PREVIOUS" ]; then
  git -C "$REPO_DIR" cat-file -e "$PREVIOUS^{commit}" 2>/dev/null \
    || fail "version déployée $PREVIOUS inconnue du dépôt (git fetch ?)."
fi

info "dépôt   : $REPO_DIR"
info "prod    : $TARGET_DIR"
info "version : $REF → $SHORT ($(git -C "$REPO_DIR" log -1 --format='%s' "$COMMIT"))"
if [ -n "$PREVIOUS" ]; then
  info "déployée: $(git -C "$REPO_DIR" rev-parse --short "$PREVIOUS")"
else
  warn "version déployée inconnue (pas de .deployed-version, ni --from) : les fichiers supprimés de git ne seront pas retirés."
fi

# --- Export de la version et calcul des changements ---------------------------------------
EXPORT="$(mktemp -d)"
trap 'rm -rf "$EXPORT"' EXIT
git -C "$REPO_DIR" archive --format=tar "$COMMIT" | tar -x -C "$EXPORT"

ADDED=(); MODIFIED=(); DELETED=()
while IFS= read -r -d '' path; do
  rel="${path#"$EXPORT"/}"
  is_protected "$rel" && continue
  if [ ! -e "$TARGET_DIR/$rel" ] && [ ! -L "$TARGET_DIR/$rel" ]; then
    ADDED+=("$rel")
  elif ! cmp -s "$path" "$TARGET_DIR/$rel"; then
    MODIFIED+=("$rel")
  fi
done < <(find "$EXPORT" \( -type f -o -type l \) -print0 | sort -z)

if [ -n "$PREVIOUS" ]; then
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    is_protected "$rel" && continue
    [ -e "$EXPORT/$rel" ] && continue
    [ -e "$TARGET_DIR/$rel" ] && DELETED+=("$rel")
  done < <(git -C "$REPO_DIR" diff --name-only --no-renames --diff-filter=D "$PREVIOUS" "$COMMIT")
fi

CHANGED=("${ADDED[@]+"${ADDED[@]}"}" "${MODIFIED[@]+"${MODIFIED[@]}"}" "${DELETED[@]+"${DELETED[@]}"}")
# Ce qu'il faut relancer se déduit de l'écart git entre la version déployée et la nouvelle,
# pas seulement des fichiers encore différents : après un déploiement interrompu (fichiers
# déjà copiés, redémarrage raté, marqueur non écrit), une relance refait npm ci / build /
# redémarrage. Version déployée inconnue : tout est refait.
NEED_NPM=0; NEED_BUILD=0; NEED_RESTART=0; WAF_CHANGED=0
GIT_CHANGED=()
if [ -n "$PREVIOUS" ]; then
  mapfile -t GIT_CHANGED < <(git -C "$REPO_DIR" diff --name-only --no-renames "$PREVIOUS" "$COMMIT")
else
  NEED_NPM=1; NEED_BUILD=1; NEED_RESTART=1
fi
for rel in "${CHANGED[@]+"${CHANGED[@]}"}" "${GIT_CHANGED[@]+"${GIT_CHANGED[@]}"}"; do
  case "$rel" in
    package.json|package-lock.json) NEED_NPM=1; NEED_BUILD=1; NEED_RESTART=1 ;;
    src/*|public/*|index.html|vite.config.*|tsconfig*.json) NEED_BUILD=1 ;;
    server/*) NEED_RESTART=1 ;;
    docs/cloudflare-waf.generated.json) WAF_CHANGED=1 ;;
  esac
done

print_list() { local label="$1"; shift; [ $# -gt 0 ] || return 0; echo "$label ($#) :"; printf '    %s\n' "$@"; }
echo
print_list "  ajoutés" "${ADDED[@]+"${ADDED[@]}"}"
print_list "  modifiés" "${MODIFIED[@]+"${MODIFIED[@]}"}"
print_list "  supprimés" "${DELETED[@]+"${DELETED[@]}"}"
echo
UP_TO_DATE=0
if [ ${#CHANGED[@]} -eq 0 ] && [ "$PREVIOUS" = "$COMMIT" ]; then UP_TO_DATE=1; fi
if [ $UP_TO_DATE = 1 ]; then
  ok "aucune différence : $TARGET_DIR correspond déjà à $SHORT."
else
  [ ${#CHANGED[@]} -eq 0 ] && info "fichiers déjà à jour, mais version $SHORT pas encore enregistrée (déploiement interrompu ?)."
  info "ensuite : $([ $NEED_NPM = 1 ] && echo 'npm ci, ')$([ $NEED_BUILD = 1 ] && echo 'npm run build, ')$([ $NEED_RESTART = 1 ] && [ $RESTART = 1 ] && echo 'redémarrage du service, ')version enregistrée."
fi
[ $WAF_CHANGED = 1 ] && warn "les règles WAF ont changé (docs/CLOUDFLARE_WAF.md) : mettre à jour Cloudflare AVANT de déployer."

if [ $DRY_RUN = 1 ]; then
  info "--dry-run : rien n'a été modifié."
  exit 0
fi
[ $UP_TO_DATE = 1 ] && exit 0
if [ $ASSUME_YES = 0 ]; then
  read -r -p "Déployer $SHORT dans $TARGET_DIR ? [o/N] " answer
  case "$answer" in o|O|oui|y|Y|yes) ;; *) fail "abandon, rien n'a été modifié." ;; esac
fi

# --- Sauvegarde ---------------------------------------------------------------------------
umask 077
BACKUP_DIR="$ARCHIVE_ROOT/$(date +%Y%m%d-%H%M%S)-$SHORT"
mkdir -p "$BACKUP_DIR"
EXISTING=()
for rel in "${MODIFIED[@]+"${MODIFIED[@]}"}" "${DELETED[@]+"${DELETED[@]}"}"; do EXISTING+=("$rel"); done
[ -f "$TARGET_DIR/.deployed-version" ] && EXISTING+=(".deployed-version")
if [ ${#EXISTING[@]} -gt 0 ]; then
  tar -czf "$BACKUP_DIR/fichiers-remplaces.tar.gz" -C "$TARGET_DIR" -- "${EXISTING[@]}"
fi
printf '%s\n' "${ADDED[@]+"${ADDED[@]}"}" > "$BACKUP_DIR/fichiers-ajoutes.txt"
if [ -f "$TARGET_DIR/messenger.db" ]; then
  # Copie cohérente même service en marche (API de sauvegarde SQLite de better-sqlite3)
  (cd "$TARGET_DIR" && node -e "require('better-sqlite3')('messenger.db', { readonly: true }).backup(process.argv[1]).then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); })" "$BACKUP_DIR/messenger.db") \
    || fail "sauvegarde de la base impossible : rien n'a été modifié ($BACKUP_DIR)."
fi
chmod -R go-rwx "$BACKUP_DIR"
ok "sauvegarde : $BACKUP_DIR"

trap 'rm -rf "$EXPORT" "$TARGET_DIR/dist.next"; warn "ÉCHEC pendant le déploiement (version non enregistrée). Relancer la même commande pour reprendre, ou restaurer : tar -xzf $BACKUP_DIR/fichiers-remplaces.tar.gz -C $TARGET_DIR (supprimer les fichiers listés dans fichiers-ajoutes.txt), puis npm ci / npm run build / restart."' ERR
umask 022

# --- Copie, suppressions ------------------------------------------------------------------
for rel in "${ADDED[@]+"${ADDED[@]}"}" "${MODIFIED[@]+"${MODIFIED[@]}"}"; do
  mkdir -p "$TARGET_DIR/$(dirname "$rel")"
  rm -f "$TARGET_DIR/$rel"
  cp -P -p "$EXPORT/$rel" "$TARGET_DIR/$rel"
done
for rel in "${DELETED[@]+"${DELETED[@]}"}"; do
  rm -f "$TARGET_DIR/$rel"
done
[ ${#CHANGED[@]} -gt 0 ] && ok "fichiers à jour : ${#ADDED[@]} ajoutés, ${#MODIFIED[@]} modifiés, ${#DELETED[@]} supprimés."

# --- Dépendances, interface, service ------------------------------------------------------
cd "$TARGET_DIR"
if [ $NEED_NPM = 1 ]; then info "npm ci…"; npm ci --no-audit --no-fund; fi
if [ $NEED_BUILD = 1 ]; then
  # Construit à côté puis échange d'un coup : un build interrompu ne laisse jamais une
  # interface partielle dans dist/ ; l'ancienne interface part dans la sauvegarde
  info "npm run build (dans dist.next)…"
  rm -rf dist.next
  npx tsc -b
  npx vite build --outDir dist.next --emptyOutDir
  if [ -d dist ]; then
    mv --exchange dist.next dist
    mv dist.next "$BACKUP_DIR/dist-precedent"
  else
    mv dist.next dist
  fi
  ok "interface reconstruite (précédente : $BACKUP_DIR/dist-precedent)."
fi

if [ $NEED_RESTART = 1 ] && [ $RESTART = 0 ]; then
  # Rien n'est enregistré : un prochain lancement (sans --no-restart) refera le redémarrage
  warn "--no-restart : service non redémarré, version NON enregistrée dans .deployed-version."
  trap 'rm -rf "$EXPORT"' ERR
  exit 0
fi
if [ $NEED_RESTART = 1 ]; then
  # Échec (service KO, /api/health sans réponse) → arrêt ici, marqueur non écrit
  "$TARGET_DIR/scripts/openwlm-service.sh" restart
fi

# Version enregistrée seulement une fois tout réussi (redémarrage et santé compris)
{
  echo "commit=$COMMIT"
  echo "ref=$REF"
  echo "date=$(date -Is)"
  echo "par=$(id -un)"
  echo "sauvegarde=$BACKUP_DIR"
} > "$TARGET_DIR/.deployed-version"
trap 'rm -rf "$EXPORT"' ERR
ok "OpenWLM $SHORT déployé dans $TARGET_DIR."
[ -n "$PREVIOUS" ] && info "retour arrière : $0 $(git -C "$REPO_DIR" rev-parse --short "$PREVIOUS")"
exit 0
