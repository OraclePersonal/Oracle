#!/usr/bin/env bash
#
# oracle-tmux-launch.sh — launch a REAL Claude Code session in a tmux pane that
# auto-wakes on Oracle inter-agent messages via the push watcher.
#
# Run inside WSL (where tmux lives). The Claude session is the Windows
# claude.exe run through WSL interop, so it uses your existing Windows auth and
# the same ~/.oracle message bus (C:\Users\Admin\.oracle) as your other
# Windows Claude sessions — no Claude install inside Ubuntu needed.
#
#   ./oracle-tmux-launch.sh <agent-name> [session-name]
#   wsl -d Ubuntu -- tmux attach -t oracle-<agent-name>
#
# Layout: pane 0 = real Claude (<agent>), pane 1 = push watcher targeting pane 0.
# When any agent sends a message to <agent> (or broadcasts), the watcher types a
# nudge into pane 0 and the idle Claude wakes up, reads its inbox, and acts.
set -euo pipefail

AGENT="${1:?usage: oracle-tmux-launch.sh <agent-name> [session-name]}"
SESSION="${2:-oracle-$AGENT}"

REPO="${ORACLE_REPO:-/mnt/d/Projects/Github/Oracle-Ecosystems}"
CLAUDE_EXE="${ORACLE_CLAUDE_EXE:-/mnt/c/Users/Admin/.local/bin/claude.exe}"
HOME_DIR="${ORACLE_HOME_DIR:-/mnt/c/Users/Admin/.oracle}"

[ -x "$CLAUDE_EXE" ] || { echo "claude.exe not found/executable at $CLAUDE_EXE" >&2; exit 1; }
[ -d "$REPO" ]       || { echo "repo not found at $REPO" >&2; exit 1; }

tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" -c "$REPO" -x 220 -y 50

# pane 0.0 — the real Claude session (Windows binary via interop)
tmux send-keys -t "$SESSION:0.0" "cd '$REPO' && '$CLAUDE_EXE'" Enter

# pane 0.1 — the push watcher nudging pane 0.0 on every new message for <agent>
tmux split-window -h -t "$SESSION:0.0" -c "$REPO"
tmux send-keys -t "$SESSION:0.1" \
  "node scripts/oracle-tmux-push-watcher.mjs --agent '$AGENT' --pane '$SESSION:0.0' --home '$HOME_DIR'" Enter

cat <<EOF

✅ tmux session '$SESSION' launched
   pane 0 = Claude ($AGENT)      pane 1 = push watcher

Next:
  1) Attach:   wsl -d Ubuntu -- tmux attach -t $SESSION
  2) In the Claude pane, approve any trust / MCP prompt.
  3) Tell that Claude once:
       register with oracle as "$AGENT", then check my inbox
  4) Done. Any oracle_msg_send to "$AGENT" now wakes this pane automatically.

Detach from tmux with:  Ctrl-b then d
Kill it later with:     wsl -d Ubuntu -- tmux kill-session -t $SESSION
EOF
