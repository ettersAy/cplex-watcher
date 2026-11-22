#!/usr/bin/env node
/** Supplementary no-network tests of the real personal-watch webhook routing. */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../cloudflare-worker/src.js", import.meta.url), "utf8")
  .replace("export default {", "globalThis.__worker = {");
await import(`data:text/javascript,${encodeURIComponent(source)}`);
const key = (id) => createHmac("sha256", "test-secret").update(id).digest("hex");
const friend = key("101");
const secondFriend = key("102");
const owner = key("201");
const env = {
  TELEGRAM_PREFERENCES_KEY: "test-secret", TELEGRAM_BOT_TOKEN: "999:synthetic",
  TELEGRAM_CHAT_IDS: "201", TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
  GITHUB_REPOSITORY: "owner/repo", GITHUB_ACTIONS_TOKEN: "test-github-token", TICKET_SCHEDULER_ENABLED: "true",
};
const movie = (slug, name, subscribers = []) => ({ url: `https://www.cineplex.com/movie/${slug}`, name, subscribers });
const movies = [movie("paper-tiger", "Paper Tiger", [friend]), movie("the-odyssey", "The Odyssey"),
  movie("another-film", "Another Friend's Film", [key("102")])];
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
async function command(text, id = "101", type = "private", secret = "webhook-secret", reply) {
  return globalThis.__worker.fetch(new Request("https://worker.test/telegram", {
    method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
    body: JSON.stringify({ message: { chat: { id, type }, from: { id, is_bot: false }, text, reply_to_message: reply } }),
  }), env);
}

await command("/watch Paper Tiger", "301");
assert.equal(dispatched.length, 0);
assert.equal(sent.length, 0);
await command("/watch@cplxwatcher_bot Paper Tiger");
assert.equal(dispatched[0].inputs.recipient_key, friend);
assert.equal(dispatched[0].inputs.title, "Paper Tiger");
assert.ok(!JSON.stringify(dispatched).includes("101"));
assert.match(sent.at(-1).text, /Searching Cineplex/);
await command("/watch Paper Tiger", "201");
assert.equal(dispatched.at(-1).inputs.recipient_key, key("201"));

await command("/list");
assert.match(sent.at(-1).text, /Paper Tiger<\/a> · Tickets not on sale/);
assert.match(sent.at(-1).text, /Your ticket alerts: on/);
assert.match(sent.at(-1).text, /Recent ticket sales/);
assert.match(sent.at(-1).text, /George Michael/);
assert.match(sent.at(-1).text, /Runner/);
assert.doesNotMatch(sent.at(-1).text, /Odyssey|Another Friend|Other Completed|Friend|Owner|Following/);

await command("/list", "201");
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
assert.match(sent.at(-1).text, /Your watcher settings/);
assert.match(sent.at(-1).text, /Weekly setting: <b>OFF<\/b> · scheduled reminder: 🔕 <b>OFF<\/b> · disabled by preference/);
assert.doesNotMatch(sent.at(-1).text, /Odyssey|Another Friend|Owner|Seat subscriptions/);

preference = { stoppedAll: true, lastReminderWeek: "2026-11-14" };
await command("/list");
assert.match(sent.at(-1).text, /Your ticket alerts: off \(all alerts paused\)/);
assert.doesNotMatch(sent.at(-1).text, /Another Friend|Odyssey|George Michael|Runner/);
await command("/state@cplxwatcher_bot");
assert.match(sent.at(-1).text, /Weekly setting: <b>ON<\/b> · scheduled reminder: ⏸ <b>BLOCKED<\/b> · all alerts paused/);
assert.match(sent.at(-1).text, /Last accepted week: 2026-11-14 \(not receipt\)/);
assert.match(sent.at(-1).text, /\/start all/);
await command("/list", "201");
assert.match(sent.at(-1).text, /Ticket alerts: You on; Friend [12] off \(all alerts paused\)/);
await command("/state", "201");
const adminState = sent.at(-1).text;
assert.match(adminState, /3 active ticket watches · 3 sales recorded/);
assert.match(adminState, /Latest success: Sun, Nov 22, 2:30 PM/);
assert.match(adminState, /Scope: Canada-wide/);
assert.match(adminState, /Ticket alerts on: You/);
assert.doesNotMatch(ownerList, /Montréal time/);
assert.match(adminState, /Latest failure: Sun, Nov 22, 3:00 PM/);
assert.match(adminState, /Seat alerts: 1\/1 active watches on/);
assert.match(adminState, /Friend 1/);
assert.match(adminState, /Friend 2/);
assert.doesNotMatch(adminState, /101|201|[a-f0-9]{64}/);

const visibilityBefore = sent.length;
for (const type of ["group", "supergroup", "channel", ""]) {
  await command("/state", "201", type);
  await command("/list", "201", type);
}
await command("/state", "301");
await command("/state", "201", "private", "wrong");
assert.equal(sent.length, visibilityBefore);

seatStateUnavailable = true;
ticketStateUnavailable = true;
await command("/state", "201");
assert.match(sent.at(-1).text, /<b>UNKNOWN<\/b> · ticket scan state unavailable/);
assert.match(sent.at(-1).text, /scheduled reminder:/);
assert.match(sent.at(-1).text, /Seat alerts: ❔ <b>UNKNOWN<\/b>/);
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
assert.equal(dispatched.length, 2, "no stop until approval");
assert.match(sent.at(-1).text, /remove Paper Tiger from your followed movies/);
assert.match(sent.at(-1).text, /admin will be notified/);
assert.equal(sent.at(-1).reply_markup.force_reply, true);
const prompt = { from: { id: "999", is_bot: true }, chat: { id: "101", type: "private" }, message_id: 11, text: sent.at(-1).text };
await command("Yes");
assert.equal(dispatched.length, 2, "unbound Yes cannot stop any movie");
await command("Yes", "201", "private", "webhook-secret", prompt);
assert.equal(dispatched.length, 2, "cross-user Yes cannot stop any movie");
await command("Yes", "101", "private", "webhook-secret", prompt);
assert.match(dispatched.at(-1).url, /check-tickets.yml/);
assert.equal(dispatched.at(-1).inputs.operation, "unfollow");
assert.equal(dispatched.at(-1).inputs.title, "paper-tiger");
assert.equal(dispatched.at(-1).inputs.recipient_key, friend);
assert.match(dispatched.at(-1).inputs.confirmation_expires, /^\d+$/);
movies[0].unfollowers = [friend];
await command("/list");
assert.doesNotMatch(sent.at(-1).text, /Paper Tiger/);
await command("/list", "201");
assert.match(sent.at(-1).text, /Paper Tiger[^\n]*\nLast scan:[^\n]*\nFollowing: You\nTicket alerts: You on/);
delete movies[0].unfollowers;
await command("/stopwatch Paper Tiger", "201");
assert.equal(dispatched.length, 3);
const ownerPrompt = { ...prompt, chat: { ...prompt.chat, id: "201" }, text: sent.at(-1).text };
await command("Yes", "201", "private", "webhook-secret", ownerPrompt);
assert.equal(dispatched.at(-1).inputs.operation, "unfollow");
assert.equal(dispatched.at(-1).inputs.recipient_key, owner);
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
