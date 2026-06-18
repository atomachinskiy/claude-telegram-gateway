# tg-gateway - Windows installer (Variant 1: bridge to the user's Claude Code session).
# Idempotent. Run from inside a clone of this repo:
#   powershell -ExecutionPolicy Bypass -File .\install-windows.ps1 [-Token <BOT_TOKEN>]
# Token may also come from $env:TELEGRAM_BOT_TOKEN or an interactive prompt.
# See AGENTS.md for rationale and the [VERIFY-PILOT] caveats. ASCII-only by design.
param([string]$Token = $env:TELEGRAM_BOT_TOKEN)

$ErrorActionPreference = "Stop"
function Say($m){ Write-Host "> $m" -ForegroundColor Cyan }
function Die($m){ Write-Host "x $m" -ForegroundColor Red; exit 1 }

$Repo  = $PSScriptRoot
$State = if ($env:TELEGRAM_STATE_DIR) { $env:TELEGRAM_STATE_DIR } else { "$env:USERPROFILE\.claude\channels\tg-gateway" }
$Gw    = Join-Path $Repo "gateway\dist\gateway.js"
$BinDir   = "$env:USERPROFILE\.local\bin"
$Launcher = Join-Path $BinDir "claude-tg.cmd"
$Wrapper  = Join-Path $State "run-gateway.cmd"
$Managed  = "C:\ProgramData\ClaudeCode\managed-settings.json"   # [VERIFY-PILOT]

if (-not (Get-Command node   -EA SilentlyContinue)) { Die "node not found - Claude Code needs it; install Node 18+ first." }
if (-not (Get-Command claude -EA SilentlyContinue)) { Die "claude (Claude Code) not found - set it up first." }
if (-not (Test-Path $Gw)) { Die "missing $Gw - run this from the repo clone." }
$Node = (Get-Command node).Source
New-Item -ItemType Directory -Force -Path $State,$BinDir | Out-Null

# 1. Pair (capture chat_id + write gateway.env). Skip if already paired.
$envFile = Join-Path $State "gateway.env"
if ((Test-Path $envFile) -and (Select-String -Path $envFile -Pattern '^TELEGRAM_SYS_ADMINS|^TELEGRAM_CHAT_ID' -Quiet)) {
  Say "already paired ($envFile) - skipping pairing"
} else {
  if (-not $Token) { $Token = Read-Host "Telegram bot token (from @BotFather)" }
  if (-not $Token) { Die "no token given" }
  Say "pairing - open Telegram, message your bot /start"
  $env:TELEGRAM_BOT_TOKEN = $Token
  $env:TELEGRAM_STATE_DIR = $State
  & $Node $Gw pair
}

# 2. Scheduled Task supervisor (at logon, restart on failure). Use a .cmd wrapper
#    so TELEGRAM_STATE_DIR is carried into the process.
Say "installing Scheduled Task 'tg-gateway' [VERIFY-PILOT]"
@"
@echo off
set TELEGRAM_STATE_DIR=$State
"$Node" "$Gw"
"@ | Set-Content -Path $Wrapper -Encoding ASCII
$action   = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$Wrapper`""
$trigger  = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "tg-gateway" -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited -Force | Out-Null
Start-ScheduledTask -TaskName "tg-gateway"
Start-Sleep 2
Say "task registered and started"

# 3. Register the bridge plugin.
Say "registering bridge plugin (telegram@telegram-local)"
& claude plugin marketplace add "$Repo\bridge"          2>$null
& claude plugin install telegram@telegram-local          2>$null
& claude plugin enable  telegram@telegram-local          2>$null
& claude plugin disable telegram@claude-plugins-official 2>$null

# 4. Channel allowlist via managed-settings (admin). Fall back to dev-flag launcher.
$devflag = $false
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) {
  Say "allowlisting the channel via managed-settings [VERIFY-PILOT]"
  New-Item -ItemType Directory -Force -Path (Split-Path $Managed) | Out-Null
  if (Test-Path $Managed) { Copy-Item $Managed "$Managed.bak-$(Get-Date -Format yyyyMMdd-HHmmss)" }
  @'
{ "channelsEnabled": true,
  "allowedChannelPlugins": [
    { "marketplace": "telegram-local", "plugin": "telegram" },
    { "marketplace": "claude-plugins-official", "plugin": "telegram" } ] }
'@ | Set-Content -Path $Managed -Encoding UTF8
  Say "managed-settings written -> $Managed"
} else {
  $devflag = $true
  Say "not elevated -> using the dev-flag launcher (one-time consent per project). Re-run elevated for the clean path."
}

# 5. Launcher the user runs to be reachable from Telegram (keep the window open).
$flag = if ($devflag) { "--dangerously-load-development-channels" } else { "--channels" }
@"
@echo off
claude $flag plugin:telegram@telegram-local %*
"@ | Set-Content -Path $Launcher -Encoding ASCII
Say "launcher installed -> $Launcher"

Write-Host ""
Say "DONE. Next:"
Write-Host "   1) add $BinDir to PATH if it isn't (or run $Launcher directly)"
Write-Host "   2) run:  claude-tg     (keep that window open - your Telegram-reachable session)"
Write-Host "   3) message your bot from Telegram; type /menu for the control panel"
if ($devflag) { Write-Host "   note: first launch asks consent once (dev flag) - accept it." }
