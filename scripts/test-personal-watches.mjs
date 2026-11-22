#!/usr/bin/env node
/** Supplementary no-network tests of the real personal-watch webhook routing. */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../cloudflare-worker/src.js", import.meta.url), "utf8")
  .replace("export default {", "globalThis.__worker = {");
await import(`data:text/javascript,${encodeURIComponent(source)}`);
const key = (id) => createHmac("sha256", "test-secret").update(id).digest("hex");
const friend = key("friend-id");
const secondFriend = key("second-friend-id");
const owner = key("owner-id");
const env = {
  TELEGRAM_PREFERENCES_KEY: "test-secret", TELEGRAM_BOT_TOKEN: "test-token",
  TELEGRAM_CHAT_IDS: "owner-id", TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
  GITHUB_REPOSITORY: "owner/repo", GITHUB_ACTIONS_TOKEN: "test-github-token",
};
const movie = (slug, name, subscribers = []) => ({ url: `https://www.cineplex.com/movie/${slug}`, name, subscribers });
const movies = [movie("paper-tiger", "Paper Tiger", [friend]), movie("the-odyssey", "The Odyssey"),
  movie("another-film", "Another Friend's Film", [key("second-friend-id")])];
const completed = [movie("george-michael-the-faith-tour", "George Michael"),
  movie("runner", "Runner", [friend]), movie("other", "Other Completed")];
let preference = {};
let ownerPreference = {};
let secondPreference = {};
let stateUnavailable = false;
let dispatchFails = false;
const sent = [];
const dispatched = [];
globalThis.fetch = async (url, options) => {
  if (url.includes("/contents/notification-preferences.json")) {
    return stateUnavailable ? new Response(null, { status: 503 })
      : Response.json({ content: Buffer.from(JSON.stringify({ recipients: { [friend]: preference, [owner]: ownerPreference, [secondFriend]: secondPreference } })).toString("base64") });
  }
  if (url.endsWith("/movies.json")) return Response.json(movies);
  if (url.endsWith("/sales-started.json")) return Response.json(completed);
  if (url.endsWith("/state.json")) return Response.json({ movies: {} });
  if (url.endsWith("/dispatches")) {
    dispatched.push({ url, ...JSON.parse(options.body) });
    return new Response(null, { status: dispatchFails ? 403 : 204 });
  }
  if (url.includes("/sendMessage")) {
    sent.push(JSON.parse(options.body));
    return Response.json({ ok: true });
  }
  throw new Error(`Unexpected fetch: ${url}`);
};
async function command(text, id = "friend-id") {
  return globalThis.__worker.fetch(new Request("https://worker.test/telegram", {
    method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "webhook-secret" },
    body: JSON.stringify({ message: { chat: { id }, text } }),
  }), env);
}

await command("/watch Paper Tiger", "stranger-id");
assert.equal(dispatched.length, 0);
assert.equal(sent.length, 0);
await command("/watch@cplxwatcher_bot Paper Tiger");
assert.equal(dispatched[0].inputs.recipient_key, friend);
assert.equal(dispatched[0].inputs.title, "Paper Tiger");
assert.ok(!JSON.stringify(dispatched).includes("friend-id"));
assert.match(sent.at(-1).text, /Searching Cineplex/);
await command("/watch Paper Tiger", "owner-id");
assert.equal(dispatched.at(-1).inputs.recipient_key, key("owner-id"));

await command("/list");
assert.match(sent.at(-1).text, /Paper Tiger/);
assert.match(sent.at(-1).text, /George Michael/);
assert.match(sent.at(-1).text, /Runner/);
assert.doesNotMatch(sent.at(-1).text, /Odyssey|Another Friend|Other Completed/);
assert.match(sent.at(-1).text, /Watching: You \+ Owner/);
assert.doesNotMatch(sent.at(-1).text, /friend-id|owner-id|\bFriend\b/);
await command("/list", "second-friend-id");
assert.match(sent.at(-1).text, /Another Friend/);
assert.doesNotMatch(sent.at(-1).text, /Paper Tiger|The Odyssey/);
await command("/list", "owner-id");
assert.match(sent.at(-1).text, /Paper Tiger/);
assert.match(sent.at(-1).text, /Odyssey/);
assert.match(sent.at(-1).text, /Another Friend/);
assert.match(sent.at(-1).text, /Paper Tiger[^\n]*\n   Watching: You \+ Friend/);
assert.match(sent.at(-1).text, /Odyssey[^\n]*\n   Watching: You\n/);

preference = { stoppedWatches: ["ticket:paper-tiger"] };
await command("/list");
assert.match(sent.at(-1).text, /Paper Tiger[^\n]*\n   Watching: You: paused \+ Owner/);
assert.match(sent.at(-1).text, /George Michael/);
preference.stoppedAll = true;
await command("/list");
assert.match(sent.at(-1).text, /weekly reminders are paused/);
assert.match(sent.at(-1).text, /Paper Tiger[^\n]*\n   Watching: You: paused \+ Owner/);
assert.doesNotMatch(sent.at(-1).text, /Another Friend|Odyssey|George Michael|Runner/);
await command("/list", "owner-id");
assert.match(sent.at(-1).text, /Paper Tiger[^\n]*\n   Watching: You \+ Friend: paused/);
ownerPreference = { stoppedWatches: ["ticket:paper-tiger"] };
await command("/list");
assert.match(sent.at(-1).text, /Paper Tiger[^\n]*\n   Watching: You: paused \+ Owner/);
assert.doesNotMatch(sent.at(-1).text, /Owner: paused/);
ownerPreference = {};
await command("/stopwatch Paper Tiger");
assert.match(dispatched.at(-1).url, /telegram-reminders.yml/);
assert.equal(dispatched.at(-1).inputs.operation, "stop");
assert.equal(dispatched.at(-1).inputs.recipient_key, friend);
await command("/stopwatch Paper Tiger", "owner-id");
assert.equal(dispatched.at(-1).inputs.operation, "remove_by_title");
const count = dispatched.length;
for (const text of ["/watchseat URL", "/watchshowtime Film 123", "/stopseats Film", "/refreshseats Film", "/listseats"]) {
  await command(text);
}
assert.equal(dispatched.length, count);

const errors = [];
const originalError = console.error;
console.error = (...args) => errors.push(args);
try {
  stateUnavailable = true;
  await command("/watch Paper Tiger");
  assert.equal(dispatched.length, count);
  assert.match(sent.at(-1).text, /could not load/);
  stateUnavailable = false;
  dispatchFails = true;
  await command("/watch Paper Tiger");
  assert.match(sent.at(-1).text, /could not start/);
} finally {
  console.error = originalError;
}
assert.equal(errors.length, 2);
console.log("Personal watch webhook checks passed");
