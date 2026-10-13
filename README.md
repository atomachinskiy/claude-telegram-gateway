# tg-gateway — надёжный Telegram-канал для Claude Code

Транспорт Telegram вынесен в отдельный супервизируемый демон, а в сессии Claude работает только тонкий мост без сети. Поэтому канал не разваливается, как встроенный плагин: даже если сессия моргнёт, демон держит коннект и буферит входящие — ничего не теряется. Архитектура — в [DESIGN.md](DESIGN.md).

## Состав
- `gateway/` — демон: робастный long-poll (graduated backoff, 409-handler, drain), запись inbox, медиа, отправка outbox. Без зависимостей (голый fetch). Готовый бандл — `gateway/dist/gateway.js`.
- `bridge/` — тонкий MCP-плагин для `--channels`: тулы `reply`/`react`/`edit_message`/`download_attachment`/`ask`/`status` пишут в outbox и ждут ответ демона. Сети нет. Бандл — `bridge/dist/bridge.js`.
- `install-windows.ps1`, `install-mac.sh` — идемпотентные инсталлеры (pairing → супервизор → плагин-мост → launcher).
- `systemd/tg-gateway.service` — шаблон user-сервиса для Linux.

## Установка
Полный пошаговый runbook (в т.ч. пригодный для ИИ-ассистента) — в [AGENTS.md](AGENTS.md). Коротко:
- **Windows:** `powershell -ExecutionPolicy Bypass -File .\install-windows.ps1`
- **macOS:** `./install-mac.sh`
- **Linux:** см. AGENTS.md (systemd `--user`).

Нужны Node 18+ и токен бота от [@BotFather](https://t.me/BotFather). Нативный установщик Claude Code (`install.ps1` / `install.sh`) Node не ставит: на Windows `winget install OpenJS.NodeJS.LTS`, на Mac пакет с nodejs.org или архив в домашнюю папку. Сборка на стороне клиента не требуется — бандлы в `dist/` готовы.

## Управление с телефона
Команды обрабатывает сам демон, поэтому `/menu`, `/status`, `/ping` отвечают, даже когда сессия Claude закрыта. Отвечает только владельцу (`TELEGRAM_SYS_ADMINS`).

На компьютере (Windows, Mac) сессию запускает сам пользователь, поэтому `/restart`, `/model`, `/effort`, `/screen` работают только в серверном режиме, где сессия Claude живёт в tmux. Подробнее в [CHANGELOG.md](CHANGELOG.md).

## Форматы ответа
Мост отдаёт Claude инструмент `reply` с форматами `text`, `markdownv2` и `rich`. `rich` — обычный GitHub-markdown (таблицы, заголовки, списки) одним сообщением до 32 тыс. знаков.

## Несколько ботов / воркспейсов
Один бот = один демон = одна `TELEGRAM_STATE_DIR` = один токен. На Windows `install-windows.ps1` принимает `-StateDir` / `-TaskName` / `-LauncherName` — запусти его по разу на каждого бота. Плагин-мост и allowlist общие, ставятся один раз. Детали — в AGENTS.md (раздел Notes).

## Разработка
Исходники — `gateway/gateway.ts` и `bridge/server.ts`. После правок пересобери бандлы: `bash scripts/build.sh` (нужен bun), затем закоммить `dist/`.
