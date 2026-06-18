#!/usr/bin/env bash
# Path-B cutover: dev-flag launcher (--dangerously-load-development-channels) ->
# managed-allowlist launcher (--channels). The root-owned managed-settings.json now
# whitelists telegram-local, so the .dev flag is no longer needed. Launch DETACHED
# (setsid nohup) so it survives killing the claude5 session it restarts. Health-gates
# the new session on a fresh bridge heartbeat; AUTO-ROLLS-BACK to the dev-flag launcher
# if the channel doesn't come up. Reports outcome over the Bot API.
set -uo pipefail

LOG=/home/ubuntu/tg-gateway/cutover.log
PROD_TOKEN=$(tr -d '\n' < /home/ubuntu/.claude/secrets/telegram-bot-token)
CHAT=123456789
STATE=/home/ubuntu/.claude/channels/telegram-claude5
START=/home/ubuntu/.local/bin/claude5-start
PATHB=/home/ubuntu/.local/bin/claude5-start.pathb
DEVBAK=/home/ubuntu/.local/bin/claude5-start.devflag-bak-20260610
MANAGED=/etc/claude-code/managed-settings.json
export PATH="$HOME/.npm-global/bin:$HOME/.claude/venv/bin:$HOME/.bun/bin:$HOME/.deno/bin:$HOME/.local/bin:$PATH"

log(){ echo "[pathb $(date -Iseconds)] $1" >> "$LOG"; }
alert(){ curl -s -X POST "https://api.telegram.org/bot$PROD_TOKEN/sendMessage" --data-urlencode chat_id=$CHAT --data-urlencode "text=$1" --data-urlencode disable_web_page_preview=true >/dev/null 2>&1 || true; }

rollback(){
  log "ROLLBACK to dev-flag launcher"
  cp "$DEVBAK" "$START"
  unset TMUX
  tmux has-session -t claude5 2>/dev/null && tmux kill-session -t claude5 || true
  sleep 3
  tmux new-session -d -s claude5 "$START"
  sleep 12
  alert "⚠️ Path B не поднялся — откатился на dev-флаг, канал восстанавливается. Детали в ~/tg-gateway/cutover.log."
}

log "=== pathb cutover start ==="

# ---- PRE-FLIGHT: live session UNTOUCHED unless everything is ready ----
fail=""
[ -f "$MANAGED" ]                                          || fail+=" no-managed-settings"
grep -q "telegram-local" "$MANAGED" 2>/dev/null           || fail+=" allowlist-missing-telegram-local"
grep -Eq '"channelsEnabled"[[:space:]]*:[[:space:]]*true' "$MANAGED" 2>/dev/null || fail+=" channels-not-enabled"
[ -x "$PATHB" ]                                            || fail+=" no-pathb-launcher"
grep -q -- "--channels plugin:telegram@telegram-local" "$PATHB" 2>/dev/null || fail+=" pathb-not-channels-mode"
grep -q "dangerously-load-development-channels" "$START" 2>/dev/null || fail+=" current-not-devflag"
if [ -n "$fail" ]; then
  log "PREFLIGHT FAILED:$fail — aborting, live channel untouched"
  alert "⛔ Path B отменён на пре-флайте, живой канал не тронут:$fail"
  log "=== pathb cutover end ==="; exit 1
fi
log "preflight OK"

# ---- back up the current (dev-flag) launcher for rollback, then swap in Path B ----
cp "$START" "$DEVBAK"
cp "$PATHB" "$START"
if grep -q "dangerously-load-development-channels" "$START" || ! grep -q -- "--channels plugin:telegram@telegram-local" "$START"; then
  log "SWAP VERIFY FAILED — restoring dev-flag launcher, aborting"
  cp "$DEVBAK" "$START"
  alert "⛔ Path B: подмена лаунчера не прошла проверку, откатил, канал не тронут."
  log "=== pathb cutover end ==="; exit 1
fi
log "swapped claude5-start -> Path B launcher (--channels, managed allowlist)"

sleep 8  # let the agent's turn finish + final message deliver before we kill the session
unset TMUX

# 1) kill the current (dev-flag) session
tmux has-session -t claude5 2>/dev/null && tmux kill-session -t claude5 || true
log "killed old claude5 session"
sleep 4

# clear stale heartbeat so the gate only sees fresh post-restart state
# (the daemon keeps polling on its own systemd process and buffers inbound to inbox/)
rm -f "$STATE/bridge.heartbeat" 2>/dev/null || true

# 2) ensure the gateway daemon (sole poller) is up
systemctl --user is-active --quiet tg-gateway || systemctl --user restart tg-gateway
for i in $(seq 1 20); do [ -s "$STATE/gateway.lock" ] && break; sleep 1; done
log "daemon lock pid: $(cat "$STATE/gateway.lock" 2>/dev/null)"

# 3) start the new claude5 session (claude5-start is now the Path B launcher)
tmux new-session -d -s claude5 "$START"
log "started new claude5 (Path B, --channels)"

# 4) health gate: fresh bridge heartbeat (written ONLY when our plugin is the ACTIVE
#    channel) + a claude proc on --channels + daemon active. Up to ~140s (first start
#    runs the launcher's plugin commands before the channel connects).
ok=0
for i in $(seq 1 70); do
  if [ -f "$STATE/bridge.heartbeat" ]; then
    age=$(( $(date +%s) - $(stat -c %Y "$STATE/bridge.heartbeat") ))
    if [ "$age" -lt 30 ] && pgrep -f "[-]-channels plugin:telegram@telegram-local" >/dev/null && systemctl --user is-active --quiet tg-gateway; then ok=1; break; fi
  fi
  sleep 2
done

if [ "$ok" = "1" ]; then
  log "HEALTHY (Path B)"
  alert "✅ Path B активен — claude5 идёт через managed-allowlist без dev-флага. Канал жив (демон + мост), pgrep видит --channels. Напиши что-нибудь — проверим туда-обратно."
else
  log "UNHEALTHY after ~140s (no fresh bridge heartbeat / claude / daemon) — rolling back"
  rollback
fi
log "=== pathb cutover end ==="
