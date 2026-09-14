#!/usr/bin/env node
/** Repeatable no-network rendering test for the /listseats Telegram message. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workerPath = new URL("../cloudflare-worker/src.js", import.meta.url);
const source = readFileSync(workerPath, "utf8")
  .replace("export default {", "globalThis.__worker = {")
  + "\nglobalThis.__seatListTest = { handleSeatList, seatWatchSummaryHtml };";
await import(`data:text/javascript,${encodeURIComponent(source)}`);

const watches = {
  dune: {
    id: "dune", name: "Dune & Friends", enabled: true, theatreId: "9406",
    showtimes: {
      "405854": { enabled: true, startsAt: "2027-01-14T15:30:00" },
      "405853": { enabled: true, startsAt: "2027-01-14T12:15:00" },
    },
  },
  stopped: { id: "stopped", name: "Stopped", enabled: false, theatreId: "9406", showtimes: { "1": { enabled: true } } },
};
const states = { watches: { dune: { lastCheckStatus: "success" } } };
const available = {
  one: { watchName: "Dune & Friends", theatreId: "9406", showtimeId: "405854", seatId: "seat", seatLabel: "E10" },
};
const sent = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const file = url.includes("seat-watches.json") ? { watches }
    : url.includes("seat-watch-state.json") ? states
      : url.includes("available-seat-list.json") ? available : null;
  if (file) return new Response(JSON.stringify(file));
  if (String(url).includes("api.telegram.org")) {
    sent.push(JSON.parse(options.body));
    return new Response("{}", { status: 200 });
  }
  throw new Error(`Unexpected fetch: ${url}`);
};

await globalThis.__seatListTest.handleSeatList({ GITHUB_REPOSITORY: "owner/repo", TELEGRAM_BOT_TOKEN: "test" }, "123");
globalThis.fetch = originalFetch;

assert.equal(sent.length, 1);
assert.equal(sent[0].parse_mode, "HTML");
assert.match(sent[0].text, /<a href="https:\/\/www\.cineplex\.com\/ticketing\/preview\?theatreId=9406&amp;showtimeId=405854">⏳ Dune &amp; Friends · 🪑 1 · #9406 · 🎬 2 · 👁 in \d+ min<\/a>/);
assert.match(sent[0].text, /📖 \/seatinfo Dune &amp; Friends/);
assert.doesNotMatch(sent[0].text, /Stopped/);
assert.match(sent[0].text, /Open web interface/);
console.log("seat list message checks passed");
