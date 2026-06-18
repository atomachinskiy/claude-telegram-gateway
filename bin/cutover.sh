#!/usr/bin/env bash
# Production cutover: official telegram plugin -> tg-gateway daemon + local bridge plugin.
# Launch DETACHED (setsid nohup) so it survives killing the claude5 session it replaces.
# Verifies the new channel comes up healthy; AUTO-ROLLS-BACK to the official plugin if
# not. Reports the outcome to the operator over the Bot API.
#
# 2026-06-09 v2: the first attempt failed because claude5-start was never switched to
# bridge mode, so the restart relaunched the OFFICIAL plugin = a 2nd poller on the prod
# token (permanent 409) and the bridge never started (no heartbeat). This version:
#   - hard pre-flight that ABORTS without touching the live session if the bridge
#     launcher / plugin / systemd unit / rollback backup are not all in place;
#   - explicitly sets plugin state (enable telegram-local, disable official) so only one
#     poller can ever exist;
#   - swaps claude5-start -> claude5-start.bridge (watchdog + restart-claude5 use it);
#   - rollback restores BOTH the launcher and the plugin enable-state.
set -uo pipefail

LOG=/home/ubuntu/tg-gateway/cutover.log
PROD_TOKEN=$(tr -d '\n' < /home/ubuntu/.claude/secrets/telegram-bot-token)
CHAT=123456789
STATE=/home/ubuntu/.claude/channels/telegram-claude5
START=/home/ubuntu/.local/bin/claude5-start
BRIDGE_START=/home/ubuntu/.local/bin/claude5-start.bridge
BACKUP=/home/ubuntu/.local/bin/claude5-start.bak-pre-cutover-20260609
BRIDGE_DIR=/home/ubuntu/tg-gateway/bridge
UNIT=/home/ubuntu/.config/systemd/user/tg-gateway.service
export PATH="$HOME/.npm-global/bin:$HOME/.claude/venv/bin:$HOME/.bun/bin:$HOME/.deno/bin:$HOME/.local/bin:$PATH"

log(){ echo "[cutover $(date -Iseconds)] $1" >> "$LOG"; }
alert(){ curl -s -X POST "https://api.telegram.org/bot$PROD_TOKEN/sendMessage" --data-urlencode chat_id=$CHAT --data-urlencode "text=$1" --data-urlencode disable_web_page_preview=true >/dev/null 2>&1 || true; }

# Make the official plugin the active channel again (rollback + abort paths).
restore_official_plugin(){
  claude plugin enable  telegram@claude-plugins-official 2>/dev/null || true
  claude plugin disable telegram@telegram-local          2>/dev/null || true
}

rollback(){
  log "ROLLBACK to official plugin"
  cp "$BACKUP" "$START"
  restore_official_plugin
  systemctl --user stop tg-gateway 2>/dev/null || true
  unset TMUX
  tmux has-session -t claude5 2>/dev/null && tmux kill-session -t claude5 || true
  sleep 3
  tmux new-session -d -s claude5 "$START"
  sleep 12
  alert "⚠️ Cutover не удался - откатился на официальный плагин, сессия поднимается. Детали в ~/tg-gateway/cutover.log."
}

log "=== cutover start ==="

# ---- PRE-FLIGHT: refuse to proceed (live session UNTOUCHED) unless everything is ready ----
fail=""
[ -x "$BRIDGE_START" ]                              || fail+=" no-bridge-launcher"
grep -q "plugin:telegram@telegram-local" "$BRIDGE_START" 2>/dev/null || fail+=" launcher-not-bridge-mode"
[ -f "$BRIDGE_DIR/.claude-plugin/plugin.json" ]     || fail+=" no-plugin-manifest"
[ -f "$BRIDGE_DIR/.claude-plugin/marketplace.json" ]|| fail+=" no-marketplace-manifest"
[ -f "$UNIT" ]                                      || fail+=" no-systemd-unit"
[ -f "$BACKUP" ]                                    || fail+=" no-rollback-backup"
grep -q "claude-plugins-official" "$BACKUP" 2>/dev/null || fail+=" backup-not-official"
if [ -n "$fail" ]; then
  log "PREFLIGHT FAILED:$fail — aborting, live channel untouched"
  alert "⛔ Cutover отменён на пре-флайте, живой канал не тронут:$fail"
  log "=== cutover end ==="; exit 1
fi
log "preflight OK"

# ---- set plugin state: telegram-local is the ONLY enabled telegram channel (idempotent) ----
claude plugin marketplace add "$BRIDGE_DIR"            2>/dev/null || true
claude plugin install telegram@telegram-local          2>/dev/null || true
claude plugin enable  telegram@telegram-local          2>/dev/null || true
claude plugin disable telegram@claude-plugins-official 2>/dev/null || true
if ! claude plugin list 2>/dev/null | grep -q "telegram@telegram-local"; then
  log "PREFLIGHT(post-install) FAILED: telegram@telegram-local not installed — aborting"
  restore_official_plugin
  alert "⛔ Cutover отменён: telegram@telegram-local не установился. Живой канал не тронут."
  log "=== cutover end ==="; exit 1
fi
log "plugin state: telegram-local enabled, official disabled"

# ---- swap launcher to bridge mode (watchdog + restart-claude5.sh both call claude5-start) ----
cp "$BRIDGE_START" "$START"
log "swapped claude5-start -> bridge launcher"

sleep 8  # let the agent's turn finish + final message deliver before we kill the session
unset TMUX

# 1) kill the current session (also kills the official plugin poller -> frees the prod token)
tmux has-session -t claude5 2>/dev/null && tmux kill-session -t claude5 || true
log "killed old claude5 session"
sleep 4

# clear stale message JSONs (binaries left), lock and heartbeat so the gate sees only fresh state
rm -f "$STATE"/inbox/*.json "$STATE"/gateway.lock "$STATE"/bridge.heartbeat 2>/dev/null || true

# 2) start the daemon (sole poller now; 409-waits ~30s for Telegram to release the old poll)
systemctl --user restart tg-gateway
log "started tg-gateway daemon"
for i in $(seq 1 20); do [ -s "$STATE/gateway.lock" ] && break; sleep 1; done
log "daemon lock pid: $(cat "$STATE/gateway.lock" 2>/dev/null)"

# 3) start the new claude5 session (claude5-start is now the bridge launcher)
tmux new-session -d -s claude5 "$START"
log "started new claude5 with bridge"

# 4) health gate: fresh bridge heartbeat (written ONLY when our plugin is the ACTIVE channel)
#    + claude alive + daemon active. Up to ~140s (first start runs the launcher's plugin cmds).
ok=0
for i in $(seq 1 70); do
  if [ -f "$STATE/bridge.heartbeat" ]; then
    age=$(( $(date +%s) - $(stat -c %Y "$STATE/bridge.heartbeat") ))
    if [ "$age" -lt 30 ] && pgrep -f "dangerously-load-development-channels" >/dev/null && systemctl --user is-active --quiet tg-gateway; then ok=1; break; fi
  fi
  sleep 2
done

if [ "$ok" = "1" ]; then
  log "HEALTHY"
  alert "✅ Cutover выполнен. Боевой бот теперь на нашем демоне + локальный мост (надёжный канал). Команды: /menu /ping /status /restart, /sys cc /compact. Напиши что-нибудь - проверим живой канал туда-обратно."
else
  log "UNHEALTHY after ~140s (no fresh bridge heartbeat / claude / daemon)"
  rollback
fi
log "=== cutover end ==="
