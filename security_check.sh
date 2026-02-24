#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
PUBLIC_DIR="$ROOT_DIR/public"

# Ensure sensitive local files are not tracked in git.
TRACKED="$(git -C "$ROOT_DIR" ls-files)"
if grep -Eq '(^|/)\.env$|(^|/)\.dev\.vars$|(^|/)\.dolar_monitor_state$|(^|/)monitor\.log$' <<<"$TRACKED"; then
  echo "Hay archivos sensibles trackeados por git." >&2
  exit 1
fi

# Detect obvious private keys accidentally committed.
if grep -R -n -E --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.wrangler -- '-----BEGIN (RSA|EC|OPENSSH|PGP) PRIVATE KEY-----' "$ROOT_DIR"; then
  echo "Se detecto una llave privada en el repo." >&2
  exit 1
fi

# Ensure source code does not expose obvious secrets or local paths.
if grep -R -n -E --exclude-dir=.git --exclude-dir=node_modules --exclude='*.md' '(AKIA[0-9A-Z]{16}|-----BEGIN PRIVATE KEY-----|/Users/|/home/)' "$ROOT_DIR/src" "$ROOT_DIR/.github/workflows" "$ROOT_DIR/wrangler.toml" 2>/dev/null; then
  echo "Se detectaron posibles datos sensibles en codigo/config." >&2
  exit 1
fi

# Ensure Cloudflare token is never hardcoded (GitHub secrets reference is allowed).
if grep -R -n -E --exclude-dir=.git --exclude-dir=node_modules --exclude='*.md' 'CLOUDFLARE_API_TOKEN\\s*[:=]\\s*[\"'\'']?[A-Za-z0-9._-]{20,}' "$ROOT_DIR/src" "$ROOT_DIR/.github/workflows" "$ROOT_DIR/wrangler.toml" 2>/dev/null; then
  echo "Se detectaron posibles datos sensibles en codigo/config." >&2
  exit 1
fi

echo "Security check OK."
