# Josephine alerted nationally instead of waiting for Montréal

Date: 2026-11-25. Repository: `/Users/Ayoub/Developer/cplex-watcher`, branch `main`.

## Cause and evidence

The existing `get_movie()` replaced Cineplex's national `hasShowtimes` with a Montréal session check only for George Michael. Every other movie used the national flag directly. Josephine was therefore announced and archived at `2026-11-25T08:00:31Z` (03:00 Montréal) by successful Action `45572562526`, source `a7cf6ed69031e89097725b1a254beba717db80c4`.

Before editing, `git pull --ff-only` advanced the exact checkout from `0ca8e19` to `f7638e3`. This brought in the newer Cloudflare ticket timer, confirmed personal unfollows, membership notifications and `/state` dashboard. Those changes were preserved. Existing local edits in `TEMP/NOTES.md` and incident 03 were left intact and excluded from this release.

Live read-only Cineplex evidence before the change:

- Josephine film ID: `62258`; national `hasShowtimes: true`.
- The film-specific theatre response contained no Montréal theatres; `find_city_showtime(62258, "Montréal")` returned no session.
- The saved completed movie retained one friend subscriber, and both registered accounts had alerts enabled. No chat IDs or secret values were printed or changed.
- Existing deployed Worker: `481a1c4d-fb73-4182-9c0e-21933746f9fc`.

## Small permanent fix

`watcher.get_movie()` now applies the same Montréal rule to every movie. Before the national flag is true it skips theatre/date requests. Once national sales begin, it reuses the existing film-specific theatre, bookable-date and session helpers. Only an online-enabled, future, unsold-out session with a session ID in a Montréal-city theatre counts as local sales.

There are two notification markers in the existing movie state:

1. `nationalAlerted`: one progress notice, while the movie stays active: “Ticket sales have started for Josephine, but not in Montréal. I'm now watching for Montréal tickets.”
2. `alerted`: the final Montréal ticket alert, with theatre/time. Only this local availability moves a movie to the completed list.

If local tickets are already available at the first successful check, only the final alert is sent. API errors remain errors; they do not become claims that Montréal is unavailable. Failed sends leave the relevant marker unset and retain the watch for retry. Both notices use the existing membership and personal opt-out filters.

`register_watch.save_registration()` restores an explicitly rewatched completed movie, preserving its subscribers and exclusions, and clears only that movie's previous check/notification state. The normal `/watch Josephine` flow can therefore reactivate it for both existing followers. Other archived movies remain untouched. `/list`, `/state`, weekly reminders and registration replies now name Montréal.

No new service, dependency, secret, scheduler, hardcoded theatre list or manual production-state rewrite is required. Montréal means the city in Cineplex's directory, not Laval/Brossard or the whole metropolitan area.

## Validation

The 75-test baseline passed before edits. After the change, all 82 Python tests passed, including the added national → Montréal lifecycle, no duplicate progress notice, direct local sale, failed notice retry, missing film ID, skipped pre-sale API calls, and archive restoration with preserved memberships and unrelated state. Worker personal-list, confirmation, preference, ticket/reminder scheduling, seat and preview regressions passed. Wrangler dry-run, workflow YAML/embedded Python, whitespace, and exact workspace paths passed.

These are supplementary checks. Direct live lookups from this checkout additionally confirmed:

- `python3 register_watch.py Josephine` returned `watching`, `city: Montréal`, national sales true, local sales false, and no session.
- George Michael remained a positive local control: Cinéma Cineplex Forum et VIP (`9109`), session `499144`, December 9 at 19:00. No message was sent by these read-only lookups.

## Deployment and live recovery

Published and verified on November 25, 2026:

- Implementation commit: `fe1ca110e3dfdd3ba33c7bd67c7ee855d5e4299c` on `main`.
- Worker version: `8b31db09-1b3e-42b4-85aa-acb808927af9`, keeping `*/5 * * * *` and `TICKET_SCHEDULER_ENABLED=true`.
- Real owner command: `/watch Josephine` at 09:51:03 Montréal (14:51:03 UTC). Worker request `b4a9904f-10bf-4255-8d4c-e28d4efd6a80` logged the accepted GitHub dispatch.
- [Action 45638569334](https://github.com/ettersAy/cplex-watcher/actions/runs/45638569334) completed successfully on the implementation commit. At 14:51:16 UTC it logged `Josephine in Montréal: Not Yet`, then `Telegram nationalAlerted sent to 2 recipient(s)`. Each send had a successful Telegram API response.
- The Action persisted state in `04927752b176481f169e8a2e0c7ad997ebeeb3fd` before sending the registration confirmation. The exact local checkout was fast-forwarded to that commit.
- Readback confirmed Josephine is active exactly once and absent from the completed list; its friend subscriber and exclusions are unchanged, all eight other completed movies are preserved, and notification preferences are unchanged. Saved state has `city: Montréal`, `nationalHasShowtimes: true`, `hasShowtimes: false`, `nationalAlerted: true`, successful check status, and no final `alerted` flag.
- The owner's actual Telegram Web chat showed the progress notice and successful registration at 09:51. The 09:52 `/list` reply showed `Tickets not on sale in Montréal · sales started elsewhere`, `Following: You and Friend`, and both ticket alerts on. Screenshot: `/Users/Ayoub/Developer/missions/cineplex-seat-finder-app/references/2026-11-25-josephine-montreal.jpg`.

Both notifications were accepted by Telegram; the owner's receipt was directly observed. The friend's private chat/read status was not accessed. The normal `/watch` flow performed recovery; no production JSON or personal preferences were manually overwritten. Repeated-check suppression was tested locally; this recovery run alone is not proof of a later automatic check.

Repeatable recovery sequence:

1. Push the tested Python/workflow change, then deploy the Worker from `cloudflare-worker/`.
2. Start `npx wrangler tail cplex-watcher --format pretty`.
3. Send the real `/watch Josephine` command from the owner's Telegram account. Registration restores the archived friend's subscription; the check sends the progress notice to both eligible accounts.
4. Verify the corresponding Action completed, the Telegram API accepted both deliveries, and Josephine is active once, absent from `sales-started.json`, with `city: Montréal`, `nationalHasShowtimes: true`, `hasShowtimes: false`, `nationalAlerted: true`, and no final `alerted` flag.
5. Confirm the owner's actual chat and `/list`. Friend API delivery is not proof that the friend read the private chat; distinguish those facts in the handoff.

## Limits and future diagnosis

Delivery and the Git state push are not atomic. A crash after sending but before saving, or a partial send across recipients, can repeat a notice on retry; this existing sender limitation is unchanged. A later subscriber receives the normal registration reply but does not replay a progress notice already sent for that shared watch. Do not clear markers merely to test delivery.

If a movie has national sales but no local session, it is supposed to stay active. Inspect its saved `lastCheckStatus`/`lastError` and the film-specific Montréal theatre/date/session responses before interpreting this as a failure. Do not restore the national-only archive condition.
