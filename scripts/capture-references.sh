#!/usr/bin/env bash
# Drive a real Claude Code session through every /btw scenario and snapshot each state
# into references/ (PNG + raw ANSI + plain text). Re-runnable; takes ~10 minutes.
#
#   scripts/capture-references.sh            # all scenarios
#   ONLY="03 05" scripts/capture-references.sh   # (re)start session, then run only these
set -uo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cc="$root/scripts/cc.sh"
snap="$root/scripts/snap.sh"
sandbox="$root/sandbox"
export BTW_TMUX_SOCKET="${BTW_TMUX_SOCKET:-btwref}"
model="${CC_MODEL:-sonnet}"

tm() { tmux -L "$BTW_TMUX_SOCKET" "$@"; }
want() { [ -z "${ONLY:-}" ] || [[ " $ONLY " == *" $1 "* ]]; }
log() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

start_session() {
  tm kill-server 2>/dev/null
  mkdir -p "$sandbox"
  printf 'print("hello")\n' > "$sandbox/app.py"
  python3 - "$sandbox/server.log" <<'PY'
import random, sys
random.seed(7)
services = ["auth", "search", "billing", "inventory", "notifications", "payment-gateway"]
lines = []
for i in range(1400):
    level = random.choices(["INFO", "DEBUG", "WARN", "ERROR"], [70, 20, 8, 2])[0]
    service = random.choice(services)
    lines.append(f"2026-11-02T{(i // 60) % 24:02d}:{i % 60:02d}:{(i * 7) % 60:02d}Z {level:5} {service:16} request {1000 + i} handled in {random.randint(3, 900)}ms")
lines[911] = "2026-11-02T15:11:44Z ERROR payment-gateway    upstream timeout after 30s while charging order #A-99812 (retry 3/3)"
open(sys.argv[1], "w").write("\n".join(lines) + "\n")
PY
  tm -f "$root/scripts/tmux.conf" new-session -d -s cc -x 120 -y 40 -c "$sandbox" \
    "env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT COLORTERM=truecolor claude --model $model; sleep 3600"
  "$cc" wait 'trust this folder|auto mode|for shortcuts|❯' 40
  if "$cc" show | grep -q 'trust this folder'; then "$cc" keys Down Enter; fi
  "$cc" wait 'auto mode|for shortcuts' 30
  sleep 1.5
}

# Ask a side question and wait for the answered state.
btw() {
  "$cc" say "/btw $1"
  "$cc" wait 'Answering' 15 || true
  "$cc" wait 'c to copy|Copied to clipboard|\(API error' "${2:-120}" || true
  sleep 0.6
}

# Send a main-conversation prompt and wait until the turn is over.
main() {
  "$cc" say "$1"
  "$cc" wait 'esc to interrupt' 20 || true
  "$cc" gone 'esc to interrupt' "${2:-120}" || true
  sleep 1.5
}

close_panel() { "$cc" keys Escape; sleep 0.6; }

start_session
"$snap" 00-welcome "00 · fresh Claude Code session" >/dev/null

if want 01; then log "01 slash menu"
  "$cc" type "/btw"; sleep 1.2
  "$snap" 01-slash-menu "01 · /btw in the slash-command menu" >/dev/null
  "$cc" keys C-u; sleep 0.4
fi

if want 02; then log "02 empty /btw with no history"
  "$cc" say "/btw"; sleep 1.2
  "$snap" 02-empty-usage "02 · /btw with no question and no history prints a usage line" >/dev/null
fi

if want 03; then log "03 basic question"
  "$cc" say "/btw what is the capital of Australia, and why isn't it Sydney? answer in 2 sentences"
  "$cc" wait 'Answering' 15; sleep 0.2
  "$snap" 03a-loading "03a · loading: spinner + Answering…, only Esc offered" >/dev/null
  "$cc" wait 'c to copy' 120; sleep 0.5
  "$snap" 03b-answered "03b · answered: markdown answer, copy/fork/close hints" >/dev/null
fi

if want 04; then log "04 dismiss"
  close_panel
  "$snap" 04-dismissed "04 · Esc closes the panel; nothing is written to the transcript" >/dev/null
fi

if want 05; then log "05 main context"
  main "For this session: the project codename is FALCON-7 and my favorite color is teal. Acknowledge in one short sentence, no tools."
  btw "what's the project codename and my favorite color?"
  "$snap" 05-main-context "05 · btw sees the main conversation (and lists the earlier btw as history)" >/dev/null
fi

if want 06; then log "06 browse history"
  "$cc" keys S-Left; sleep 0.6
  "$snap" 06a-browse-older "06a · Shift+← shows an older btw (selected line bold, no fork)" >/dev/null
  "$cc" keys S-Right; sleep 0.6
  "$snap" 06b-browse-newest "06b · Shift+→ back to the newest" >/dev/null
fi

if want 07; then log "07 copy"
  "$cc" keys c; sleep 0.3
  "$snap" 07-copied "07 · c copies the answer; the hint flashes 'Copied to clipboard' for 2s" >/dev/null
  sleep 2.2; close_panel
fi

if want 08; then log "08 btw remembers btw"
  btw "remember this secret number: 4817. just reply ok"
  close_panel
  btw "what secret number did I give you in my previous side question?"
  "$snap" 08-btw-thread-memory "08 · earlier btw exchanges are part of the next btw's context" >/dev/null
  close_panel
fi

if want 09; then log "09 main isolation"
  main "Did I tell you any secret number in this conversation? Answer in one sentence, no tools."
  "$snap" 09-main-isolated "09 · the main agent never sees btw exchanges" >/dev/null
fi

if want 10; then log "10 btw while main agent is busy"
  "$cc" say "Use the Bash tool in the foreground to run exactly: ping -c 25 127.0.0.1 | tail -1   then report that line."
  "$cc" wait 'ping -c 25' 40; sleep 3
  "$snap" 10a-main-busy "10a · main agent busy running a shell command" >/dev/null
  "$cc" say "/btw while that runs: what does the -p flag do for mkdir? one sentence"
  "$cc" wait 'Answering' 15; sleep 0.2
  "$snap" 10b-busy-loading "10b · /btw while busy: the main spinner keeps going above the panel" >/dev/null
  "$cc" wait 'c to copy' 120; sleep 0.5
  "$snap" 10c-busy-answered "10c · answer arrives while the main turn is still running" >/dev/null
  close_panel
  "$cc" gone 'esc to interrupt' 120; sleep 1
  "$snap" 10d-main-finished "10d · main turn finishes normally, unaware of the side question" >/dev/null
fi

if want 11; then log "11 asked to run a command"
  btw "run ls in the current directory and tell me which files exist"
  "$snap" 11-no-tools "11 · btw has no tools: it says it can't run commands" >/dev/null
  close_panel
fi

if want 12; then log "12 long answer + scrolling"
  btw "list 45 fruits, one per line, numbered, no extra text"
  "$snap" 12a-long-top "12a · long answer: bounded viewport, ↓ marker, ↑/↓ to scroll hint" >/dev/null
  "$cc" keys Down Down Down; sleep 0.4
  "$snap" 12b-long-scrolled "12b · ↓ ×3 scrolls 9 lines (3 per press); ↑ marker appears" >/dev/null
  "$cc" keys End; sleep 0.4
  "$snap" 12c-long-end "12c · End jumps to the bottom" >/dev/null
  "$cc" keys Home; sleep 0.4
  close_panel
fi

if want 13; then log "13 many questions -> history overflow"
  for n in 2 3 4 5 6 7 8; do
    btw "what is $n squared? reply with just the number" 60
    close_panel
  done
  btw "what is 9 squared? reply with just the number" 60
  "$snap" 13-history-overflow "13 · only the last 5 earlier questions are listed, plus '(+N earlier /btw)'" >/dev/null
fi

if want 14; then log "14 clear history"
  "$cc" keys x; sleep 0.6
  "$snap" 14-history-cleared "14 · x clears earlier btw history (the shown exchange stays)" >/dev/null
  close_panel
fi

if want 15; then log "15 reopen last answer"
  "$cc" say "/btw"; sleep 1.2
  "$snap" 15-reopen-last "15 · /btw with no question reopens the last answer" >/dev/null
  close_panel
fi

if want 16; then log "16 cancel while loading"
  "$cc" say "/btw write a 300 word poem about terminals"
  "$cc" wait 'Answering' 15; sleep 0.3
  close_panel
  "$snap" 16a-cancelled "16a · Esc while answering cancels the side question" >/dev/null
  "$cc" say "/btw"; sleep 1.2
  "$snap" 16b-after-cancel "16b · a cancelled question is not kept in history" >/dev/null
  close_panel
fi

if want 17; then log "17 markdown"
  btw "give me a tiny markdown sample: a level-2 heading, a 3-item bullet list with one bold word, and a 3-line python code block. nothing else"
  "$snap" 17-markdown "17 · the answer is rendered as markdown" >/dev/null
  close_panel
fi

if want 18; then log "18 narrow terminal"
  tm resize-window -t cc -x 64 -y 30; sleep 1.5
  btw "in two sentences, what is a monorepo?"
  "$snap" 18-narrow "18 · narrow terminal (64 cols): separator still spans the full width" >/dev/null
  close_panel
  tm resize-window -t cc -x 120 -y 40; sleep 1.5
fi

if want 19; then log "19 long context"
  main "Use only the Read tool (no grep, no bash) to read every line of server.log, in chunks if needed, then tell me in one sentence how many ERROR lines it has." 300
  "$snap" 19a-long-context-main "19a · main agent loaded a long log into context" >/dev/null
  btw "in that log, which order id appeared in the payment-gateway timeout, and at what time?" 180
  "$snap" 19b-long-context-btw "19b · btw answers from the long context without re-reading the file" >/dev/null
  close_panel
fi

if want 20; then log "20 fork"
  btw "suggest a name for a CLI tool that tracks coffee intake. one line"
  "$cc" keys f; sleep 1.5
  "$snap" 20a-forked "20a · f forks the side question into a background agent (with tools)" >/dev/null
  "$cc" gone 'esc to interrupt' 120; sleep 4
  "$snap" 20b-fork-result "20b · the fork's result comes back into the main conversation" >/dev/null
fi

log "done → $root/references"
