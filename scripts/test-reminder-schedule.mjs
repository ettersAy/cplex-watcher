#!/usr/bin/env node
/** No-network tests of the real scheduled handler, including DST and retries. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../cloudflare-worker/src.js", import.meta.url), "utf8")
  .replace("export default {", "globalThis.__worker = {")
  + "\nglobalThis.__reminderWeek = reminderWeek;";
await import(`data:text/javascript,${encodeURIComponent(source)}`);

for (const [timestamp, expectedWeek] of [
  ["2026-11-14T16:59:00Z", "2026-11-07"], // Winter: 11:59 Montréal.
  ["2026-11-14T17:00:00Z", "2026-11-14"], // Winter noon.
  ["2026-07-11T15:59:00Z", "2026-07-04"], // Summer: 11:59 Montréal.
  ["2026-07-11T16:00:00Z", "2026-07-11"], // Summer noon.
  ["2026-03-08T07:00:00Z", "2026-03-07"], // DST spring transition.
  ["2026-11-01T06:00:00Z", "2026-10-31"], // DST fall transition.
  ["2027-01-01T20:00:00Z", "2026-12-26"], // Year boundary; catch up a failed week.
  ["2026-11-16T14:00:00Z", "2026-11-14"], // Monday retry still belongs to Saturday.
]) {
  assert.equal(globalThis.__reminderWeek(new Date(timestamp)), expectedWeek, timestamp);
}

const env = { GITHUB_REPOSITORY: "owner/repo", GITHUB_ACTIONS_TOKEN: "test-token" };
let runs = [], requests = [], readStatus = 200, dispatchStatus = 204;
globalThis.fetch = async (url, options) => {
  requests.push({ url, ...options });
  if (url.includes("/runs?")) return Response.json({ workflow_runs: runs }, { status: readStatus });
  if (url.endsWith("/dispatches")) return new Response(null, { status: dispatchStatus });
  throw new Error(`Unexpected fetch: ${url}`);
};
const logs = [], errors = [];
const originalLog = console.log, originalError = console.error;
console.log = (line) => logs.push(JSON.parse(line));
console.error = (...args) => errors.push(args);
const tick = (timestamp = "2026-11-14T17:00:00Z", cron = "*/5 * * * *") =>
  globalThis.__worker.scheduled({ scheduledTime: Date.parse(timestamp), cron }, env);
const name = "Telegram remind weekly-2026-11-14";

try {
  await tick();
  assert.equal(requests.length, 2);
  assert.deepEqual(JSON.parse(requests[1].body), { ref: "main", inputs: { operation: "remind", request_id: "weekly-2026-11-14" } });
  assert.equal(logs.at(-1).event, "weekly_reminder_queued");

  for (const status of ["queued", "in_progress", "waiting"]) {
    requests = [];
    runs = [{ id: 10, display_title: name, status, conclusion: null }];
    await tick();
    assert.equal(requests.length, 1, "A running job must not build a queue of duplicates");
    assert.equal(logs.at(-1).event, "weekly_reminder_pending");
  }

  for (const conclusion of ["failure", "cancelled", "timed_out"]) {
    requests = [];
    runs = [{ id: 10, display_title: name, status: "completed", conclusion }];
    await tick("2026-11-14T17:05:00Z");
    assert.equal(requests.length, 2, "A failed job must be retried");
  }

  requests = [];
  runs.push({ id: 11, display_title: name, status: "completed", conclusion: "success" });
  await tick();
  assert.equal(requests.length, 1);
  assert.equal(logs.at(-1).event, "weekly_reminder_complete");
  assert.equal(logs.at(-1).runId, 11);
  await tick("2026-11-21T17:00:00Z");
  assert.equal(JSON.parse(requests.at(-1).body).inputs.request_id, "weekly-2026-11-21");

  requests = [];
  runs = [{ display_title: "Telegram stop owner-request", status: "completed", conclusion: "success" }];
  await tick();
  assert.equal(requests.length, 2, "A successful preference command is not a successful reminder");

  readStatus = 503;
  requests = [];
  await assert.rejects(tick(), /check weekly reminder runs: HTTP 503/);
  assert.equal(requests.length, 1);
  readStatus = 200;
  dispatchStatus = 503;
  await assert.rejects(tick(), /notification dispatch failed: HTTP 503/);
  assert.equal(errors.length, 2);
  dispatchStatus = 204;
  await tick(); // An error does not consume the week; the next tick can dispatch.

  requests = [];
  await tick(undefined, "*/30 * * * *");
  assert.equal(requests.length, 0);
  assert.equal(logs.at(-1).event, "legacy_cron_ignored");
} finally {
  console.log = originalLog;
  console.error = originalError;
}
console.log("Reminder scheduler checks passed: Montréal noon, DST, retry, pending/success, and errors");
