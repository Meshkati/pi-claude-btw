#!/usr/bin/env bash
# Re-render a PNG from an existing raw/<name>.ansi capture (e.g. after redacting it).
# Usage: scripts/render.sh <dir> <name> <cols> <rows> [caption]
set -euo pipefail

dir="$1"; name="$2"; cols="$3"; rows="$4"; caption="${5:-}"
root="$(cd "$(dirname "$0")/.." && pwd)"
work="${TMPDIR:-/tmp}/btw-snap"
chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
mkdir -p "$work"

python3 "$root/scripts/ansi2html.py" "$dir/raw/$name.ansi" "$work/$name.html" --cols "$cols" --title "$caption"
width=$(python3 -c "print(int($cols * 8.43 + 40))")
height=$(( rows * 17 + 28 + ( ${#caption} > 0 ? 20 : 0 ) ))
"$chrome" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
  --window-size="$width,$height" --screenshot="$dir/$name.png" "file://$work/$name.html" >/dev/null 2>&1
echo "$dir/$name.png"
