#!/usr/bin/env node
/** No-network tests of the real Telegram webhook and personal command dispatch. */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../cloudflare-worker/src.js", import.meta.url), "utf8")
  .replace("export default {", "globalThis.__worker = {");
await import(`data:text/javascript,${encodeURIComponent(source)}`);
const key = createHmac("sha256", "test-secret").update("friend-id").digest("hex");
const env = {
  TELEGRAM_PREFERENCES_KEY: "test-secret", TELEGRAM_BOT_TOKEN: "test-token",
  TELEGRAM_CHAT_IDS: "owner-id", TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
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

async function command(text, chatId = "friend-id", secret = "webhook-secret") {
  return globalThis.__worker.fetch(new Request("https://worker.test/telegram", {
    method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
    body: JSON.stringify({ message: { chat: { id: chatId }, text } }),
  }), env);
}

assert.equal((await command("/stop reminder", "friend-id", "invalid")).status, 403);
await command("/stop reminder", "stranger-id");
await command("/watch Some Movie"); // Notification-only friend must not gain admin access.
assert.equal(dispatched.length, 0);
assert.equal(sent.length, 0);

await command("/stop@cplxwatcher_bot reminder");
assert.equal(dispatched.length, 1);
assert.equal(dispatched[0].inputs.operation, "stop");
assert.equal(dispatched[0].inputs.query, "reminder");
assert.equal(dispatched[0].inputs.recipient_key, key);
assert.ok(!JSON.stringify(dispatched).includes("friend-id"));
assert.match(sent[0].text, /confirm when saved/);

await command("/stop Dune & Friends");
await command("/stop all");
await command("/start reminder");
assert.deepEqual(dispatched.slice(1).map(({ inputs }) => [inputs.operation, inputs.query]), [
  ["stop", "Dune & Friends"], ["stop", "all"], ["start", "reminder"],
]);
await command("/stop");
assert.equal(dispatched.length, 4);
assert.match(sent.at(-1).text, /Use \/stop Movie Name/);

dispatchFails = true;
const errors = [];
const originalError = console.error;
console.error = (...args) => errors.push(args);
try {
  await command("/stop reminder");
} finally {
  console.error = originalError;
}
assert.equal(errors.length, 1);
assert.match(sent.at(-1).text, /could not update/);
console.log("Telegram preference webhook checks passed");
