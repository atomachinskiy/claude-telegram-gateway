#!/usr/bin/env bun
// @bun

// gateway/gateway.ts
import { homedir } from "os";
import { join } from "path";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync, renameSync, statSync } from "fs";
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
var VERSION = "1.0.0";
var STALE_MS = 180000;
var SYS_ADMINS = new Set((process.env.TELEGRAM_SYS_ADMINS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
var ALLOWED_CHATS = new Set([
  ...(process.env.TELEGRAM_ALLOWED_CHATS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  ...SYS_ADMINS
]);
function isAllowedChat(chatId, userId) {
  return ALLOWED_CHATS.has("*") || ALLOWED_CHATS.has(chatId) || SYS_ADMINS.has(userId);
}
var TMUX_SESSION = process.env.CLAUDE_TMUX ?? "claude";
var SYS_RESTART_CMD = process.env.SYS_RESTART_CMD ?? "";
var BRIDGE_HEARTBEAT = join(STATE_DIR, "bridge.heartbeat");
var ACK_EMOJI = process.env.TELEGRAM_ACK_EMOJI ?? "\uD83D\uDC40";
var TYPING_MAX_MS = 8 * 60000;
var typingChats = new Map;
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
var API = `https://api.telegram.org/bot${TOKEN}`;
var FILE_API = `https://api.telegram.org/file/bot${TOKEN}`;

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
function writeInbox(name, obj) {
  const tmp = join(INBOX, `.${name}.tmp`);
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, join(INBOX, name));
}
async function downloadFile(fileId, suggestExt) {
  const f = await call("getFile", { file_id: fileId });
  const path = f.file_path;
  const ext = suggestExt ?? (path.includes(".") ? path.split(".").pop() : "bin");
  const dest = join(INBOX, `${Date.now()}-${fileId}.${ext}`);
  const resp = await fetch(`${FILE_API}/${path}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  writeFileSync(dest, buf);
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
    if (rest.startsWith("tui:"))
      return void sysTuiKey(chat_id, rest.slice(4), messageId);
    return;
  }
  const from = cq.from ?? {};
  const msg = cq.message ?? {};
  if (!isAllowedChat(String(msg.chat?.id ?? from.id ?? ""), String(from.id ?? ""))) {
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
  writeInbox(`${Date.now()}-cbm-${cq.id}.json`, base);
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
  if (!isAllowedChat(gateChat, gateUser)) {
    LOG(`DROP non-allowed chat ${gateChat} user ${gateUser} (@${from.username ?? "?"}): ${(msg.text ?? "[media]").slice(0, 80)}`);
    return;
  }
  const text0 = (msg.text ?? "").trim();
  if (/^\/(sys|menu|ping|status|restart|screen|logs|model|models|mcp)\b/i.test(text0)) {
    if (!SYS_ADMINS.has(String(from.id ?? ""))) {
      await call("sendMessage", { chat_id: String(msg.chat.id), text: "\u26D4 \u041A\u043E\u043C\u0430\u043D\u0434\u044B \u0443\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0438\u044F \u0434\u043E\u0441\u0442\u0443\u043F\u043D\u044B \u0442\u043E\u043B\u044C\u043A\u043E \u0432\u043B\u0430\u0434\u0435\u043B\u044C\u0446\u0443." }).catch(() => {});
      return;
    }
    return void handleSysCommand(String(msg.chat.id), text0).catch((e) => LOG(`sys cmd error: ${e.message}`));
  }
  call("setMessageReaction", { chat_id: String(msg.chat.id), message_id: Number(msg.message_id), reaction: [{ type: "emoji", emoji: pickReaction(msg.text ?? msg.caption ?? "") }] }).catch(() => {});
  call("sendChatAction", { chat_id: String(msg.chat.id), action: "typing" }).catch(() => {});
  typingChats.set(String(msg.chat.id), Date.now());
  const base = {
    chat_id: String(msg.chat.id),
    message_id: String(msg.message_id),
    user: from.username ?? `${from.first_name ?? "user"}`,
    user_id: String(from.id ?? msg.chat.id),
    ts: new Date((msg.date ?? Date.now() / 1000) * 1000).toISOString()
  };
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
    } else if (msg.document) {
      base.text = msg.caption ?? "";
      base.attachment_file_id = msg.document.file_id;
      base.attachment_kind = "document";
      base.attachment_mime = msg.document.mime_type;
    } else if (msg.video) {
      base.text = msg.caption ?? "";
      base.attachment_file_id = msg.video.file_id;
      base.attachment_kind = "video";
    } else if (msg.text) {
      base.text = msg.text;
    } else {
      base.text = msg.caption ?? "[unsupported message type]";
    }
  } catch (e) {
    LOG(`media handling error: ${e.message}`);
    base.text = base.text ?? "[media download failed]";
  }
  writeInbox(`${Date.now()}-${msg.message_id}.json`, base);
  LOG(`inbox <- chat ${base.chat_id} msg ${base.message_id} ${base.image_path ? "[photo]" : base.attachment_kind ? `[${base.attachment_kind}]${base.voice_transcribed ? "+stt" : ""}` : ""}`);
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
async function sendReply(args) {
  const { chat_id, text, format, reply_to, files, disable_notification } = args;
  typingChats.delete(String(chat_id));
  const parse_mode = format === "markdownv2" ? "MarkdownV2" : undefined;
  const reply_markup = normalizeButtons(args.buttons);
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
      const tail = await sendReply({ chat_id, text: rest, format, disable_notification, buttons: args.buttons });
      ids.push(...tail.message_ids ?? []);
    }
    return { message_ids: ids };
  }
  const parts = chunk(text ?? "");
  for (let i = 0;i < parts.length; i++) {
    const quiet = disable_notification || i < parts.length - 1;
    const last = i === parts.length - 1;
    const body = { chat_id, text: parts[i] };
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
        const res = await call("sendMessage", { chat_id, text: unescapeMd(parts[i]), ...quiet ? { disable_notification: true } : {}, ...reply_markup && last ? { reply_markup } : {}, ...reply_to && i === 0 ? { reply_to_message_id: reply_to } : {} });
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
  const sent = await sendReply({ chat_id, text: question, format: args.format, buttons });
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
  return sendReply({ chat_id, text: "\uD83C\uDF9B \u041F\u0430\u043D\u0435\u043B\u044C \u0443\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0438\u044F Claude", buttons: [
    [{ text: "\uD83D\uDCCA \u0421\u0442\u0430\u0442\u0443\u0441", data: "sys:status" }, { text: "\uD83D\uDD04 \u0420\u0435\u0441\u0442\u0430\u0440\u0442", data: "sys:restart" }],
    [{ text: "\uD83D\uDCDC \u041B\u043E\u0433\u0438", data: "sys:logs" }, { text: "\uD83D\uDDA5 \u042D\u043A\u0440\u0430\u043D", data: "sys:screen" }],
    [{ text: "\uD83D\uDDDC /compact", data: "sys:cc:/compact" }, { text: "\uD83E\uDDF9 /clear", data: "sys:cc:/clear" }],
    [{ text: "\uD83E\uDDE0 \u041C\u043E\u0434\u0435\u043B\u044C", data: "sys:models" }, { text: "\uD83D\uDD0C MCP", data: "sys:mcp" }]
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
    return sendReply({ chat_id, text: `\uD83D\uDDA5 \u042D\u043A\u0440\u0430\u043D \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D: ${c.out || "\u043D\u0435\u0442 \u0441\u0435\u0441\u0441\u0438\u0438 " + TMUX_SESSION}` });
  const out = c.out.split(`
`).filter((l) => l.trim()).slice(-40).join(`
`).slice(-3500);
  return sendReply({ chat_id, text: `\uD83D\uDDA5 \u042D\u043A\u0440\u0430\u043D Claude:

` + (out || "(\u043F\u0443\u0441\u0442\u043E)") });
}
async function sysMcp(chat_id) {
  if (!sh(["tmux", "has-session", "-t", TMUX_SESSION]).ok)
    return sendReply({ chat_id, text: `\uD83D\uDD34 \u0421\u0435\u0441\u0441\u0438\u044F ${TMUX_SESSION} \u043D\u0435 \u0437\u0430\u043F\u0443\u0449\u0435\u043D\u0430 \u2014 \u043F\u0430\u043D\u0435\u043B\u044C /mcp \u043F\u043E\u043A\u0430\u0437\u044B\u0432\u0430\u0442\u044C \u043D\u0435\u0433\u0434\u0435.` });
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
    return sendReply({ chat_id, text: `\uD83D\uDD34 \u0421\u0435\u0441\u0441\u0438\u044F ${TMUX_SESSION} \u043D\u0435 \u0437\u0430\u043F\u0443\u0449\u0435\u043D\u0430 - \u043A\u043E\u043C\u0430\u043D\u0434\u0443 \u043D\u0435\u043A\u0443\u0434\u0430 \u0441\u043B\u0430\u0442\u044C.` });
  const r1 = sh(["tmux", "send-keys", "-t", TMUX_SESSION, "-l", keys]);
  const r2 = sh(["tmux", "send-keys", "-t", TMUX_SESSION, "Enter"]);
  if (!r1.ok || !r2.ok)
    return sendReply({ chat_id, text: `send-keys \u043E\u0448\u0438\u0431\u043A\u0430: ${r1.out || r2.out}` });
  await sleep(1500);
  const cap = sh(["tmux", "capture-pane", "-t", TMUX_SESSION, "-p"]);
  const out = cap.ok ? cap.out.split(`
`).filter((l) => l.trim()).slice(-30).join(`
`).slice(-3000) : "(\u044D\u043A\u0440\u0430\u043D \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D)";
  return sendReply({ chat_id, text: `\u2328\uFE0F \u041E\u0442\u043F\u0440\u0430\u0432\u0438\u043B \u0432 Claude: ${keys}

\uD83D\uDDA5 \u042D\u043A\u0440\u0430\u043D:
${out}` });
}
var MODELS = [
  { label: "Opus 4.8 (1M)", id: "claude-opus-4-8[1m]" },
  { label: "Opus 4.8", id: "claude-opus-4-8" },
  { label: "Sonnet 4.6", id: "claude-sonnet-4-6" },
  { label: "Haiku 4.5", id: "claude-haiku-4-5-20251001" },
  { label: "Fable 5", id: "claude-fable-5" }
];
function sysModels(chat_id) {
  const buttons = MODELS.map((m, i) => [{ text: m.label, data: `sys:model:${i}` }]);
  return sendReply({ chat_id, text: "\uD83E\uDDE0 \u0412\u044B\u0431\u0435\u0440\u0438 \u043C\u043E\u0434\u0435\u043B\u044C (\u043F\u0435\u0440\u0435\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u0435 \u043D\u0430 \u043B\u0435\u0442\u0443, \u0431\u0435\u0437 \u0440\u0435\u0441\u0442\u0430\u0440\u0442\u0430):", buttons });
}
async function sysSetModel(chat_id, idx, messageId) {
  const m = MODELS[Number(idx)];
  if (!m)
    return void sendReply({ chat_id, text: "\u041D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u0430\u044F \u043C\u043E\u0434\u0435\u043B\u044C." });
  if (!sh(["tmux", "has-session", "-t", TMUX_SESSION]).ok)
    return void sendReply({ chat_id, text: `\uD83D\uDD34 \u0421\u0435\u0441\u0441\u0438\u044F ${TMUX_SESSION} \u043D\u0435 \u0437\u0430\u043F\u0443\u0449\u0435\u043D\u0430 \u2014 \u043F\u0435\u0440\u0435\u043A\u043B\u044E\u0447\u0430\u0442\u044C \u043D\u0435\u043A\u043E\u0433\u043E.` });
  sh(["tmux", "send-keys", "-t", TMUX_SESSION, "-l", `/model ${m.id}`]);
  sh(["tmux", "send-keys", "-t", TMUX_SESSION, "Enter"]);
  await sleep(2500);
  let confirmed = false;
  if (/Switch model\?/i.test(paneTail())) {
    sh(["tmux", "send-keys", "-t", TMUX_SESSION, "Enter"]);
    confirmed = true;
    await sleep(1200);
  }
  const txt = `\uD83E\uDDE0 \u041F\u0435\u0440\u0435\u043A\u043B\u044E\u0447\u0438\u043B \u043D\u0430 ${m.label}
(${m.id})${confirmed ? `
\u2705 \u0434\u0438\u0430\u043B\u043E\u0433 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u044F \u043D\u0430\u0436\u0430\u043B \u0437\u0430 \u0442\u0435\u0431\u044F` : ""}`;
  if (messageId)
    call("editMessageText", { chat_id, message_id: messageId, text: txt }).catch(() => sendReply({ chat_id, text: txt }));
  else
    sendReply({ chat_id, text: txt });
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
    return void sendReply({ chat_id, text: `\uD83D\uDD34 \u0421\u0435\u0441\u0441\u0438\u044F ${TMUX_SESSION} \u043D\u0435 \u0437\u0430\u043F\u0443\u0449\u0435\u043D\u0430.` });
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
  return sendReply({ chat_id, text: "\uD83D\uDD04 \u041F\u0435\u0440\u0435\u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u044C \u0441\u0435\u0441\u0441\u0438\u044E Claude? \u0414\u0435\u043C\u043E\u043D \u0443\u0431\u044C\u0451\u0442 \u0438 \u043F\u043E\u0434\u043D\u0438\u043C\u0435\u0442 \u0435\u0451 \u0437\u0430\u043D\u043E\u0432\u043E; \u0432\u0445\u043E\u0434\u044F\u0449\u0438\u0435 \u0432 \u044D\u0442\u043E \u0432\u0440\u0435\u043C\u044F \u0431\u0443\u0444\u0435\u0440\u0438\u0437\u0443\u044E\u0442\u0441\u044F \u0438 \u0434\u043E\u0433\u0440\u0443\u0437\u044F\u0442\u0441\u044F.", buttons: [
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
  await editOrSend("\uD83D\uDD04 \u041F\u0435\u0440\u0435\u0437\u0430\u043F\u0443\u0441\u043A\u0430\u044E \u0441\u0435\u0441\u0441\u0438\u044E Claude...");
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
    case "mcp":
      return sysMcp(chat_id);
    case "cc":
      return sysSendKeys(chat_id, text.replace(/^\/sys\s+cc\s*/i, ""));
    default:
      return sendReply({ chat_id, text: "\u041A\u043E\u043C\u0430\u043D\u0434\u044B: /menu \xB7 /sys ping \xB7 /sys status \xB7 /sys logs \xB7 /sys screen \xB7 /sys restart \xB7 /sys mcp \xB7 /sys cc <\u043A\u043E\u043C\u0430\u043D\u0434\u0430> (\u043D\u0430\u043F\u0440. /sys cc /compact)" });
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
      tell(`\uD83D\uDD34 \u0421\u0435\u0441\u0441\u0438\u044F Claude \u043D\u0435 \u043D\u0430 \u0441\u0432\u044F\u0437\u0438 (heartbeat \u043C\u043E\u0441\u0442\u0430 ${age === Infinity ? "\u043E\u0442\u0441\u0443\u0442\u0441\u0442\u0432\u0443\u0435\u0442" : "\u0443\u0441\u0442\u0430\u0440\u0435\u043B"}). \u0412\u0445\u043E\u0434\u044F\u0449\u0438\u0435 \u0431\u0443\u0444\u0435\u0440\u0438\u0437\u0443\u044E\u0442\u0441\u044F. \u041F\u043E\u0434\u043D\u0438\u043C\u0438 \u0435\u0451: /restart`);
  } else if (brainWasAlive && !alive) {
    brainWasAlive = false;
    tell(`\uD83D\uDD34 \u0421\u0435\u0441\u0441\u0438\u044F Claude \u043C\u043E\u043B\u0447\u0438\u0442 ~${Math.round(age / 60000)} \u043C\u0438\u043D \u2014 \u043C\u043E\u0441\u0442 \u043F\u0435\u0440\u0435\u0441\u0442\u0430\u043B \u0441\u043B\u0430\u0442\u044C heartbeat. \u0412\u0445\u043E\u0434\u044F\u0449\u0438\u0435 \u0431\u0443\u0444\u0435\u0440\u0438\u0437\u0443\u044E\u0442\u0441\u044F \u0438 \u0434\u043E\u0435\u0434\u0443\u0442. \u0416\u043C\u0438 /restart, \u0434\u0435\u0442\u0430\u043B\u0438: /status`);
  } else if (!brainWasAlive && alive) {
    brainWasAlive = true;
    tell("\uD83D\uDFE2 \u0421\u0435\u0441\u0441\u0438\u044F Claude \u0441\u043D\u043E\u0432\u0430 \u043D\u0430 \u0441\u0432\u044F\u0437\u0438 \u2014 heartbeat \u043F\u043E\u0448\u0451\u043B, \u0431\u044D\u043A\u043B\u043E\u0433 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0439 \u0434\u043E\u0435\u0437\u0436\u0430\u0435\u0442.");
  }
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
    for (const [chat, started] of typingChats) {
      if (now - started > TYPING_MAX_MS) {
        typingChats.delete(chat);
        continue;
      }
      call("sendChatAction", { chat_id: chat, action: "typing" }).catch(() => {});
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
