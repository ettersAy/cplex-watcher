#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const content = readFileSync(new URL("../chrome-extension/content.js", import.meta.url), "utf8");
const worker = readFileSync(new URL("../cloudflare-worker/src.js", import.meta.url), "utf8");

assert.match(content, /searchParams\.get\("theatreId"\) \|\| url\.searchParams\.get\("locationId"\)/);
assert.match(worker, /searchParams\.get\("theatreId"\) \|\| url\.searchParams\.get\("locationId"\)/);

for (const value of [
  "https://www.cineplex.com/ticketing/preview?theatreId=9406&showtimeId=405810",
  "https://www.cineplex.com/ticketing/preview?locationId=9406&showtimeId=405810",
]) {
  const url = new URL(value);
  const theatreId = url.searchParams.get("theatreId") || url.searchParams.get("locationId");
  assert.match(theatreId, /^\d+$/);
  assert.match(url.searchParams.get("showtimeId"), /^\d+$/);
}

console.log("preview URL parameter checks passed");
