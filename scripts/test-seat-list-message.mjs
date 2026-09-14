#!/usr/bin/env node
/** Repeatable no-network rendering test for the /listseats Telegram message. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workerPath = new URL("../cloudflare-worker/src.js", import.meta.url);
const source = readFileSync(workerPath, "utf8")
  .replace("export default {", "globalThis.__worker = {")
  + "\nglobalThis.__seatListTest = { handleSeatList, handleSeatInfo, seatWatchSummaryHtml };";
await import(`data:text/javascript,${encodeURIComponent(source)}`);

const watches = {
  dune: {
    id: "dune", name: "Dune & Friends", enabled: true, theatreId: "9406", theatreName: "Test Theatre",
    showtimes: {
      "405854": { enabled: true, startsAt: "2027-01-14T15:30:00", displayTime: "Jan 14, 3:30 PM" },
      "405853": { enabled: true, startsAt: "2027-01-14T12:15:00", displayTime: "Jan 14, 12:15 PM" },
    },
  },
  stopped: { id: "stopped", name: "Stopped", enabled: false, theatreId: "9406", showtimes: { "1": { enabled: true } } },
};
const states = {
  watches: {
    dune: {
      lastCheckStatus: "success",
      showtimes: { "405854": { selectedSeats: { seat: { label: "E10", status: "Available" } } } },
    },
  },
};
const available = {
  one: { watchName: "Dune & Friends", theatreId: "9406", showtimeId: "405854", seatId: "seat", seatLabel: "E10" },
};
const sent = [];
const originalFetch = globalThis.fetch;
let failStateRead = false;
globalThis.fetch = async (url, options = {}) => {
  const file = url.includes("seat-watches.json") ? { watches }
    : url.includes("seat-watch-state.json") ? states
      : url.includes("available-seat-list.json") ? available : null;
  if (failStateRead && url.includes("seat-watch-state.json")) return new Response("forbidden", { status: 403 });
  if (file) return new Response(JSON.stringify({ content: Buffer.from(JSON.stringify(file)).toString("base64") }));
  if (String(url).includes("api.telegram.org")) {
    sent.push(JSON.parse(options.body));
    return new Response("{}", { status: 200 });
  }
  throw new Error(`Unexpected fetch: ${url}`);
};

await globalThis.__seatListTest.handleSeatList({ GITHUB_REPOSITORY: "owner/repo", GITHUB_ACTIONS_TOKEN: "test", TELEGRAM_BOT_TOKEN: "test" }, "123");

assert.equal(sent.length, 1);
assert.equal(sent[0].parse_mode, "HTML");
assert.match(sent[0].text, /<a href="https:\/\/www\.cineplex\.com\/ticketing\/preview\?theatreId=9406&amp;showtimeId=405854">🟢 <b>Dune &amp; Friends<\/b> · Test Theatre · #9406 · 1 🪑 · 2 🎬<\/a>/);
assert.match(sent[0].text, /📖 <code>\/seatinfo Dune &amp; Friends<\/code> · 👁 in \d+ min/);
assert.doesNotMatch(sent[0].text, /Stopped/);
assert.match(sent[0].text, /Web interface/);

states.watches.dune = {
  lastCheckStatus: "success", lastCheckedAt: "2027-01-14T12:00:00Z",
  showtimes: {
    "405853": { lastCheckStatus: "success", selectedSeats: { first: { label: "E10", status: "Available" }, second: { label: "F20", status: "Available" } } },
    "405854": { lastCheckStatus: "success", selectedSeats: { first: { label: "E9", status: "Occupied" } } },
  },
};
await globalThis.__seatListTest.handleSeatInfo({ GITHUB_REPOSITORY: "owner/repo", GITHUB_ACTIONS_TOKEN: "test", TELEGRAM_BOT_TOKEN: "test" }, "123", "Dune & Friends");
assert.equal(sent.length, 2);
assert.match(sent[1].text, /🎟 <b>Dune &amp; Friends<\/b> · Test Theatre · #9406 · 2 🪑 · 2 🎬/);
assert.match(sent[1].text, /🟢 <b>Available<\/b>/);
assert.match(sent[1].text, /<b>Thursday, Jan 14 · 2 🪑 · 🎬 1<\/b>/);
assert.match(sent[1].text, /#405853 · 12:15 PM · 2 🪑/);
assert.match(sent[1].text, /⚪ <b>Still watching<\/b>/);
assert.match(sent[1].text, /#405854 · 3:30 PM · 0 🪑/);
assert.match(sent[1].text, /🕒 Checked at 27-01-14 07:00:00/);
assert.match(sent[1].text, /\/stopshowtime Dune &amp; Friends ShowtimeId/);
failStateRead = true;
await globalThis.__seatListTest.handleSeatList({ GITHUB_REPOSITORY: "owner/repo", GITHUB_ACTIONS_TOKEN: "test", TELEGRAM_BOT_TOKEN: "test" }, "123");
assert.equal(sent.length, 3);
assert.match(sent[2].text, /Latest seat-scan details are temporarily unavailable/);
assert.match(sent[2].text, /Dune &amp; Friends/);
globalThis.fetch = originalFetch;
console.log("seat list message checks passed");
