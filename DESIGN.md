# tg-gateway — стабильный Telegram-канал для Claude Code

Дата: 2026-06-09 · Автор: server-claude5 (как CTO, по запросу Андрея) · Статус: в разработке
Развивает: PRD `Андрей (мета)/Roadmaps/Продукты/2026-05-26 — PRD — TG-плагин для Claude Code v0.1.md`

## 1. Проблема

Официальный плагин `claude-plugins-official/telegram` держит весь транспорт Telegram ВНУТРИ процесса Claude Code как MCP-сервер. Из этого вытекают все отвалы:

- При сетевой ошибке retry-loop делает максимум 8 попыток на 409 Conflict, потом тихо выходит из polling. Канал мёртв до ручного `/mcp`.
- bun-процесс плагина это дитя сессии Клода: умирает вместе с ним, при дрейфе MCP-линка, под нагрузкой. Сам не встаёт.
- Telegram держит ровно один getUpdates-поллер на токен и старую сессию ~30с после рестарта, короткий фиксированный backoff этого не покрывает.

Лечить retry внутри той же схемы значит лечить симптом. Чиним архитектуру.

## 2. Принцип

Разделить НАДЁЖНОСТЬ ТРАНСПОРТА и ИНТЕГРАЦИЮ с Claude Code. Транспорт выносим в отдельный, всегда живой, под systemd процесс. В сессии Клода остаётся только тонкий мост без сети.

## 3. Архитектура

```
Telegram Bot API
   |  long-poll getUpdates (робастный, ручной)            ^ sendMessage / sendPhoto / ...
   v                                                      |
+-------------------------- tg-gateway (демон, systemd Restart=always) -----------+
|  poll.ts  робастный long-poll: graduated backoff, 409-handler, drain, DNS-fb    |
|  inbox writer  входящие -> ~/.claude/channels/telegram-claude5/inbox/<f>.json   |
|  media downloader  фото/голос/док -> в ту же inbox-папку                         |
|  outbox watcher  читает outbox/req-*.json -> шлёт -> пишет outbox/res/<id>.json  |
+----------------------------------------------------------------------------------+
   ^ inbox (читает Claude Code через --channels)        ^ outbox/req  | outbox/res
   |                                                     |             v
+----------------- tg-bridge (тонкий MCP-плагин в сессии Клода) -------------------+
|  MCP-тулы reply / react / edit_message / download_attachment (те же схемы)       |
|  каждый тул: пишет req в outbox, ждёт res от демона, возвращает message_id        |
|  НИКАКОЙ сети, НИКАКИХ ретраев. Тривиальный = не валит канал.                     |
+----------------------------------------------------------------------------------+
```

### Компоненты

1. **tg-gateway** (Bun/TS, без grammy, на голом fetch для полного контроля над polling).
   - Единственный держатель токена и getUpdates. PID-lock.
   - Робастный long-poll: timeout 50с; на сетевой ошибке экспоненциальный backoff (1с..60с, без верхней границы по числу попыток, не сдаёмся НИКОГДА); на 409 растущие паузы 5с..55с с очисткой webhook; drain соединений перед reconnect.
   - `deleteWebhook(drop_pending_updates=false)` перед стартом polling.
   - Входящие пишет в inbox в формате, идентичном официальному плагину (drop-in).
   - Скачивает медиа (фото/голос/док/видео) в inbox-папку, кладёт `image_path`/`attachment_file_id`.
   - Watcher на `outbox/req-*.json`: исполняет (reply с чанкингом и MarkdownV2-fallback, react, edit), результат пишет в `outbox/res/<id>.json`.
   - systemd `--user` сервис, `Restart=always`, свой cgroup. Падение восстанавливается за ~1с.

2. **tg-bridge** (Bun/TS, MCP stdio, зависит только от @modelcontextprotocol/sdk).
   - Drop-in замена `--channels`-плагина: те же имена и схемы тулов.
   - Тул пишет запрос в `outbox/req-<uuid>.json`, поллит `outbox/res/<uuid>.json` (таймаут ~15с), возвращает результат. Сети нет.
   - Inbox не трогает: его пишет демон, читает Claude Code штатно.

## 4. Контракты (1-в-1 с официальным)

Inbox JSON: `{ chat_id, message_id, user, user_id, ts, text, attachment_file_id?, image_path?, reply_to? }`
Тулы: `reply(chat_id, text, format=text|markdownv2, files?, reply_to?)`, `react(chat_id, message_id, emoji)`, `edit_message(chat_id, message_id, text, format?)`, `download_attachment(file_id) -> path`.
Outbox req: `{ id, tool, args }`. Outbox res: `{ id, ok, result?, error? }`.

## 5. Почему это убивает все режимы отказа

- Падение плагина-ребёнка вместе с Клодом: демон независим, systemd поднимает за секунду.
- Дрейф MCP-линка: мост тривиален; даже если моргнул, демон держит коннект и буферит входящие в inbox (ничего не теряется), достаточно `/mcp` чтобы сессия снова увидела.
- 409 / сетевые блипы: обрабатываются в демоне, и даже его краш чинит systemd.
- Тяжёлая/вложенная работа Клода: отдельный процесс и cgroup, физически не влияет.

## 6. Деплой и cutover

- Демон ставится как `~/.config/systemd/user/tg-gateway.service` (Restart=always, WantedBy=default.target, токен из `~/.claude/secrets/telegram-bot-token`).
- В `claude5-start` плагин `--channels` меняется с официального на наш `tg-bridge`.
- Cutover: остановить официальный плагин (он единственный поллер) -> запустить демон -> перезапустить claude5 с мостом. Откат: вернуть `--channels` на официальный.
- Тестирование polling требует отдельного тестового бота ИЛИ окна, когда официальный плагин остановлен (один поллер на токен).

## 7. Фазы

- MVP (надёжность): демон (робастный polling + inbox + media + outbox sender) + мост (reply/react/edit/download). Канал не отваливается. ~3-4 дня.
- V1.1: тише пуши (disable_notification на промежуточных), batching фото, `/status`.
- V1.2: inline-кнопки approval (callback handler в демоне, prefix-routing).
- V2: DNS-fallback IP под Россию, webhook-режим для cloud, упаковка как продукт для клиентов.

## 8. Тесты

- Юнит: чанкинг по лимиту 4096 и по абзацам; MarkdownV2-escape и fallback на plain; backoff-расчёт.
- Интеграция (мок Bot API): inbox-формат, outbox req/res цикл.
- Live smoke: на тестовом боте полный путь входящее->inbox и outbox->отправка.

## 9. Как именно Claude Code получает входящие (выяснено из официального плагина)

КЛЮЧЕВОЕ: Claude Code НЕ следит за inbox-папкой. Канал работает так:
- MCP-сервер при handshake объявляет capability `experimental: { 'claude/channel': {} }` + `instructions`.
  Это говорит Claude Code «я канал».
- На КАЖДОЕ входящее сервер шлёт MCP-нотификацию `notifications/claude/channel` с
  `{ content: <text>, meta: { chat_id, message_id, user, user_id, ts, image_path?, attachment_*? } }`.
  Claude Code инжектит её в сессию как `<channel source="telegram" ...>content</channel>`.
- inbox-папка нужна ТОЛЬКО для бинарей вложений (фото/доки), на которые ссылается `image_path` / `download_attachment`.

Поэтому мост — НЕ только request-responder. Он:
1. объявляет `claude/channel` (низкоуровневый `Server`, не `McpServer`),
2. watcher'ом читает inbox-JSON, что пишет демон, и форвардит каждый как `notifications/claude/channel`
   (доставка с at-least-once: файл удаляется только после флаша в транспорт; сессия легла -> демон
   буферит в inbox -> мост дренит бэклог при реконнекте, ничего не теряется),
3. исполняет тулы через outbox.
Permission-relay (`claude/channel/permission`) НЕ объявляем: сессия идёт `defaultMode: bypassPermissions`,
промптов на подтверждение нет. Это V1.2, не MVP.

## 10. Hardening (production-grade, перенос паттернов Hermes)

Демон (`gateway.ts`):
- PID-lock (`gateway.lock`): один поллер на токен; чужой живой PID -> exit (защита от само-409).
- `uncaughtException`/`unhandledRejection` -> лог + releaseLock + exit(1) (никогда не умираем молча; systemd поднимет).
- Liveness-watchdog: если нет успешного getUpdates `STALE_MS=180s` -> exit(1) (лечит «жив, но не поллит» = Баг 2;
  bare-fetch уже иммунен к PTB-wedge, watchdog ловит остаток).
- Heartbeat/status (`gateway.status.json` + тул `status`): pid, version, uptime, lastPollOk, lastInbound,
  updatesSeen, conflicts, lastError. Для внешнего health-check и наблюдаемости.
- Notification mode: `disable_notification` на reply; промежуточные чанки длинного ответа тихие, пинг один.
- 401 -> exit; graceful SIGTERM (save offset, release lock).

## 11. Валидация (2026-06-09, мок MCP-клиент = эмуляция Claude Code over --channels)

`bridge/test-client.ts` спавнит мост по stdio и проверил живьём (тестовый бот, изолир. state):
1) tools/list -> 5 тулов (reply, react, download_attachment, status, edit_message) — OK
2) синтетический inbox-JSON -> мост отдал `notifications/claude/channel` с верными content+meta — OK
3) тул `status` -> вернул здоровье демона (v1.0.0, lastPollOk...) — OK
4) тул `react` -> outbox -> демон -> Telegram setMessageReaction -> res -> мост -> клиент = true — OK
Плюс ранее: реальные входящие `/start` и «проверка» -> inbox в формате офиц. плагина; реальный outbox reply
-> отправка с message_id; 409 поймал и восстановился. Полный контур подтверждён.
