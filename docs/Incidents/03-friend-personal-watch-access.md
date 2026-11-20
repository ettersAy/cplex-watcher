# Secondary friend could not use /watch

Date: 2026-11-20. Application: `/Users/Ayoub/Developer/cplex-watcher`, branch `main`, remote `ettersAy/cplex-watcher`.

## Cause and scope

The secondary recipient secret, `TELEGRAM_GEORGE_MICHAEL_ALERT_CHAT_IDS`, originally granted only George Michael alerts and personal notification settings. `handleUpdate()` rejected `/watch` and `/list` unless the sender belonged to the main `TELEGRAM_CHAT_IDS` list. Adding the friend there would also give them all unrelated alerts and shared-management access.

The requested behavior is a personal movie list for each secondary account, with every added movie also watched for the owner. The existing movie checker, Actions storage and HMAC account registry remain the owners of this behavior; no new service, secret or database was introduced.

## Implementation

- Worker: recognizes registered secondary accounts, accepts `/watch` and filters `/list`; `/stopwatch` routes to the existing personal `/stop` handler. Shared seat commands remain main-account-only.
- `/watch` dispatch carries an opaque `recipient_key`, not a chat ID. GitHub resolves it against its configured recipients before saving a subscription or sending the result. Web additions and legacy main-account commands still work.
- `register_watch.save_registration()` owns the old workflow persistence logic. It adds a friend's HMAC key to the movie's optional `subscribers` list, including when the shared movie already exists. It adds no separate movie check or owner subscription: main recipients already watch every shared movie.
- `watcher.sale_alert_chat_ids()` selects main recipients plus subscribed secondary recipients. The existing George Michael entitlement is retained. Weekly reminders use the same selector. The existing personal opt-out filter still applies.
- Movie subscriptions are carried into `sales-started.json` and merged if that URL is already archived, preserving personal history.
- Explicit preference initialization removes accounts no longer configured, preserving current accounts' settings.
- Ticket commands queue with `queue: max` and read latest `main` at job start. This prevents queued commands replacing each other or reading stale subscriptions. Save/push now precedes the final registration reply; a failed save cannot claim success.
- A new watch preserves `/stop all` and individual opt-outs. A paused account's reply says to use `/start all`. No stored preference was changed manually.

## Initial observed environment

- Local checkout fast-forwarded from `4b3fc96` to `f623e95`; upstream changes were runtime state only. Existing `TEMP/NOTES.md` was preserved.
- Deployed Worker before this feature: `0ef9fce7-e32f-4dfc-a76c-4ad5c1573535`.
- Latest observed ticket Action: `44785460520`, successful, source `f2a67c5d0d6cb54d4a13e1c9bff686fc5bdf1842`.
- Current active movie was Paper Tiger. Two accounts were registered; one had `stoppedAll: true`. Do not reset this preference just to make a test pass.

## Validation before publication

From the exact application checkout:

```bash
python3 -m unittest discover -s tests -q
node scripts/test-personal-watches.mjs
node scripts/test-notification-preferences.mjs
node scripts/test-reminder-schedule.mjs
python3 scripts/test-seat-watcher.py
node scripts/test-seat-list-message.mjs
node scripts/test-preview-url-parameters.mjs
```

All 53 Python tests and the listed Worker/seat checks passed. They cover adding a new or already-shared movie, repeat requests, two independent friends, owner alerts, personal reminders/stops, history preservation, rejected accounts, revoked access, failed persistence and dispatch, and paused-alert replies. These are supplementary checks, not real Telegram delivery evidence.

Wrangler dry-run build, workflow YAML and embedded Python syntax, diff whitespace, and mission workspace paths were checked. The real read-only command `python3 register_watch.py 'Paper Tiger'` returned `status: watching`, `hasShowtimes: false`, and the correct official movie URL. This proves the live lookup, not command delivery.

## Publication and real account verification

Status: local implementation; publication and real friend-account verification pending.

1. Commit/push the approved files, excluding the pre-existing `TEMP/NOTES.md` edit. Push the workflow before deploying the Worker, which sends the new `recipient_key` input.
2. Deploy from `cloudflare-worker` with `npx wrangler deploy`; record version and commit here.
3. Start `npx wrangler tail cplex-watcher --format pretty` before the real command.
4. Have the existing friend send `/watch Paper Tiger` if this is the movie they want, or another real desired movie. Match `watch_requested` / dispatch request ID with the successful ticket Action.
5. Confirm the acknowledgement and final reply in the friend's actual chat. Inspect the saved movie's subscriber count without printing chat IDs or secrets. Verify the friend's `/list` and owner's `/list`; an owner-only movie must remain absent from the friend's list.
6. Respect existing opt-outs. `/start all` is a real preference change that the account holder should choose. Do not send fake sale alerts or force a weekly broadcast to test this feature.

A real command from the owner's account cannot prove the friend's account received its reply. A direct workflow dispatch or synthetic webhook is also not a real friend-account end-to-end test. Record these boundaries explicitly.

## Remaining limitations and rollback

Movie names and opaque subscriber identifiers are in the existing public repository. Raw chat IDs remain only in secrets. Public `/list` reads can briefly lag a state commit due to caching. Telegram delivery and Git persistence are not atomic; an existing sale-delivery retry can duplicate a message after partial delivery. Errors continue to be logged and failed registrations cannot send a saved-success reply.

To roll back, restore the previous Worker first, then the prior Python/workflow code, preserving live JSON state and personal preferences. Older code ignores the extra subscriber metadata but will not deliver friends' newly selected movies. No schema migration or secret rotation is required.
