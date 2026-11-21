#!/usr/bin/env node
/** No-network tests of the production Worker scheduler. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../cloudflare-worker/src.js", import.meta.url), "utf8");
const worker = (await import(`data:text/javascript,${encodeURIComponent(source)}`)).default;
const now = Date.parse("2026-11-21T18:00:00Z");
const id = `ticket-check-${Math.floor(now / (30 * 60 * 1000))}`;
const title = `Ticket check ${id}`;
const env = { GITHUB_REPOSITORY: "owner/repo", GITHUB_ACTIONS_TOKEN: "test-token", TICKET_SCHEDULER_ENABLED: "true" };
const mock = { now, calls: [], runs: [], listStatus: 200, dispatchStatus: 204, weeklyStatus: 200 };
const tick = (time = now, variables = env, cron = "*/5 * * * *") =>
  worker.scheduled({ scheduledTime: time, cron }, variables);
const ticketCalls = () => mock.calls.filter(({ url }) => url.includes("check-tickets.yml"));
const dispatchCount = () => ticketCalls().filter(({ method }) => method === "POST").length;
const original = { now: Date.now, fetch: globalThis.fetch, log: console.log, error: console.error };
Date.now = () => mock.now;
console.log = console.error = () => {};
globalThis.fetch = async (url, options) => {
  mock.calls.push({ url, ...options });
  if (url.includes("telegram-reminders.yml/runs?")) {
    return Response.json({ workflow_runs: [{
      display_title: "Telegram remind weekly-2026-11-21", status: "completed", conclusion: "success",
    }] }, { status: mock.weeklyStatus });
  }
  if (url.includes("check-tickets.yml/runs?")) {
    assert.equal(new URL(url).searchParams.get("branch"), "main");
    assert.equal(new URL(url).searchParams.get("event"), "workflow_dispatch");
    return Response.json({ workflow_runs: mock.runs }, { status: mock.listStatus });
  }
  if (url.endsWith("check-tickets.yml/dispatches")) {
    return new Response(null, { status: mock.dispatchStatus });
  }
  throw new Error(`Unexpected URL: ${url}`);
};

try {
  await tick();
  assert.deepEqual(JSON.parse(ticketCalls().at(-1).body), {
    ref: "main", inputs: { operation: "check", request_id: id },
  });

  for (const result of [
    { status: "queued", display_title: title },
    { status: "in_progress", display_title: title },
    { status: "waiting", display_title: `Ticket check ticket-check-${Number(id.split("-").at(-1)) - 1}` },
    { status: "completed", conclusion: "success", display_title: title },
  ]) {
    mock.calls = [];
    mock.runs = [result];
    await tick();
    assert.equal(dispatchCount(), 0);
    assert.equal(ticketCalls().length, 1);
  }

  mock.calls = [];
  mock.runs = [
    { status: "completed", conclusion: "failure", display_title: title },
    { status: "completed", conclusion: "success", display_title: "Ticket watch s1" },
    { status: "in_progress", display_title: "Ticket watch s2" },
  ];
  await tick(now + 5 * 60_000);
  assert.equal(dispatchCount(), 1, "Retry failed slots and ignore unrelated manual runs");

  mock.calls = [];
  mock.runs = [];
  mock.now = now + 30 * 60_000;
  await tick(now);
  assert.equal(ticketCalls().length, 0, "Old Cloudflare events must not dispatch an expired slot");
  await tick(mock.now);
  assert.equal(JSON.parse(ticketCalls().at(-1).body).inputs.request_id, `ticket-check-${Math.floor(mock.now / (30 * 60 * 1000))}`);

  mock.calls = [];
  await tick(mock.now, { ...env, TICKET_SCHEDULER_ENABLED: "false" });
  await tick(mock.now, env, "*/30 * * * *");
  assert.equal(ticketCalls().length, 0);

  mock.calls = [];
  mock.listStatus = 503;
  await assert.rejects(tick(mock.now), /ticket workflow runs: HTTP 503/);
  assert.equal(dispatchCount(), 0);
  assert.equal(mock.calls.filter(({ url }) => url.includes("telegram-reminders")).length, 1, "Ticket listing failure must not stop reminders");
  mock.listStatus = 200;
  mock.dispatchStatus = 503;
  await assert.rejects(tick(mock.now), /ticket check dispatch failed: HTTP 503/);
  mock.dispatchStatus = 204;

  mock.calls = [];
  mock.weeklyStatus = 503;
  await assert.rejects(tick(mock.now), /weekly reminder runs: HTTP 503/);
  assert.equal(dispatchCount(), 1, "Reminder failure must not stop ticket checks");
} finally {
  Date.now = original.now;
  globalThis.fetch = original.fetch;
  console.log = original.log;
  console.error = original.error;
}
console.log("Ticket timer checks passed: stable slots, retry, pending/success, stale events, and independent reminders");
