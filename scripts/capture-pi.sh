#!/usr/bin/env bash
# Run the same /btw scenarios against pi with this extension loaded and snapshot each state
# into screenshots/pi/, numbered like references/ so the two can be compared side by side.
#
#   PI_MODEL=provider/model scripts/capture-pi.sh
set -uo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cc="$root/scripts/cc.sh"
snap="$root/scripts/snap.sh"
sandbox="$root/sandbox-pi"
export BTW_TMUX_SOCKET=pibtw BTW_TMUX_TARGET=pi BTW_OUT="$root/screenshots/pi"
sessions="${TMPDIR:-/tmp}/pi-btw-sessions"
model_args=()
[ -n "${PI_MODEL:-}" ] && model_args=(--model "$PI_MODEL")

tm() { tmux -L "$BTW_TMUX_SOCKET" "$@"; }
log() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

btw() {
  "$cc" say "/btw $1"
  "$cc" wait 'Answering' 15 || true
  "$cc" wait 'c to copy|\(API error' "${2:-120}" || true
  sleep 0.5
}

main() {
  "$cc" say "$1"
  "$cc" wait 'Working' 20 || true
  "$cc" gone 'Working' "${2:-120}" || true
  sleep 1
}

close_panel() { "$cc" keys Escape; sleep 0.5; }

tm kill-server 2>/dev/null
rm -rf "$sessions" && mkdir -p "$sessions" "$sandbox" "$BTW_OUT"
printf 'print("hello")\n' > "$sandbox/app.py"
tm -f "$root/scripts/tmux.conf" new-session -d -s pi -x 120 -y 40 -c "$sandbox" \
  "env -u CLAUDECODE pi -e $root/extensions/btw.ts --session-dir $sessions ${model_args[*]:-} --thinking low; sleep 3600"
"$cc" wait 'Extensions' 30; sleep 2

log "01 slash menu"
"$cc" type "/bt"; sleep 1
"$snap" 01-slash-menu "pi · 01 · /btw in the slash-command menu" >/dev/null
"$cc" keys C-u; sleep 0.3

log "02 empty"
"$cc" say "/btw"; sleep 0.8
"$snap" 02-empty-usage "pi · 02 · /btw with no question and no history shows the usage" >/dev/null

log "03 basic"
"$cc" say "/btw what is the capital of Australia, and why isn't it Sydney? answer in 2 sentences"
"$cc" wait 'Answering' 15; sleep 0.2
"$snap" 03a-loading "pi · 03a · loading" >/dev/null
"$cc" wait 'c to copy' 120; sleep 0.4
"$snap" 03b-answered "pi · 03b · answered" >/dev/null
close_panel
"$snap" 04-dismissed "pi · 04 · Esc closes the panel; nothing is added to the session" >/dev/null

log "05 context + history"
main "For this session: the project codename is FALCON-7 and my favorite color is teal. Acknowledge in one short sentence, no tools."
btw "what's the project codename and my favorite color?"
"$snap" 05-main-context "pi · 05 · btw sees the main conversation; earlier btw listed above" >/dev/null
"$cc" keys S-Left; sleep 0.4
"$snap" 06a-browse-older "pi · 06a · Shift+← shows the older exchange" >/dev/null
"$cc" keys S-Right c; sleep 0.3
"$snap" 07-copied "pi · 07 · c copies; the hint flashes 'Copied to clipboard'" >/dev/null
sleep 2.2; close_panel

log "10 busy"
"$cc" say "Use the bash tool to run exactly: ping -c 25 127.0.0.1 | tail -1   then report that line."
"$cc" wait 'ping -c 25' 40; sleep 3
"$snap" 10a-main-busy "pi · 10a · main agent busy running a shell command" >/dev/null
"$cc" say "/btw while that runs: what does the -p flag do for mkdir? one sentence"
"$cc" wait 'Answering' 15; sleep 0.2
"$snap" 10b-busy-loading "pi · 10b · /btw while busy" >/dev/null
"$cc" wait 'c to copy' 120; sleep 0.4
"$snap" 10c-busy-answered "pi · 10c · answered while the main turn keeps running (no fork while busy)" >/dev/null
close_panel
"$cc" gone 'Working' 120; sleep 1
"$snap" 10d-main-finished "pi · 10d · main turn finishes normally" >/dev/null

log "11 no tools"
btw "run ls in the current directory and tell me which files exist"
"$snap" 11-no-tools "pi · 11 · btw has no tools" >/dev/null
close_panel

log "12 long"
btw "list 45 fruits, one per line, numbered, no extra text"
"$snap" 12a-long-top "pi · 12a · long answer: bounded viewport with ↓ marker" >/dev/null
"$cc" keys Down Down Down; sleep 0.3
"$snap" 12b-long-scrolled "pi · 12b · ↓ ×3 scrolls 9 lines" >/dev/null
close_panel

log "13 overflow"
for n in 2 3 4 5; do btw "what is $n squared? reply with just the number" 60; close_panel; done
btw "what is 9 squared? reply with just the number" 60
"$snap" 13-history-overflow "pi · 13 · last five earlier questions plus '(+N earlier /btw)'" >/dev/null
"$cc" keys x; sleep 0.4
"$snap" 14-history-cleared "pi · 14 · x clears earlier history" >/dev/null
close_panel

log "18 narrow"
tm resize-window -t pi -x 64 -y 30; sleep 1
btw "in two sentences, what is a monorepo?"
"$snap" 18-narrow "pi · 18 · narrow terminal: full-width separator, wrapped hints" >/dev/null
close_panel
tm resize-window -t pi -x 120 -y 40; sleep 1

log "20 fork"
btw "suggest a name for a CLI tool that tracks coffee intake. one line"
"$cc" keys f; sleep 3
"$snap" 20a-forked "pi · 20a · f forks into a new session that carries the side exchange" >/dev/null

log "done → $BTW_OUT"
