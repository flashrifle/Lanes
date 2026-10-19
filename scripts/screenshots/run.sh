#!/usr/bin/env bash
# Regenerate the landing-page screenshots: site/assets/screens/{ko,en}/*.png
# Needs: git, python3 + Pillow, node, Google Chrome, pnpm deps installed. Uses ports 1420 (Vite), 1555, 1556.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
WORK="${WORK:-$(mktemp -d "${TMPDIR:-/tmp}/lanes-shots.XXXXXX")}"
OUT="$ROOT/site/assets/screens"
PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

for port in 1420 1555 1556; do
  if lsof -nP -iTCP:$port -sTCP:LISTEN > /dev/null 2>&1; then echo "port $port is busy; stop that process first" >&2; exit 1; fi
done

python3 "$HERE/make_repo.py" "$WORK/ko" ko
python3 "$HERE/make_repo.py" "$WORK/en" en

(cd "$ROOT" && exec pnpm vite --port 1420 --strictPort) > "$WORK/vite.log" 2>&1 & PIDS+=($!)
python3 "$HERE/server.py" --repo "$WORK/ko/Lanes" --port 1555 2> "$WORK/server-ko.log" & PIDS+=($!)
python3 "$HERE/server.py" --repo "$WORK/en/Lanes" --port 1556 2> "$WORK/server-en.log" & PIDS+=($!)
for _ in $(seq 60); do curl -sf http://localhost:1420/src/main.tsx > /dev/null && break; sleep 0.5; done

node "$HERE/shoot.mjs" --lang ko --port 1555 --out "$OUT/ko" "$@"
node "$HERE/shoot.mjs" --lang en --port 1556 --out "$OUT/en" "$@"
# Open Graph card (1200x630) from og.html, which embeds the fresh English main shot
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
OGP="$(mktemp -d)"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --user-data-dir="$OGP" --allow-file-access-from-files \
  --window-size=1200,630 --virtual-time-budget=5000 --screenshot="$ROOT/site/assets/og.png" "file://$HERE/og.html" 2>/dev/null
rm -rf "$OGP"

python3 "$HERE/optimize.py" "$OUT"/ko/*.png "$OUT"/en/*.png "$ROOT/site/assets/og.png"

echo "--- page log (ko) ---"; grep -v '^\[mock\] serving' "$WORK/server-ko.log" || true
echo "--- page log (en) ---"; grep -v '^\[mock\] serving' "$WORK/server-en.log" || true
echo "Screenshots in $OUT (work dir: $WORK)"
