#!/usr/bin/env bash
# Capture the visible tmux pane as .ansi (with colors), .txt (plain) and .png (rendered).
# Usage: scripts/snap.sh <name> [caption]
# Env:   BTW_TMUX_SOCKET (default btwref), BTW_TMUX_TARGET (default cc), BTW_OUT (default references)
set -euo pipefail

name="$1"
caption="${2:-}"
socket="${BTW_TMUX_SOCKET:-btwref}"
target="${BTW_TMUX_TARGET:-cc}"
root="$(cd "$(dirname "$0")/.." && pwd)"
out="${BTW_OUT:-$root/references}"
work="${TMPDIR:-/tmp}/btw-snap"
chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
mkdir -p "$out/raw" "$work"

cols=$(tmux -L "$socket" display-message -p -t "$target" '#{pane_width}')
rows=$(tmux -L "$socket" display-message -p -t "$target" '#{pane_height}')

tmux -L "$socket" capture-pane -p -e -t "$target" > "$out/raw/$name.ansi"
tmux -L "$socket" capture-pane -p -t "$target" > "$out/raw/$name.txt"

python3 "$root/scripts/ansi2html.py" "$out/raw/$name.ansi" "$work/$name.html" --cols "$cols" --title "$caption"

width=$(python3 -c "print(int($cols * 8.43 + 40))")
height=$(( rows * 17 + 28 + ( ${#caption} > 0 ? 20 : 0 ) ))
"$chrome" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
  --window-size="$width,$height" --screenshot="$out/$name.png" "file://$work/$name.html" >/dev/null 2>&1
echo "$out/$name.png"
