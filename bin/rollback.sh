#!/usr/bin/env bash
# Manual rollback to the official telegram plugin. Run any time after cutover.
set -uo pipefail
cp /home/ubuntu/.local/bin/claude5-start.bak-pre-cutover-20260609 /home/ubuntu/.local/bin/claude5-start
systemctl --user stop tg-gateway 2>/dev/null || true
unset TMUX
tmux has-session -t claude5 2>/dev/null && tmux kill-session -t claude5 || true
sleep 3
tmux new-session -d -s claude5 /home/ubuntu/.local/bin/claude5-start
echo "rolled back to official plugin; claude5 restarting"
