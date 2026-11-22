#!/usr/bin/env bash
# Record the gallery demo: pi runs a slow test suite, the user asks /btw meanwhile,
# reads the answer, closes it, and the agent finishes. Produces media/demo.mp4 and
# media/cover.png (the frame with the side answer on screen).
#
#   PI_MODEL=provider/model scripts/record-demo.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cc="$root/scripts/cc.sh"
demo="$root/sandbox-demo"
work="${TMPDIR:-/tmp}/btw-demo"
frames="$work/frames"
chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
cols=88 rows=26
export BTW_TMUX_SOCKET=pidemo BTW_TMUX_TARGET=pi
model_args=()
[ -n "${PI_MODEL:-}" ] && model_args=(--model "$PI_MODEL")

tm() { tmux -L "$BTW_TMUX_SOCKET" "$@"; }
type_slowly() {
  local text="$1" i
  for ((i = 0; i < ${#text}; i++)); do tm send-keys -t pi -l "${text:i:1}"; sleep 0.035; done
}

# A project whose tests take ~13 s, so the agent is visibly busy.
rm -rf "$demo" "$work" && mkdir -p "$demo" "$frames" "$root/media"
cat > "$demo/package.json" <<'EOF'
{ "name": "demo", "private": true, "scripts": { "test": "node slow-test.js" } }
EOF
cat > "$demo/slow-test.js" <<'EOF'
const suites = ["parser", "renderer", "keybindings", "history", "scrolling", "fork"];
let done = 0;
const timer = setInterval(() => {
  console.log(`ok ${suites[done]} (${12 + done * 3} tests)`);
  if (++done === suites.length) { clearInterval(timer); console.log("6 suites, 117 tests passed"); }
}, 2200);
EOF

tm kill-server 2>/dev/null || true
tm -f "$root/scripts/tmux.conf" new-session -d -s pi -x "$cols" -y "$rows" -c "$demo" \
  "env -u CLAUDECODE pi -ne -ns -np -nc -e $root/extensions/btw.ts --no-session ${model_args[*]:-} --thinking low; sleep 3600"
"$cc" wait 'btw.ts' 30
sleep 2

python3 "$root/scripts/record_frames.py" "$frames" "$BTW_TMUX_SOCKET" pi &
recorder=$!
sleep 1.2

type_slowly "Run npm test with the bash tool, then summarize the result in one line."
sleep 0.4; tm send-keys -t pi Enter
"$cc" wait '\$ npm test' 60
sleep 1.5
type_slowly "/btw what does the --watch flag do for node --test? one sentence"
sleep 0.5; tm send-keys -t pi Enter
"$cc" wait 'c to copy' 90
sleep 3.5
tm send-keys -t pi Escape
"$cc" wait '117 tests' 60
"$cc" gone 'Working' 90
sleep 3
touch "$frames/STOP"
wait "$recorder"
tm kill-server

# Render every frame to PNG (2x, no caption) in parallel.
render() {
  local ansi="$1" name html profile
  name="$(basename "$ansi" .ansi)"; html="$work/$name.html"; profile="$(mktemp -d)"
  python3 "$root/scripts/ansi2html.py" "$ansi" "$html" --cols "$cols"
  "$chrome" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
    --user-data-dir="$profile" --window-size="$(python3 -c "print(int($cols * 8.43 + 40))"),$((rows * 17 + 28))" \
    --screenshot="$frames/$name.png" "file://$html" >/dev/null 2>&1
  rm -rf "$profile"
}
export -f render
export root work frames chrome cols rows
ls "$frames"/*.ansi | xargs -P 3 -I{} bash -c 'render "$1"' _ {} || true
# Parallel headless Chrome occasionally crashes; render whatever is missing one by one.
for ansi in "$frames"/*.ansi; do
  for attempt in 1 2 3; do [ -s "${ansi%.ansi}.png" ] && break; render "$ansi" || true; done
  [ -s "${ansi%.ansi}.png" ] || { echo "could not render $ansi" >&2; exit 1; }
done

# Frame durations come from the recorded timeline.
python3 - "$frames" <<'EOF'
import pathlib, sys
frames = pathlib.Path(sys.argv[1])
rows = [line.split() for line in (frames / "timeline.txt").read_text().splitlines()]
lines = []
for (name, start), (_, end) in zip(rows, rows[1:]):
    lines += [f"file '{frames / (name + '.png')}'", f"duration {float(end) - float(start):.3f}"]
lines.append(f"file '{frames / (rows[-2][0] + '.png')}'")
(frames / "concat.txt").write_text("\n".join(lines) + "\n")
EOF
ffmpeg -y -loglevel error -f concat -safe 0 -i "$frames/concat.txt" \
  -vf "fps=30,format=yuv420p" -c:v libx264 -preset slow -crf 20 -movflags +faststart "$root/media/demo.mp4"

# Cover: the last frame that shows the side answer.
cover="$(grep -l 'c to copy' "$frames"/*.ansi | tail -1)"
cp "${cover%.ansi}.png" "$root/media/cover.png"
echo "media/demo.mp4 and media/cover.png (from $(basename "$cover"))"
