# tg-gateway — install runbook (for an AI assistant)

You are an AI assistant installing **tg-gateway** on a user's machine: a reliable
Telegram channel for their **Claude Code** session. After this, the user talks to
their Claude from Telegram (phone) and gets reactions, "typing…", voice
transcription, and usage-limit alerts.

This is the **bridge** deployment (Variant 1): the user keeps a Claude Code
window open; messages from Telegram inject into that open session, replies go
back to Telegram. A background daemon (the gateway) owns the Telegram connection
and is supervised so it restarts on crash/boot.

> Execute the steps for the detected OS. Run commands one at a time, check each
> result before moving on, and STOP and ask the user if anything is unexpected.

**Fast path:** a clone ships wrapper installers that do steps 1–3 for you —
macOS `./install-mac.sh`, Windows `powershell -ExecutionPolicy Bypass -File .\install-windows.ps1`.
They're idempotent and follow this runbook. Read the script for your OS, run it,
then use section 4 to verify. The manual steps below are the source of truth if a
script step misbehaves.

---

## 0. Prerequisites (all OS)

1. **Claude Code is installed and working** (`claude --version`). If not, set that up first — that's the normal onboarding.
2. **Node.js present** (`node --version`, v18+). The gateway and bridge run on node — no bun, no npm install required. The native Claude Code installer does NOT bring node: install it first (Windows `winget install --id OpenJS.NodeJS.LTS -e`; macOS the nodejs.org pkg, or unpack the official tarball into `~/.local/node` and put its `bin` on PATH when there is no admin password).
3. **A Telegram bot token**: the user creates a bot via [@BotFather](https://t.me/BotFather) (`/newbot`) and gives you the token (looks like `123456789:AAE...`). Recommend they also set BotFather → Bot Settings → **Allow Groups? Off** and, if available, **Restrict bot usage** (Access) to themselves.
4. Pick install paths (defaults; override only if needed):
   - Repo/install dir: `REPO` = where this repo is cloned (keep it; the daemon runs from here).
   - State dir: `STATE = ~/.claude/channels/tg-gateway` (config + message spool live here).

```bash
# clone if not already (any stable location)
git clone https://github.com/atomachinskiy/claude-telegram-gateway "$HOME/tg-gateway"   # REPO
```

---

## 1. Pair the bot (capture the user's chat, write config) — all OS

Run the pairing wizard. It asks the user to message their bot, captures their
chat id, and writes `$STATE/gateway.env` (token + owner + allowlist, chmod 600).

```bash
TELEGRAM_BOT_TOKEN="<token-from-botfather>" \
TELEGRAM_STATE_DIR="$HOME/.claude/channels/tg-gateway" \
node "$HOME/tg-gateway/gateway/dist/gateway.js" pair
```

Tell the user: **open Telegram, find your bot, send it `/start`.** The wizard
prints `[pair] OK — chat_id=…` and the bot replies "✅ Спарено". If it times out
(5 min), re-run. After this, the token lives ONLY in `$STATE/gateway.env` — you
never need to pass it again.

---

## 2. Run the daemon under a supervisor (always-on)

The daemon = `node $REPO/gateway/dist/gateway.js` with `TELEGRAM_STATE_DIR` set;
it reads the rest from `$STATE/gateway.env`. Set it up so it starts on login and
restarts on crash.

### macOS — launchd
Write `~/Library/LaunchAgents/com.tg-gateway.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.tg-gateway</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string><string>node</string>
    <string>REPLACE_HOME/tg-gateway/gateway/dist/gateway.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>TELEGRAM_STATE_DIR</key><string>REPLACE_HOME/.claude/channels/tg-gateway</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>REPLACE_HOME/.claude/channels/tg-gateway/daemon.log</string>
</dict></plist>
```
Replace `REPLACE_HOME` with `$HOME` (absolute). Then:
```bash
launchctl unload ~/Library/LaunchAgents/com.tg-gateway.plist 2>/dev/null
launchctl load  ~/Library/LaunchAgents/com.tg-gateway.plist
```
Verify: `launchctl list | grep tg-gateway` shows it, and the log has `registered N bot commands` (N = 9 in v1.2.0). Note: `node` must be on launchd's PATH; if not, use the absolute node path (`which node`) instead of `/usr/bin/env node`.

### Windows — Scheduled Task
PowerShell (per-user; runs at logon, restarts on failure):
```powershell
$node = (Get-Command node).Source
$gw   = "$HOME\tg-gateway\gateway\dist\gateway.js"
$env:TELEGRAM_STATE_DIR = "$HOME\.claude\channels\tg-gateway"
$action  = New-ScheduledTaskAction -Execute $node -Argument "`"$gw`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
Register-ScheduledTask -TaskName "tg-gateway" -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited -Force
```
The task must pass `TELEGRAM_STATE_DIR` to the process. If env vars don't carry into the task, instead point the task at a tiny `.cmd` wrapper that does `set TELEGRAM_STATE_DIR=... & node "%gw%"`. Start it now: `Start-ScheduledTask -TaskName tg-gateway`.

### Linux — systemd --user
See `systemd/tg-gateway.service` in the repo; `Environment=TELEGRAM_STATE_DIR=...`, `Restart=always`, `loginctl enable-linger $USER`.

---

## 3. Let Claude Code load the bridge plugin (no dev-flag prompt)

Claude Code gates channel plugins behind an allowlist. Two ways to satisfy it —
prefer the managed-settings way (clean, no prompt).

### 3a. Register the local plugin (all OS)
```bash
claude plugin marketplace add "$HOME/tg-gateway/bridge"
claude plugin install telegram@telegram-local
claude plugin enable  telegram@telegram-local
claude plugin disable telegram@claude-plugins-official 2>/dev/null || true
```

### 3b. Allowlist via managed-settings (admin/sudo) — preferred
Write this JSON to the OS managed-settings path and it loads with no dev prompt:
```json
{ "channelsEnabled": true,
  "allowedChannelPlugins": [
    { "marketplace": "telegram-local", "plugin": "telegram" },
    { "marketplace": "claude-plugins-official", "plugin": "telegram" } ] }
```
Paths (need admin/sudo to write):
- **macOS**: `/Library/Application Support/ClaudeCode/managed-settings.json`
- **Windows**: `C:\ProgramData\ClaudeCode\managed-settings.json`
- **Linux**: `/etc/claude-code/managed-settings.json` (verified working)

If you cannot get admin, **skip 3b** and use the dev-flag launcher in 3c instead.

### 3c. Launcher
Create a command the user runs to start their bridged session (Variant 1 — they keep this window open):
- If 3b succeeded (managed-settings): launch `claude --channels plugin:telegram@telegram-local`
- If no admin (no 3b): launch `claude --dangerously-load-development-channels plugin:telegram@telegram-local` (Claude Code asks for consent ONCE per project, then remembers).

- **Critical:** the launcher must export the SAME `TELEGRAM_STATE_DIR` the daemon uses (e.g. `~/.claude/channels/tg-gateway`, or the per-bot dir) *before* invoking `claude`. If the daemon's state dir isn't the bridge's default, the bridge won't see its inbox/outbox and nothing flows.

macOS/Linux — add a `claude-tg` function/alias to the shell rc (with `export TELEGRAM_STATE_DIR=…`). Windows — a `claude-tg.cmd` on PATH (with `set TELEGRAM_STATE_DIR=…`). Tell the user: **run `claude-tg` whenever you want to be reachable from Telegram, and keep that window open.**

---

## 4. Verify end-to-end

1. Daemon up: supervisor shows it running; `$STATE/gateway.status.json` updates; log has `registered N bot commands` (N = 9 in v1.2.0).
2. User runs `claude-tg` (a Claude Code session with the bridge).
3. From Telegram, the user sends the bot a message → it should appear in the Claude Code session, and Claude's reply should arrive back in Telegram. The bot should also react (👀/etc.) and show "typing…".
4. In Telegram type `/menu` — a control panel should appear (handled by the daemon).

If inbound messages don't reach the session: the allowlist isn't satisfied (revisit 3b/3c) or the bridge plugin isn't enabled (`claude plugin list`).

---

## 5. Uninstall

- Stop + remove the supervisor entry (launchctl unload / `Unregister-ScheduledTask -TaskName tg-gateway` / `systemctl --user disable --now tg-gateway`).
- `claude plugin disable telegram@telegram-local`; remove the managed-settings file (or its two channel keys).
- Remove `$STATE` (contains the token) and the repo clone.

---

## Notes for the installing AI
- The gateway and bridge are **node** bundles in `gateway/dist/` and `bridge/dist/` — no build step on the client.
- **Multiple bots / workspaces:** one bot = one daemon = one `TELEGRAM_STATE_DIR` = one token. Pair + supervise once per bot, each with a distinct state dir (e.g. `…/channels/tg-bot1`), token, and supervisor name (`tg-gateway-bot1`). The bridge plugin (`telegram-local`) and the managed-settings allowlist are **shared** — register them once. Differentiate sessions by exporting that bot's `TELEGRAM_STATE_DIR` in its own launcher (`claude-tg-bot1.cmd`), and run the matching launcher inside the matching workspace. On Windows, `install-windows.ps1` accepts `-StateDir`, `-TaskName`, `-LauncherName` for exactly this — run it once per bot.
- All config is `$STATE/gateway.env` (written by pairing). To add another allowed chat later, append its id to `TELEGRAM_ALLOWED_CHATS` (comma-separated) and restart the daemon.
- The slick session-control panel (`/restart`, `/model`, `/screen`, terminal-dialog relay) needs the daemon to manage the Claude session in tmux — that's a server/headless setup, **not** this bridge deployment. Here the daemon only transports; `/menu`/`/status`/`/ping` still work (daemon-handled), but `/restart`/`/model`/`/screen` are no-ops without a managed tmux session.