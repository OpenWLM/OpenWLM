#!/usr/bin/env bash
# scripts/provision_vapid.sh - OpenWLM
# Script shell pour exécuter le provisioning sécurisé des clés VAPID (RFC 8292).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$ROOT_DIR"
exec node "$SCRIPT_DIR/generate_vapid_keys.js" "$@"
