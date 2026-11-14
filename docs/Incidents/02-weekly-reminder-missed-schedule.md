# Weekly reminder missed at Montréal noon — 2026-11-14

## Issue and confirmed cause

The first weekly reminder was due Saturday, November 14 at 12:00 Montréal time (17:00 UTC). It had not arrived after 30 minutes.

At 17:37 UTC the GitHub workflow was active, its schedule was correct, both recipients had reminders enabled, and neither had a `lastReminderWeek`. The only reminder-workflow runs were the earlier manual initialization and stop/start command tests. **GitHub had not created the scheduled run.** The Python sender and Telegram were never reached.

GitHub documents that [scheduled events can be delayed or dropped](https://docs.github.com/en/actions/how-tos/troubleshoot-workflows). That is a known limitation, not proof of the specific internal reason for this missed event. Earlier claims of verification were too broad: unit tests and real preference commands had passed, but automatic weekly delivery had not been observed.

## Today's reminder recovered

From `/Users/Ayoub/Developer/cplex-watcher`:

```bash
gh workflow run telegram-reminders.yml --repo ettersAy/cplex-watcher -f operation=remind
```

- [Run 43622164968](https://github.com/ettersAy/cplex-watcher/actions/runs/43622164968) used source `b44ad4a1b495999fd7177492200d6f5b42faa146` and succeeded at 17:38:13 UTC.
- The owner’s signed-in Telegram Web chat visibly received **Weekly reminder** at **12:38 PM Montréal**, listing George Michael ticket sales in Montréal and Dune seat watches, with all three stop instructions.
- Both recipient records saved `lastReminderWeek: 2026-11-14` in commit `ebc9594`. This confirms successful Telegram API delivery for both; only the owner's chat was inspected visually.
- The existing `TEMP/NOTES.md` edit and upstream ticket/seat state changes were preserved. No recipient preferences were reset and no secret values or raw chat IDs were written into these notes.

## Small scheduling fix

The existing Cloudflare Worker now owns the clock. The existing GitHub Action and Python reminder sender remain the owners of delivery and saved preferences.

1. `cloudflare-worker/wrangler.toml` configures one UTC Cron Trigger: `*/5 * * * *`.
2. `reminderWeek()` converts the event time to `America/Toronto` and finds the most recent Saturday whose noon has passed. Before Saturday noon, the week remains the previous Saturday. This handles daylight saving and date/year boundaries.
3. The Worker reads the last 100 runs of this workflow on `main`. The exact run title is `Telegram remind weekly-YYYY-MM-DD`.
4. A successful matching run ends work for that week. A matching queued/running/waiting run prevents duplicate dispatches. Otherwise the Worker dispatches `operation=remind` and `request_id=weekly-YYYY-MM-DD`.
5. Python already skips accounts with that week's delivery marker. Independent failures are logged, successful deliveries are saved, and the job fails visibly. The next timer tick retries the failed work.

The Action's `run-name` is the completion identifier, so it must stay consistent with the Worker. A successful unrelated `/stop` or `/start` run must never count as reminder delivery. The old GitHub weekly `schedule` was removed; other ticket/seat schedules were not changed. Obsolete Worker cron expressions still do nothing.

If unusually high command activity pushes the matching run beyond the last 100 results, the Worker may start an extra no-op run; the per-account delivery markers still prevent duplicate messages. Telegram sends and Git commits cannot be atomic: a crash after sending but before saving can still duplicate a message on retry. Infrastructure outages can delay delivery; the timer retries rather than silently abandoning the week.

## Deploy and verify correctly

1. Inspect `git status --short --branch` in the exact checkout. Preserve unrelated edits.
2. Run the tests below and publish the updated workflow to `main` **before** deploying the Worker; the Worker depends on the new run name.
3. From `cloudflare-worker/`, run `npx wrangler deploy`. Confirm the version ID and `schedule: */5 * * * *` in the output. Existing secrets are reused; do not rotate `TELEGRAM_PREFERENCES_KEY`.
4. Start `npx wrangler tail cplex-watcher --format pretty`. Cloudflare says Cron Trigger changes can take [up to 15 minutes to propagate](https://developers.cloudflare.com/workers/configuration/cron-triggers/). Wait for a real scheduled event, not just a local simulation.
5. Confirm `weekly_reminder_queued`, then a successful Action with the matching title. On the next tick, confirm `weekly_reminder_complete` with that run ID. `weekly_reminder_pending` is expected while a job is still running.
6. Verify actual Telegram receipt and the saved delivery markers separately. A successful dispatch alone is not proof that a message arrived.

```bash
cd /Users/Ayoub/Developer/cplex-watcher
node scripts/test-reminder-schedule.mjs
node scripts/test-notification-preferences.mjs
node scripts/test-seat-list-message.mjs
node scripts/test-preview-url-parameters.mjs
python3 -m unittest discover -s tests -v
```

Scheduler tests cover winter/summer noon, both daylight-saving transitions, year boundaries, delayed catch-up, pending jobs, successful/failed jobs, unrelated commands, API errors, and obsolete triggers. Existing reminder tests cover personal scope, delivery retries, empty lists, opt-outs, and same-week deduplication.

## If a future reminder is missing

```bash
gh run list --repo ettersAy/cplex-watcher --workflow telegram-reminders.yml --limit 10 \
  --json databaseId,displayTitle,status,conclusion,createdAt,url
gh run view RUN_ID --repo ettersAy/cplex-watcher --log-failed
```

Read the saved delivery dates without printing recipient identifiers:

```bash
gh api 'repos/ettersAy/cplex-watcher/contents/notification-preferences.json?ref=main' --jq .content \
  | python3 -c 'import sys,base64,json; p=json.loads(base64.b64decode(sys.stdin.read()))["recipients"]; print([{"remindersEnabled": v.get("remindersEnabled", True), "stoppedAll": v.get("stoppedAll", False), "lastReminderWeek": v.get("lastReminderWeek")} for v in p.values()])'
```

- No Cloudflare scheduled events: inspect the deployed trigger and Worker version. A health-page HTTP 200 does not prove the cron is configured.
- Scheduler HTTP 401/403: inspect `GITHUB_ACTIONS_TOKEN` authorization; Actions read/write access is required. Do not print its value.
- Pending Action: inspect the Actions queue; the timer will not add more copies of the same job.
- Failed Action: inspect the original error and fix it; automatic retry follows. Do not erase successful recipients' markers.
- Successful run but no message: check whether that account has active watches, reminders enabled, and an existing delivery marker; inspect the actual Telegram conversation.

To send a missed reminder immediately, use the recovery command near the top of this document. It safely skips already-delivered accounts. The next Cloudflare tick records a matching successful weekly run without resending those messages.

## Scheduler deployment evidence

- Fix commit: `86d24a0006031f907f382e0aa0318c50c8df71a4`, published before the Worker deployment.
- Worker version: `0ef9fce7-e32f-4dfc-a76c-4ad5c1573535`. The deployment output explicitly registered `schedule: */5 * * * *` at about 17:44 UTC.
- A real Cloudflare scheduled event fired at **12:50:18 PM Montréal** and finished `Ok`. It logged `weekly_reminder_queued`, week `2026-11-14`, request ID `weekly-2026-11-14`.
- Cloudflare created [run 43623262366](https://github.com/ettersAy/cplex-watcher/actions/runs/43623262366) at 17:50:20 UTC on the fix commit. Its exact title was `Telegram remind weekly-2026-11-14`; processing and state saving both succeeded.
- Both saved delivery markers remained `2026-11-14`, both reminder preferences remained enabled, and the owner's Telegram chat still contained exactly **one** weekly reminder after the automatic run. This verifies that the recovery did not duplicate today's delivery.
- The next real timer event at **12:55:18 PM Montréal** also finished `Ok` and logged `weekly_reminder_complete`, week `2026-11-14`, run ID `43623262366`. It did not dispatch another job. This verifies the completed-week branch in production, separately from local mocks.
