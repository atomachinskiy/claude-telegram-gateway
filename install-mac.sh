#!/usr/bin/env bash
# tg-gateway — macOS installer (Variant 1: bridge to the user's Claude Code session).
# Idempotent. Run from inside a clone of this repo:  ./install-mac.sh [BOT_TOKEN]
# The bot token can also come from $TELEGRAM_BOT_TOKEN or an interactive prompt.
# See AGENTS.md for the step-by-step rationale and the [VERIFY-PILOT] caveats.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="${TELEGRAM_STATE_DIR:-$HOME/.claude/channels/tg-gateway}"
PLIST="$HOME/Library/LaunchAgents/com.tg-gateway.plist"
LAUNCHER="$HOME/.local/bin/claude-tg"
GW="$REPO/gateway/dist/gateway.js"
MS="/Library/Application Support/ClaudeCode/managed-settings.json"  # [VERIFY-PILOT]

say(){ printf '\033[1;36m▸ %s\033[0m\n' "$*"; }
die(){ printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

command -v node  >/dev/null || die "node not found — Claude Code needs it; install Node 18+ first."
command -v claude >/dev/null || die "claude (Claude Code) not found — set it up first."
[ -f "$GW" ] || die "missing $GW — are you running this from the repo clone?"
mkdir -p "$STATE" "$(dirname "$LAUNCHER")"

# 1. Pair (capture chat_id + write $STATE/gateway.env). Skip if already paired.
if [ -f "$STATE/gateway.env" ] && grep -q '^TELEGRAM_CHAT_ID\|^TELEGRAM_SYS_ADMINS' "$STATE/gateway.env"; then
  say "already paired ($STATE/gateway.env exists) — skipping pairing"
else
  TOKEN="${1:-${TELEGRAM_BOT_TOKEN:-}}"
  [ -n "$TOKEN" ] || { printf 'Telegram bot token (from @BotFather): '; read -r TOKEN; }
  [ -n "$TOKEN" ] || die "no token given"
  say "pairing — open Telegram, message your bot /start"
  TELEGRAM_BOT_TOKEN="$TOKEN" TELEGRAM_STATE_DIR="$STATE" node "$GW" pair
fi

# 2. launchd supervisor (RunAtLoad + KeepAlive).
say "installing launchd agent -> $PLIST"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.tg-gateway</string>
  <key>ProgramArguments</key>
  <array><string>$(command -v node)</string><string>$GW</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>TELEGRAM_STATE_DIR</key><string>$STATE</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>$STATE/daemon.log</string>
</dict></plist>
PLIST
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
sleep 2
launchctl list | grep -q tg-gateway && say "daemon loaded" || say "WARN: launchctl list has no tg-gateway — check $STATE/daemon.log"

# 3. Register the bridge plugin.
say "registering bridge plugin (telegram@telegram-local)"
claude plugin marketplace add "$REPO/bridge"        2>/dev/null || true
claude plugin install telegram@telegram-local        2>/dev/null || true
claude plugin enable  telegram@telegram-local        2>/dev/null || true
claude plugin disable telegram@claude-plugins-official 2>/dev/null || true

# 4. Channel allowlist via managed-settings (sudo). Fall back to dev-flag launcher.
DEVFLAG=0
say "allowlisting the channel (needs sudo to write managed-settings) [VERIFY-PILOT]"
if sudo -v 2>/dev/null; then
  sudo mkdir -p "$(dirname "$MS")"
  [ -f "$MS" ] && sudo cp "$MS" "$MS.bak-$(date +%Y%m%d-%H%M%S)" || true
  sudo tee "$MS" >/dev/null <<'JSON'
{ "channelsEnabled": true,
  "allowedChannelPlugins": [
    { "marketplace": "telegram-local", "plugin": "telegram" },
    { "marketplace": "claude-plugins-official", "plugin": "telegram" } ] }
JSON
  say "managed-settings written -> $MS"
else
  DEVFLAG=1
  say "no sudo -> will use the dev-flag launcher (one-time consent per project)"
fi

# 5. Launcher the user runs to be reachable from Telegram (keep the window open).
if [ "$DEVFLAG" = "1" ]; then
  CMD='claude --dangerously-load-development-channels plugin:telegram@telegram-local'
else
  CMD='claude --channels plugin:telegram@telegram-local'
fi
cat > "$LAUNCHER" <<LAUNCH
#!/usr/bin/env bash
exec $CMD "\$@"
LAUNCH
chmod +x "$LAUNCHER"
say "launcher installed -> $LAUNCHER"

echo
say "DONE. Next:"
echo "   1) ensure ~/.local/bin is on PATH (else run $LAUNCHER directly)"
echo "   2) run:  claude-tg     (keep that window open — that's your Telegram-reachable session)"
echo "   3) message your bot from Telegram; type /menu to see the control panel"
[ "$DEVFLAG" = "1" ] && echo "   note: first launch asks consent once (dev flag) — accept it."
