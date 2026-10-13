#!/usr/bin/env bun
// @bun

// gateway/gateway.ts
import { homedir } from "os";
import { join } from "path";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync, renameSync, statSync, copyFileSync } from "fs";
import { spawnSync } from "child_process";
var STATE_DIR = process.env.TELEGRAM_STATE_DIR ?? join(homedir(), ".claude", "channels", "tg-gateway");
var INBOX = join(STATE_DIR, "inbox");
var OUTBOX = join(STATE_DIR, "outbox");
var OUTBOX_RES = join(OUTBOX, "res");
var OFFSET_FILE = join(STATE_DIR, "gateway.offset");
var STATUS_FILE = join(STATE_DIR, "gateway.status.json");
var LOCK_FILE = join(STATE_DIR, "gateway.lock");
var CONFIG_ENV_FILE = process.env.TG_GATEWAY_ENV ?? join(STATE_DIR, "gateway.env");
(function loadEnvFile() {
  try {
    if (!existsSync(CONFIG_ENV_FILE))
      return;
    for (const line of readFileSync(CONFIG_ENV_FILE, "utf8").split(`
`)) {
      const s = line.trim();
      if (!s || s.startsWith("#") || !s.includes("="))
        continue;
      const i = s.indexOf("=");
      const k = s.slice(0, i).trim();
      const v = s.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      if (k && process.env[k] === undefined)
        process.env[k] = v;
    }
  } catch {}
})();
var VERSION = "1.2.0";
var STALE_MS = 180000;
var SYS_ADMINS = new Set((process.env.TELEGRAM_SYS_ADMINS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
var ALLOWED_CHATS = new Set([
  ...(process.env.TELEGRAM_ALLOWED_CHATS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  ...SYS_ADMINS
]);
var ALLOWED_GROUP_USERS = new Set([
  ...(process.env.TELEGRAM_ALLOWED_GROUP_USERS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  ...SYS_ADMINS
]);
function isAllowedChat(chatId, userId, isGroup = false) {
  if (ALLOWED_CHATS.has("*"))
    return true;
  if (isGroup)
    return ALLOWED_CHATS.has(chatId) && ALLOWED_GROUP_USERS.has(userId);
  return ALLOWED_CHATS.has(chatId) || SYS_ADMINS.has(userId);
}
var topicNames = new Map;
var sysThread = new Map;
var TMUX_SESSION = process.env.CLAUDE_TMUX ?? "claude";
var SESSION_LABEL = process.env.TG_SESSION_LABEL ?? "Claude";
var SYS_RESTART_CMD = process.env.SYS_RESTART_CMD ?? "";
var BRIDGE_HEARTBEAT = join(STATE_DIR, "bridge.heartbeat");
var ACK_EMOJI = process.env.TELEGRAM_ACK_EMOJI ?? "\uD83D\uDC40";
var TYPING_MAX_MS = 8 * 60000;
var typingChats = new Map;
var typingKey = (chatId, threadId) => threadId ? `${chatId}:${threadId}` : String(chatId);
var REACTION_RULES = [
  [/\u0441\u043F\u0430\u0441\u0438\u0431|(?<![\u0430-\u044F\u0451a-z])\u0441\u043F\u0441(?![\u0430-\u044F\u0451a-z])|\u0431\u043B\u0430\u0433\u043E\u0434\u0430\u0440|\u043C\u0435\u0440\u0441\u0438|\uD83D\uDE4F/i, "\uD83D\uDE4F"],
  [/(?<![\u0430-\u044F\u0451a-z])\u0443\u0440\u0430(?![\u0430-\u044F\u0451a-z])|\u043F\u043E\u0437\u0434\u0440\u0430\u0432|\uD83C\uDF89|\u0441 \u0434\u043D\u0451\u043C|\u0441 \u0434\u043D\u0435\u043C|\u043F\u0440\u0430\u0437\u0434/i, "\uD83C\uDF89"],
  [/\u0430\u0445\u0430\u0445|\u0445\u0430\u0445\u0430|\u0445\u0430-\u0445\u0430|(?<![\u0430-\u044F\u0451a-z])\u043B\u043E\u043B(?![\u0430-\u044F\u0451a-z])|\u0440\u0436\u0443|\u0441\u043C\u0435\u0448\u043D\u043E|\u0443\u0433\u0430\u0440|\uD83D\uDE02|\uD83E\uDD23/i, "\uD83E\uDD23"],
  [/\u0432\u0430\u0443|(?<![\u0430-\u044F\u0451a-z])\u043E\u0433\u043E(?![\u0430-\u044F\u0451a-z])|\u043E\u0444\u0438\u0433|\u043E\u0445\u0440\u0435\u043D|\u043E\u0431\u0430\u043B\u0434|\uD83E\uDD2F|\u043D\u0435\u0432\u0435\u0440\u043E\u044F\u0442\u043D|\u0436\u0435\u0441\u0442\u044C/i, "\uD83E\uDD2F"],
  [/\u043E\u0433\u043E\u043D\u044C|\u043E\u0433\u043E\u043D\u0451\u043A|\u043E\u0433\u043E\u043D\u0435\u043A|\uD83D\uDD25|\u0431\u043E\u043C\u0431|\u043C\u043E\u0449\u043D\u043E|\u043F\u0443\u0448\u043A\u0430|\u0442\u043E\u043F\u0447\u0438\u043A/i, "\uD83D\uDD25"],
  [/\u0438\u0434\u0435\u0430\u043B\u044C|\u0432 \u0442\u043E\u0447\u043A\u0443|(?<![\u0430-\u044F\u0451a-z])\u0442\u043E\u0447\u043D\u043E(?![\u0430-\u044F\u0451a-z])|\uD83D\uDCAF|\u0431\u0435\u0437\u0443\u043F\u0440\u0435\u0447|\u0447\u0451\u0442\u043A\u043E|\u0447\u0435\u0442\u043A\u043E/i, "\uD83D\uDCAF"],
  [/\u043F\u0440\u0438\u043D\u044F\u043B|(?<![\u0430-\u044F\u0451a-z])\u043F\u043E\u043D\u044F\u043B|\u0442\u0430\u043A \u0442\u043E\u0447\u043D\u043E|\uD83E\uDEE1/i, "\uD83E\uDEE1"],
  [/\u043C\u043E\u043B\u043E\u0434\u0435\u0446|\u043A\u0440\u0430\u0441\u0430\u0432|\u0440\u0435\u0441\u043F\u0435\u043A\u0442|\uD83E\uDD1D|\u0436\u043C\u0443 \u0440\u0443\u043A\u0443|\u0443\u0432\u0430\u0436\u0435\u043D\u0438\u0435/i, "\uD83E\uDD1D"],
  [/\u0441\u0443\u043F\u0435\u0440|\u043A\u043B\u0430\u0441\u0441|\u043E\u0442\u043B\u0438\u0447\u043D|\u043A\u0430\u0439\u0444|\u0448\u0438\u043A\u0430\u0440|\u043E\u0431\u043E\u0436\u0430\u044E|\u043B\u044E\u0431\u043B\u044E|\u043A\u0440\u0443\u0442\u043E|(?<![\u0430-\u044F\u0451a-z])\u0442\u043E\u043F(?![\u0430-\u044F\u0451a-z])|\u2764|\uD83E\uDD70|\uD83D\uDE0D/i, "\u2764"],
  [/(^|[\s,])(\u043E\u043A|\u043E\u043A\u0435\u0439|\u043E\u043A\u0439|\u0434\u0430\u0432\u0430\u0439|\u0433\u043E|\u043F\u043E\u0435\u0445\u0430\u043B\u0438|\u043F\u043E\u0433\u043D\u0430\u043B\u0438|\u0441\u043E\u0433\u043B\u0430\u0441\u0435\u043D|\u0441\u043E\u0433\u043B)([\s,.!?]|$)/i, "\uD83D\uDC4D"],
  [/\u0431\u043B\u0438\u043D|(?<![\u0430-\u044F\u0451a-z])\u0447[\u0435\u0451]\u0440\u0442(?![\u0430-\u044F\u0451a-z])|\u043D\u0435 \u0440\u0430\u0431\u043E\u0442\u0430|\u0441\u043B\u043E\u043C\u0430\u043B|\u0443\u043F\u0430\u043B|\u043E\u0448\u0438\u0431\u043A|\u043F\u0440\u043E\u0431\u043B\u0435\u043C|(?<![\u0430-\u044F\u0451a-z])\u0431\u0430\u0433(?![\u0430-\u044F\u0451a-z])|\u043A\u043E\u0441\u044F\u043A|\uD83D\uDE22|\uD83D\uDE2D|\u043F\u0435\u0447\u0430\u043B\u044C/i, "\uD83D\uDE22"]
];
function pickReaction(text) {
  const t = (text ?? "").trim();
  if (!t)
    return ACK_EMOJI;
  for (const [re, emo] of REACTION_RULES)
    if (re.test(t))
      return emo;
  return ACK_EMOJI;
}
var LOG = (m) => process.stderr.write(`[tg-gateway ${new Date().toISOString()}] ${m}
`);
for (const d of [STATE_DIR, INBOX, OUTBOX, OUTBOX_RES])
  mkdirSync(d, { recursive: true });
function acquireLock() {
  try {
    if (existsSync(LOCK_FILE)) {
      const pid = Number(readFileSync(LOCK_FILE, "utf8").trim());
      if (pid && pid !== process.pid) {
        try {
          process.kill(pid, 0);
          LOG(`FATAL: another tg-gateway already running (pid ${pid}). exiting.`);
          process.exit(1);
        } catch {
          LOG(`stale lock from dead pid ${pid}, taking over`);
        }
      }
    }
  } catch {}
  try {
    writeFileSync(LOCK_FILE, String(process.pid));
  } catch {}
}
function releaseLock() {
  try {
    if (existsSync(LOCK_FILE) && Number(readFileSync(LOCK_FILE, "utf8").trim()) === process.pid)
      unlinkSync(LOCK_FILE);
  } catch {}
}
var status = {
  pid: process.pid,
  version: VERSION,
  started: new Date().toISOString(),
  lastPollOk: null,
  lastInbound: null,
  lastError: null,
  updatesSeen: 0,
  conflicts: 0
};
function writeStatus() {
  try {
    const t = STATUS_FILE + ".tmp";
    writeFileSync(t, JSON.stringify(status, null, 2));
    renameSync(t, STATUS_FILE);
  } catch {}
}
function loadToken() {
  if (process.env.TELEGRAM_BOT_TOKEN)
    return process.env.TELEGRAM_BOT_TOKEN.trim();
  const f = join(homedir(), ".claude", "secrets", "telegram-bot-token");
  if (existsSync(f))
    return readFileSync(f, "utf8").trim();
  LOG("FATAL: no TELEGRAM_BOT_TOKEN and no secrets/telegram-bot-token");
  process.exit(1);
}
var TOKEN = loadToken();
var API_ROOT = (process.env.TELEGRAM_API_ROOT || "https://api.telegram.org").replace(/\/+$/, "");
var API = `${API_ROOT}/bot${TOKEN}`;
var FILE_API = `${API_ROOT}/file/bot${TOKEN}`;

class TgError extends Error {
  status;
  constructor(status2, msg) {
    super(msg);
    this.status = status2;
  }
}
async function call(method, body, timeoutMs = 65000) {
  const ctrl = new AbortController;
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${API}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false)
      throw new TgError(r.status, j.description || `${method} http ${r.status}`);
    return j.result;
  } finally {
    clearTimeout(t);
  }
}
function writeInbox(name, obj, dir = INBOX) {
  const tmp = join(dir, `.${name}.tmp`);
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, join(dir, name));
}
var TOPIC_RUNTIME_CHATS = new Set((process.env.TELEGRAM_TOPIC_RUNTIME_CHATS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
var TOPICS_INBOX = join(STATE_DIR, "topics", "inbox");
function inboxDirFor(chatId, threadId) {
  if (threadId && TOPIC_RUNTIME_CHATS.has(chatId)) {
    mkdirSync(TOPICS_INBOX, { recursive: true });
    return TOPICS_INBOX;
  }
  return INBOX;
}
async function downloadFile(fileId, suggestExt) {
  const f = await call("getFile", { file_id: fileId });
  const path = f.file_path;
  const ext = suggestExt ?? (path.includes(".") ? path.split(".").pop() : "bin");
  const dest = join(INBOX, `${Date.now()}-${fileId}.${ext}`);
  if (path.startsWith("/")) {
    copyFileSync(path, dest);
  } else {
    const resp = await fetch(`${FILE_API}/${path}`);
    writeFileSync(dest, Buffer.from(await resp.arrayBuffer()));
  }
  return dest;
}
var GROQ_TOKEN_FILE = join(homedir(), ".claude", "secrets", "groq-token");
async function transcribeVoice(fileId) {
  try {
    if (!existsSync(GROQ_TOKEN_FILE))
      return null;
    const token = readFileSync(GROQ_TOKEN_FILE, "utf8").trim();
    const path = await downloadFile(fileId, "ogg");
    const fd = new FormData;
    fd.append("model", "whisper-large-v3-turbo");
    fd.append("language", "ru");
    fd.append("file", new Blob([readFileSync(path)], { type: "audio/ogg" }), "voice.ogg");
    const ctrl = new AbortController;
    const t = setTimeout(() => ctrl.abort(), 30000);
    try {
      const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: fd,
        signal: ctrl.signal
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        LOG(`groq stt http ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
        return null;
      }
      return (j.text ?? "").trim() || null;
    } finally {
      clearTimeout(t);
    }
  } catch (e) {
    LOG(`voice stt: ${e.message}`);
    return null;
  }
}
function buttonLabel(msg, data) {
  const rows = msg?.reply_markup?.inline_keyboard;
  if (!Array.isArray(rows))
    return null;
  for (const row of rows)
    for (const b of row)
      if (b?.callback_data === data) {
        const t = String(b.text ?? "").trim();
        return t || null;
      }
  return null;
}
async function handleCallback(cq) {
  const data = cq.data ?? "";
  const askMatch = /^ask:([^:]+):(\d+)$/.exec(data);
  if (askMatch && pendingAsks.has(askMatch[1])) {
    try {
      await call("answerCallbackQuery", { callback_query_id: cq.id });
    } catch {}
    resolveAsk(askMatch[1], Number(askMatch[2]), "answered");
    return;
  }
  if (data.startsWith("sys:")) {
    try {
      await call("answerCallbackQuery", { callback_query_id: cq.id });
    } catch {}
    if (!SYS_ADMINS.has(String(cq.from?.id ?? "")))
      return;
    LOG(`sys tap "${data}"`);
    const chat_id = String(cq.message?.chat?.id ?? cq.from?.id ?? "");
    const messageId = cq.message?.message_id;
    const rest = data.slice(4);
    if (rest === "status")
      return void sysStatus(chat_id);
    if (rest === "logs")
      return void sysLogs(chat_id);
    if (rest === "screen")
      return void sysScreen(chat_id);
    if (rest === "restart")
      return void sysRestartPrompt(chat_id);
    if (rest === "restart:yes")
      return void doRestart(chat_id, messageId);
    if (rest === "restart:no") {
      if (messageId)
        call("editMessageText", { chat_id, message_id: messageId, text: "\u041E\u0442\u043C\u0435\u043D\u0435\u043D\u043E." }).catch(() => {});
      return;
    }
    if (rest.startsWith("cc:"))
      return void sysSendKeys(chat_id, rest.slice(3));
    if (rest === "models")
      return void sysModels(chat_id);
    if (rest === "mcp")
      return void sysMcp(chat_id);
    if (rest.startsWith("model:"))
      return void sysSetModel(chat_id, rest.slice(6), messageId);
    if (rest === "efforts")
      return void sysEfforts(chat_id);
    if (rest.startsWith("effort:"))
      return void sysSetEffort(chat_id, rest.slice(7), messageId);
    if (rest.startsWith("tui:"))
      return void sysTuiKey(chat_id, rest.slice(4), messageId);
    return;
  }
  const from = cq.from ?? {};
  const msg = cq.message ?? {};
  const cbIsGroup = msg.chat?.type === "group" || msg.chat?.type === "supergroup";
  if (!isAllowedChat(String(msg.chat?.id ?? from.id ?? ""), String(from.id ?? ""), cbIsGroup)) {
    try {
      await call("answerCallbackQuery", { callback_query_id: cq.id });
    } catch {}
    LOG(`DROP callback from non-allowed ${from.id}`);
    return;
  }
  const label = buttonLabel(msg, data) || data;
  const chatId = String(msg.chat?.id ?? from.id);
  try {
    await call("answerCallbackQuery", { callback_query_id: cq.id, text: `\u2713 ${label}`.slice(0, 190) });
  } catch (e) {
    LOG(`answerCallbackQuery: ${e.message}`);
  }
  if (msg.message_id != null) {
    try {
      await call("editMessageReplyMarkup", { chat_id: chatId, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } });
    } catch {}
  }
  const base = {
    chat_id: chatId,
    message_id: String(Date.now()),
    user: from.username ?? `${from.first_name ?? "user"}`,
    user_id: String(from.id ?? ""),
    ts: new Date().toISOString(),
    text: label,
    callback_data: data
  };
  let cbThread = "";
  if (msg.chat?.is_forum && msg.is_topic_message && msg.message_thread_id != null) {
    cbThread = String(msg.message_thread_id);
    base.message_thread_id = cbThread;
    const title = topicNames.get(`${chatId}:${msg.message_thread_id}`);
    if (title)
      base.topic = title;
  }
  writeInbox(`${Date.now()}-cbm-${cq.id}.json`, base, inboxDirFor(chatId, cbThread));
  LOG(`inbox <- button-tap chat ${chatId} data="${data}" label="${label}"`);
}
async function handleUpdate(u) {
  if (u.callback_query)
    return handleCallback(u.callback_query);
  const msg = u.message ?? u.edited_message;
  if (!msg)
    return;
  const from = msg.from ?? {};
  const gateChat = String(msg.chat.id), gateUser = String(from.id ?? "");
  const isGroup = msg.chat?.type === "group" || msg.chat?.type === "supergroup";
  const isForum = msg.chat?.is_forum === true;
  const threadId = isForum && msg.is_topic_message && msg.message_thread_id != null ? String(msg.message_thread_id) : "";
  const tKey = typingKey(gateChat, threadId);
  if (msg.forum_topic_created?.name)
    topicNames.set(`${gateChat}:${msg.message_thread_id}`, msg.forum_topic_created.name);
  if (msg.forum_topic_edited?.name)
    topicNames.set(`${gateChat}:${msg.message_thread_id}`, msg.forum_topic_edited.name);
  if (msg.forum_topic_created || msg.forum_topic_edited || msg.forum_topic_closed || msg.forum_topic_reopened || msg.new_chat_members || msg.left_chat_member)
    return;
  if (!isAllowedChat(gateChat, gateUser, isGroup)) {
    LOG(`DROP non-allowed chat ${gateChat} user ${gateUser} (@${from.username ?? "?"}): ${(msg.text ?? "[media]").slice(0, 80)}`);
    return;
  }
  const text0 = (msg.text ?? "").trim().replace(/^(\/[a-z_]+)@[A-Za-z0-9_]+/i, "$1");
  if (/^\/(sys|menu|ping|status|restart|screen|logs|model|models|effort|mcp)\b/i.test(text0)) {
    if (!SYS_ADMINS.has(String(from.id ?? ""))) {
      await call("sendMessage", { chat_id: gateChat, ...threadId ? { message_thread_id: Number(threadId) } : {}, text: "\u26D4 \u041A\u043E\u043C\u0430\u043D\u0434\u044B \u0443\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0438\u044F \u0434\u043E\u0441\u0442\u0443\u043F\u043D\u044B \u0442\u043E\u043B\u044C\u043A\u043E \u0432\u043B\u0430\u0434\u0435\u043B\u044C\u0446\u0443." }).catch(() => {});
      return;
    }
    if (threadId)
      sysThread.set(gateChat, threadId);
    else
      sysThread.delete(gateChat);
    return void handleSysCommand(gateChat, text0).catch((e) => LOG(`sys cmd error: ${e.message}`)).finally(() => sysThread.delete(gateChat));
  }
  call("setMessageReaction", { chat_id: gateChat, message_id: Number(msg.message_id), reaction: [{ type: "emoji", emoji: pickReaction(msg.text ?? msg.caption ?? "") }] }).catch(() => {});
  call("sendChatAction", { chat_id: gateChat, ...threadId ? { message_thread_id: Number(threadId) } : {}, action: "typing" }).catch(() => {});
  typingChats.set(tKey, Date.now());
  const base = {
    chat_id: gateChat,
    message_id: String(msg.message_id),
    user: from.username ?? `${from.first_name ?? "user"}`,
    user_id: String(from.id ?? msg.chat.id),
    ts: new Date((msg.date ?? Date.now() / 1000) * 1000).toISOString()
  };
  if (threadId) {
    base.message_thread_id = threadId;
    const title = topicNames.get(`${gateChat}:${threadId}`);
    if (title)
      base.topic = title;
  }
  if (msg.reply_to_message)
    base.reply_to_message_id = String(msg.reply_to_message.message_id);
  try {
    if (msg.photo) {
      const best = msg.photo[msg.photo.length - 1];
      base.text = msg.caption ?? "";
      base.image_path = await downloadFile(best.file_id, "jpg");
    } else if (msg.voice) {
      base.text = msg.caption ?? "";
      base.attachment_file_id = msg.voice.file_id;
      base.attachment_kind = "voice";
      base.attachment_mime = msg.voice.mime_type;
      base.attachment_size = msg.voice.file_size;
      const stt = await transcribeVoice(msg.voice.file_id);
      if (stt) {
        base.text = `[\u0433\u043E\u043B\u043E\u0441\u043E\u0432\u043E\u0435, \u0440\u0430\u0441\u0448\u0438\u0444\u0440\u043E\u0432\u0430\u043D\u043E \u0432 \u0442\u0440\u0430\u043D\u0441\u043F\u043E\u0440\u0442\u0435] ${stt}`;
        base.voice_transcribed = true;
      }
    } else if (msg.audio) {
      base.text = msg.caption ?? "";
      base.attachment_file_id = msg.audio.file_id;
      base.attachment_kind = "audio";
      base.attachment_mime = msg.audio.mime_type;
      base.attachment_size = msg.audio.file_size;
    } else if (msg.document) {
      base.text = msg.caption ?? "";
      base.attachment_file_id = msg.document.file_id;
      base.attachment_kind = "document";
      base.attachment_mime = msg.document.mime_type;
      base.attachment_size = msg.document.file_size;
    } else if (msg.video) {
      base.text = msg.caption ?? "";
      base.attachment_file_id = msg.video.file_id;
      base.attachment_kind = "video";
      base.attachment_mime = msg.video.mime_type;
      base.attachment_size = msg.video.file_size;
    } else if (msg.text) {
      base.text = msg.text;
    } else {
      base.text = msg.caption ?? "[unsupported message type]";
    }
  } catch (e) {
    LOG(`media handling error: ${e.message}`);
    base.text = base.text ?? "[media download failed]";
  }
  const TG_DL_LIMIT = Number(process.env.TELEGRAM_DL_LIMIT_MB || 20) * 1024 * 1024;
  if (base.attachment_kind && !base.image_path && !base.voice_transcribed && typeof base.attachment_size === "number" && base.attachment_size > TG_DL_LIMIT) {
    const mb = Math.round(base.attachment_size / 1048576);
    sendReply({ chat_id: base.chat_id, text: `\u26A0\uFE0F \u0424\u0430\u0439\u043B \u0441\u043B\u0438\u0448\u043A\u043E\u043C \u0431\u043E\u043B\u044C\u0448\u043E\u0439 (${mb} \u041C\u0411). \u041A\u0430\u043A \u0431\u043E\u0442 \u044F \u043C\u043E\u0433\u0443 \u0437\u0430\u0431\u0438\u0440\u0430\u0442\u044C \u0438\u0437 Telegram \u0442\u043E\u043B\u044C\u043A\u043E \u0444\u0430\u0439\u043B\u044B \u0434\u043E 20 \u041C\u0411. \u041F\u0440\u0438\u0448\u043B\u0438 \u0437\u0430\u043F\u0438\u0441\u044C \u0433\u043E\u043B\u043E\u0441\u043E\u0432\u044B\u043C \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435\u043C (\u043E\u043D\u043E \u0441\u0436\u0430\u0442\u043E \u0438 \u043E\u0431\u044B\u0447\u043D\u043E \u0432\u043B\u0435\u0437\u0430\u0435\u0442), \u0441\u0441\u044B\u043B\u043A\u043E\u0439 \u043D\u0430 \u0444\u0430\u0439\u043B, \u0438\u043B\u0438 \u0441\u043E\u0436\u043C\u0438/\u0440\u0430\u0437\u0440\u0435\u0436\u044C \u0435\u0433\u043E, \u0442\u043E\u0433\u0434\u0430 \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u0430\u044E.`, reply_to: base.message_id }).catch(() => {});
    base.text = `${base.text ? base.text + " " : ""}[\u0412\u043B\u043E\u0436\u0435\u043D\u0438\u0435 "${base.attachment_kind}" ${mb} \u041C\u0411 \u041D\u0415 \u0441\u043A\u0430\u0447\u0430\u043D\u043E: \u043F\u0440\u0435\u0432\u044B\u0448\u0435\u043D \u043B\u0438\u043C\u0438\u0442 Telegram Bot API 20 \u041C\u0411. \u041F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044E \u0443\u0436\u0435 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043E \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u0435 \u0441 \u043F\u0440\u043E\u0441\u044C\u0431\u043E\u0439 \u043F\u0440\u0438\u0441\u043B\u0430\u0442\u044C \u0433\u043E\u043B\u043E\u0441\u043E\u0432\u044B\u043C/\u0441\u0441\u044B\u043B\u043A\u043E\u0439/\u0441\u0436\u0430\u0442\u044C. \u041D\u0435 \u043F\u044B\u0442\u0430\u0439\u0441\u044F \u0441\u043A\u0430\u0447\u0438\u0432\u0430\u0442\u044C \u044D\u0442\u043E \u0432\u043B\u043E\u0436\u0435\u043D\u0438\u0435.]`;
    delete base.attachment_file_id;
    LOG(`oversized ${base.attachment_kind} ${mb}MB from chat ${base.chat_id}: user notified`);
  }
  const dir = inboxDirFor(base.chat_id, threadId);
  writeInbox(`${Date.now()}-${msg.message_id}.json`, base, dir);
  LOG(`inbox${dir === INBOX ? "" : "(\u0442\u0435\u043C\u0430)"} <- chat ${base.chat_id}${threadId ? ` \u0442\u0435\u043C\u0430 ${threadId}` : ""} msg ${base.message_id} ${base.image_path ? "[photo]" : base.attachment_kind ? `[${base.attachment_kind}]${base.voice_transcribed ? "+stt" : ""}` : ""}`);
  const down = dir === INBOX ? brainDownNow() : null;
  if (down) {
    const t = down === "auth" ? "\u26A0\uFE0F \u041F\u043E\u043B\u0443\u0447\u0438\u043B, \u043D\u043E Claude \u0441\u0435\u0439\u0447\u0430\u0441 \u0440\u0430\u0437\u043B\u043E\u0433\u0438\u043D\u0435\u043D (API 401) \u0438 \u043D\u0435 \u043E\u0431\u0440\u0430\u0431\u0430\u0442\u044B\u0432\u0430\u0435\u0442 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u044F. \u041D\u0443\u0436\u0435\u043D /login \u0432 \u0442\u0435\u0440\u043C\u0438\u043D\u0430\u043B\u0435 \u0438\u043B\u0438 /restart. \u041E\u0442\u0432\u0435\u0447\u0443, \u043A\u0430\u043A \u043F\u043E\u0447\u0438\u043D\u044E." : "\u26A0\uFE0F \u041F\u043E\u043B\u0443\u0447\u0438\u043B, \u043D\u043E \u0441\u0435\u0441\u0441\u0438\u044F Claude \u0441\u0435\u0439\u0447\u0430\u0441 \u043D\u0435 \u043D\u0430 \u0441\u0432\u044F\u0437\u0438. \u0416\u043C\u0438 /restart. \u0421\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435 \u0431\u0443\u0444\u0435\u0440\u0438\u0437\u0443\u0435\u0442\u0441\u044F \u0438 \u0434\u043E\u0435\u0434\u0435\u0442.";
    sendReply({ chat_id: base.chat_id, text: t, reply_to: base.message_id }).catch(() => {});
    LOG(`brain-down ack sent to chat ${base.chat_id} (${down})`);
  }
}
function chunk(text, limit = 4000) {
  if (text.length <= limit)
    return [text];
  const out = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf(`
`, limit);
    if (cut < limit * 0.6)
      cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest)
    out.push(rest);
  return out;
}
function normalizeButtons(buttons) {
  if (!Array.isArray(buttons) || buttons.length === 0)
    return;
  const rows = Array.isArray(buttons[0]) ? buttons : [buttons];
  const inline_keyboard = rows.map((row) => row.map((b) => b.url ? { text: String(b.text), url: String(b.url) } : { text: String(b.text), callback_data: String(b.data ?? b.text).slice(0, 64) }));
  return { inline_keyboard };
}
function unescapeMd(s) {
  let out = "";
  for (let i = 0;i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) {
      out += c + s[i + 1];
      i++;
      continue;
    }
    if (c === "*" || c === "_" || c === "~" || c === "`" || c === "|")
      continue;
    out += c;
  }
  return out.replace(/\\([_*\[\]()~`>#+\-=|{}.!])/g, "$1");
}
var RICH_MAX_CHARS = 32768;
var richDisabled = false;
var RICH_SPACER = "\u2800";
var RICH_BREATHES = /^(?:#{1,6}\s|>|\||```|~~~|(?:-{3,}|\*{3,}|_{3,})\s*$)/;
var RICH_LIST_ITEM = /^\s{0,3}(?:[-*+]\s|\d+[.)]\s)/;
function richSpacing(md) {
  const lines = md.split(`
`);
  const out = [];
  let fence = null;
  for (let i = 0;i < lines.length; i++) {
    const line = lines[i];
    const fenceMark = line.match(/^\s{0,3}(```+|~~~+)/);
    if (fenceMark)
      fence = fence && line.trim().startsWith(fence) ? null : fence ?? fenceMark[1];
    out.push(line);
    if (fence || line.trim() !== "")
      continue;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === "")
      j++;
    if (j >= lines.length) {
      for (let x = i + 1;x < j; x++)
        out.push(lines[x]);
      break;
    }
    const next = lines[j];
    let k = out.length - 2;
    while (k >= 0 && out[k].trim() === "")
      k--;
    const prev = k >= 0 ? out[k] : "";
    const bothList = RICH_LIST_ITEM.test(prev) && RICH_LIST_ITEM.test(next);
    if (!bothList && !RICH_BREATHES.test(prev.trim()) && !RICH_BREATHES.test(next.trim())) {
      out.push(RICH_SPACER, "");
    }
    for (let x = i + 1;x < j; x++)
      out.push(lines[x]);
    i = j - 1;
  }
  return out.join(`
`);
}
function richPayload(text) {
  return { markdown: richSpacing(text) };
}
function isRichCapabilityError(e) {
  return e?.status === 404 || /method not found|unknown method|not implemented/i.test(String(e?.message ?? ""));
}
function richToPlain(md) {
  return md.replace(/^\s{0,3}#{1,6}\s+/gm, "").replace(/(\*\*|__)([^\n]*?)\1/g, "$2").replace(/^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/gm, "").replace(/^\s*\|(.+)\|\s*$/gm, (_m, row) => row.split("|").map((c) => c.trim()).filter(Boolean).join(" \xB7 ")).replace(/\n{3,}/g, `

`).trim();
}
async function trySendRich(args, reply_markup) {
  const { chat_id, text, reply_to, disable_notification } = args;
  if (richDisabled || !text || text.length > RICH_MAX_CHARS)
    return null;
  const body = { chat_id, rich_message: richPayload(text) };
  if (args.message_thread_id)
    body.message_thread_id = Number(args.message_thread_id);
  if (disable_notification)
    body.disable_notification = true;
  if (reply_markup)
    body.reply_markup = reply_markup;
  if (reply_to)
    body.reply_parameters = { message_id: Number(reply_to) };
  try {
    const res = await call("sendRichMessage", body);
    return { message_ids: [res.message_id] };
  } catch (e) {
    if (isRichCapabilityError(e)) {
      richDisabled = true;
      LOG(`rich: server has no sendRichMessage (${e.message}) \u2014 rich off until restart`);
    } else
      LOG(`rich: sendRichMessage rejected (${e.message}) \u2014 plain fallback`);
    return null;
  }
}
async function sendReply(args) {
  const { chat_id, text, format, reply_to, files, disable_notification } = args;
  const thread = args.message_thread_id ?? sysThread.get(String(chat_id)) ?? "";
  const threadArg = thread ? { message_thread_id: Number(thread) } : {};
  typingChats.delete(typingKey(String(chat_id), thread ? String(thread) : undefined));
  const parse_mode = format === "markdownv2" ? "MarkdownV2" : undefined;
  const reply_markup = normalizeButtons(args.buttons);
  if (format === "rich") {
    const pre = [];
    if (files && files.length) {
      const f = await sendReply({ chat_id, files, text: "", disable_notification: true, message_thread_id: args.message_thread_id });
      pre.push(...f.message_ids ?? []);
    }
    const rich = await trySendRich({ ...args, files: undefined }, reply_markup);
    if (rich)
      return { message_ids: [...pre, ...rich.message_ids] };
    const plain = await sendReply({ ...args, files: undefined, format: "text", text: richToPlain(text ?? "") });
    return { message_ids: [...pre, ...plain.message_ids ?? []] };
  }
  const ids = [];
  if (files && files.length) {
    const CAPTION_LIMIT = 1024;
    let caption = text ?? "", rest = "";
    if (caption.length > CAPTION_LIMIT) {
      let cut = caption.lastIndexOf(`
`, CAPTION_LIMIT);
      if (cut < CAPTION_LIMIT * 0.5)
        cut = CAPTION_LIMIT;
      rest = caption.slice(cut).replace(/^\n/, "");
      caption = caption.slice(0, cut);
    }
    for (let fi = 0;fi < files.length; fi++) {
      const p = files[fi];
      const blob = new Blob([readFileSync(p)]);
      const name = p.split("/").pop() ?? "file";
      const isPhoto = /\.(jpe?g|png|webp)$/i.test(name);
      const lastFile = fi === files.length - 1;
      const attempt = async (method, field, cap2, pm) => {
        const fd = new FormData;
        fd.append("chat_id", String(chat_id));
        if (thread)
          fd.append("message_thread_id", String(thread));
        fd.append("caption", cap2);
        if (pm)
          fd.append("parse_mode", pm);
        if (disable_notification)
          fd.append("disable_notification", "true");
        if (reply_markup && lastFile && !rest)
          fd.append("reply_markup", JSON.stringify(reply_markup));
        fd.append(field, blob, name);
        const r = await fetch(`${API}/${method}`, { method: "POST", body: fd });
        return r.json();
      };
      const cap = fi === 0 ? caption : "";
      let j = await attempt(isPhoto ? "sendPhoto" : "sendDocument", isPhoto ? "photo" : "document", cap, parse_mode);
      if (!j.ok && parse_mode)
        j = await attempt(isPhoto ? "sendPhoto" : "sendDocument", isPhoto ? "photo" : "document", unescapeMd(cap));
      if (!j.ok && isPhoto)
        j = await attempt("sendDocument", "document", unescapeMd(cap));
      if (j.ok)
        ids.push(j.result.message_id);
      else
        LOG(`send file failed (${name}): ${j.description}`);
    }
    if (rest) {
      const tail = await sendReply({ chat_id, text: rest, format, disable_notification, buttons: args.buttons, message_thread_id: thread || undefined });
      ids.push(...tail.message_ids ?? []);
    }
    return { message_ids: ids };
  }
  const parts = chunk(text ?? "");
  for (let i = 0;i < parts.length; i++) {
    const quiet = disable_notification || i < parts.length - 1;
    const last = i === parts.length - 1;
    const body = { chat_id, text: parts[i], ...threadArg };
    if (parse_mode)
      body.parse_mode = parse_mode;
    if (quiet)
      body.disable_notification = true;
    if (reply_markup && last)
      body.reply_markup = reply_markup;
    if (reply_to && i === 0)
      body.reply_to_message_id = reply_to;
    try {
      const res = await call("sendMessage", body);
      ids.push(res.message_id);
    } catch (e) {
      if (parse_mode) {
        const res = await call("sendMessage", { chat_id, text: unescapeMd(parts[i]), ...threadArg, ...quiet ? { disable_notification: true } : {}, ...reply_markup && last ? { reply_markup } : {}, ...reply_to && i === 0 ? { reply_to_message_id: reply_to } : {} });
        ids.push(res.message_id);
      } else
        throw e;
    }
  }
  return { message_ids: ids };
}
async function execTool(tool, args) {
  switch (tool) {
    case "reply":
      return sendReply(args);
    case "react":
      return call("setMessageReaction", { chat_id: args.chat_id, message_id: Number(args.message_id), reaction: [{ type: "emoji", emoji: args.emoji }] });
    case "edit_message": {
      const body = { chat_id: args.chat_id, message_id: Number(args.message_id), text: args.text };
      if (args.format === "markdownv2")
        body.parse_mode = "MarkdownV2";
      const rm = normalizeButtons(args.buttons);
      if (rm)
        body.reply_markup = rm;
      if (args.format === "rich" && !richDisabled) {
        const rb = { chat_id: args.chat_id, message_id: Number(args.message_id), rich_message: richPayload(args.text) };
        if (rm)
          rb.reply_markup = rm;
        try {
          return await call("editMessageText", rb);
        } catch (e) {
          if (isRichCapabilityError(e))
            richDisabled = true;
          if (/not modified/i.test(String(e.message)))
            return true;
          LOG(`rich: edit rejected (${e.message}) \u2014 plain edit`);
          body.text = richToPlain(args.text);
        }
      }
      try {
        return await call("editMessageText", body);
      } catch (e) {
        if (!body.parse_mode)
          throw e;
        const { parse_mode, ...plain } = body;
        plain.text = unescapeMd(args.text);
        return call("editMessageText", plain);
      }
    }
    case "download_attachment":
      return { path: await downloadFile(args.file_id) };
    case "status":
      return { ...status, now: new Date().toISOString() };
    default:
      throw new Error(`unknown tool ${tool}`);
  }
}
var ASK_TIMEOUT_MS = 600000;
var pendingAsks = new Map;
function writeRes(res) {
  const rt = join(OUTBOX_RES, `.${res.id}.tmp`);
  writeFileSync(rt, JSON.stringify(res));
  renameSync(rt, join(OUTBOX_RES, `${res.id}.json`));
}
async function startAsk(reqId, args) {
  const chat_id = String(args.chat_id ?? "");
  const question = String(args.question ?? "");
  const options = (Array.isArray(args.options) ? args.options : []).map(String).slice(0, 20);
  if (!chat_id || options.length === 0) {
    writeRes({ id: reqId, ok: false, error: "ask needs chat_id and non-empty options" });
    return;
  }
  const buttons = options.map((o, i) => [{ text: o, data: `ask:${reqId}:${i}` }]);
  const sent = await sendReply({ chat_id, text: question, format: args.format, buttons, message_thread_id: args.message_thread_id });
  const messageId = sent.message_ids[sent.message_ids.length - 1];
  const timer = setTimeout(() => resolveAsk(reqId, -1, "timeout"), ASK_TIMEOUT_MS);
  pendingAsks.set(reqId, { chat_id, options, messageId, timer });
  LOG(`ask ${reqId} sent (${options.length} options) msg ${messageId}`);
}
function resolveAsk(reqId, index, reason) {
  const p = pendingAsks.get(reqId);
  if (!p)
    return;
  clearTimeout(p.timer);
  pendingAsks.delete(reqId);
  if (index >= 0 && index < p.options.length) {
    writeRes({ id: reqId, ok: true, result: { choice: p.options[index], index } });
    call("editMessageText", { chat_id: p.chat_id, message_id: p.messageId, text: `\u2705 ${p.options[index]}` }).catch(() => {});
    LOG(`ask ${reqId} answered: ${p.options[index]}`);
  } else {
    writeRes({ id: reqId, ok: false, error: `no answer (${reason})` });
    call("editMessageText", { chat_id: p.chat_id, message_id: p.messageId, text: `\u231B \u0411\u0435\u0437 \u043E\u0442\u0432\u0435\u0442\u0430` }).catch(() => {});
    LOG(`ask ${reqId} unresolved: ${reason}`);
  }
}
function sh(cmd, timeoutMs = 6000) {
  try {
    const p = spawnSync(cmd[0], cmd.slice(1), { timeout: timeoutMs, encoding: "utf8", env: { ...process.env, TMUX: "" } });
    const out = ((p.stdout ?? "") + (p.stderr ?? "")).trim();
    return { ok: p.status === 0, out };
  } catch (e) {
    return { ok: false, out: e.message };
  }
}
function uptimeStr() {
  const s = Math.round((Date.now() - new Date(status.started).getTime()) / 1000);
  return `${Math.floor(s / 3600)}\u0447 ${Math.floor(s % 3600 / 60)}\u043C`;
}
function sessionState() {
  try {
    const st = statSync(BRIDGE_HEARTBEAT);
    const age = Date.now() - st.mtimeMs;
    if (age < 60000)
      return { alive: true, detail: `\u043C\u043E\u0441\u0442 ${Math.round(age / 1000)}\u0441 \u043D\u0430\u0437\u0430\u0434` };
  } catch {}
  const p = sh(["pgrep", "-af", "claude --channels"]);
  if (p.ok && p.out)
    return { alive: true, detail: "claude --channels \u0437\u0430\u043F\u0443\u0449\u0435\u043D" };
  return { alive: false, detail: "\u043D\u0435\u0442 heartbeat \u043C\u043E\u0441\u0442\u0430 \u0438 \u043F\u0440\u043E\u0446\u0435\u0441\u0441\u0430 claude --channels" };
}
function lastPollAgo() {
  return status.lastPollOk ? Math.round((Date.now() - new Date(status.lastPollOk).getTime()) / 1000) : -1;
}
function sysMenu(chat_id) {
  return sendReply({ chat_id, text: `\uD83C\uDF9B \u041F\u0430\u043D\u0435\u043B\u044C \u0443\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0438\u044F ${SESSION_LABEL}`, buttons: [
    [{ text: "\uD83D\uDCCA \u0421\u0442\u0430\u0442\u0443\u0441", data: "sys:status" }, { text: "\uD83D\uDD04 \u0420\u0435\u0441\u0442\u0430\u0440\u0442", data: "sys:restart" }],
    [{ text: "\uD83D\uDCDC \u041B\u043E\u0433\u0438", data: "sys:logs" }, { text: "\uD83D\uDDA5 \u042D\u043A\u0440\u0430\u043D", data: "sys:screen" }],
    [{ text: "\uD83D\uDDDC /compact", data: "sys:cc:/compact" }, { text: "\uD83E\uDDF9 /clear", data: "sys:cc:/clear" }],
    [{ text: "\uD83E\uDDE0 \u041C\u043E\u0434\u0435\u043B\u044C", data: "sys:models" }, { text: "\u26A1 Effort", data: "sys:efforts" }],
    [{ text: "\uD83D\uDD0C MCP", data: "sys:mcp" }]
  ] });
}
async function sysStatus(chat_id) {
  const s = sessionState();
  const proc = sh(["pgrep", "-af", "claude --channels"]);
  const pid = proc.ok && proc.out ? proc.out.split(`
`)[0].split(/\s+/)[0] : "-";
  let mem = "-";
  if (pid !== "-") {
    const m = sh(["ps", "-o", "rss=", "-p", pid]);
    if (m.ok && m.out)
      mem = `${Math.round(Number(m.out.trim()) / 1024)}\u041C\u0411`;
  }
  const lines = [
    `\uD83C\uDF9B gateway v${VERSION}: \uD83D\uDFE2 uptime ${uptimeStr()}`,
    `\u043E\u043F\u0440\u043E\u0441\u043E\u0432 ${status.updatesSeen}, \u043A\u043E\u043D\u0444\u043B\u0438\u043A\u0442\u043E\u0432 ${status.conflicts}, \u043F\u043E\u0441\u043B\u0435\u0434\u043D\u0438\u0439 \u043E\u043F\u0440\u043E\u0441 ${lastPollAgo()}\u0441 \u043D\u0430\u0437\u0430\u0434`,
    `\u0441\u0435\u0441\u0441\u0438\u044F: ${s.alive ? "\uD83D\uDFE2 \u043E\u043D\u043B\u0430\u0439\u043D" : "\uD83D\uDD34 DOWN"} (${s.detail})`,
    `claude pid ${pid}, \u043F\u0430\u043C\u044F\u0442\u044C ${mem}`,
    status.lastError ? `\u043F\u043E\u0441\u043B\u0435\u0434\u043D\u044F\u044F \u043E\u0448\u0438\u0431\u043A\u0430: ${status.lastError}` : "\u043E\u0448\u0438\u0431\u043E\u043A \u043D\u0435\u0442"
  ];
  return sendReply({ chat_id, text: lines.join(`
`) });
}
function sysLogs(chat_id) {
  const j = sh(["journalctl", "--user", "-u", "tg-gateway.service", "-n", "20", "--no-pager"]);
  const body = j.ok && j.out ? j.out.slice(-3500) : `journalctl \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D (\u0442\u0435\u0441\u0442-\u0438\u043D\u0441\u0442\u0430\u043D\u0441?). \u041F\u043E\u0441\u043B\u0435\u0434\u043D\u044F\u044F \u043E\u0448\u0438\u0431\u043A\u0430: ${status.lastError ?? "\u043D\u0435\u0442"}`;
  return sendReply({ chat_id, text: `\uD83D\uDCDC \u041B\u043E\u0433 gateway:

` + body });
}
function sysScreen(chat_id) {
  const c = sh(["tmux", "capture-pane", "-t", TMUX_SESSION, "-p"]);
  if (!c.ok)
    return sendReply({ chat_id, text: `\uD83D\uDDA5 \u042D\u043A\u0440\u0430\u043D \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D: ${c.out || "\u043D\u0435\u0442 \u0441\u0435\u0441\u0441\u0438\u0438 " + SESSION_LABEL}` });
  const out = c.out.split(`
`).filter((l) => l.trim()).slice(-40).join(`
`).slice(-3500);
  return sendReply({ chat_id, text: `\uD83D\uDDA5 \u042D\u043A\u0440\u0430\u043D ${SESSION_LABEL}:

` + (out || "(\u043F\u0443\u0441\u0442\u043E)") });
}
async function sysMcp(chat_id) {
  if (!sh(["tmux", "has-session", "-t", TMUX_SESSION]).ok)
    return sendReply({ chat_id, text: `\uD83D\uDD34 \u0421\u0435\u0441\u0441\u0438\u044F ${SESSION_LABEL} \u043D\u0435 \u0437\u0430\u043F\u0443\u0449\u0435\u043D\u0430 \u2014 \u043F\u0430\u043D\u0435\u043B\u044C /mcp \u043F\u043E\u043A\u0430\u0437\u044B\u0432\u0430\u0442\u044C \u043D\u0435\u0433\u0434\u0435.` });
  sh(["tmux", "send-keys", "-t", TMUX_SESSION, "-l", "/mcp"]);
  sh(["tmux", "send-keys", "-t", TMUX_SESSION, "Enter"]);
  await sleep(2000);
  const cap = sh(["tmux", "capture-pane", "-t", TMUX_SESSION, "-p"]);
  const out = cap.ok ? cap.out.split(`
`).filter((l) => l.trim()).slice(-45).join(`
`).slice(-3500) : "(\u044D\u043A\u0440\u0430\u043D \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D)";
  sh(["tmux", "send-keys", "-t", TMUX_SESSION, "Escape"]);
  await sleep(250);
  sh(["tmux", "send-keys", "-t", TMUX_SESSION, "Escape"]);
  return sendReply({ chat_id, text: `\uD83D\uDD0C \u041F\u0430\u043D\u0435\u043B\u044C /mcp \u0432 \u0441\u0435\u0441\u0441\u0438\u0438:

${out || "(\u043F\u0443\u0441\u0442\u043E)"}` });
}
async function sysSendKeys(chat_id, keys) {
  keys = keys.trim();
  if (!keys)
    return sendReply({ chat_id, text: "\u0424\u043E\u0440\u043C\u0430\u0442: /sys cc <\u043A\u043E\u043C\u0430\u043D\u0434\u0430>, \u043D\u0430\u043F\u0440. /sys cc /compact" });
  if (!sh(["tmux", "has-session", "-t", TMUX_SESSION]).ok)
    return sendReply({ chat_id, text: `\uD83D\uDD34 \u0421\u0435\u0441\u0441\u0438\u044F ${SESSION_LABEL} \u043D\u0435 \u0437\u0430\u043F\u0443\u0449\u0435\u043D\u0430 - \u043A\u043E\u043C\u0430\u043D\u0434\u0443 \u043D\u0435\u043A\u0443\u0434\u0430 \u0441\u043B\u0430\u0442\u044C.` });
  const r1 = sh(["tmux", "send-keys", "-t", TMUX_SESSION, "-l", keys]);
  const r2 = sh(["tmux", "send-keys", "-t", TMUX_SESSION, "Enter"]);
  if (!r1.ok || !r2.ok)
    return sendReply({ chat_id, text: `send-keys \u043E\u0448\u0438\u0431\u043A\u0430: ${r1.out || r2.out}` });
  await sleep(1500);
  const cap = sh(["tmux", "capture-pane", "-t", TMUX_SESSION, "-p"]);
  const out = cap.ok ? cap.out.split(`
`).filter((l) => l.trim()).slice(-30).join(`
`).slice(-3000) : "(\u044D\u043A\u0440\u0430\u043D \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D)";
  return sendReply({ chat_id, text: `\u2328\uFE0F \u041E\u0442\u043F\u0440\u0430\u0432\u0438\u043B \u0432 ${SESSION_LABEL}: ${keys}

\uD83D\uDDA5 \u042D\u043A\u0440\u0430\u043D:
${out}` });
}
var MODELS_1M = (process.env.TG_MODELS_1M ?? "1") !== "0";
var MODELS_FALLBACK = [
  { label: "Opus 5", id: "claude-opus-5" },
  { label: "Sonnet 5", id: "claude-sonnet-5" },
  { label: "Fable 5", id: "claude-fable-5" },
  { label: "Haiku 4.5", id: "claude-haiku-4-5-20251001" }
];
var MODELS_TTL_MS = 30 * 60 * 1000;
var MODELS_MAX = 8;
var MODELS_URL = process.env.CLAUDE_MODELS_URL ?? "https://api.anthropic.com/v1/models?limit=100";
var modelsCache = [];
var modelsCacheAt = 0;
function oauthToken() {
  const fromEnv = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (fromEnv)
    return fromEnv;
  try {
    return readFileSync(join(homedir(), ".claude", "secrets", "claude-oauth-token"), "utf8").trim();
  } catch {
    return "";
  }
}
async function fetchModels() {
  if (modelsCache.length && Date.now() - modelsCacheAt < MODELS_TTL_MS)
    return modelsCache;
  const token = oauthToken();
  if (!token) {
    LOG("models: no OAuth token \u2014 using fallback list");
    return modelsCache.length ? modelsCache : MODELS_FALLBACK;
  }
  try {
    const r = await fetch(MODELS_URL, {
      headers: { authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(1e4)
    });
    if (!r.ok)
      throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const list = (Array.isArray(j?.data) ? j.data : []).filter((m) => typeof m?.id === "string").sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""))).slice(0, MODELS_MAX).map((m) => ({ label: String(m.display_name ?? m.id).replace(/^Claude\s+/i, ""), id: m.id, ctx1m: Number(m.max_input_tokens ?? 0) >= 1e6 }));
    if (!list.length)
      throw new Error("empty catalogue");
    modelsCache = list;
    modelsCacheAt = Date.now();
    LOG(`models: catalogue refreshed (${list.length}): ${list.map((m) => m.id).join(", ")}`);
    return modelsCache;
  } catch (e) {
    LOG(`models: catalogue fetch failed (${e?.message ?? e}) \u2014 using ${modelsCache.length ? "cached" : "fallback"} list`);
    return modelsCache.length ? modelsCache : MODELS_FALLBACK;
  }
}
async function sysModels(chat_id) {
  const models = await fetchModels();
  const live = modelsCacheAt > 0;
  const buttons = models.map((m) => {
    const row = [{ text: m.label, data: `sys:model:${m.id}` }];
    if (MODELS_1M && m.ctx1m)
      row.push({ text: `${m.label} \xB7 1M`, data: `sys:model:${m.id}[1m]` });
    return row;
  });
  const note = live ? "" : `
\u26A0\uFE0F \u043A\u0430\u0442\u0430\u043B\u043E\u0433 \u043C\u043E\u0434\u0435\u043B\u0435\u0439 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D, \u0441\u043F\u0438\u0441\u043E\u043A \u0440\u0435\u0437\u0435\u0440\u0432\u043D\u044B\u0439`;
  return sendReply({ chat_id, text: `\uD83E\uDDE0 \u0412\u044B\u0431\u0435\u0440\u0438 \u043C\u043E\u0434\u0435\u043B\u044C (\u043F\u0435\u0440\u0435\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u0435 \u043D\u0430 \u043B\u0435\u0442\u0443, \u0431\u0435\u0437 \u0440\u0435\u0441\u0442\u0430\u0440\u0442\u0430)${note}:`, buttons });
}
async function sysSetModel(chat_id, key, messageId) {
  const models = await fetchModels();
  const base1m = key.endsWith("[1m]") ? key.slice(0, -4) : "";
  const b = base1m ? models.find((x) => x.id === base1m) ?? MODELS_FALLBACK.find((x) => x.id === base1m) : undefined;
  const m = models.find((x) => x.id === key) ?? MODELS_FALLBACK.find((x) => x.id === key) ?? (b ? { label: `${b.label} \xB7 1M`, id: key } : undefined) ?? (/^claude-[a-z0-9.[\]-]+$/i.test(key) ? { label: key, id: key } : undefined);
  if (!m) {
    const stale = /^\d+$/.test(key);
    return void sendReply({ chat_id, text: stale ? "\u26A0\uFE0F \u041A\u043D\u043E\u043F\u043A\u0430 \u0438\u0437 \u0443\u0441\u0442\u0430\u0440\u0435\u0432\u0448\u0435\u0433\u043E \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u044F \u2014 \u0441\u043F\u0438\u0441\u043E\u043A \u043C\u043E\u0434\u0435\u043B\u0435\u0439 \u0441 \u0442\u0435\u0445 \u043F\u043E\u0440 \u043C\u0435\u043D\u044F\u043B\u0441\u044F. \u041E\u0442\u043F\u0440\u0430\u0432\u044C /model \u0437\u0430\u043D\u043E\u0432\u043E." : "\u041D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u0430\u044F \u043C\u043E\u0434\u0435\u043B\u044C." });
  }
  if (!sh(["tmux", "has-session", "-t", TMUX_SESSION]).ok)
    return void sendReply({ chat_id, text: `\uD83D\uDD34 \u0421\u0435\u0441\u0441\u0438\u044F ${SESSION_LABEL} \u043D\u0435 \u0437\u0430\u043F\u0443\u0449\u0435\u043D\u0430 \u2014 \u043F\u0435\u0440\u0435\u043A\u043B\u044E\u0447\u0430\u0442\u044C \u043D\u0435\u043A\u043E\u0433\u043E.` });
  sh(["tmux", "send-keys", "-t", TMUX_SESSION, "-l", `/model ${m.id}`]);
  sh(["tmux", "send-keys", "-t", TMUX_SESSION, "Enter"]);
  await sleep(2500);
  let confirmed = false;
  if (/Switch model\?/i.test(paneTail())) {
    sh(["tmux", "send-keys", "-t", TMUX_SESSION, "Enter"]);
    confirmed = true;
    await sleep(1200);
  }
  await sleep(800);
  const tail = paneTail();
  const err = /does not support this model[^\n]*/i.exec(tail) ?? /claude_code_version_too_old/i.exec(tail) ?? /API error: \d+[^\n]*/i.exec(tail) ?? /invalid_request_error[^\n]*/i.exec(tail);
  if (err) {
    const old = /version (\d+\.\d+\.\d+) or newer is required/i.exec(tail);
    const hint = old ? `
\u041D\u0443\u0436\u0435\u043D Claude Code ${old[1]}+ (\u0441\u0435\u0439\u0447\u0430\u0441 \u0434\u0440\u0443\u0433\u043E\u0439). \u041E\u0431\u043D\u043E\u0432\u0438 \u0438 \u043F\u043E\u0432\u0442\u043E\u0440\u0438.` : "";
    const bad = `\u26A0\uFE0F \u041D\u0435 \u043F\u0435\u0440\u0435\u043A\u043B\u044E\u0447\u0438\u043B \u043D\u0430 ${m.label} (${m.id})
${err[0].slice(0, 300)}${hint}`;
    if (messageId)
      return void call("editMessageText", { chat_id, message_id: messageId, text: bad }).catch(() => sendReply({ chat_id, text: bad }));
    return void sendReply({ chat_id, text: bad });
  }
  const txt = `\uD83E\uDDE0 \u041F\u0435\u0440\u0435\u043A\u043B\u044E\u0447\u0438\u043B \u043D\u0430 ${m.label}
(${m.id})${confirmed ? `
\u2705 \u0434\u0438\u0430\u043B\u043E\u0433 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u044F \u043D\u0430\u0436\u0430\u043B \u0437\u0430 \u0442\u0435\u0431\u044F` : ""}`;
  if (messageId)
    call("editMessageText", { chat_id, message_id: messageId, text: txt }).catch(() => sendReply({ chat_id, text: txt }));
  else
    sendReply({ chat_id, text: txt });
}
var EFFORTS = [
  { id: "low", label: "low \xB7 \u0431\u044B\u0441\u0442\u0440\u043E" },
  { id: "medium", label: "medium" },
  { id: "high", label: "high" },
  { id: "xhigh", label: "xhigh \xB7 \u0433\u043B\u0443\u0431\u043E\u043A\u043E" },
  { id: "max", label: "max \xB7 \u043C\u0430\u043A\u0441\u0438\u043C\u0443\u043C" },
  { id: "auto", label: "auto \xB7 \u043F\u043E \u0443\u043C\u043E\u043B\u0447\u0430\u043D\u0438\u044E \u043C\u043E\u0434\u0435\u043B\u0438" }
];
function sysEfforts(chat_id) {
  const buttons = [
    EFFORTS.slice(0, 3).map((e) => ({ text: e.label, data: `sys:effort:${e.id}` })),
    EFFORTS.slice(3, 5).map((e) => ({ text: e.label, data: `sys:effort:${e.id}` })),
    [{ text: EFFORTS[5].label, data: `sys:effort:${EFFORTS[5].id}` }]
  ];
  return sendReply({ chat_id, text: "\u26A1 \u0412\u044B\u0431\u0435\u0440\u0438 effort: \u043D\u0430\u0441\u043A\u043E\u043B\u044C\u043A\u043E \u0434\u043E\u043B\u0433\u043E \u043C\u043E\u0434\u0435\u043B\u044C \u0434\u0443\u043C\u0430\u0435\u0442 \u043F\u0435\u0440\u0435\u0434 \u043E\u0442\u0432\u0435\u0442\u043E\u043C (\u043D\u0430 \u043B\u0435\u0442\u0443, \u0431\u0435\u0437 \u0440\u0435\u0441\u0442\u0430\u0440\u0442\u0430):", buttons });
}
async function sysSetEffort(chat_id, level, messageId) {
  const out = (t) => messageId ? void call("editMessageText", { chat_id, message_id: messageId, text: t }).catch(() => sendReply({ chat_id, text: t })) : void sendReply({ chat_id, text: t });
  if (!EFFORTS.some((e) => e.id === level))
    return out(`\u041D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u044B\u0439 \u0443\u0440\u043E\u0432\u0435\u043D\u044C \xAB${level}\xBB. \u0412\u0430\u0440\u0438\u0430\u043D\u0442\u044B: ${EFFORTS.map((e) => e.id).join(", ")}`);
  if (!sh(["tmux", "has-session", "-t", TMUX_SESSION]).ok)
    return out(`\uD83D\uDD34 \u0421\u0435\u0441\u0441\u0438\u044F ${SESSION_LABEL} \u043D\u0435 \u0437\u0430\u043F\u0443\u0449\u0435\u043D\u0430 \u2014 \u043C\u0435\u043D\u044F\u0442\u044C effort \u043D\u0435\u043A\u043E\u043C\u0443.`);
  sh(["tmux", "send-keys", "-t", TMUX_SESSION, "-l", `/effort ${level}`]);
  sh(["tmux", "send-keys", "-t", TMUX_SESSION, "Enter"]);
  await sleep(2500);
  const re = /(?:Set effort level to|Effort level set to|Effort set to|Invalid argument|exceeds the cap|not supported|does not support)[^\n]*/gi;
  const last = [...paneTail(40).matchAll(re)].pop()?.[0]?.trim() ?? "";
  if (/^(?:Set effort level to|Effort level set to|Effort set to)/i.test(last) && last.toLowerCase().includes(level)) {
    const scope = /this session only/i.test(last) ? `
\u0414\u0435\u0439\u0441\u0442\u0432\u0443\u0435\u0442 \u0434\u043E \u0440\u0435\u0441\u0442\u0430\u0440\u0442\u0430 \u0441\u0435\u0441\u0441\u0438\u0438.` : /saved as your default/i.test(last) ? `
\u0421\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u043E \u043F\u043E \u0443\u043C\u043E\u043B\u0447\u0430\u043D\u0438\u044E, \u043F\u0435\u0440\u0435\u0436\u0438\u0432\u0451\u0442 \u0440\u0435\u0441\u0442\u0430\u0440\u0442.` : "";
    return out(`\u26A1 Effort: ${level}${scope}

${last.slice(0, 300)}`);
  }
  if (last && !/^(?:Set effort level to|Effort level set to|Effort set to)/i.test(last))
    return out(`\u26A0\uFE0F Effort \u043D\u0435 \u043F\u043E\u043C\u0435\u043D\u044F\u043B\u0441\u044F: ${last.slice(0, 300)}`);
  return out(`\u26A1 \u041E\u0442\u043F\u0440\u0430\u0432\u0438\u043B /effort ${level}, \u043D\u043E \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u044F \u043D\u0430 \u044D\u043A\u0440\u0430\u043D\u0435 \u043D\u0435 \u0432\u0438\u0436\u0443. \u041F\u0440\u043E\u0432\u0435\u0440\u044C: /screen`);
}
var PROMPT_POLL_MS = 5000;
var promptFp = "";
var promptSeen = 0;
var alertedFp = "";
function paneTail(lines = 30) {
  const c = sh(["tmux", "capture-pane", "-t", TMUX_SESSION, "-p"]);
  return c.ok ? c.out.split(`
`).filter((l) => l.trim()).slice(-lines).join(`
`) : "";
}
function detectPrompt() {
  const tail = paneTail();
  if (!/\u276F\s*\d+\./.test(tail))
    return null;
  const lines = tail.split(`
`);
  const opts = [];
  let firstOpt = -1;
  for (let i = 0;i < lines.length; i++) {
    const m = /^\s*(?:\u2502\s*)?\u276F?\s*(\d+)\.\s+(.+)$/.exec(lines[i]);
    if (m) {
      opts.push(`${m[1]}. ${m[2].trim()}`);
      if (firstOpt < 0)
        firstOpt = i;
    }
  }
  if (!opts.length)
    return null;
  const ctx = lines.slice(Math.max(0, firstOpt - 6), firstOpt).join(`
`);
  const block = `${ctx}

${opts.join(`
`)}`.trim().slice(-1500);
  return { fp: opts.join("|").slice(0, 300), block, nOpts: Math.min(opts.length, 8) };
}
async function relayPrompt(p) {
  const digits = Array.from({ length: p.nOpts }, (_, i) => ({ text: String(i + 1), data: `sys:tui:${i + 1}` }));
  const ctl = [{ text: "\u2328\uFE0F Enter", data: "sys:tui:enter" }, { text: "\u2716\uFE0F Esc", data: "sys:tui:esc" }, { text: "\uD83D\uDDA5 \u042D\u043A\u0440\u0430\u043D", data: "sys:screen" }];
  for (const admin of SYS_ADMINS) {
    await sendReply({ chat_id: admin, text: `\u26A0\uFE0F \u0412 \u0442\u0435\u0440\u043C\u0438\u043D\u0430\u043B\u0435 \u0441\u0435\u0441\u0441\u0438\u0438 \u0432\u0438\u0441\u0438\u0442 \u0432\u043E\u043F\u0440\u043E\u0441 \u2014 \u0432\u044B\u0431\u0435\u0440\u0438 \u043E\u0442\u0432\u0435\u0442 \u043A\u043D\u043E\u043F\u043A\u043E\u0439:

${p.block}`, buttons: [digits, ctl] }).catch((e) => LOG(`relayPrompt: ${e.message}`));
  }
  LOG(`relayed TUI prompt (${p.nOpts} options)`);
}
async function sysTuiKey(chat_id, key, messageId) {
  if (!sh(["tmux", "has-session", "-t", TMUX_SESSION]).ok)
    return void sendReply({ chat_id, text: `\uD83D\uDD34 \u0421\u0435\u0441\u0441\u0438\u044F ${SESSION_LABEL} \u043D\u0435 \u0437\u0430\u043F\u0443\u0449\u0435\u043D\u0430.` });
  if (key === "enter")
    sh(["tmux", "send-keys", "-t", TMUX_SESSION, "Enter"]);
  else if (key === "esc")
    sh(["tmux", "send-keys", "-t", TMUX_SESSION, "Escape"]);
  else {
    sh(["tmux", "send-keys", "-t", TMUX_SESSION, "-l", key]);
    sh(["tmux", "send-keys", "-t", TMUX_SESSION, "Enter"]);
  }
  alertedFp = promptFp;
  await sleep(1500);
  const out = paneTail(15).slice(-1200);
  const txt = `\u2328\uFE0F \u041D\u0430\u0436\u0430\u043B \xAB${key}\xBB

\uD83D\uDDA5 \u042D\u043A\u0440\u0430\u043D:
${out || "(\u043F\u0443\u0441\u0442\u043E)"}`;
  if (messageId)
    call("editMessageText", { chat_id, message_id: messageId, text: txt }).catch(() => sendReply({ chat_id, text: txt }));
  else
    sendReply({ chat_id, text: txt });
}
function sysRestartPrompt(chat_id) {
  return sendReply({ chat_id, text: `\uD83D\uDD04 \u041F\u0435\u0440\u0435\u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u044C \u0441\u0435\u0441\u0441\u0438\u044E ${SESSION_LABEL}? \u0414\u0435\u043C\u043E\u043D \u0443\u0431\u044C\u0451\u0442 \u0438 \u043F\u043E\u0434\u043D\u0438\u043C\u0435\u0442 \u0435\u0451 \u0437\u0430\u043D\u043E\u0432\u043E; \u0432\u0445\u043E\u0434\u044F\u0449\u0438\u0435 \u0432 \u044D\u0442\u043E \u0432\u0440\u0435\u043C\u044F \u0431\u0443\u0444\u0435\u0440\u0438\u0437\u0443\u044E\u0442\u0441\u044F \u0438 \u0434\u043E\u0433\u0440\u0443\u0437\u044F\u0442\u0441\u044F.`, buttons: [
    [{ text: "\u2705 \u041F\u043E\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u044C", data: "sys:restart:yes" }, { text: "\u274C \u041E\u0442\u043C\u0435\u043D\u0430", data: "sys:restart:no" }]
  ] });
}
var lastRestartAt = 0;
async function doRestart(chat_id, messageId) {
  const editOrSend = (t) => messageId ? call("editMessageText", { chat_id, message_id: messageId, text: t }).catch(() => {}) : sendReply({ chat_id, text: t });
  if (!SYS_RESTART_CMD)
    return void editOrSend("\u26A0\uFE0F \u0420\u0435\u0441\u0442\u0430\u0440\u0442 \u043D\u0435 \u043D\u0430\u0441\u0442\u0440\u043E\u0435\u043D \u043D\u0430 \u044D\u0442\u043E\u043C \u0438\u043D\u0441\u0442\u0430\u043D\u0441\u0435 (SYS_RESTART_CMD \u043F\u0443\u0441\u0442).");
  if (Date.now() - lastRestartAt < 60000)
    return void editOrSend("\u23F3 \u0420\u0435\u0441\u0442\u0430\u0440\u0442 \u0443\u0436\u0435 \u0437\u0430\u043F\u0443\u0441\u043A\u0430\u043B\u0441\u044F <1 \u043C\u0438\u043D \u043D\u0430\u0437\u0430\u0434. \u041F\u043E\u0434\u043E\u0436\u0434\u0438.");
  lastRestartAt = Date.now();
  await editOrSend(`\uD83D\uDD04 \u041F\u0435\u0440\u0435\u0437\u0430\u043F\u0443\u0441\u043A\u0430\u044E \u0441\u0435\u0441\u0441\u0438\u044E ${SESSION_LABEL}...`);
  const r = sh(["bash", SYS_RESTART_CMD], 20000);
  await sendReply({ chat_id, text: r.ok ? "\u2705 \u0420\u0435\u0441\u0442\u0430\u0440\u0442 \u0437\u0430\u043F\u0443\u0449\u0435\u043D. \u0421\u0435\u0441\u0441\u0438\u044F \u043F\u043E\u0434\u043D\u0438\u043C\u0435\u0442\u0441\u044F \u0437\u0430 ~15\u0441, \u043D\u043E\u0432\u044B\u0439 \u0438\u043D\u0441\u0442\u0430\u043D\u0441 \u043E\u0442\u0432\u0435\u0442\u0438\u0442 \u043A\u0430\u043A \u0431\u0443\u0434\u0435\u0442 \u0433\u043E\u0442\u043E\u0432." : `\u274C \u0420\u0435\u0441\u0442\u0430\u0440\u0442 \u043D\u0435 \u0443\u0434\u0430\u043B\u0441\u044F: ${r.out}` });
}
var BOT_COMMANDS = [
  { command: "menu", description: "\uD83C\uDF9B \u041F\u0430\u043D\u0435\u043B\u044C \u0443\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0438\u044F" },
  { command: "ping", description: "\u041F\u0440\u043E\u0432\u0435\u0440\u0438\u0442\u044C \u0436\u0438\u0432\u043E\u0441\u0442\u044C" },
  { command: "status", description: "\u041F\u043E\u0434\u0440\u043E\u0431\u043D\u044B\u0439 \u0441\u0442\u0430\u0442\u0443\u0441" },
  { command: "screen", description: "\u041F\u043E\u043A\u0430\u0437\u0430\u0442\u044C \u044D\u043A\u0440\u0430\u043D \u0441\u0435\u0441\u0441\u0438\u0438" },
  { command: "restart", description: "\u041F\u0435\u0440\u0435\u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u044C \u0441\u0435\u0441\u0441\u0438\u044E" },
  { command: "model", description: "\uD83E\uDDE0 \u0412\u044B\u0431\u0440\u0430\u0442\u044C \u043C\u043E\u0434\u0435\u043B\u044C" },
  { command: "effort", description: "\u26A1 \u0423\u0440\u043E\u0432\u0435\u043D\u044C effort" },
  { command: "mcp", description: "\uD83D\uDD0C \u0421\u0442\u0430\u0442\u0443\u0441 MCP-\u0441\u0435\u0440\u0432\u0435\u0440\u043E\u0432" },
  { command: "logs", description: "\u041B\u043E\u0433 gateway" }
];
async function registerCommands() {
  try {
    await call("setMyCommands", { commands: BOT_COMMANDS });
    LOG(`registered ${BOT_COMMANDS.length} bot commands`);
  } catch (e) {
    LOG(`setMyCommands failed: ${e.message}`);
  }
  try {
    await call("setChatMenuButton", { menu_button: { type: "commands" } });
  } catch {}
}
async function handleSysCommand(chat_id, text) {
  LOG(`sys cmd "${text}"`);
  let cmd;
  if (/^\/menu\b/i.test(text))
    cmd = "menu";
  else if (/^\/sys\b/i.test(text))
    cmd = (text.split(/\s+/)[1] ?? "help").toLowerCase();
  else
    cmd = text.split(/\s+/)[0].replace(/^\//, "").toLowerCase();
  switch (cmd) {
    case "menu":
      return sysMenu(chat_id);
    case "ping": {
      const s = sessionState();
      return sendReply({ chat_id, text: `\uD83D\uDFE2 gateway v${VERSION} \u0436\u0438\u0432. \u0421\u0435\u0441\u0441\u0438\u044F: ${s.alive ? "\uD83D\uDFE2 \u043E\u043D\u043B\u0430\u0439\u043D" : "\uD83D\uDD34 DOWN"} (${s.detail}). \u041F\u043E\u0441\u043B\u0435\u0434\u043D\u0438\u0439 \u043E\u043F\u0440\u043E\u0441 ${lastPollAgo()}\u0441 \u043D\u0430\u0437\u0430\u0434.` });
    }
    case "status":
      return sysStatus(chat_id);
    case "logs":
      return sysLogs(chat_id);
    case "screen":
      return sysScreen(chat_id);
    case "restart":
      return sysRestartPrompt(chat_id);
    case "model":
    case "models":
      return sysModels(chat_id);
    case "effort": {
      const lvl = (/^\/sys\b/i.test(text) ? text.split(/\s+/)[2] : text.split(/\s+/)[1])?.toLowerCase();
      return lvl ? sysSetEffort(chat_id, lvl) : sysEfforts(chat_id);
    }
    case "mcp":
      return sysMcp(chat_id);
    case "cc":
      return sysSendKeys(chat_id, text.replace(/^\/sys\s+cc\s*/i, ""));
    default:
      return sendReply({ chat_id, text: "\u041A\u043E\u043C\u0430\u043D\u0434\u044B: /menu \xB7 /sys ping \xB7 /sys status \xB7 /sys logs \xB7 /sys screen \xB7 /sys restart \xB7 /sys mcp \xB7 /model \xB7 /effort [low|medium|high|xhigh|max|auto] \xB7 /sys cc <\u043A\u043E\u043C\u0430\u043D\u0434\u0430> (\u043D\u0430\u043F\u0440. /sys cc /compact)" });
  }
}
async function pumpOutbox() {
  let files = [];
  try {
    files = readdirSync(OUTBOX).filter((f) => f.startsWith("req-") && f.endsWith(".json"));
  } catch {
    return;
  }
  for (const f of files) {
    const full = join(OUTBOX, f);
    let req;
    try {
      req = JSON.parse(readFileSync(full, "utf8"));
    } catch {
      unlinkSync(full);
      continue;
    }
    unlinkSync(full);
    if (req.tool === "ask") {
      try {
        await startAsk(req.id, req.args);
      } catch (e) {
        writeRes({ id: req.id, ok: false, error: e.message });
        LOG(`outbox ask error: ${e.message}`);
      }
      continue;
    }
    let res;
    try {
      res = { id: req.id, ok: true, result: await execTool(req.tool, req.args) };
    } catch (e) {
      res = { id: req.id, ok: false, error: e.message };
      LOG(`outbox ${req.tool} error: ${e.message}`);
    }
    writeRes(res);
  }
}
var BRAIN_STALE_MS = 150000;
var brainWasAlive = null;
function checkBrain() {
  let age = Infinity;
  try {
    age = Date.now() - statSync(BRIDGE_HEARTBEAT).mtimeMs;
  } catch {}
  const alive = age < BRAIN_STALE_MS;
  const tell = (t) => {
    for (const a of SYS_ADMINS)
      sendReply({ chat_id: a, text: t }).catch(() => {});
  };
  if (brainWasAlive === null) {
    brainWasAlive = alive;
    if (!alive)
      tell(`\uD83D\uDD34 \u0421\u0435\u0441\u0441\u0438\u044F ${SESSION_LABEL} \u043D\u0435 \u043D\u0430 \u0441\u0432\u044F\u0437\u0438 (heartbeat \u043C\u043E\u0441\u0442\u0430 ${age === Infinity ? "\u043E\u0442\u0441\u0443\u0442\u0441\u0442\u0432\u0443\u0435\u0442" : "\u0443\u0441\u0442\u0430\u0440\u0435\u043B"}). \u0412\u0445\u043E\u0434\u044F\u0449\u0438\u0435 \u0431\u0443\u0444\u0435\u0440\u0438\u0437\u0443\u044E\u0442\u0441\u044F. \u041F\u043E\u0434\u043D\u0438\u043C\u0438 \u0435\u0451: /restart`);
  } else if (brainWasAlive && !alive) {
    brainWasAlive = false;
    tell(`\uD83D\uDD34 \u0421\u0435\u0441\u0441\u0438\u044F ${SESSION_LABEL} \u043C\u043E\u043B\u0447\u0438\u0442 ~${Math.round(age / 60000)} \u043C\u0438\u043D \u2014 \u043C\u043E\u0441\u0442 \u043F\u0435\u0440\u0435\u0441\u0442\u0430\u043B \u0441\u043B\u0430\u0442\u044C heartbeat. \u0412\u0445\u043E\u0434\u044F\u0449\u0438\u0435 \u0431\u0443\u0444\u0435\u0440\u0438\u0437\u0443\u044E\u0442\u0441\u044F \u0438 \u0434\u043E\u0435\u0434\u0443\u0442. \u0416\u043C\u0438 /restart, \u0434\u0435\u0442\u0430\u043B\u0438: /status`);
  } else if (!brainWasAlive && alive) {
    brainWasAlive = true;
    tell(`\uD83D\uDFE2 \u0421\u0435\u0441\u0441\u0438\u044F ${SESSION_LABEL} \u0441\u043D\u043E\u0432\u0430 \u043D\u0430 \u0441\u0432\u044F\u0437\u0438 \u2014 heartbeat \u043F\u043E\u0448\u0451\u043B, \u0431\u044D\u043A\u043B\u043E\u0433 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0439 \u0434\u043E\u0435\u0437\u0436\u0430\u0435\u0442.`);
  }
}
var AUTH_DOWN_RE = /Please run \/login|Invalid authentication credentials|API Error:\s*401|Credit balance is too low|OAuth token has expired/i;
function detectAuthDown() {
  return AUTH_DOWN_RE.test(paneTail(40));
}
var authWasDown = false;
var authDownStreak = 0;
function checkAuth() {
  if (detectAuthDown())
    authDownStreak++;
  else
    authDownStreak = 0;
  const isDown = authDownStreak >= 2;
  const tell = (t) => {
    for (const a of SYS_ADMINS)
      sendReply({ chat_id: a, text: t }).catch(() => {});
  };
  if (!authWasDown && isDown) {
    authWasDown = true;
    tell("\uD83D\uDD34 Claude \u0440\u0430\u0437\u043B\u043E\u0433\u0438\u043D\u0438\u043B\u0441\u044F \u2014 API 401. \u0421\u0435\u0441\u0441\u0438\u044F \u0436\u0438\u0432\u0430, \u043D\u043E \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u044F \u0421\u0415\u0419\u0427\u0410\u0421 \u041D\u0415 \u043E\u0431\u0440\u0430\u0431\u0430\u0442\u044B\u0432\u0430\u044E\u0442\u0441\u044F. \u0417\u0430\u043B\u043E\u0433\u0438\u043D\u044C \u0435\u0451 (/login \u0432 \u0442\u0435\u0440\u043C\u0438\u043D\u0430\u043B\u0435) \u0438\u043B\u0438 \u0436\u043C\u0438 /restart.");
  } else if (authWasDown && authDownStreak === 0) {
    authWasDown = false;
    tell("\uD83D\uDFE2 \u0410\u0432\u0442\u043E\u0440\u0438\u0437\u0430\u0446\u0438\u044F Claude \u0432\u043E\u0441\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u0430 \u2014 \u0441\u043D\u043E\u0432\u0430 \u043D\u0430 \u0441\u0432\u044F\u0437\u0438, \u0431\u044D\u043A\u043B\u043E\u0433 \u0434\u043E\u0435\u0434\u0435\u0442.");
  }
}
function brainDownNow() {
  if (detectAuthDown())
    return "auth";
  let age = Infinity;
  try {
    age = Date.now() - statSync(BRIDGE_HEARTBEAT).mtimeMs;
  } catch {}
  return age >= BRAIN_STALE_MS ? "dead" : "";
}
function cleanupRes() {
  try {
    for (const f of readdirSync(OUTBOX_RES)) {
      const p = join(OUTBOX_RES, f);
      try {
        if (Date.now() - statSync(p).mtimeMs > 3600000)
          unlinkSync(p);
      } catch {}
    }
  } catch {}
}
var offset = 0;
try {
  offset = Number(readFileSync(OFFSET_FILE, "utf8")) || 0;
} catch {}
function saveOffset() {
  try {
    writeFileSync(OFFSET_FILE, String(offset));
  } catch {}
}
var netBackoff = 1000;
var conflictPause = 5000;
var running = true;
process.on("SIGTERM", () => {
  LOG("SIGTERM, stopping");
  saveOffset();
  releaseLock();
  process.exit(0);
});
process.on("SIGINT", () => {
  saveOffset();
  releaseLock();
  process.exit(0);
});
process.on("uncaughtException", (e) => {
  LOG(`FATAL uncaughtException: ${e?.stack || e}`);
  releaseLock();
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  LOG(`FATAL unhandledRejection: ${e?.stack || e}`);
  releaseLock();
  process.exit(1);
});
async function main() {
  acquireLock();
  LOG(`starting v${VERSION}. state=${STATE_DIR} offset=${offset}`);
  status.lastPollOk = new Date().toISOString();
  writeStatus();
  try {
    await call("deleteWebhook", { drop_pending_updates: false }, 1e4);
  } catch (e) {
    LOG(`deleteWebhook: ${e.message}`);
  }
  registerCommands().catch(() => {});
  setInterval(() => {
    pumpOutbox().catch((e) => LOG(`outbox pump: ${e.message}`));
  }, 400);
  setInterval(() => {
    try {
      const p = detectPrompt();
      if (!p) {
        promptFp = "";
        promptSeen = 0;
        alertedFp = "";
        return;
      }
      if (p.fp === promptFp)
        promptSeen++;
      else {
        promptFp = p.fp;
        promptSeen = 1;
      }
      if (promptSeen === 2 && alertedFp !== p.fp) {
        alertedFp = p.fp;
        relayPrompt(p);
      }
    } catch (e) {
      LOG(`prompt watcher: ${e.message}`);
    }
  }, PROMPT_POLL_MS);
  setInterval(() => {
    const now = Date.now();
    for (const [key, started] of typingChats) {
      if (now - started > TYPING_MAX_MS) {
        typingChats.delete(key);
        continue;
      }
      const [chat, thread] = key.split(":");
      call("sendChatAction", { chat_id: chat, ...thread ? { message_thread_id: Number(thread) } : {}, action: "typing" }).catch(() => {});
    }
  }, 4500);
  setInterval(() => {
    writeStatus();
    const age = Date.now() - new Date(status.lastPollOk).getTime();
    if (age > STALE_MS) {
      LOG(`FATAL: no successful poll in ${Math.round(age / 1000)}s \u2014 wedged. exiting for supervisor restart.`);
      releaseLock();
      process.exit(1);
    }
    checkBrain();
    checkAuth();
    cleanupRes();
  }, 15000);
  while (running) {
    try {
      const updates = await call("getUpdates", { offset, timeout: 50, allowed_updates: ["message", "edited_message", "callback_query"] });
      netBackoff = 1000;
      conflictPause = 5000;
      status.lastPollOk = new Date().toISOString();
      for (const u of updates) {
        await handleUpdate(u);
        offset = u.update_id + 1;
        status.updatesSeen++;
        status.lastInbound = new Date().toISOString();
      }
      if (updates.length)
        saveOffset();
    } catch (e) {
      status.lastError = `${new Date().toISOString()} ${e.message}`;
      if (e instanceof TgError && e.status === 409) {
        status.conflicts++;
        LOG(`409 Conflict (another poller / stale session). pausing ${conflictPause / 1000}s`);
        try {
          await call("deleteWebhook", { drop_pending_updates: false }, 1e4);
        } catch {}
        await sleep(conflictPause);
        conflictPause = Math.min(conflictPause + 1e4, 55000);
      } else if (e instanceof TgError && e.status === 401) {
        LOG("FATAL 401 Unauthorized: bad token");
        releaseLock();
        process.exit(1);
      } else {
        LOG(`poll error: ${e.message}. backoff ${netBackoff / 1000}s`);
        await sleep(netBackoff);
        netBackoff = Math.min(netBackoff * 2, 60000);
      }
    }
  }
  saveOffset();
  writeStatus();
  releaseLock();
  LOG("stopped");
  process.exit(0);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function writeEnvFile(kv) {
  const existing = {};
  try {
    for (const line of readFileSync(CONFIG_ENV_FILE, "utf8").split(`
`)) {
      const s = line.trim();
      if (s && !s.startsWith("#") && s.includes("=")) {
        const i = s.indexOf("=");
        existing[s.slice(0, i).trim()] = s.slice(i + 1).trim();
      }
    }
  } catch {}
  const merged = { ...existing, ...kv };
  const body = "# tg-gateway config (written by `pair`). Keep private \u2014 contains the bot token.\n" + Object.entries(merged).map(([k, v]) => `${k}=${v}`).join(`
`) + `
`;
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = CONFIG_ENV_FILE + ".tmp";
  writeFileSync(tmp, body, { mode: 384 });
  renameSync(tmp, CONFIG_ENV_FILE);
}
async function pairMode() {
  process.stderr.write(`
[pair] \u041E\u0442\u043A\u0440\u043E\u0439 Telegram, \u043D\u0430\u0439\u0434\u0438 \u0441\u0432\u043E\u0435\u0433\u043E \u0431\u043E\u0442\u0430 \u0438 \u043E\u0442\u043F\u0440\u0430\u0432\u044C \u0435\u043C\u0443 \u043B\u044E\u0431\u043E\u0435 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435 (\u043D\u0430\u043F\u0440\u0438\u043C\u0435\u0440 /start).
[pair] \u0416\u0434\u0443 \u0434\u043E 5 \u043C\u0438\u043D\u0443\u0442...

`);
  try {
    await call("deleteWebhook", { drop_pending_updates: true }, 1e4);
  } catch {}
  let offset2 = 0;
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    let updates = [];
    try {
      updates = await call("getUpdates", { offset: offset2, timeout: 25, allowed_updates: ["message"] });
    } catch (e) {
      process.stderr.write(`[pair] \u043E\u043F\u0440\u043E\u0441 \u043D\u0435 \u0443\u0434\u0430\u043B\u0441\u044F: ${e.message}
`);
      await sleep(2000);
      continue;
    }
    for (const u of updates) {
      offset2 = u.update_id + 1;
      const msg = u.message ?? u.edited_message;
      if (!msg)
        continue;
      const chatId = String(msg.chat.id);
      const who = msg.from?.username ? `@${msg.from.username}` : msg.from?.first_name ?? "user";
      writeEnvFile({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_SYS_ADMINS: chatId, TELEGRAM_ALLOWED_CHATS: chatId });
      try {
        await call("sendMessage", { chat_id: chatId, text: "\u2705 \u0421\u043F\u0430\u0440\u0435\u043D\u043E. \u042D\u0442\u043E\u0442 \u0447\u0430\u0442 \u0443\u043F\u0440\u0430\u0432\u043B\u044F\u0435\u0442 \u0442\u0432\u043E\u0438\u043C Claude; \u0434\u043B\u044F \u043E\u0441\u0442\u0430\u043B\u044C\u043D\u044B\u0445 \u0431\u043E\u0442 \u0437\u0430\u043A\u0440\u044B\u0442." });
      } catch {}
      process.stderr.write(`[pair] OK \u2014 chat_id=${chatId} (${who}), \u043A\u043E\u043D\u0444\u0438\u0433 \u0437\u0430\u043F\u0438\u0441\u0430\u043D: ${CONFIG_ENV_FILE}
`);
      process.exit(0);
    }
  }
  process.stderr.write(`[pair] \u0422\u0430\u0439\u043C\u0430\u0443\u0442: \u0437\u0430 5 \u043C\u0438\u043D\u0443\u0442 \u043D\u0435 \u043F\u0440\u0438\u0448\u043B\u043E \u043D\u0438 \u043E\u0434\u043D\u043E\u0433\u043E \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u044F. \u0417\u0430\u043F\u0443\u0441\u0442\u0438 setup \u0435\u0449\u0451 \u0440\u0430\u0437.
`);
  process.exit(1);
}
var MODE = process.argv.slice(2).find((a) => !a.startsWith("-"));
if (MODE === "pair" || MODE === "setup")
  pairMode();
else
  main();
