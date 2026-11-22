#!/usr/bin/env bash
# Drive the reference Claude Code session that runs inside a private tmux server.
#   cc.sh keys <tmux-key>...      send raw keys (Enter, Escape, Down, C-c, ...)
#   cc.sh type "<text>"           type literal text (no Enter)
#   cc.sh say "<text>"            type literal text and press Enter
#   cc.sh wait "<regex>" [secs]   block until the pane matches regex (default 90s)
#   cc.sh gone "<regex>" [secs]   block until the pane no longer matches regex
#   cc.sh show                    print the visible pane as plain text
set -euo pipefail
socket="${BTW_TMUX_SOCKET:-btwref}"
target="${BTW_TMUX_TARGET:-cc}"
tm() { tmux -L "$socket" "$@"; }
pane() { tm capture-pane -p -t "$target"; }

command="$1"; shift
case "$command" in
  keys) for key in "$@"; do tm send-keys -t "$target" "$key"; sleep 0.25; done ;;
  type) tm send-keys -t "$target" -l "$1" ;;
  say)  tm send-keys -t "$target" -l "$1"; sleep 0.4; tm send-keys -t "$target" Enter ;;
  wait|gone)
    deadline=$(( $(date +%s) + ${2:-90} ))
    while :; do
      if pane | grep -Eq "$1"; then [ "$command" = wait ] && exit 0
      else [ "$command" = gone ] && exit 0; fi
      [ "$(date +%s)" -ge "$deadline" ] && { echo "timeout: $command '$1'" >&2; pane | tail -15 >&2; exit 1; }
      sleep 0.3
    done ;;
  show) pane ;;
  *) echo "unknown command: $command" >&2; exit 2 ;;
esac
