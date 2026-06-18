# tg-gateway

Надёжный Telegram-канал для Claude Code. Транспорт вынесен в supervised-демон, в сессии Клода только тонкий мост без сети. См. DESIGN.md.

## Состав
- `gateway/gateway.ts` — демон: робастный long-poll (graduated backoff, 409-handler, drain), inbox-writer, media, outbox-sender. Без зависимостей (голый fetch).
- `bridge/server.ts` — тонкий MCP-плагин для `--channels`: тулы reply/react/edit_message/download_attachment пишут в outbox и ждут ответ демона. Без сети.
- `systemd/tg-gateway.service` — user-сервис, Restart=always.

## Запуск демона
    cp systemd/tg-gateway.service ~/.config/systemd/user/
    systemctl --user daemon-reload && systemctl --user enable --now tg-gateway
    journalctl --user -u tg-gateway -f

## Cutover (боевой бот)
Telegram держит ОДИН getUpdates-поллер на токен. Порядок:
1. Остановить официальный плагин (он единственный поллер): в claude5-start убрать `--channels plugin:telegram@claude-plugins-official`.
2. Запустить демон (systemd, см. выше).
3. Подключить наш мост как `--channels` (локальный плагин), перезапустить claude5.
Откат: вернуть `--channels` на официальный, остановить демон.

## Тест (безопасно, без конфликта с боевым)
Нужен ОТДЕЛЬНЫЙ тестовый бот-токен от @BotFather. Прогон:
- `TELEGRAM_BOT_TOKEN=<test> TELEGRAM_STATE_DIR=/tmp/tg-test bun gateway/gateway.ts`
- написать тестовому боту -> проверить файл в /tmp/tg-test/inbox
- положить outbox/req-*.json с tool=reply -> проверить, что пришло в Telegram и появился outbox/res/<id>.json

## Открытый вопрос интеграции
Как именно Claude Code `--channels` загружает локальный плагин-мост (через локальный marketplace или путь) — финально проверяется на cutover. Inbox-формат и имена тулов 1-в-1 с официальным, так что харнес должен подхватить без изменений.
