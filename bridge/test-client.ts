#!/usr/bin/env bun
/**
 * Integration harness: acts as Claude Code would over `--channels`.
 * Spawns the bridge via stdio, then verifies:
 *   1. tools/list exposes the channel tools
 *   2. a daemon-written inbox file is forwarded as notifications/claude/channel
 *   3. the status tool returns live daemon health
 *   4. a network tool (react) round-trips through outbox -> daemon -> Telegram
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync, renameSync, mkdirSync } from "fs";
import { join } from "path";

const STATE = process.env.TELEGRAM_STATE_DIR || "/tmp/tg-bridge-test";
const INBOX = join(STATE, "inbox");
mkdirSync(INBOX, { recursive: true });

const got: any[] = [];
const client = new Client({ name: "test-harness", version: "0.0.1" }, { capabilities: {} });
client.fallbackNotificationHandler = async (n: any) => {
  if (n.method === "notifications/claude/channel") { got.push(n.params); console.log("  CHANNEL NOTIF:", JSON.stringify(n.params)); }
};

const transport = new StdioClientTransport({
  command: "node",
  args: ["./bridge/dist/bridge.js"],
  env: { ...process.env, TELEGRAM_STATE_DIR: STATE },
  stderr: "inherit",
});
await client.connect(transport);
console.log("connected to bridge");

// 1. tools/list
const tools = await client.listTools();
const names = tools.tools.map((t: any) => t.name);
console.log("1) TOOLS:", names.join(", "), names.length === 5 ? "[OK 5]" : `[expected 5, got ${names.length}]`);

// 2. channel notification — drop a synthetic inbound (as the daemon would)
const msg = { chat_id: "123456789", message_id: "9991", user: "your_username", user_id: "123456789", ts: new Date().toISOString(), text: "synthetic channel test" };
const tmp = join(INBOX, ".syn.tmp"); writeFileSync(tmp, JSON.stringify(msg)); renameSync(tmp, join(INBOX, `${Date.now()}-9991.json`));
for (let i = 0; i < 40 && got.length === 0; i++) await new Promise(r => setTimeout(r, 100));
console.log("2) CHANNEL FORWARD:", got.length ? "[OK delivered]" : "[FAIL no notification]");

// 3. status tool
try { const s: any = await client.callTool({ name: "status", arguments: {} }); console.log("3) STATUS:", s.content[0].text); }
catch (e: any) { console.log("3) STATUS ERR:", e.message); }

// 4. react — outbox -> daemon -> Telegram (best-effort; proves the network path)
try { const r: any = await client.callTool({ name: "react", arguments: { chat_id: "123456789", message_id: "2", emoji: "👀" } }); console.log("4) REACT:", r.content[0].text, r.isError ? "[isError]" : "[OK]"); }
catch (e: any) { console.log("4) REACT ERR:", e.message); }

await client.close();
process.exit(0);
