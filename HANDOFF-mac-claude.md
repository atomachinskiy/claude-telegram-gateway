# Что поменялось на серваке — брифинг для Mac-Claude

Документ для локального Клода на маке. Объясняет, как на сервере (AWS, 52.29.159.27, бот **@aiclaude5server_bot**) поменялся транспорт Telegram. Дата: 2026-06-10.

---

## TL;DR

Официальный Telegram-плагин (`--channels plugin:telegram@claude-plugins-official`) **выключен**. Его заменил наш собственный надёжный транспорт **tg-gateway**: отдельный демон под systemd держит соединение с Telegram, а в сессии Клода крутится только тонкий мост без сети. Это убрало главную болячку — тихие отвалы плагина на `409 Conflict`. Заодно появились **команды и кнопки в боте** (`/menu`, `/status`, `/restart` и т.д.), которые работают даже когда сессия Клода лежит.

**Старые инструкции в Mac CLAUDE.md про восстановление TG-плагина (`claude5-self reconnect plugin:telegram:telegram`, «не запускай `claude mcp list`») для нового транспорта НЕАКТУАЛЬНЫ.** См. раздел «Что протухло».

---

## Было → Стало

| | Было | Стало |
|---|---|---|
| Транспорт | офиц. плагин `telegram@claude-plugins-official` | свой `tg-gateway`: демон + мост |
| Кто держит getUpdates | сам Claude Code внутри сессии | отдельный демон под `systemd --user` |
| Launcher | `claude --channels plugin:telegram@claude-plugins-official` | `claude --channels plugin:telegram@telegram-local` |
| Допуск локального плагина | — | root-owned `/etc/claude-code/managed-settings.json` (`allowedChannelPlugins`) |
| Падение/отвал | тихий выход из polling на 409, тишина Андрею | демон Restart=always + watchdog (выход при wedge → systemd поднимает) |
| Команды/кнопки в боте | нет | `/menu` `/ping` `/status` `/screen` `/restart` `/logs` + инлайн-панель |
| Если сессия лежит | бот мёртв | команды управления всё равно отвечают (их обрабатывает демон) |

---

## Архитектура (3 части)

1. **Демон** `~/tg-gateway/gateway/gateway.ts` (Bun) под `systemd --user tg-gateway.service`, `Restart=always`.
   Держит токен боевого бота + `getUpdates` (робастный long-poll: backoff, 409-handler, single-instance lock, stale-watchdog). Входящие пишет в `inbox/` в формате 1-в-1 с официальным плагином; исходящие шлёт из `outbox/`. Сам обрабатывает команды управления и callback-кнопки.
2. **Мост** `~/tg-gateway/bridge/server.ts` — тонкий MCP-плагин (маркетплейс `telegram-local`, плагин `telegram`), грузится в сессию через `--channels`. Сети не трогает: тулы `reply`/`react`/`edit_message`/`download_attachment`/`ask` пишут запрос в `outbox/` и ждут ответ демона. Пишет `bridge.heartbeat` каждые ~10с (по нему демон понимает, что сессия жива).
3. **managed-settings** `/etc/claude-code/managed-settings.json` (root, неизменяемый юзером) — whitelist'ит `telegram-local`, поэтому `--channels` грузит его как обычный канал, без dev-флага и без стартового промпта.

Поток входящего: Telegram → демон `getUpdates` → `inbox/*.json` → мост инжектит в сессию. Поток исходящего: сессия зовёт тул моста → `outbox/req-*.json` → демон шлёт в Telegram → `outbox/res/*.json` → мост возвращает результат.

---

## Где что лежит (на сервере)

- Репо: `~/tg-gateway/` → `github.com/atomachinskiy/tg-gateway` (PRIVATE). Док-ция: `README.md`, `DESIGN.md`, этот файл.
- State канала: `~/.claude/channels/telegram-claude5/` (`inbox/`, `outbox/`, `gateway.status.json`, `gateway.offset`, `gateway.lock`, `bridge.heartbeat`).
- Launcher: `~/.local/bin/claude5-start` (Path B; старый dev-флаговый сохранён как `claude5-start.devflag-bak-*` для отката).
- Restart-скрипт: `~/tg-gateway/bin/restart-claude5.sh` (детачится через setsid, безопасно убивает и поднимает сессию заново).
- systemd-юнит: `~/.config/systemd/user/tg-gateway.service`.
- Токен бота: `~/.claude/secrets/telegram-bot-token` (нигде не захардкожен, читается в рантайме).
- Сессия Клода живёт в tmux `claude5`.

---

## Операционка

**Статус транспорта:**
```
systemctl --user status tg-gateway.service
journalctl --user -u tg-gateway -n 50 --no-pager
cat ~/.claude/channels/telegram-claude5/gateway.status.json
```
**Рестарт демона** (транспорт): `systemctl --user restart tg-gateway.service`
**Рестарт сессии Клода:** `bash ~/tg-gateway/bin/restart-claude5.sh` (или кнопка `/restart` в боте).

**Команды бота** (доступны только владельцу — `TELEGRAM_SYS_ADMINS`, сейчас id Андрея 123456789):
- `/menu` — панель с инлайн-кнопками (статус / рестарт / логи / экран / compact / clear)
- `/ping` — живость, `/status` — подробный статус, `/screen` — дамп экрана tmux, `/logs` — лог демона, `/restart` — рестарт сессии с подтверждением.

Команды и callback-кнопки обрабатывает **демон** (не сессия), поэтому работают даже при мёртвой сессии.

---

## Что в Mac CLAUDE.md ПРОТУХЛО (предлагаю поправить)

- ❌ «`claude --channels plugin:telegram@claude-plugins-official` крутится в tmux claude5» → теперь `plugin:telegram@telegram-local`.
- ❌ «Telegram плагин `✘ failed` → `claude5-self reconnect plugin:telegram:telegram`» → к новому транспорту неприменимо. Теперь: проверить `systemctl --user status tg-gateway.service`, при нужде `restart`.
- ❌ «НЕ запускай `claude mcp list` (ломает плагин через 409)» → проблема 409 относилась к офиц. плагину; новый демон сам разруливает 409. Но всё равно нет смысла плодить второй поллер на токен.
- ⚠️ Source-тег входящих остался `plugin:telegram:telegram` (локальный плагин называется тоже «telegram») — по тегу А от официального не отличить, смотри по `ps` (`--channels plugin:telegram@telegram-local`).

---

## Гочи (на будущее)

- **Кеш команд в клиенте.** После cutover Telegram-клиент может показывать старый список команд (`/start /help /status` от офиц. плагина) несмотря на корректный `setMyCommands`. Лечится `deleteMyCommands`+`setMyCommands` по scope + переоткрытием чата.
- **GH007 при пуше.** Аккаунт `atomachinskiy` блокирует пуш с приватным gmail. Коммиты должны идти с `atomachinskiy@users.noreply.github.com` (в репо `user.email` уже выставлен на noreply).
- **Один поллер на токен.** Telegram держит ровно один `getUpdates` на токен. Никогда не поднимай второй процесс с боевым токеном (старый dev-флаговый launcher + новый = 409). Для тестов — отдельный бот-токен и `TELEGRAM_STATE_DIR=/tmp/...`.

---

Полная история cutover и причины решений — в `DESIGN.md` и в серверной памяти `project_tg_gateway_cutover.md`.
