#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
PUBLIC_DIR="$ROOT_DIR/public"

if [[ ! -f "$PUBLIC_DIR/dashboard.html" ]]; then
  echo "Falta $PUBLIC_DIR/dashboard.html" >&2
  exit 1
fi

# Ensure sensitive local files are not tracked in git.
TRACKED="$(git -C "$ROOT_DIR" ls-files)"
if grep -Eq '(^|/)\.env$|(^|/)\.dolar_monitor_state$|(^|/)monitor\.log$' <<<"$TRACKED"; then
  echo "Hay archivos sensibles trackeados por git." >&2
  exit 1
fi

# Detect obvious private keys accidentally committed.
if grep -R -n -E --exclude-dir=.git -- '-----BEGIN (RSA|EC|OPENSSH|PGP) PRIVATE KEY-----' "$ROOT_DIR"; then
  echo "Se detecto una llave privada en el repo." >&2
  exit 1
fi

# Ensure public dir only contains expected publishable file(s).
UNEXPECTED="$(find "$PUBLIC_DIR" -type f ! -name 'dashboard.html' | wc -l | tr -d ' ')"
if [[ "$UNEXPECTED" != "0" ]]; then
  echo "Hay archivos inesperados dentro de public/." >&2
  find "$PUBLIC_DIR" -type f ! -name 'dashboard.html'
  exit 1
fi

# Ensure generated dashboard does not expose local paths or smtp fields.
if grep -n -E 'SMTP_|/Users/|/home/' "$PUBLIC_DIR/dashboard.html"; then
  echo "dashboard.html expone datos internos." >&2
  exit 1
fi

echo "Security check OK."
