# T01 Seat Watcher implementation log

This log records implementation steps, checks, and reusable lessons. It contains no credentials, chat IDs, raw Cineplex responses, or production secrets.

## 2026-09-13 — Stage 1: pure selection and alert state

Implemented:

- `seat_watcher.py`: label-range parsing, layout selection, available-seat de-duplication, preview URLs, and grouped Telegram HTML alert rendering.
- `scripts/test-seat-watcher.py`: no-network regression script.

Verified:

```text
python3 scripts/test-seat-watcher.py
python3 -m py_compile seat_watcher.py scripts/test-seat-watcher.py
```

Observed result: both checks passed. The fixture proves the Dune rule selects 49 seats, includes `E10`, `F20`, and `H15`, rejects `E18`, `F24`, and `D15`, de-duplicates unchanged available seats, and alerts again after a seat is occupied then re-available.

Lesson retained: select from visible `seat.label`, never `columnPhysicalNumber`; use the full watch/theatre/showtime/seat identity for de-duplication.

## 2026-09-13 — Stage 2: Cineplex contract and persisted scanner

Observed live, read-only API evidence for theatre `9406`, showtime `405765`:

- `seat-layout` returned `standardSeats`, `dboxSeats`, and `balconySeats`; the first standard seat was `1_12_28` / `A24`.
- `seat-availability` returned `seatAvailabilities`, `isSoldOut`, and `isPostShowtime`; observed seat statuses were `Occupied` and `Available` across 345 seats.

Implemented:

- Empty committed seat-watch configuration/state files and the rolling `seat-watch.log`.
- `scan_all()` with layout mapping, availability state updates, post-showtime completion, grouped availability alerts, final failure alerts, and 1,000-line log retention.
- Three-attempt retry for transient network, HTTP 429, and HTTP 5xx failures. Invalid JSON/shape failures are not retried.

Verified:

```text
python3 scripts/test-seat-watcher.py
python3 -m py_compile seat_watcher.py scripts/test-seat-watcher.py
python3 seat_watcher.py scan
```

Observed result: all checks passed; the empty configuration scan returned `{"watches": 0, "showtimes": 0, "failures": 0, "newSeats": 0}` and wrote sanitized lifecycle entries to `seat-watch.log`.

Lesson retained: verify the current paired endpoints before using fixture assumptions. Preserve available-seat entries after a failed scan; only a successful response may clear a seat from the alert list.

## 2026-09-13 — Stage 3: scheduled Action and configuration command foundation

Implemented:

- `.github/workflows/check-seat-watches.yml` with the required five-minute schedule, `contents: write`, and shared `seat-watch-write` concurrency group.
- Optional `--notify` scanner mode that sends grouped alerts/failures through the existing Telegram sender using GitHub secrets.
- `seat_watch_command.py` for create, edit, stop, add-showtime, and stop-showtime operations. It validates all form-supplied showtimes against both Cineplex endpoints before saving a configuration.
- Action command-result delivery to the issuing Telegram chat, while scheduled availability/failure alerts use the configured recipient list.

Verified:

```text
python3 scripts/test-seat-watcher.py
python3 -m py_compile seat_watcher.py seat_watch_command.py
python3 seat_watcher.py scan
```

Observed result: all local checks passed. The Action workflow structure contains the five-minute cron, shared concurrency key, scanner invocation, and one commit step for state/log files.

## 2026-09-13 — Stage 4: Telegram command does not require date/time

Decision confirmed: a Telegram user supplies only the existing watch name and a
numeric showtime ID, for example `/watchshowtime Dune 405765`. Date/time is
display metadata, not part of the scanning contract.

Implemented:

- `seat_watch_command.py` now accepts showtimes that contain only `id`.
- Optional `startsAt` and `displayTime` are preserved when the web form has
  them, but are not validated as required fields.
- The no-network regression script asserts that an ID-only showtime is accepted.

Verified:

```text
python3 scripts/test-seat-watcher.py
python3 -m py_compile seat_watcher.py seat_watch_command.py scripts/test-seat-watcher.py
```

Expected behavior: the command validates the ID against the paired seat APIs,
saves it, and scanning begins immediately. Date/time enrichment is a separate
best-effort display step; a missing value renders as the clickable showtime ID
and must not prevent the watch from working.

Lesson retained: keep mandatory command inputs limited to what the scan
actually needs. Do not turn a UI sorting/detail field into a requirement for a
Telegram action.

## 2026-09-13 — Stage 5: one-time showtime metadata lookup

The supplied real `TEMP/showtime-detail.json` confirms the direct Cineplex
endpoint returns `showDate` and `showtime.showStartDateTime` for a known
theatre/showtime pair. It also contains much more information than the seat
watcher needs.

Implemented:

- `showtime_detail_url()` and `request_showtime_detail()` use the one-time
  theatrical detail endpoint with the same temporary public-browser header
  discovery used by the existing Cineplex Seat Watcher.
- Configuration validation calls it once per submitted showtime, verifies the
  returned theatre and Vista session IDs, and saves only `showDate`,
  `startsAt`, and formatted `displayTime`.
- The recurring scanner does not call this endpoint.

Observed live read-only check: the endpoint returned HTTP 401 without its
header. The established watcher automatically discovers Cineplex's current
public browser header from its JavaScript assets. That method was ported here;
the header remains in process memory only, is never committed or logged, and
requires no user configuration.

## 2026-09-13 — Stage 6: Telegram showtime registration dispatch

Implemented `/watchshowtime <watch name> <showtimeId>` in the Worker.

1. It parses the final numeric value as the showtime ID.
2. It loads the saved seat-watch configuration and resolves the existing watch
   name case-insensitively.
3. It dispatches `add_showtime` to the dedicated seat-watch Action with only
   `{ "id": "<showtimeId>" }` as its payload.
4. The command handler automatically obtains Cineplex's current public browser
   header, then performs the one-time detail lookup and paired seat validation
   before writing any configuration.

The Worker records request IDs and showtime IDs but never chat IDs, payload
bodies, or secrets. An unknown/disabled watch returns a clear instruction to
create the full watch in the web interface first.

Verified locally:

```text
python3 scripts/test-seat-watcher.py
python3 -m py_compile seat_watcher.py seat_watch_command.py scripts/test-seat-watcher.py
node --check cloudflare-worker/src.js
```

All checks passed. The no-network test proves the detail request is made once,
normalizes the returned time to `Jan 14, 12:15 PM`, then proceeds to the layout
and availability validation.

Additional reusable live proof:

```text
python3 scripts/check-showtime-detail.py 9406 405853
```

It prints only theatre ID, showtime ID, date, and local start time; it never
prints Cineplex's temporary header.

## 2026-09-13 — Stage 7: real Cineplex registration and scan proof

Ran the complete registration and scan path against Cineplex, using a temporary
local configuration only. No GitHub dispatch, Telegram message, commit, or
production watch was created.

```text
python3 seat_watch_command.py create --root <temporary directory> --payload <E2E Dune test>
python3 seat_watcher.py scan --root <temporary directory>
python3 seat_watcher.py scan --root <temporary directory>
python3 seat_watch_command.py add_showtime --root <temporary directory> --watch-id e2e-dune-test --payload '{"id":"999999"}'
```

Observed results for theatre `9406`, showtime `405853`:

- The automatic public-header discovery retrieved the real detail response.
- Saved metadata was `2027-01-14T00:00:00`, `2027-01-14T12:15:00`, and
  `Jan 14, 12:15 PM`.
- The real seat-layout selected exactly 49 seats for the approved rule.
- The first availability scan succeeded and found 9 selected seats available.
- The immediate second scan reported 0 new seats, proving persisted
  de-duplication on real availability data.
- Adding invalid showtime `999999` returned Cineplex HTTP 404 and left the
  saved configuration with only `405853` and its 9 de-duplication entries.

Lesson retained: a live detail lookup, paired seat validation, first scan, and
second scan are required before claiming registration works. A failed
registration must leave the existing saved watch untouched.

## 2026-09-13 — Stage 8: real Telegram user end-to-end proof

The seat watcher was committed, pushed, and deployed as Worker version
`887e1e20-2c70-4bdd-9d0d-e70f44a01df9`. A real Telegram user sent:

```text
/watchshowtime Dune 405854
```

Observed full path:

1. The deployed Worker immediately replied: `Adding #405854 to Dune`.
2. Worker dispatched GitHub Actions run `34795193913` at the deployed source
   SHA. The run completed successfully.
3. The Action performed one-time detail lookup, saved `405854` as Jan 14 at
   3:30 PM, validated the real layout/availability APIs, scanned both watched
   showtimes, and committed state.
4. Telegram sent the final confirmation: `Added showtime #405854 to Dune`.
5. GitHub read-back confirmed both `405853` and `405854` have correct saved
   metadata and 49 selected seats each.

An additional real production scan, GitHub Actions run `34795328415`, completed
successfully immediately afterward. Its committed log recorded 9 and 5 selected
available seats but `new_seats=0`; the de-duplication list remained at 14 and
Telegram showed no additional alert. This proves the system does not alert the
same available seat twice on a later successful scan.

Lesson retained: do not call a local API test a real user test. Complete proof
requires an actual Telegram-originated command, deployed Worker acknowledgement,
successful Action at the deployed SHA, persisted GitHub state, final Telegram
reply, and a later scan that confirms de-duplication.

## Next implementation step: `/stopshowtime`

The next isolated step adds `/stopshowtime <watch name> <showtimeId>` to the
Worker. It resolves the existing enabled watch, checks that the showtime is
active, dispatches `stop_showtime`, and replies only after the Action saves the
change. The repeatable regression script verifies that it disables only the
requested showtime and removes only that showtime's de-duplication entries.

## 2026-09-13 — Stage 9: `/stopshowtime` live proof

`/stopshowtime Dune 405854` was sent by a real Telegram user to the deployed
Worker. The Worker acknowledged the request, GitHub Actions run `34795780587`
completed successfully, and Telegram replied: `Stopped showtime #405854 for
Dune.`

GitHub state read-back confirmed `405854` is disabled, `405853` remains
enabled, and the available-seat list contains only the 9 entries for `405853`.
This proves stopping one showtime does not stop the movie watch or erase alerts
for the other watched showtimes.

Lesson retained: test destructive-looking commands against a multi-showtime
watch. The assertion must prove both the requested removal and preservation of
the unrelated active showtime and its de-duplication records.

## Next implementation step: `/stopseats`

The next isolated step adds `/stopseats <watch name>`. It must disable the
whole watch, clear every available-seat alert entry for that watch, retain the
configuration for later editing, and leave unrelated watches untouched. The
repeatable regression script covers those saved-state effects before deployment.

## 2026-09-13 — Validation correction found while restoring the live test watch

The first restoration attempt used a compact rule such as `"E": [9, 17]`
instead of the documented range-list shape `"E": [[9, 17]]`. The command
handler accepted it, then the layout validation raised a Python type error.
No state was saved or changed because the failure occurred before writes.

`validate_watch` now rejects malformed, non-positive, descending, overlapping,
or duplicate-row rules before it makes any Cineplex request. The repeatable
test includes the malformed compact shape.

Lesson retained: validate a command payload's complete nested data contract at
the command boundary. Do not rely on later scanning code to reveal malformed
configuration.

## Next implementation step: `/listseats`

The next isolated step renders only enabled seat watches. Each movie line is a
single Cineplex-preview link: status, available selected-seat count, theatre,
active-showtime count, and next-check or failure status. The first showtime
with availability is the link target; if none has availability, it is the
earliest enabled showtime. The message also gives exact follow-up commands and
the web-interface link. `scripts/test-seat-list-message.mjs` verifies the
rendering without network access before the real Telegram command test.

## 2026-09-13 — Stage 10: `/listseats` live proof

The Worker was deployed as version `2a3dda7c-c977-49ff-8ada-44cdc91e665e`.
A real Telegram `/listseats` request returned the approved compact Dune block:
9 seats, theatre `#9406`, one active showtime, and a clickable complete summary
line targeting showtime `#405853`. It also displayed the detail, add-showtime,
and stop commands and the web-interface link.

Lesson retained: a rendering test catches HTML escaping, link selection, and
hidden stopped watches before deployment; the real Telegram test must still
verify that Telegram makes the entire intended summary line clickable.

## Next implementation step: `/seatinfo`

The detailed command must use the latest saved successful scan only. It groups
currently available selected seats by row, shows each enabled successful
showtime exactly once in either the availability or no-availability section,
keeps failures separate, and links every showtime to Cineplex preview. The
same message-rendering script covers both `/listseats` and `/seatinfo`.
