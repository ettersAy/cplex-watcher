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
  GITHUB_REPOSITORY: "owner/repo", GITHUB_ACTIONS_TOKEN: "test-github-token", TICKET_SCHEDULER_ENABLED: "true",
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
let ticketStateUnavailable = false;
let seatStateUnavailable = false;
let dispatchCount = 0;
const seats = { visible: { name: "Future & Seats", enabled: true, showtimes: { "1": { enabled: true, startsAt: "2099-11-22T12:00:00" } } },
  past: { name: "Past seats", enabled: true, showtimes: { "1": { enabled: true, startsAt: "2000-05-01T12:00:00" } } },
  completed: { name: "Completed seats", enabled: true, showtimes: { "1": { enabled: true, completed: true } } } };
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
  if (url.endsWith("/state.json")) return ticketStateUnavailable ? new Response(null, { status: 503 }) : Response.json({ movies: {
    "paper-tiger": { lastCheckedAt: "2026-11-22T19:30:00Z", lastCheckStatus: "success", hasShowtimes: false },
    "the-odyssey": { lastCheckedAt: "2026-11-22T20:00:00Z", lastCheckStatus: "failed", lastError: "internal error detail" },
  } });
  if (url.includes("/contents/seat-watches.json")) return seatStateUnavailable ? new Response(null, { status: 503 })
    : Response.json({ content: Buffer.from(JSON.stringify({ watches: seats })).toString("base64") });
  if (url.endsWith("/dispatches")) {
    dispatchCount += 1;
    dispatched.push({ url, ...JSON.parse(options.body) });
    return new Response(null, { status: dispatchFails ? 403 : 204 });
  }
  if (url.includes("/sendMessage")) {
    sent.push(JSON.parse(options.body));
    return Response.json({ ok: true });
  }
  throw new Error(`Unexpected fetch: ${url}`);
};
async function command(text, id = "friend-id", type = "private", secret = "webhook-secret") {
  return globalThis.__worker.fetch(new Request("https://worker.test/telegram", {
    method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
    body: JSON.stringify({ message: { chat: { id, type }, text } }),
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
assert.match(sent.at(-1).text, /Paper Tiger<\/a> · Tickets not on sale/);
assert.match(sent.at(-1).text, /Your ticket alerts: on/);
assert.match(sent.at(-1).text, /Recent ticket sales/);
assert.match(sent.at(-1).text, /George Michael/);
assert.match(sent.at(-1).text, /Runner/);
assert.doesNotMatch(sent.at(-1).text, /Odyssey|Another Friend|Other Completed|Friend|Owner|Following/);

await command("/list", "owner-id");
const ownerList = sent.at(-1).text;
assert.match(ownerList, /Following: You and Friend [12]/);
assert.match(ownerList, /Ticket alerts: You on; Friend [12] on/);
assert.match(ownerList, /The Odyssey<\/a> · Last check failed\nLast attempt:/);
assert.doesNotMatch(ownerList, /internal error detail/);
assert.match(ownerList, /Next expected ticket scan/);

preference = { stoppedWatches: ["ticket:paper-tiger"], remindersEnabled: false };
await command("/list");
assert.match(sent.at(-1).text, /Your ticket alerts: off \(paused for this title\)/);
assert.match(sent.at(-1).text, /\/start reminder/);
await command("/state");
assert.match(sent.at(-1).text, /Your watcher state/);
assert.match(sent.at(-1).text, /Weekly reminders: Disabled by preference/);
assert.doesNotMatch(sent.at(-1).text, /Odyssey|Another Friend|Owner|Seat subscriptions/);

preference = { stoppedAll: true, lastReminderWeek: "2026-11-14" };
await command("/list");
assert.match(sent.at(-1).text, /Your ticket alerts: off \(all alerts paused\)/);
assert.doesNotMatch(sent.at(-1).text, /Another Friend|Odyssey|George Michael|Runner/);
await command("/state@cplxwatcher_bot");
assert.match(sent.at(-1).text, /Enabled, but not sent while all alerts are paused/);
assert.match(sent.at(-1).text, /Last accepted by Telegram: week of 2026-11-14/);
assert.match(sent.at(-1).text, /\/start all/);
await command("/list", "owner-id");
assert.match(sent.at(-1).text, /Ticket alerts: You on; Friend [12] off \(all alerts paused\)/);
await command("/state", "owner-id");
const adminState = sent.at(-1).text;
assert.match(adminState, /Active ticket watches: 3 · ticket-sale history: 3/);
assert.match(adminState, /Latest successful result: 26-11-22 14:30:00 Montréal time/);
assert.match(adminState, /Latest failed attempt: 26-11-22 15:00:00 Montréal time/);
assert.match(adminState, /Seat subscriptions: 1 · alerts on for 1/);
assert.match(adminState, /Friend 1/);
assert.match(adminState, /Friend 2/);
assert.doesNotMatch(adminState, /friend-id|owner-id|[a-f0-9]{64}/);

const visibilityBefore = sent.length;
for (const type of ["group", "supergroup", "channel", ""]) {
  await command("/state", "owner-id", type);
  await command("/list", "owner-id", type);
}
await command("/state", "stranger-id");
await command("/state", "owner-id", "private", "wrong");
assert.equal(sent.length, visibilityBefore);

seatStateUnavailable = true;
ticketStateUnavailable = true;
await command("/state", "owner-id");
assert.match(sent.at(-1).text, /Ticket scan state temporarily unavailable/);
assert.match(sent.at(-1).text, /eligibility unavailable/);
assert.match(sent.at(-1).text, /Seat alert status temporarily unavailable/);
seatStateUnavailable = ticketStateUnavailable = false;

const longTitle = "<&".repeat(85);
const originalLength = movies.length;
for (let i = 0; i < 40; i++) movies.push(movie(`large-${i}`, `Bulk ${i} ${longTitle}`, [friend]));
const firstChunk = sent.length;
await command("/list");
const chunks = sent.slice(firstChunk);
assert.ok(chunks.length > 1);
assert.ok(chunks.every(({ text, parse_mode }) => text.length <= 3800 && parse_mode === "HTML"));
assert.equal(chunks.map(({ text }) => text).join("\n").match(/Bulk \d+/g).length, 40);
assert.match(chunks[0].text, /&lt;&amp;/);
assert.doesNotMatch(chunks[0].text, /<&/);
assert.equal(dispatchCount, 2, "read commands do not dispatch workflow");
movies.splice(originalLength);
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
