#!/usr/bin/env bun
/**
 * tg-gateway — standalone, supervised Telegram transport for Claude Code.
 * Owns the Bot API connection (robust long-poll). Writes incoming to the inbox
 * (drop-in format), sends outgoing from the outbox. No Claude Code coupling.
 */
import { homedir } from "os";
import { join } from "path";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync, renameSync, statSync, copyFileSync } from "fs";
import { spawnSync } from "child_process"; // node builtin — works on both bun and node runtimes

const STATE_DIR = process.env.TELEGRAM_STATE_DIR ?? join(homedir(), ".claude", "channels", "tg-gateway");
const INBOX = join(STATE_DIR, "inbox");
const OUTBOX = join(STATE_DIR, "outbox");
const OUTBOX_RES = join(OUTBOX, "res");
const OFFSET_FILE = join(STATE_DIR, "gateway.offset");
const STATUS_FILE = join(STATE_DIR, "gateway.status.json");
const LOCK_FILE = join(STATE_DIR, "gateway.lock");
const CONFIG_ENV_FILE = process.env.TG_GATEWAY_ENV ?? join(STATE_DIR, "gateway.env");
// Client deployments keep config in a single `gateway.env` (written by `pair`),
// so the supervisor needn't carry a pile of env vars. Load it FIRST — before any
// const below reads process.env — but never override vars already set (prod sets
// them via systemd, so prod behaviour is unchanged).
(function loadEnvFile() {
  try {
    if (!existsSync(CONFIG_ENV_FILE)) return;
    for (const line of readFileSync(CONFIG_ENV_FILE, "utf8").split("\n")) {
      const s = line.trim();
      if (!s || s.startsWith("#") || !s.includes("=")) continue;
      const i = s.indexOf("=");
      const k = s.slice(0, i).trim();
      const v = s.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      if (k && process.env[k] === undefined) process.env[k] = v;
    }
  } catch {}
})();
const VERSION = "1.2.0";
const STALE_MS = 180_000; // no successful poll in 3 min => wedged; exit so the supervisor restarts fresh
// /sys + /menu control commands: who may run them, where the session lives, how to restart it.
const SYS_ADMINS = new Set((process.env.TELEGRAM_SYS_ADMINS ?? "").split(",").map(s => s.trim()).filter(Boolean));
// Chat allowlist: only these chats reach the session. Default = the admins' DMs.
// Anyone else gets one polite refusal per 6h and is logged, never injected.
// TELEGRAM_ALLOWED_CHATS="id1,id2" extends it; "*" opens the bot to everyone.
const ALLOWED_CHATS = new Set([
  ...(process.env.TELEGRAM_ALLOWED_CHATS ?? "").split(",").map(s => s.trim()).filter(Boolean),
  ...SYS_ADMINS,
]);
// A group is ONE chat_id for everyone in it, so a chat-level allow would hand the
// session to whoever gets invited later. Groups therefore need the sender to be known
// too: TELEGRAM_ALLOWED_GROUP_USERS="id1,id2" (admins are always in).
const ALLOWED_GROUP_USERS = new Set([
  ...(process.env.TELEGRAM_ALLOWED_GROUP_USERS ?? "").split(",").map(s => s.trim()).filter(Boolean),
  ...SYS_ADMINS,
]);
function isAllowedChat(chatId: string, userId: string, isGroup = false): boolean {
  if (ALLOWED_CHATS.has("*")) return true;
  if (isGroup) return ALLOWED_CHATS.has(chatId) && ALLOWED_GROUP_USERS.has(userId);
  return ALLOWED_CHATS.has(chatId) || SYS_ADMINS.has(userId);
}
// Forum topics: name cache (Telegram sends the title only in the forum_topic_created
// service message, never with ordinary messages) and the control-plane's current
// topic, so /sys answers land in the topic the command came from rather than General.
const topicNames = new Map<string, string>();  // "chat:thread" -> title
const sysThread = new Map<string, string>();   // chat_id -> thread awaiting a control-plane answer
const TMUX_SESSION = process.env.CLAUDE_TMUX ?? "claude";
// User-facing label for the session in control-panel text. Set TG_SESSION_LABEL
// (e.g. "ассистента") to rename it per bot.
const SESSION_LABEL = process.env.TG_SESSION_LABEL ?? "Claude";
const SYS_RESTART_CMD = process.env.SYS_RESTART_CMD ?? ""; // path to restart script; empty = restart disabled (safe default)
const BRIDGE_HEARTBEAT = join(STATE_DIR, "bridge.heartbeat");
// Instant transport-level acknowledgement: react to an inbound message so the user
// sees it landed, and keep a "typing…" action alive until we reply, so they see
// work is underway (mirrors the old official-plugin behavior).
const ACK_EMOJI = process.env.TELEGRAM_ACK_EMOJI ?? "👀";
const TYPING_MAX_MS = 8 * 60_000; // refresh "typing…" at most 8 min per chat, then give up
const typingChats = new Map<string, number>(); // "chat" or "chat:thread" -> ms work started; drives the typing indicator
// One key per conversation: in a forum every topic gets its own indicator, otherwise
// a reply in one topic would clear "typing…" in all of them.
const typingKey = (chatId: string, threadId?: string) => (threadId ? `${chatId}:${threadId}` : String(chatId));
// Content-aware reaction palette (our own variant — richer than a fixed 👀).
// First rule whose pattern matches the inbound text wins; otherwise ACK_EMOJI.
// Every emoji here is in Telegram's standard reaction whitelist (no variation selectors).
// NB: JS \b is ASCII-only and NEVER matches at Cyrillic letters — use explicit
// lookaround boundaries (?<![а-яёa-z]) / (?![а-яёa-z]) for short Russian words.
const REACTION_RULES: Array<[RegExp, string]> = [
  [/спасиб|(?<![а-яёa-z])спс(?![а-яёa-z])|благодар|мерси|🙏/i, "🙏"],
  [/(?<![а-яёa-z])ура(?![а-яёa-z])|поздрав|🎉|с днём|с днем|празд/i, "🎉"],
  [/ахах|хаха|ха-ха|(?<![а-яёa-z])лол(?![а-яёa-z])|ржу|смешно|угар|😂|🤣/i, "🤣"],
  [/вау|(?<![а-яёa-z])ого(?![а-яёa-z])|офиг|охрен|обалд|🤯|невероятн|жесть/i, "🤯"],
  [/огонь|огонёк|огонек|🔥|бомб|мощно|пушка|топчик/i, "🔥"],
  [/идеаль|в точку|(?<![а-яёa-z])точно(?![а-яёa-z])|💯|безупреч|чётко|четко/i, "💯"],
  [/принял|(?<![а-яёa-z])понял|так точно|🫡/i, "🫡"],
  [/молодец|красав|респект|🤝|жму руку|уважение/i, "🤝"],
  [/супер|класс|отличн|кайф|шикар|обожаю|люблю|круто|(?<![а-яёa-z])топ(?![а-яёa-z])|❤|🥰|😍/i, "❤"],
  [/(^|[\s,])(ок|окей|окй|давай|го|поехали|погнали|согласен|согл)([\s,.!?]|$)/i, "👍"],
  [/блин|(?<![а-яёa-z])ч[её]рт(?![а-яёa-z])|не работа|сломал|упал|ошибк|проблем|(?<![а-яёa-z])баг(?![а-яёa-z])|косяк|😢|😭|печаль/i, "😢"],
];
function pickReaction(text: string): string {
  const t = (text ?? "").trim();
  if (!t) return ACK_EMOJI; // voice / photo / no-text -> default "seen"
  for (const [re, emo] of REACTION_RULES) if (re.test(t)) return emo;
  return ACK_EMOJI;
}
const LOG = (m: string) => process.stderr.write(`[tg-gateway ${new Date().toISOString()}] ${m}\n`);

for (const d of [STATE_DIR, INBOX, OUTBOX, OUTBOX_RES]) mkdirSync(d, { recursive: true });

// ---------- single-instance lock (Telegram allows one poller per token) ----------
function acquireLock() {
  try {
    if (existsSync(LOCK_FILE)) {
      const pid = Number(readFileSync(LOCK_FILE, "utf8").trim());
      if (pid && pid !== process.pid) {
        try { process.kill(pid, 0); LOG(`FATAL: another tg-gateway already running (pid ${pid}). exiting.`); process.exit(1); }
        catch { LOG(`stale lock from dead pid ${pid}, taking over`); }
      }
    }
  } catch {}
  try { writeFileSync(LOCK_FILE, String(process.pid)); } catch {}
}
function releaseLock() {
  try { if (existsSync(LOCK_FILE) && Number(readFileSync(LOCK_FILE, "utf8").trim()) === process.pid) unlinkSync(LOCK_FILE); } catch {}
}

// ---------- status / heartbeat (observability + watchdog input) ----------
const status: any = {
  pid: process.pid, version: VERSION, started: new Date().toISOString(),
  lastPollOk: null, lastInbound: null, lastError: null, updatesSeen: 0, conflicts: 0,
};
function writeStatus() {
  try { const t = STATUS_FILE + ".tmp"; writeFileSync(t, JSON.stringify(status, null, 2)); renameSync(t, STATUS_FILE); } catch {}
}

function loadToken(): string {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN.trim();
  const f = join(homedir(), ".claude", "secrets", "telegram-bot-token");
  if (existsSync(f)) return readFileSync(f, "utf8").trim();
  LOG("FATAL: no TELEGRAM_BOT_TOKEN and no secrets/telegram-bot-token"); process.exit(1);
}
const TOKEN = loadToken();
// TELEGRAM_API_ROOT lets a box point at a self-hosted local Bot API server
// (http://127.0.0.1:8081) for large-file support; defaults to Telegram cloud.
const API_ROOT = (process.env.TELEGRAM_API_ROOT || "https://api.telegram.org").replace(/\/+$/, "");
const API = `${API_ROOT}/bot${TOKEN}`;
const FILE_API = `${API_ROOT}/file/bot${TOKEN}`;

class TgError extends Error { constructor(public status: number, msg: string) { super(msg); } }

async function call(method: string, body?: any, timeoutMs = 65000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${API}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal,
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) throw new TgError(r.status, j.description || `${method} http ${r.status}`);
    return j.result;
  } finally { clearTimeout(t); }
}

// ---------- inbox (drop-in format) ----------
function writeInbox(name: string, obj: any, dir: string = INBOX) {
  const tmp = join(dir, `.${name}.tmp`);
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, join(dir, name));
}
// Чаты, где темы обслуживает отдельный рантайм, а не общая сессия. Их сообщения
// уходят в свой инбокс: иначе их подхватит мост и вольёт в общую сессию, ради
// разделения которой всё и затевалось. Личка и General этих чатов идут как раньше.
const TOPIC_RUNTIME_CHATS = new Set(
  (process.env.TELEGRAM_TOPIC_RUNTIME_CHATS ?? "").split(",").map(s => s.trim()).filter(Boolean),
);
const TOPICS_INBOX = join(STATE_DIR, "topics", "inbox");
function inboxDirFor(chatId: string, threadId: string): string {
  if (threadId && TOPIC_RUNTIME_CHATS.has(chatId)) {
    mkdirSync(TOPICS_INBOX, { recursive: true });
    return TOPICS_INBOX;
  }
  return INBOX;
}
async function downloadFile(fileId: string, suggestExt?: string): Promise<string> {
  const f = await call("getFile", { file_id: fileId });
  const path = f.file_path as string;
  const ext = suggestExt ?? (path.includes(".") ? path.split(".").pop() : "bin");
  const dest = join(INBOX, `${Date.now()}-${fileId}.${ext}`);
  if (path.startsWith("/")) {
    // Local Bot API server (--local): getFile returns an absolute on-disk path
    // instead of a relative one — copy it directly, no HTTP fetch, no size cap.
    copyFileSync(path, dest);
  } else {
    const resp = await fetch(`${FILE_API}/${path}`);
    writeFileSync(dest, Buffer.from(await resp.arrayBuffer()));
  }
  return dest;
}

// Voice STT in the transport: transcribe via Groq Whisper so the transcript
// arrives INSIDE the channel message — the session skips download+transcribe
// (~10-20s faster replies to voice). attachment_file_id stays for re-listening.
const GROQ_TOKEN_FILE = join(homedir(), ".claude", "secrets", "groq-token");
async function transcribeVoice(fileId: string): Promise<string | null> {
  try {
    if (!existsSync(GROQ_TOKEN_FILE)) return null;
    const token = readFileSync(GROQ_TOKEN_FILE, "utf8").trim();
    const path = await downloadFile(fileId, "ogg"); // Groq rejects .oga — save as .ogg
    const fd = new FormData();
    fd.append("model", "whisper-large-v3-turbo");
    fd.append("language", "ru");
    fd.append("file", new Blob([readFileSync(path)], { type: "audio/ogg" }), "voice.ogg");
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 30_000);
    try {
      const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST", headers: { authorization: `Bearer ${token}` }, body: fd, signal: ctrl.signal,
      });
      const j: any = await r.json().catch(() => ({}));
      if (!r.ok) { LOG(`groq stt http ${r.status}: ${JSON.stringify(j).slice(0, 200)}`); return null; }
      return (j.text ?? "").trim() || null;
    } finally { clearTimeout(t); }
  } catch (e: any) { LOG(`voice stt: ${e.message}`); return null; }
}

// Visible text of the inline button whose callback_data matches `data`.
function buttonLabel(msg: any, data: string): string | null {
  const rows = msg?.reply_markup?.inline_keyboard;
  if (!Array.isArray(rows)) return null;
  for (const row of rows) for (const b of row) if (b?.callback_data === data) { const t = String(b.text ?? "").trim(); return t || null; }
  return null;
}

// A user tapped an inline button. Stop the spinner immediately, then forward
// the press as a channel event so the session can react (edit the message,
// reply, etc). callback_data is trusted: it came from Telegram, not user-typed.
async function handleCallback(cq: any) {
  const data = cq.data ?? "";
  // A tap that answers a pending `ask` resolves the held tool result; it is NOT
  // delivered to the session as a generic event.
  const askMatch = /^ask:([^:]+):(\d+)$/.exec(data);
  if (askMatch && pendingAsks.has(askMatch[1])) {
    try { await call("answerCallbackQuery", { callback_query_id: cq.id }); } catch {}
    resolveAsk(askMatch[1], Number(askMatch[2]), "answered");
    return;
  }
  // Control-panel taps are handled by the daemon (auth-gated), not forwarded to the session.
  if (data.startsWith("sys:")) {
    try { await call("answerCallbackQuery", { callback_query_id: cq.id }); } catch {}
    if (!SYS_ADMINS.has(String(cq.from?.id ?? ""))) return;
    LOG(`sys tap "${data}"`);
    const chat_id = String(cq.message?.chat?.id ?? cq.from?.id ?? "");
    const messageId = cq.message?.message_id;
    const rest = data.slice(4);
    if (rest === "status") return void sysStatus(chat_id);
    if (rest === "logs") return void sysLogs(chat_id);
    if (rest === "screen") return void sysScreen(chat_id);
    if (rest === "restart") return void sysRestartPrompt(chat_id);
    if (rest === "restart:yes") return void doRestart(chat_id, messageId);
    if (rest === "restart:no") { if (messageId) call("editMessageText", { chat_id, message_id: messageId, text: "Отменено." }).catch(() => {}); return; }
    if (rest.startsWith("cc:")) return void sysSendKeys(chat_id, rest.slice(3));
    if (rest === "models") return void sysModels(chat_id);
    if (rest === "mcp") return void sysMcp(chat_id);
    if (rest.startsWith("model:")) return void sysSetModel(chat_id, rest.slice(6), messageId);
    if (rest === "efforts") return void sysEfforts(chat_id);
    if (rest.startsWith("effort:")) return void sysSetEffort(chat_id, rest.slice(7), messageId);
    if (rest.startsWith("tui:")) return void sysTuiKey(chat_id, rest.slice(4), messageId);
    return;
  }
  const from = cq.from ?? {};
  const msg = cq.message ?? {};
  const cbIsGroup = msg.chat?.type === "group" || msg.chat?.type === "supergroup";
  if (!isAllowedChat(String(msg.chat?.id ?? from.id ?? ""), String(from.id ?? ""), cbIsGroup)) {
    try { await call("answerCallbackQuery", { callback_query_id: cq.id }); } catch {}
    LOG(`DROP callback from non-allowed ${from.id}`); return;
  }
  // Surface the tap to the session as a REAL inbound message. CC's channel layer
  // silently drops is_callback notifications and dedups on the bot's own
  // message_id (the button message it already sent), so a raw callback never
  // reached the agent — which is why taps "did nothing". Instead inject the
  // button's LABEL as FRESH user text (synthetic id): it surfaces reliably and
  // reads naturally in the transcript. Plus instant toast + strip the keyboard
  // so it can't be re-tapped and the choice is visibly consumed.
  const label = buttonLabel(msg, data) || data;
  const chatId = String(msg.chat?.id ?? from.id);
  try { await call("answerCallbackQuery", { callback_query_id: cq.id, text: `✓ ${label}`.slice(0, 190) }); } catch (e: any) { LOG(`answerCallbackQuery: ${e.message}`); }
  if (msg.message_id != null) { try { await call("editMessageReplyMarkup", { chat_id: chatId, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } }); } catch {} }
  const base: any = {
    chat_id: chatId,
    message_id: String(Date.now()),
    user: from.username ?? `${from.first_name ?? "user"}`,
    user_id: String(from.id ?? ""),
    ts: new Date().toISOString(),
    text: label,
    callback_data: data,
  };
  // Keep the tap in its topic: the button message carries the thread it was posted in.
  let cbThread = "";
  if (msg.chat?.is_forum && msg.is_topic_message && msg.message_thread_id != null) {
    cbThread = String(msg.message_thread_id);
    base.message_thread_id = cbThread;
    const title = topicNames.get(`${chatId}:${msg.message_thread_id}`);
    if (title) base.topic = title;
  }
  // Нажатие в теме должно вернуться той же сессии, что задала вопрос, а не общей.
  writeInbox(`${Date.now()}-cbm-${cq.id}.json`, base, inboxDirFor(chatId, cbThread));
  LOG(`inbox <- button-tap chat ${chatId} data="${data}" label="${label}"`);
}

async function handleUpdate(u: any) {
  if (u.callback_query) return handleCallback(u.callback_query);
  const msg = u.message ?? u.edited_message;
  if (!msg) return;
  const from = msg.from ?? {};
  // Allowlist gate: unknown chats never reach the session (and never see the control
  // plane). SILENT drop — no reply at all, so probers can't even confirm the bot is
  // alive (owner's call; Telegram has no server-side DM allowlist, BotFather can't do this).
  const gateChat = String(msg.chat.id), gateUser = String(from.id ?? "");
  const isGroup = msg.chat?.type === "group" || msg.chat?.type === "supergroup";
  // A forum topic is message_thread_id. Guard on is_forum + is_topic_message: in an
  // ordinary group message_thread_id also shows up on replies, and that is not a topic.
  const isForum = msg.chat?.is_forum === true;
  const threadId = isForum && msg.is_topic_message && msg.message_thread_id != null
    ? String(msg.message_thread_id) : "";
  const tKey = typingKey(gateChat, threadId);

  // Topic titles arrive only in service messages, so remember them as they pass by.
  if (msg.forum_topic_created?.name) topicNames.set(`${gateChat}:${msg.message_thread_id}`, msg.forum_topic_created.name);
  if (msg.forum_topic_edited?.name) topicNames.set(`${gateChat}:${msg.message_thread_id}`, msg.forum_topic_edited.name);
  // Service messages carry no user text — recording the title above is all we need.
  if (msg.forum_topic_created || msg.forum_topic_edited || msg.forum_topic_closed
      || msg.forum_topic_reopened || msg.new_chat_members || msg.left_chat_member) return;

  if (!isAllowedChat(gateChat, gateUser, isGroup)) {
    LOG(`DROP non-allowed chat ${gateChat} user ${gateUser} (@${from.username ?? "?"}): ${(msg.text ?? "[media]").slice(0, 80)}`);
    return;
  }
  // Control commands are handled by the daemon directly (work even if the session is dead) and never forwarded.
  // In a group Telegram delivers them as "/status@botname" — strip the suffix or nothing matches.
  const text0 = (msg.text ?? "").trim().replace(/^(\/[a-z_]+)@[A-Za-z0-9_]+/i, "$1");
  if (/^\/(sys|menu|ping|status|restart|screen|logs|model|models|effort|mcp)\b/i.test(text0)) {
    if (!SYS_ADMINS.has(String(from.id ?? ""))) { await call("sendMessage", { chat_id: gateChat, ...(threadId ? { message_thread_id: Number(threadId) } : {}), text: "⛔ Команды управления доступны только владельцу." }).catch(() => {}); return; }
    if (threadId) sysThread.set(gateChat, threadId); else sysThread.delete(gateChat);
    return void handleSysCommand(gateChat, text0)
      .catch((e: any) => LOG(`sys cmd error: ${e.message}`))
      .finally(() => sysThread.delete(gateChat));
  }
  // Instant ack BEFORE media download/STT: react (content-aware) + start "typing…".
  call("setMessageReaction", { chat_id: gateChat, message_id: Number(msg.message_id), reaction: [{ type: "emoji", emoji: pickReaction(msg.text ?? msg.caption ?? "") }] }).catch(() => {});
  call("sendChatAction", { chat_id: gateChat, ...(threadId ? { message_thread_id: Number(threadId) } : {}), action: "typing" }).catch(() => {});
  typingChats.set(tKey, Date.now());
  const base: any = {
    chat_id: gateChat,
    message_id: String(msg.message_id),
    user: from.username ?? `${from.first_name ?? "user"}`,
    user_id: String(from.id ?? msg.chat.id),
    ts: new Date((msg.date ?? Date.now() / 1000) * 1000).toISOString(),
  };
  if (threadId) {
    base.message_thread_id = threadId;
    const title = topicNames.get(`${gateChat}:${threadId}`);
    if (title) base.topic = title;
  }
  if (msg.reply_to_message) base.reply_to_message_id = String(msg.reply_to_message.message_id);
  try {
    if (msg.photo) {
      const best = msg.photo[msg.photo.length - 1];
      base.text = msg.caption ?? "";
      base.image_path = await downloadFile(best.file_id, "jpg");
    } else if (msg.voice) {
      base.text = msg.caption ?? ""; base.attachment_file_id = msg.voice.file_id;
      base.attachment_kind = "voice"; base.attachment_mime = msg.voice.mime_type; base.attachment_size = msg.voice.file_size;
      const stt = await transcribeVoice(msg.voice.file_id);
      if (stt) { base.text = `[голосовое, расшифровано в транспорте] ${stt}`; base.voice_transcribed = true; }
    } else if (msg.audio) {
      base.text = msg.caption ?? ""; base.attachment_file_id = msg.audio.file_id; base.attachment_kind = "audio";
      base.attachment_mime = msg.audio.mime_type; base.attachment_size = msg.audio.file_size;
    } else if (msg.document) {
      base.text = msg.caption ?? ""; base.attachment_file_id = msg.document.file_id; base.attachment_kind = "document";
      base.attachment_mime = msg.document.mime_type; base.attachment_size = msg.document.file_size;
    } else if (msg.video) {
      base.text = msg.caption ?? ""; base.attachment_file_id = msg.video.file_id; base.attachment_kind = "video";
      base.attachment_mime = msg.video.mime_type; base.attachment_size = msg.video.file_size;
    } else if (msg.text) {
      base.text = msg.text;
    } else {
      base.text = msg.caption ?? "[unsupported message type]";
    }
  } catch (e: any) { LOG(`media handling error: ${e.message}`); base.text = base.text ?? "[media download failed]"; }
  // Telegram Bot API caps getFile downloads at 20 MB. Bigger audio/doc/video
  // can't be fetched — tell the sender instead of leaving a silent reaction.
  const TG_DL_LIMIT = Number(process.env.TELEGRAM_DL_LIMIT_MB || 20) * 1024 * 1024;
  if (base.attachment_kind && !base.image_path && !base.voice_transcribed
      && typeof base.attachment_size === "number" && base.attachment_size > TG_DL_LIMIT) {
    const mb = Math.round(base.attachment_size / 1048576);
    sendReply({ chat_id: base.chat_id, text: `⚠️ Файл слишком большой (${mb} МБ). Как бот я могу забирать из Telegram только файлы до 20 МБ. Пришли запись голосовым сообщением (оно сжато и обычно влезает), ссылкой на файл, или сожми/разрежь его, тогда обработаю.`, reply_to: base.message_id }).catch(() => {});
    base.text = `${base.text ? base.text + " " : ""}[Вложение "${base.attachment_kind}" ${mb} МБ НЕ скачано: превышен лимит Telegram Bot API 20 МБ. Пользователю уже отправлено уведомление с просьбой прислать голосовым/ссылкой/сжать. Не пытайся скачивать это вложение.]`;
    delete base.attachment_file_id;
    LOG(`oversized ${base.attachment_kind} ${mb}MB from chat ${base.chat_id}: user notified`);
  }
  const dir = inboxDirFor(base.chat_id, threadId);
  writeInbox(`${Date.now()}-${msg.message_id}.json`, base, dir);
  LOG(`inbox${dir === INBOX ? "" : "(тема)"} <- chat ${base.chat_id}${threadId ? ` тема ${threadId}` : ""} msg ${base.message_id} ${base.image_path ? "[photo]" : base.attachment_kind ? `[${base.attachment_kind}]${base.voice_transcribed ? "+stt" : ""}` : ""}`);
  // If the brain can't answer right now the sender would otherwise get total
  // silence. Tell them immediately — the inbox entry above is still buffered and
  // gets answered once the session recovers.
  // Темы обслуживает свой рантайм, здоровье общей сессии их не касается —
  // иначе человек в теме получит предупреждение о чужой поломке.
  const down = dir === INBOX ? brainDownNow() : null;
  if (down) {
    const t = down === "auth"
      ? "⚠️ Получил, но Claude сейчас разлогинен (API 401) и не обрабатывает сообщения. Нужен /login в терминале или /restart. Отвечу, как починю."
      : "⚠️ Получил, но сессия Claude сейчас не на связи. Жми /restart. Сообщение буферизуется и доедет.";
    sendReply({ chat_id: base.chat_id, text: t, reply_to: base.message_id }).catch(() => {});
    LOG(`brain-down ack sent to chat ${base.chat_id} (${down})`);
  }
}

// ---------- outgoing (chunk + markdownv2 fallback) ----------
function chunk(text: string, limit = 4000): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = []; let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit); if (cut < limit * 0.6) cut = limit;
    out.push(rest.slice(0, cut)); rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) out.push(rest); return out;
}
// Accept buttons as a single row [{text,data}] or rows [[{text,data}],[...]].
// Each button: {text, data} -> callback button, or {text, url} -> link button.
function normalizeButtons(buttons: any): any {
  if (!Array.isArray(buttons) || buttons.length === 0) return undefined;
  const rows = Array.isArray(buttons[0]) ? buttons : [buttons];
  const inline_keyboard = rows.map((row: any[]) => row.map((b: any) =>
    b.url ? { text: String(b.text), url: String(b.url) }
          : { text: String(b.text), callback_data: String(b.data ?? b.text).slice(0, 64) }));
  return { inline_keyboard };
}

// On a MarkdownV2 parse failure we resend as plain text. One missed escape (e.g.
// a bare `=`) makes Telegram reject the WHOLE message, so the fallback must read
// cleanly. Two jobs:
//  1) drop UNescaped formatting markers (* _ ~ ` |) — otherwise bold/italic show
//     as raw asterisks/underscores to the user. An escaped \* is a literal the
//     user wanted: the backslash-pair is preserved here, then unescaped in step 2.
//  2) strip the backslash before every reserved char so no \. \- \= leak through.
function unescapeMd(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) { out += c + s[i + 1]; i++; continue; } // keep \X pair intact
    if (c === "*" || c === "_" || c === "~" || c === "`" || c === "|") continue;  // unescaped marker → drop
    out += c;
  }
  return out.replace(/\\([_*\[\]()~`>#+\-=|{}.!])/g, "$1");
}

// ---------- Bot API 10.1 Rich Messages ----------
// format:"rich" = the agent hands over plain GitHub-flavoured markdown (NO MarkdownV2
// escaping) and Telegram renders tables, headings, lists, quotes and <details> natively
// via sendRichMessage (cap 32 768 chars: one message instead of 4 096-char chunks).
// Policy, same as Hermes: rich only where MarkdownV2 degrades (tables, structured
// reports); ordinary replies stay MarkdownV2 so font/spacing don't jump between messages.
// Any rejection falls back to a plain-text send so the message is never lost; a server
// without the method (404) latches rich off until restart instead of failing every send.
const RICH_MAX_CHARS = 32768;
let richDisabled = false;
// Telegram's rich renderer collapses a blank line between paragraphs into a plain
// line break, so a prose reply arrives as one wall of text. A paragraph holding a
// single U+2800 (braille blank) survives as an empty-looking line and restores the
// air. Verified in the client 11.09.2026; headings, rules and quotes bring their own
// spacing, so blocks that already breathe are left alone.
const RICH_SPACER = "\u2800";
const RICH_BREATHES = /^(?:#{1,6}\s|>|\||```|~~~|(?:-{3,}|\*{3,}|_{3,})\s*$)/;
const RICH_LIST_ITEM = /^\s{0,3}(?:[-*+]\s|\d+[.)]\s)/;
function richSpacing(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMark = line.match(/^\s{0,3}(```+|~~~+)/);
    if (fenceMark) fence = fence && line.trim().startsWith(fence) ? null : (fence ?? fenceMark[1]);
    out.push(line);
    if (fence || line.trim() !== "") continue;
    // a blank line outside code: decide whether this gap needs a visible spacer
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === "") j++;       // collapse runs of blanks
    if (j >= lines.length) { for (let x = i + 1; x < j; x++) out.push(lines[x]); break; }  // trailing blanks: keep, nothing to space
    const next = lines[j];
    let k = out.length - 2;
    while (k >= 0 && out[k].trim() === "") k--;
    const prev = k >= 0 ? out[k] : "";
    const bothList = RICH_LIST_ITEM.test(prev) && RICH_LIST_ITEM.test(next);
    if (!bothList && !RICH_BREATHES.test(prev.trim()) && !RICH_BREATHES.test(next.trim())) {
      out.push(RICH_SPACER, "");
    }
    for (let x = i + 1; x < j; x++) out.push(lines[x]);            // keep the original blanks
    i = j - 1;
  }
  return out.join("\n");
}
function richPayload(text: string) { return { markdown: richSpacing(text) }; }
function isRichCapabilityError(e: any): boolean {
  return e?.status === 404 || /method not found|unknown method|not implemented/i.test(String(e?.message ?? ""));
}
// Last-resort plain rendering of GFM: strip heading/emphasis markers, flatten table rows.
function richToPlain(md: string): string {
  return md
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/(\*\*|__)([^\n]*?)\1/g, "$2")
    .replace(/^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/gm, "")
    .replace(/^\s*\|(.+)\|\s*$/gm, (_m, row: string) => row.split("|").map((c) => c.trim()).filter(Boolean).join(" · "))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
async function trySendRich(args: any, reply_markup: any): Promise<{ message_ids: number[] } | null> {
  const { chat_id, text, reply_to, disable_notification } = args;
  if (richDisabled || !text || text.length > RICH_MAX_CHARS) return null;
  const body: any = { chat_id, rich_message: richPayload(text) };
  if (args.message_thread_id) body.message_thread_id = Number(args.message_thread_id);
  if (disable_notification) body.disable_notification = true;
  if (reply_markup) body.reply_markup = reply_markup;
  if (reply_to) body.reply_parameters = { message_id: Number(reply_to) }; // reply_to_message_id is silently ignored by sendRichMessage
  try {
    const res = await call("sendRichMessage", body);
    return { message_ids: [res.message_id] };
  } catch (e: any) {
    if (isRichCapabilityError(e)) { richDisabled = true; LOG(`rich: server has no sendRichMessage (${e.message}) — rich off until restart`); }
    else LOG(`rich: sendRichMessage rejected (${e.message}) — plain fallback`);
    return null;
  }
}

async function sendReply(args: any): Promise<any> {
  const { chat_id, text, format, reply_to, files, disable_notification } = args;
  // Forum topic to answer into. The session passes it back from the inbound message;
  // control-plane answers fall back to the topic the command was typed in, so /sys
  // does not reply into General from a topic.
  const thread = args.message_thread_id ?? sysThread.get(String(chat_id)) ?? "";
  const threadArg = thread ? { message_thread_id: Number(thread) } : {};
  typingChats.delete(typingKey(String(chat_id), thread ? String(thread) : undefined)); // reply going out → stop "typing…" for this topic
  const parse_mode = format === "markdownv2" ? "MarkdownV2" : undefined;
  const reply_markup = normalizeButtons(args.buttons);
  if (format === "rich") {
    // Captions can't be rich: attachments go first, bare, then the rich text as its own message.
    const pre: number[] = [];
    if (files && files.length) {
      const f = await sendReply({ chat_id, files, text: "", disable_notification: true, message_thread_id: args.message_thread_id });
      pre.push(...(f.message_ids ?? []));
    }
    const rich = await trySendRich({ ...args, files: undefined }, reply_markup);
    if (rich) return { message_ids: [...pre, ...rich.message_ids] };
    const plain = await sendReply({ ...args, files: undefined, format: "text", text: richToPlain(text ?? "") });
    return { message_ids: [...pre, ...(plain.message_ids ?? [])] };
  }
  const ids: number[] = [];
  if (files && files.length) {
    // Telegram caps captions at 1024 chars — overflow goes out as a follow-up
    // message (otherwise the API rejects and the whole reply is silently lost).
    const CAPTION_LIMIT = 1024;
    let caption = text ?? "", rest = "";
    if (caption.length > CAPTION_LIMIT) {
      let cut = caption.lastIndexOf("\n", CAPTION_LIMIT);
      if (cut < CAPTION_LIMIT * 0.5) cut = CAPTION_LIMIT;
      rest = caption.slice(cut).replace(/^\n/, ""); caption = caption.slice(0, cut);
    }
    for (let fi = 0; fi < files.length; fi++) {
      const p = files[fi];
      const blob = new Blob([readFileSync(p)]);
      const name = p.split("/").pop() ?? "file";
      const isPhoto = /\.(jpe?g|png|webp)$/i.test(name); // images as photos (inline preview)
      const lastFile = fi === files.length - 1;
      const attempt = async (method: string, field: string, cap: string, pm?: string) => {
        const fd = new FormData();
        fd.append("chat_id", String(chat_id));
        if (thread) fd.append("message_thread_id", String(thread));
        fd.append("caption", cap);
        if (pm) fd.append("parse_mode", pm);
        if (disable_notification) fd.append("disable_notification", "true");
        if (reply_markup && lastFile && !rest) fd.append("reply_markup", JSON.stringify(reply_markup));
        fd.append(field, blob, name);
        const r = await fetch(`${API}/${method}`, { method: "POST", body: fd });
        return r.json() as Promise<any>;
      };
      const cap = fi === 0 ? caption : ""; // caption only on the first file
      // Ladder: native method + markdown -> plain unescaped -> document as last resort for photos.
      let j = await attempt(isPhoto ? "sendPhoto" : "sendDocument", isPhoto ? "photo" : "document", cap, parse_mode);
      if (!j.ok && parse_mode) j = await attempt(isPhoto ? "sendPhoto" : "sendDocument", isPhoto ? "photo" : "document", unescapeMd(cap));
      if (!j.ok && isPhoto) j = await attempt("sendDocument", "document", unescapeMd(cap));
      if (j.ok) ids.push(j.result.message_id);
      else LOG(`send file failed (${name}): ${j.description}`);
    }
    if (rest) {
      const tail = await sendReply({ chat_id, text: rest, format, disable_notification, buttons: args.buttons, message_thread_id: thread || undefined });
      ids.push(...(tail.message_ids ?? []));
    }
    return { message_ids: ids };
  }
  const parts = chunk(text ?? "");
  for (let i = 0; i < parts.length; i++) {
    // Notification mode: silence every chunk but the last, so a long multi-part
    // reply pings the user only once (or never, if disable_notification is set).
    const quiet = disable_notification || i < parts.length - 1;
    const last = i === parts.length - 1;
    const body: any = { chat_id, text: parts[i], ...threadArg };
    if (parse_mode) body.parse_mode = parse_mode;
    if (quiet) body.disable_notification = true;
    if (reply_markup && last) body.reply_markup = reply_markup; // buttons go on the final chunk
    if (reply_to && i === 0) body.reply_to_message_id = reply_to;
    try {
      const res = await call("sendMessage", body); ids.push(res.message_id);
    } catch (e: any) {
      if (parse_mode) { // fallback to plain text on parse error — strip the now-pointless md escapes
        const res = await call("sendMessage", { chat_id, text: unescapeMd(parts[i]), ...threadArg, ...(quiet ? { disable_notification: true } : {}), ...(reply_markup && last ? { reply_markup } : {}), ...(reply_to && i === 0 ? { reply_to_message_id: reply_to } : {}) });
        ids.push(res.message_id);
      } else throw e;
    }
  }
  return { message_ids: ids };
}
async function execTool(tool: string, args: any): Promise<any> {
  switch (tool) {
    case "reply": return sendReply(args);
    case "react": return call("setMessageReaction", { chat_id: args.chat_id, message_id: Number(args.message_id), reaction: [{ type: "emoji", emoji: args.emoji }] });
    case "edit_message": {
      const body: any = { chat_id: args.chat_id, message_id: Number(args.message_id), text: args.text };
      if (args.format === "markdownv2") body.parse_mode = "MarkdownV2";
      // buttons present -> set them; absent -> editMessageText clears the keyboard (drop buttons after a tap)
      const rm = normalizeButtons(args.buttons);
      if (rm) body.reply_markup = rm;
      if (args.format === "rich" && !richDisabled) {
        const rb: any = { chat_id: args.chat_id, message_id: Number(args.message_id), rich_message: richPayload(args.text) };
        if (rm) rb.reply_markup = rm;
        try { return await call("editMessageText", rb); }
        catch (e: any) {
          if (isRichCapabilityError(e)) richDisabled = true;
          if (/not modified/i.test(String(e.message))) return true;
          LOG(`rich: edit rejected (${e.message}) — plain edit`);
          body.text = richToPlain(args.text);
        }
      }
      try { return await call("editMessageText", body); }
      catch (e: any) {
        if (!body.parse_mode) throw e; // plain edit already; nothing to fall back to
        const { parse_mode, ...plain } = body; plain.text = unescapeMd(args.text);
        return call("editMessageText", plain);
      }
    }
    case "download_attachment": return { path: await downloadFile(args.file_id) };
    case "status": return { ...status, now: new Date().toISOString() };
    default: throw new Error(`unknown tool ${tool}`);
  }
}

// ---------- interactive ask (AskUserQuestion rendered as buttons) ----------
// The agent calls the `ask` tool; we send the question as inline buttons and
// hold the response open until the user taps a choice (or times out). Unlike a
// normal tool, the outbox result is written by the callback handler, not inline,
// so the outbox pump is never blocked while a human decides.
const ASK_TIMEOUT_MS = 600_000; // 10 min for a human to tap
const pendingAsks = new Map<string, { chat_id: string; options: string[]; messageId: number; timer: any }>();

function writeRes(res: any) {
  const rt = join(OUTBOX_RES, `.${res.id}.tmp`);
  writeFileSync(rt, JSON.stringify(res)); renameSync(rt, join(OUTBOX_RES, `${res.id}.json`));
}

async function startAsk(reqId: string, args: any) {
  const chat_id = String(args.chat_id ?? "");
  const question = String(args.question ?? "");
  const options = (Array.isArray(args.options) ? args.options : []).map(String).slice(0, 20);
  if (!chat_id || options.length === 0) { writeRes({ id: reqId, ok: false, error: "ask needs chat_id and non-empty options" }); return; }
  const buttons = options.map((o, i) => [{ text: o, data: `ask:${reqId}:${i}` }]);
  const sent = await sendReply({ chat_id, text: question, format: args.format, buttons, message_thread_id: args.message_thread_id });
  const messageId = sent.message_ids[sent.message_ids.length - 1];
  const timer = setTimeout(() => resolveAsk(reqId, -1, "timeout"), ASK_TIMEOUT_MS);
  pendingAsks.set(reqId, { chat_id, options, messageId, timer });
  LOG(`ask ${reqId} sent (${options.length} options) msg ${messageId}`);
}

function resolveAsk(reqId: string, index: number, reason: string) {
  const p = pendingAsks.get(reqId);
  if (!p) return;
  clearTimeout(p.timer); pendingAsks.delete(reqId);
  if (index >= 0 && index < p.options.length) {
    writeRes({ id: reqId, ok: true, result: { choice: p.options[index], index } });
    call("editMessageText", { chat_id: p.chat_id, message_id: p.messageId, text: `✅ ${p.options[index]}` }).catch(() => {});
    LOG(`ask ${reqId} answered: ${p.options[index]}`);
  } else {
    writeRes({ id: reqId, ok: false, error: `no answer (${reason})` });
    call("editMessageText", { chat_id: p.chat_id, message_id: p.messageId, text: `⌛ Без ответа` }).catch(() => {});
    LOG(`ask ${reqId} unresolved: ${reason}`);
  }
}

// ---------- /sys + /menu control plane (works even when the session is dead) ----------
function sh(cmd: string[], timeoutMs = 6000): { ok: boolean; out: string } {
  try {
    const p = spawnSync(cmd[0], cmd.slice(1), { timeout: timeoutMs, encoding: "utf8", env: { ...process.env, TMUX: "" } });
    const out = ((p.stdout ?? "") + (p.stderr ?? "")).trim();
    return { ok: p.status === 0, out };
  } catch (e: any) { return { ok: false, out: e.message }; }
}
function uptimeStr(): string {
  const s = Math.round((Date.now() - new Date(status.started).getTime()) / 1000);
  return `${Math.floor(s / 3600)}ч ${Math.floor((s % 3600) / 60)}м`;
}
function sessionState(): { alive: boolean; detail: string } {
  try { const st = statSync(BRIDGE_HEARTBEAT); const age = Date.now() - st.mtimeMs; if (age < 60_000) return { alive: true, detail: `мост ${Math.round(age / 1000)}с назад` }; } catch {}
  const p = sh(["pgrep", "-af", "claude --channels"]);
  if (p.ok && p.out) return { alive: true, detail: "claude --channels запущен" };
  return { alive: false, detail: "нет heartbeat моста и процесса claude --channels" };
}
function lastPollAgo(): number { return status.lastPollOk ? Math.round((Date.now() - new Date(status.lastPollOk).getTime()) / 1000) : -1; }

function sysMenu(chat_id: string) {
  return sendReply({ chat_id, text: `🎛 Панель управления ${SESSION_LABEL}`, buttons: [
    [{ text: "📊 Статус", data: "sys:status" }, { text: "🔄 Рестарт", data: "sys:restart" }],
    [{ text: "📜 Логи", data: "sys:logs" }, { text: "🖥 Экран", data: "sys:screen" }],
    [{ text: "🗜 /compact", data: "sys:cc:/compact" }, { text: "🧹 /clear", data: "sys:cc:/clear" }],
    [{ text: "🧠 Модель", data: "sys:models" }, { text: "⚡ Effort", data: "sys:efforts" }],
    [{ text: "🔌 MCP", data: "sys:mcp" }],
  ] });
}
async function sysStatus(chat_id: string) {
  const s = sessionState();
  const proc = sh(["pgrep", "-af", "claude --channels"]);
  const pid = proc.ok && proc.out ? proc.out.split("\n")[0].split(/\s+/)[0] : "-";
  let mem = "-";
  if (pid !== "-") { const m = sh(["ps", "-o", "rss=", "-p", pid]); if (m.ok && m.out) mem = `${Math.round(Number(m.out.trim()) / 1024)}МБ`; }
  const lines = [
    `🎛 gateway v${VERSION}: 🟢 uptime ${uptimeStr()}`,
    `опросов ${status.updatesSeen}, конфликтов ${status.conflicts}, последний опрос ${lastPollAgo()}с назад`,
    `сессия: ${s.alive ? "🟢 онлайн" : "🔴 DOWN"} (${s.detail})`,
    `claude pid ${pid}, память ${mem}`,
    status.lastError ? `последняя ошибка: ${status.lastError}` : "ошибок нет",
  ];
  return sendReply({ chat_id, text: lines.join("\n") });
}
function sysLogs(chat_id: string) {
  const j = sh(["journalctl", "--user", "-u", "tg-gateway.service", "-n", "20", "--no-pager"]);
  const body = j.ok && j.out ? j.out.slice(-3500) : `journalctl недоступен (тест-инстанс?). Последняя ошибка: ${status.lastError ?? "нет"}`;
  return sendReply({ chat_id, text: "📜 Лог gateway:\n\n" + body });
}
function sysScreen(chat_id: string) {
  const c = sh(["tmux", "capture-pane", "-t", TMUX_SESSION, "-p"]);
  if (!c.ok) return sendReply({ chat_id, text: `🖥 Экран недоступен: ${c.out || "нет сессии " + SESSION_LABEL}` });
  const out = c.out.split("\n").filter(l => l.trim()).slice(-40).join("\n").slice(-3500);
  return sendReply({ chat_id, text: `🖥 Экран ${SESSION_LABEL}:\n\n` + (out || "(пусто)") });
}
// Live MCP status: drive the in-session /mcp panel (same send-keys path as /model).
// Deliberately NOT `claude mcp list` — that spawns a 2nd process that 409-conflicts
// the long-poller and silently kills the channel. The in-session panel is safe.
async function sysMcp(chat_id: string) {
  if (!sh(["tmux", "has-session", "-t", TMUX_SESSION]).ok)
    return sendReply({ chat_id, text: `🔴 Сессия ${SESSION_LABEL} не запущена — панель /mcp показывать негде.` });
  sh(["tmux", "send-keys", "-t", TMUX_SESSION, "-l", "/mcp"]);
  sh(["tmux", "send-keys", "-t", TMUX_SESSION, "Enter"]);
  await sleep(2000);
  const cap = sh(["tmux", "capture-pane", "-t", TMUX_SESSION, "-p"]);
  const out = cap.ok ? cap.out.split("\n").filter(l => l.trim()).slice(-45).join("\n").slice(-3500) : "(экран недоступен)";
  // close the panel (and a possible drilled-in server view) so the TUI returns to the prompt
  sh(["tmux", "send-keys", "-t", TMUX_SESSION, "Escape"]);
  await sleep(250);
  sh(["tmux", "send-keys", "-t", TMUX_SESSION, "Escape"]);
  return sendReply({ chat_id, text: `🔌 Панель /mcp в сессии:\n\n${out || "(пусто)"}` });
}
async function sysSendKeys(chat_id: string, keys: string) {
  keys = keys.trim();
  if (!keys) return sendReply({ chat_id, text: "Формат: /sys cc <команда>, напр. /sys cc /compact" });
  if (!sh(["tmux", "has-session", "-t", TMUX_SESSION]).ok) return sendReply({ chat_id, text: `🔴 Сессия ${SESSION_LABEL} не запущена - команду некуда слать.` });
  const r1 = sh(["tmux", "send-keys", "-t", TMUX_SESSION, "-l", keys]);
  const r2 = sh(["tmux", "send-keys", "-t", TMUX_SESSION, "Enter"]);
  if (!r1.ok || !r2.ok) return sendReply({ chat_id, text: `send-keys ошибка: ${r1.out || r2.out}` });
  await sleep(1500);
  const cap = sh(["tmux", "capture-pane", "-t", TMUX_SESSION, "-p"]);
  const out = cap.ok ? cap.out.split("\n").filter(l => l.trim()).slice(-30).join("\n").slice(-3000) : "(экран недоступен)";
  return sendReply({ chat_id, text: `⌨️ Отправил в ${SESSION_LABEL}: ${keys}\n\n🖥 Экран:\n${out}` });
}
// Model picker — switches the LIVE session model via the in-session /model command
// (send-keys, same path as /sys cc). No restart: Claude Code picks the model up on the fly.
// The list is pulled LIVE from the provider catalogue (GET /v1/models with the
// same OAuth token the session runs on), so a freshly released model appears in
// the picker without editing this file. Cached for MODELS_TTL_MS; on any failure
// falls back to the last good list, then to MODELS_FALLBACK.
// ctx1m: the catalogue reports a 1M input window, so the picker also offers the
// "<id>[1m]" variant (Claude Code's opt-in suffix for the long window). The
// catalogue itself never lists [1m] ids — without this the 1M choice is missing.
// TG_MODELS_1M=0 hides those buttons (Pro plans don't get the 1M window).
type ModelOpt = { label: string; id: string; ctx1m?: boolean };
const MODELS_1M = (process.env.TG_MODELS_1M ?? "1") !== "0";
const MODELS_FALLBACK: ModelOpt[] = [
  { label: "Opus 5", id: "claude-opus-5" },
  { label: "Sonnet 5", id: "claude-sonnet-5" },
  { label: "Fable 5", id: "claude-fable-5" },
  { label: "Haiku 4.5", id: "claude-haiku-4-5-20251001" },
];
const MODELS_TTL_MS = 30 * 60 * 1000;
const MODELS_MAX = 8;
const MODELS_URL = process.env.CLAUDE_MODELS_URL ?? "https://api.anthropic.com/v1/models?limit=100";
let modelsCache: ModelOpt[] = [];
let modelsCacheAt = 0;
function oauthToken(): string {
  const fromEnv = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try { return readFileSync(join(homedir(), ".claude", "secrets", "claude-oauth-token"), "utf8").trim(); } catch { return ""; }
}
async function fetchModels(): Promise<ModelOpt[]> {
  if (modelsCache.length && Date.now() - modelsCacheAt < MODELS_TTL_MS) return modelsCache;
  const token = oauthToken();
  if (!token) { LOG("models: no OAuth token — using fallback list"); return modelsCache.length ? modelsCache : MODELS_FALLBACK; }
  try {
    const r = await fetch(MODELS_URL, {
      headers: { authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j: any = await r.json();
    const list: ModelOpt[] = (Array.isArray(j?.data) ? j.data : [])
      .filter((m: any) => typeof m?.id === "string")
      .sort((a: any, b: any) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))
      .slice(0, MODELS_MAX)
      .map((m: any) => ({ label: String(m.display_name ?? m.id).replace(/^Claude\s+/i, ""), id: m.id, ctx1m: Number(m.max_input_tokens ?? 0) >= 1_000_000 }));
    if (!list.length) throw new Error("empty catalogue");
    modelsCache = list; modelsCacheAt = Date.now();
    LOG(`models: catalogue refreshed (${list.length}): ${list.map(m => m.id).join(", ")}`);
    return modelsCache;
  } catch (e: any) {
    LOG(`models: catalogue fetch failed (${e?.message ?? e}) — using ${modelsCache.length ? "cached" : "fallback"} list`);
    return modelsCache.length ? modelsCache : MODELS_FALLBACK;
  }
}
async function sysModels(chat_id: string) {
  const models = await fetchModels();
  const live = modelsCacheAt > 0;
  // callback carries the model id, not an index: index-based callbacks on old
  // messages silently pick the wrong model once the list changes
  const buttons = models.map((m) => {
    const row = [{ text: m.label, data: `sys:model:${m.id}` }];
    if (MODELS_1M && m.ctx1m) row.push({ text: `${m.label} · 1M`, data: `sys:model:${m.id}[1m]` });
    return row;
  });
  const note = live ? "" : "\n⚠️ каталог моделей недоступен, список резервный";
  return sendReply({ chat_id, text: `🧠 Выбери модель (переключение на лету, без рестарта)${note}:`, buttons });
}
async function sysSetModel(chat_id: string, key: string, messageId?: number) {
  const models = await fetchModels();
  const base1m = key.endsWith("[1m]") ? key.slice(0, -4) : "";
  const b = base1m ? (models.find((x) => x.id === base1m) ?? MODELS_FALLBACK.find((x) => x.id === base1m)) : undefined;
  const m = models.find((x) => x.id === key) ?? MODELS_FALLBACK.find((x) => x.id === key)
    ?? (b ? { label: `${b.label} · 1M`, id: key } : undefined)
    ?? (/^claude-[a-z0-9.[\]-]+$/i.test(key) ? { label: key, id: key } : undefined);
  if (!m) {
    // bare number = index-style callback from a pre-Sep-2026 /model message
    const stale = /^\d+$/.test(key);
    return void sendReply({ chat_id, text: stale ? "⚠️ Кнопка из устаревшего сообщения — список моделей с тех пор менялся. Отправь /model заново." : "Неизвестная модель." });
  }
  if (!sh(["tmux", "has-session", "-t", TMUX_SESSION]).ok) return void sendReply({ chat_id, text: `🔴 Сессия ${SESSION_LABEL} не запущена — переключать некого.` });
  sh(["tmux", "send-keys", "-t", TMUX_SESSION, "-l", `/model ${m.id}`]);
  sh(["tmux", "send-keys", "-t", TMUX_SESSION, "Enter"]);
  // /model pops a "Switch model?" confirm dialog in the TUI. Headless, nobody sees
  // it and the session blocks. The TG tap IS the consent — auto-confirm it.
  await sleep(2500);
  let confirmed = false;
  if (/Switch model\?/i.test(paneTail())) { sh(["tmux", "send-keys", "-t", TMUX_SESSION, "Enter"]); confirmed = true; await sleep(1200); }
  // Don't report success blindly: the catalogue can offer a model this Claude Code
  // build refuses ("version too old"), and the session prints the error into the
  // pane while the tap message still claimed "переключил".
  await sleep(800);
  const tail = paneTail();
  const err = /does not support this model[^\n]*/i.exec(tail)
    ?? /claude_code_version_too_old/i.exec(tail)
    ?? /API error: \d+[^\n]*/i.exec(tail)
    ?? /invalid_request_error[^\n]*/i.exec(tail);
  if (err) {
    const old = /version (\d+\.\d+\.\d+) or newer is required/i.exec(tail);
    const hint = old ? `\nНужен Claude Code ${old[1]}+ (сейчас другой). Обнови и повтори.` : "";
    const bad = `⚠️ Не переключил на ${m.label} (${m.id})\n${err[0].slice(0, 300)}${hint}`;
    if (messageId) return void call("editMessageText", { chat_id, message_id: messageId, text: bad }).catch(() => sendReply({ chat_id, text: bad }));
    return void sendReply({ chat_id, text: bad });
  }
  const txt = `🧠 Переключил на ${m.label}\n(${m.id})${confirmed ? "\n✅ диалог подтверждения нажал за тебя" : ""}`;
  if (messageId) call("editMessageText", { chat_id, message_id: messageId, text: txt }).catch(() => sendReply({ chat_id, text: txt }));
  else sendReply({ chat_id, text: txt });
}
// Effort picker — same send-keys path as /model: the in-session `/effort <level>`
// sets it on the fly and Claude Code itself saves it as the default for new
// sessions. Which levels a model accepts differs (Haiku has none, older Sonnet
// has no xhigh), so we don't pre-filter: the session's own answer is relayed.
const EFFORTS = [
  { id: "low", label: "low · быстро" },
  { id: "medium", label: "medium" },
  { id: "high", label: "high" },
  { id: "xhigh", label: "xhigh · глубоко" },
  { id: "max", label: "max · максимум" },
  { id: "auto", label: "auto · по умолчанию модели" },
];
function sysEfforts(chat_id: string) {
  const buttons = [
    EFFORTS.slice(0, 3).map((e) => ({ text: e.label, data: `sys:effort:${e.id}` })),
    EFFORTS.slice(3, 5).map((e) => ({ text: e.label, data: `sys:effort:${e.id}` })),
    [{ text: EFFORTS[5].label, data: `sys:effort:${EFFORTS[5].id}` }],
  ];
  return sendReply({ chat_id, text: "⚡ Выбери effort: насколько долго модель думает перед ответом (на лету, без рестарта):", buttons });
}
async function sysSetEffort(chat_id: string, level: string, messageId?: number) {
  const out = (t: string) => messageId
    ? void call("editMessageText", { chat_id, message_id: messageId, text: t }).catch(() => sendReply({ chat_id, text: t }))
    : void sendReply({ chat_id, text: t });
  if (!EFFORTS.some((e) => e.id === level)) return out(`Неизвестный уровень «${level}». Варианты: ${EFFORTS.map((e) => e.id).join(", ")}`);
  if (!sh(["tmux", "has-session", "-t", TMUX_SESSION]).ok) return out(`🔴 Сессия ${SESSION_LABEL} не запущена — менять effort некому.`);
  sh(["tmux", "send-keys", "-t", TMUX_SESSION, "-l", `/effort ${level}`]);
  sh(["tmux", "send-keys", "-t", TMUX_SESSION, "Enter"]);
  await sleep(2500);
  // The pane may still show an answer from an earlier /effort, so judge by the
  // LAST effort line only, and count success only if it names the level we sent.
  const re = /(?:Set effort level to|Effort level set to|Effort set to|Invalid argument|exceeds the cap|not supported|does not support)[^\n]*/gi;
  const last = [...paneTail(40).matchAll(re)].pop()?.[0]?.trim() ?? "";
  if (/^(?:Set effort level to|Effort level set to|Effort set to)/i.test(last) && last.toLowerCase().includes(level)) {
    const scope = /this session only/i.test(last) ? "\nДействует до рестарта сессии." : /saved as your default/i.test(last) ? "\nСохранено по умолчанию, переживёт рестарт." : "";
    return out(`⚡ Effort: ${level}${scope}\n\n${last.slice(0, 300)}`);
  }
  if (last && !/^(?:Set effort level to|Effort level set to|Effort set to)/i.test(last)) return out(`⚠️ Effort не поменялся: ${last.slice(0, 300)}`);
  return out(`⚡ Отправил /effort ${level}, но подтверждения на экране не вижу. Проверь: /screen`);
}
// ---------- TUI prompt relay: terminal dialogs -> TG buttons ----------
// Claude Code occasionally pops an interactive selection dialog in the TUI
// ("Switch model?", permission prompts, trust dialogs). In a headless tmux
// session nobody sees it and the session just sits blocked. Watch the pane for
// a "❯ N." selection marker; if the same prompt persists across two polls,
// relay question+options to the admins as inline buttons that press the keys.
const PROMPT_POLL_MS = 5000;
let promptFp = "", promptSeen = 0, alertedFp = "";
function paneTail(lines = 30): string {
  const c = sh(["tmux", "capture-pane", "-t", TMUX_SESSION, "-p"]);
  return c.ok ? c.out.split("\n").filter(l => l.trim()).slice(-lines).join("\n") : "";
}
function detectPrompt(): { fp: string; block: string; nOpts: number } | null {
  const tail = paneTail();
  if (!/❯\s*\d+\./.test(tail)) return null; // "❯ 1." marker = a selection dialog is up
  const lines = tail.split("\n");
  const opts: string[] = [];
  let firstOpt = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:│\s*)?❯?\s*(\d+)\.\s+(.+)$/.exec(lines[i]);
    if (m) { opts.push(`${m[1]}. ${m[2].trim()}`); if (firstOpt < 0) firstOpt = i; }
  }
  if (!opts.length) return null;
  const ctx = lines.slice(Math.max(0, firstOpt - 6), firstOpt).join("\n"); // question text above the options
  const block = `${ctx}\n\n${opts.join("\n")}`.trim().slice(-1500);
  return { fp: opts.join("|").slice(0, 300), block, nOpts: Math.min(opts.length, 8) };
}
async function relayPrompt(p: { block: string; nOpts: number }) {
  const digits = Array.from({ length: p.nOpts }, (_, i) => ({ text: String(i + 1), data: `sys:tui:${i + 1}` }));
  const ctl = [{ text: "⌨️ Enter", data: "sys:tui:enter" }, { text: "✖️ Esc", data: "sys:tui:esc" }, { text: "🖥 Экран", data: "sys:screen" }];
  for (const admin of SYS_ADMINS) {
    await sendReply({ chat_id: admin, text: `⚠️ В терминале сессии висит вопрос — выбери ответ кнопкой:\n\n${p.block}`, buttons: [digits, ctl] })
      .catch((e: any) => LOG(`relayPrompt: ${e.message}`));
  }
  LOG(`relayed TUI prompt (${p.nOpts} options)`);
}
async function sysTuiKey(chat_id: string, key: string, messageId?: number) {
  if (!sh(["tmux", "has-session", "-t", TMUX_SESSION]).ok) return void sendReply({ chat_id, text: `🔴 Сессия ${SESSION_LABEL} не запущена.` });
  if (key === "enter") sh(["tmux", "send-keys", "-t", TMUX_SESSION, "Enter"]);
  else if (key === "esc") sh(["tmux", "send-keys", "-t", TMUX_SESSION, "Escape"]);
  else { sh(["tmux", "send-keys", "-t", TMUX_SESSION, "-l", key]); sh(["tmux", "send-keys", "-t", TMUX_SESSION, "Enter"]); }
  alertedFp = promptFp; // answered — don't re-alert this prompt
  await sleep(1500);
  const out = paneTail(15).slice(-1200);
  const txt = `⌨️ Нажал «${key}»\n\n🖥 Экран:\n${out || "(пусто)"}`;
  if (messageId) call("editMessageText", { chat_id, message_id: messageId, text: txt }).catch(() => sendReply({ chat_id, text: txt }));
  else sendReply({ chat_id, text: txt });
}
function sysRestartPrompt(chat_id: string) {
  return sendReply({ chat_id, text: `🔄 Перезапустить сессию ${SESSION_LABEL}? Демон убьёт и поднимет её заново; входящие в это время буферизуются и догрузятся.`, buttons: [
    [{ text: "✅ Подтвердить", data: "sys:restart:yes" }, { text: "❌ Отмена", data: "sys:restart:no" }],
  ] });
}
let lastRestartAt = 0;
async function doRestart(chat_id: string, messageId?: number) {
  const editOrSend = (t: string) => messageId ? call("editMessageText", { chat_id, message_id: messageId, text: t }).catch(() => {}) : sendReply({ chat_id, text: t });
  if (!SYS_RESTART_CMD) return void editOrSend("⚠️ Рестарт не настроен на этом инстансе (SYS_RESTART_CMD пуст).");
  if (Date.now() - lastRestartAt < 60_000) return void editOrSend("⏳ Рестарт уже запускался <1 мин назад. Подожди.");
  lastRestartAt = Date.now();
  await editOrSend(`🔄 Перезапускаю сессию ${SESSION_LABEL}...`);
  const r = sh(["bash", SYS_RESTART_CMD], 20_000);
  await sendReply({ chat_id, text: r.ok ? "✅ Рестарт запущен. Сессия поднимется за ~15с, новый инстанс ответит как будет готов." : `❌ Рестарт не удался: ${r.out}` });
}
// Commands are registered with Telegram so the Menu button / "/" list shows them.
const BOT_COMMANDS = [
  { command: "menu", description: "🎛 Панель управления" },
  { command: "ping", description: "Проверить живость" },
  { command: "status", description: "Подробный статус" },
  { command: "screen", description: "Показать экран сессии" },
  { command: "restart", description: "Перезапустить сессию" },
  { command: "model", description: "🧠 Выбрать модель" },
  { command: "effort", description: "⚡ Уровень effort" },
  { command: "mcp", description: "🔌 Статус MCP-серверов" },
  { command: "logs", description: "Лог gateway" },
];
async function registerCommands() {
  try { await call("setMyCommands", { commands: BOT_COMMANDS }); LOG(`registered ${BOT_COMMANDS.length} bot commands`); }
  catch (e: any) { LOG(`setMyCommands failed: ${e.message}`); }
  try { await call("setChatMenuButton", { menu_button: { type: "commands" } }); } catch {}
}

async function handleSysCommand(chat_id: string, text: string) {
  LOG(`sys cmd "${text}"`);
  let cmd: string;
  if (/^\/menu\b/i.test(text)) cmd = "menu";
  else if (/^\/sys\b/i.test(text)) cmd = (text.split(/\s+/)[1] ?? "help").toLowerCase();
  else cmd = text.split(/\s+/)[0].replace(/^\//, "").toLowerCase(); // top-level alias, e.g. /ping
  switch (cmd) {
    case "menu": return sysMenu(chat_id);
    case "ping": {
      const s = sessionState();
      return sendReply({ chat_id, text: `🟢 gateway v${VERSION} жив. Сессия: ${s.alive ? "🟢 онлайн" : "🔴 DOWN"} (${s.detail}). Последний опрос ${lastPollAgo()}с назад.` });
    }
    case "status": return sysStatus(chat_id);
    case "logs": return sysLogs(chat_id);
    case "screen": return sysScreen(chat_id);
    case "restart": return sysRestartPrompt(chat_id);
    case "model": case "models": return sysModels(chat_id);
    case "effort": {
      const lvl = (/^\/sys\b/i.test(text) ? text.split(/\s+/)[2] : text.split(/\s+/)[1])?.toLowerCase();
      return lvl ? sysSetEffort(chat_id, lvl) : sysEfforts(chat_id);
    }
    case "mcp": return sysMcp(chat_id);
    case "cc": return sysSendKeys(chat_id, text.replace(/^\/sys\s+cc\s*/i, ""));
    default: return sendReply({ chat_id, text: "Команды: /menu · /sys ping · /sys status · /sys logs · /sys screen · /sys restart · /sys mcp · /model · /effort [low|medium|high|xhigh|max|auto] · /sys cc <команда> (напр. /sys cc /compact)" });
  }
}

// ---------- outbox watcher ----------
async function pumpOutbox() {
  let files: string[] = [];
  try { files = readdirSync(OUTBOX).filter(f => f.startsWith("req-") && f.endsWith(".json")); } catch { return; }
  for (const f of files) {
    const full = join(OUTBOX, f);
    let req: any;
    try { req = JSON.parse(readFileSync(full, "utf8")); } catch { unlinkSync(full); continue; }
    unlinkSync(full);
    if (req.tool === "ask") { // deferred: res is written by resolveAsk on tap/timeout
      try { await startAsk(req.id, req.args); } catch (e: any) { writeRes({ id: req.id, ok: false, error: e.message }); LOG(`outbox ask error: ${e.message}`); }
      continue;
    }
    let res: any;
    try { res = { id: req.id, ok: true, result: await execTool(req.tool, req.args) }; }
    catch (e: any) { res = { id: req.id, ok: false, error: e.message }; LOG(`outbox ${req.tool} error: ${e.message}`); }
    writeRes(res);
  }
}

// ---------- brain-silent alert + res cleanup ----------
// The transport surviving while the session is dead is invisible to the user:
// the bot receives but never answers. Watch the bridge heartbeat and tell the
// admins on the dead->alive edges only (no routine "all green" noise).
const BRAIN_STALE_MS = 150_000; // bridge beats every 10s; session restart+init takes ~60-90s
let brainWasAlive: boolean | null = null;
function checkBrain() {
  let age = Infinity;
  try { age = Date.now() - statSync(BRIDGE_HEARTBEAT).mtimeMs; } catch {}
  const alive = age < BRAIN_STALE_MS;
  const tell = (t: string) => { for (const a of SYS_ADMINS) sendReply({ chat_id: a, text: t }).catch(() => {}); };
  if (brainWasAlive === null) {
    brainWasAlive = alive;
    if (!alive) tell(`🔴 Сессия ${SESSION_LABEL} не на связи (heartbeat моста ${age === Infinity ? "отсутствует" : "устарел"}). Входящие буферизуются. Подними её: /restart`);
  } else if (brainWasAlive && !alive) {
    brainWasAlive = false;
    tell(`🔴 Сессия ${SESSION_LABEL} молчит ~${Math.round(age / 60_000)} мин — мост перестал слать heartbeat. Входящие буферизуются и доедут. Жми /restart, детали: /status`);
  } else if (!brainWasAlive && alive) {
    brainWasAlive = true;
    tell(`🟢 Сессия ${SESSION_LABEL} снова на связи — heartbeat пошёл, бэклог сообщений доезжает.`);
  }
}
// ---------- auth-down detector (401 / "Please run /login") ----------
// The bridge heartbeat ticks on a 10s timer regardless of API auth, so a dead
// token leaves the session "alive" by heartbeat while the brain can't answer at
// all — invisible to checkBrain (message received, never answered, no alert).
// The reliable signal is the on-screen TUI banner. Scrape the pane and alert on
// the down/up edges only (no routine "all green" noise).
const AUTH_DOWN_RE = /Please run \/login|Invalid authentication credentials|API Error:\s*401|Credit balance is too low|OAuth token has expired/i;
function detectAuthDown(): boolean { return AUTH_DOWN_RE.test(paneTail(40)); }
let authWasDown = false, authDownStreak = 0;
function checkAuth() {
  if (detectAuthDown()) authDownStreak++; else authDownStreak = 0;
  const isDown = authDownStreak >= 2; // 2 consecutive ticks (~30s) confirm — kills transient redraws
  const tell = (t: string) => { for (const a of SYS_ADMINS) sendReply({ chat_id: a, text: t }).catch(() => {}); };
  if (!authWasDown && isDown) {
    authWasDown = true;
    tell("🔴 Claude разлогинился — API 401. Сессия жива, но сообщения СЕЙЧАС НЕ обрабатываются. Залогинь её (/login в терминале) или жми /restart.");
  } else if (authWasDown && authDownStreak === 0) {
    authWasDown = false;
    tell("🟢 Авторизация Claude восстановлена — снова на связи, бэклог доедет.");
  }
}
// Live reachability probe at message time — used to ack the sender immediately if
// the brain can't answer right now (auth banner on screen, or heartbeat stale).
function brainDownNow(): "" | "auth" | "dead" {
  if (detectAuthDown()) return "auth";
  let age = Infinity; try { age = Date.now() - statSync(BRIDGE_HEARTBEAT).mtimeMs; } catch {}
  return age >= BRAIN_STALE_MS ? "dead" : "";
}
// Orphaned outbox results (bridge died mid-wait) otherwise pile up forever.
function cleanupRes() {
  try {
    for (const f of readdirSync(OUTBOX_RES)) {
      const p = join(OUTBOX_RES, f);
      try { if (Date.now() - statSync(p).mtimeMs > 3600_000) unlinkSync(p); } catch {}
    }
  } catch {}
}

// ---------- robust long-poll loop ----------
let offset = 0;
try { offset = Number(readFileSync(OFFSET_FILE, "utf8")) || 0; } catch {}
function saveOffset() { try { writeFileSync(OFFSET_FILE, String(offset)); } catch {} }

let netBackoff = 1000, conflictPause = 5000, running = true;
// Exit promptly so a restart isn't stuck behind the 50s long-poll. Offset is
// saved after each batch, and drop_pending_updates=false means an in-flight
// batch is simply re-fetched next start — no loss.
process.on("SIGTERM", () => { LOG("SIGTERM, stopping"); saveOffset(); releaseLock(); process.exit(0); });
process.on("SIGINT", () => { saveOffset(); releaseLock(); process.exit(0); });
// Never die silently — log, drop the lock, exit so the supervisor restarts fresh.
process.on("uncaughtException", (e: any) => { LOG(`FATAL uncaughtException: ${e?.stack || e}`); releaseLock(); process.exit(1); });
process.on("unhandledRejection", (e: any) => { LOG(`FATAL unhandledRejection: ${e?.stack || e}`); releaseLock(); process.exit(1); });

async function main() {
  acquireLock();
  LOG(`starting v${VERSION}. state=${STATE_DIR} offset=${offset}`);
  status.lastPollOk = new Date().toISOString(); // seed so the watchdog doesn't fire during startup
  writeStatus();
  try { await call("deleteWebhook", { drop_pending_updates: false }, 10000); } catch (e: any) { LOG(`deleteWebhook: ${e.message}`); }
  registerCommands().catch(() => {}); // populate the bot's Menu button / command list
  // run outbox pump on its own cadence
  setInterval(() => { pumpOutbox().catch(e => LOG(`outbox pump: ${e.message}`)); }, 400);
  // relay stuck TUI dialogs (selection prompts) to the admins as TG buttons
  setInterval(() => {
    try {
      const p = detectPrompt();
      // dialog gone: forget what we alerted about, otherwise a repeat of the same
      // prompt (fp is just the option texts, so "1. Yes|2. No" repeats verbatim)
      // is never relayed again and the session hangs unseen for hours.
      if (!p) { promptFp = ""; promptSeen = 0; alertedFp = ""; return; }
      if (p.fp === promptFp) promptSeen++; else { promptFp = p.fp; promptSeen = 1; }
      if (promptSeen === 2 && alertedFp !== p.fp) { alertedFp = p.fp; relayPrompt(p); }
    } catch (e: any) { LOG(`prompt watcher: ${e.message}`); }
  }, PROMPT_POLL_MS);
  // keep "typing…" alive for chats awaiting a reply (Telegram clears it after ~5s)
  setInterval(() => {
    const now = Date.now();
    for (const [key, started] of typingChats) {
      if (now - started > TYPING_MAX_MS) { typingChats.delete(key); continue; }
      const [chat, thread] = key.split(":"); // "chat" or "chat:thread"; chat ids never contain a colon
      call("sendChatAction", { chat_id: chat, ...(thread ? { message_thread_id: Number(thread) } : {}), action: "typing" }).catch(() => {});
    }
  }, 4500);
  // heartbeat + liveness watchdog: if no successful poll in STALE_MS, we're wedged — exit for a clean restart
  setInterval(() => {
    writeStatus();
    const age = Date.now() - new Date(status.lastPollOk).getTime();
    if (age > STALE_MS) { LOG(`FATAL: no successful poll in ${Math.round(age / 1000)}s — wedged. exiting for supervisor restart.`); releaseLock(); process.exit(1); }
    checkBrain();
    checkAuth();
    cleanupRes();
  }, 15000);
  while (running) {
    try {
      const updates = await call("getUpdates", { offset, timeout: 50, allowed_updates: ["message", "edited_message", "callback_query"] });
      netBackoff = 1000; conflictPause = 5000; // healthy, reset
      status.lastPollOk = new Date().toISOString();
      for (const u of updates) { await handleUpdate(u); offset = u.update_id + 1; status.updatesSeen++; status.lastInbound = new Date().toISOString(); }
      if (updates.length) saveOffset();
    } catch (e: any) {
      status.lastError = `${new Date().toISOString()} ${e.message}`;
      if (e instanceof TgError && e.status === 409) {
        status.conflicts++;
        LOG(`409 Conflict (another poller / stale session). pausing ${conflictPause / 1000}s`);
        try { await call("deleteWebhook", { drop_pending_updates: false }, 10000); } catch {}
        await sleep(conflictPause); conflictPause = Math.min(conflictPause + 10000, 55000);
      } else if (e instanceof TgError && e.status === 401) {
        LOG("FATAL 401 Unauthorized: bad token"); releaseLock(); process.exit(1);
      } else {
        LOG(`poll error: ${e.message}. backoff ${netBackoff / 1000}s`);
        await sleep(netBackoff); netBackoff = Math.min(netBackoff * 2, 60000);
      }
    }
  }
  saveOffset(); writeStatus(); releaseLock(); LOG("stopped"); process.exit(0);
}
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ---------- `pair` setup mode: capture the owner's chat_id, write gateway.env ----------
function writeEnvFile(kv: Record<string, string>) {
  const existing: Record<string, string> = {};
  try {
    for (const line of readFileSync(CONFIG_ENV_FILE, "utf8").split("\n")) {
      const s = line.trim();
      if (s && !s.startsWith("#") && s.includes("=")) { const i = s.indexOf("="); existing[s.slice(0, i).trim()] = s.slice(i + 1).trim(); }
    }
  } catch {}
  const merged = { ...existing, ...kv };
  const body = "# tg-gateway config (written by `pair`). Keep private — contains the bot token.\n" +
    Object.entries(merged).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = CONFIG_ENV_FILE + ".tmp";
  writeFileSync(tmp, body, { mode: 0o600 });
  renameSync(tmp, CONFIG_ENV_FILE);
}

async function pairMode() {
  process.stderr.write("\n[pair] Открой Telegram, найди своего бота и отправь ему любое сообщение (например /start).\n[pair] Жду до 5 минут...\n\n");
  try { await call("deleteWebhook", { drop_pending_updates: true }, 10000); } catch {}
  let offset = 0;
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    let updates: any[] = [];
    try { updates = await call("getUpdates", { offset, timeout: 25, allowed_updates: ["message"] }); }
    catch (e: any) { process.stderr.write(`[pair] опрос не удался: ${e.message}\n`); await sleep(2000); continue; }
    for (const u of updates) {
      offset = u.update_id + 1;
      const msg = u.message ?? u.edited_message;
      if (!msg) continue;
      const chatId = String(msg.chat.id);
      const who = msg.from?.username ? `@${msg.from.username}` : (msg.from?.first_name ?? "user");
      writeEnvFile({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_SYS_ADMINS: chatId, TELEGRAM_ALLOWED_CHATS: chatId });
      try { await call("sendMessage", { chat_id: chatId, text: "✅ Спарено. Этот чат управляет твоим Claude; для остальных бот закрыт." }); } catch {}
      process.stderr.write(`[pair] OK — chat_id=${chatId} (${who}), конфиг записан: ${CONFIG_ENV_FILE}\n`);
      process.exit(0);
    }
  }
  process.stderr.write("[pair] Таймаут: за 5 минут не пришло ни одного сообщения. Запусти setup ещё раз.\n");
  process.exit(1);
}

const MODE = process.argv.slice(2).find(a => !a.startsWith("-"));
if (MODE === "pair" || MODE === "setup") pairMode();
else main();
