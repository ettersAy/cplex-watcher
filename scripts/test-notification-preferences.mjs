#!/usr/bin/env node
/** No-network tests of the real Telegram webhook and personal command dispatch. */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../cloudflare-worker/src.js", import.meta.url), "utf8")
  .replace("export default {", "globalThis.__worker = {");
await import(`data:text/javascript,${encodeURIComponent(source)}`);
const key = createHmac("sha256", "test-secret").update("101").digest("hex");
const env = {
  TELEGRAM_PREFERENCES_KEY: "test-secret", TELEGRAM_BOT_TOKEN: "999:synthetic",
  TELEGRAM_CHAT_IDS: "201", TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
  GITHUB_REPOSITORY: "owner/repo", GITHUB_ACTIONS_TOKEN: "test-github-token",
};
const sent = [];
const dispatched = [];
let dispatchFails = false;
globalThis.fetch = async (url, options) => {
  if (url.includes("/contents/notification-preferences.json")) {
    return Response.json({ content: Buffer.from(JSON.stringify({ recipients: { [key]: {} } })).toString("base64") });
  }
  if (url.includes("/telegram-reminders.yml/dispatches")) {
    dispatched.push(JSON.parse(options.body));
    return new Response(null, { status: dispatchFails ? 403 : 204 });
  }
  if (url.includes("/sendMessage")) {
    sent.push(JSON.parse(options.body));
    return Response.json({ ok: true });
  }
  throw new Error(`Unexpected fetch: ${url}`);
};

async function command(text, chatId = "101", secret = "webhook-secret", reply) {
  return globalThis.__worker.fetch(new Request("https://worker.test/telegram", {
    method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
    body: JSON.stringify({ message: { chat: { id: chatId, type: "private" }, from: { id: chatId, is_bot: false }, text, reply_to_message: reply } }),
  }), env);
}

assert.equal((await command("/stop reminder", "101", "invalid")).status, 403);
await command("/stop reminder", "301");
await command("/watchseat Some Movie"); // Friends must not gain shared seat-management access.
assert.equal(dispatched.length, 0);
assert.match(sent.pop().text, /Use \/watch Movie Name/);

async function acceptLast() {
  const reply = { from: { id: "999", is_bot: true }, chat: { id: "101", type: "private" }, message_id: 11, text: sent.at(-1).text };
  await command("Yes", "101", "webhook-secret", reply);
}
await command("/stop@cplxwatcher_bot reminder");
assert.equal(dispatched.length, 0);
assert.match(sent.at(-1).text, /turn off only your weekly reminder/);
await acceptLast();
assert.equal(dispatched.length, 1);
assert.equal(dispatched[0].inputs.operation, "stop");
assert.equal(dispatched[0].inputs.query, "reminder");
assert.equal(dispatched[0].inputs.recipient_key, key);
await command("/stop all");
assert.match(sent.at(-1).text, /movies stay on your list and checks continue/);
await acceptLast();
await command("/start reminder");
assert.deepEqual(dispatched.slice(1).map(({ inputs }) => [inputs.operation, inputs.query]), [
  ["stop", "all"], ["start", "reminder"],
]);
await command("/stop");
assert.equal(dispatched.length, 3);
assert.match(sent.at(-1).text, /Use \/stop Movie Name/);

dispatchFails = true;
const errors = [];
const originalError = console.error;
console.error = (...args) => errors.push(args);
try {
  await command("/stop reminder");
  await acceptLast();
} finally {
  console.error = originalError;
}
assert.equal(errors.length, 1);
assert.match(sent.at(-1).text, /could not process/);
console.log("Telegram preference webhook checks passed");
