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
