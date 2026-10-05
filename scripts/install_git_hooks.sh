#!/usr/bin/env bash
# scripts/install_git_hooks.sh - OpenWLM
# Installation du hook pre-commit pour empêcher tout commit accidentel de secrets.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
HOOKS_DIR="$ROOT_DIR/.git/hooks"

if [ ! -d "$HOOKS_DIR" ]; then
  echo "[AVERTISSEMENT] Répertoire .git/hooks introuvable. Ce dossier n'est pas un dépôt Git principal."
  exit 0
fi

PRE_COMMIT="$HOOKS_DIR/pre-commit"

cat << 'EOF' > "$PRE_COMMIT"
#!/usr/bin/env bash
# OpenWLM Pre-Commit Security Hook
# Empêche le commit accidentel de clés privées, secrets ou variables sensibles.
set -e

echo "[Pre-Commit] Vérification anti-fuite de secrets..."
node scripts/check_secrets.js
EOF

chmod +x "$PRE_COMMIT"
echo "✅ Hook Git pre-commit installé avec succès dans .git/hooks/pre-commit."
