# T01 Seat Watcher — final implementation guideline

## 1. Purpose and boundaries

Build a Cineplex **seat watcher** for precise seats in already-known showtimes. It is separate from the current movie-sale watcher:

| Existing movie watcher | New seat watcher |
|---|---|
| Checks whether a movie has started ticket sales. | Checks selected seats in known showtimes. |
| Runs every 30 minutes. | Runs every five minutes. |
| Watches a Cineplex movie URL. | Watches theatre ID, showtime IDs, and seat-label ranges. |

The seat watcher sends a Telegram alert when a selected seat is `Available`. It does not alert again while that same seat stays available. If it becomes unavailable and later available again, it alerts once again.

This document is the implementation contract. It does not implement product code by itself.

## 2. Architecture and ownership

```text
Protected web form ─┐
Telegram commands ──┼─> Cloudflare Worker ─> Seat-watch GitHub Action
                    │                             │
                    │                             ├─> Cineplex layout + availability APIs
                    │                             ├─> committed JSON state + rolling log
                    │                             └─> Telegram result / alerts
                    └─> existing Worker authorization rules
```

- **Web form:** creates and edits complex watches. Users do not type theatre IDs, long showtime lists, or seat ranges into Telegram.
- **Telegram:** receives alerts and provides lightweight commands.
- **Cloudflare Worker:** validates existing authorized Telegram chat IDs, validates protected browser requests, logs dispatch events, and dispatches GitHub Actions. It does not write Git files directly.
- **GitHub Action:** validates input, calls Cineplex, writes seat-watch JSON/log files, commits once, and delivers Action results to Telegram.
- **Cineplex APIs:** `seat-layout` maps an API seat ID to a visible seat label; `seat-availability` supplies current status keyed by seat ID.

Use a dedicated `check-seat-watches.yml` workflow. Do not change the existing 30-minute movie-sale workflow except to share helpers when safe.

## 3. Watch creation and editing

The protected web form contains:

- Watch name, for example `Dune`.
- Theatre ID, for example `9406`.
- Theatre display name, for example `Scotiabank Theatre Toronto`.
- Showtime IDs in one comma-separated field, for example:

  ```text
  405740,405741,405743,405745,405750,405751,405752,405753,405754,405755,405760,405761,405765
  ```

- Display date/time for every showtime, for example `Dec 14, 6:00 PM`.
- Seat-label ranges, for example `E9-E17, F14-F23, G14-G23, H14-H23, I14-I23`.
- Start, edit, and stop controls.

The layout/availability API examples do not supply the human-readable showtime date/time. The form must capture or confirm it from the ticketing page and store it with the showtime.

### 3.1 Layout reference

Implement the watcher-first layout in [seat-watcher-layout-template.html](seat-watcher-layout-template.html). Use one compact card per watcher, with its name, theatre, theatre ID, selected-seat total, and showtime total on the same summary line. Inside that card, group enabled showtimes by date and order them by time. Each date heading shows its selected-seat total and showtime count, for example `Monday, Dec 14 · 4 🪑 · 🎬 3`. Every showtime is a compact clickable Cineplex-preview row; because its parent already gives the date, show only the time in the row. Use emoji icon buttons for Edit and Stop. Both the watcher summary and each date heading have a `🔺`/`🔻` collapse control. Cards fit their content on wider screens and use the available width on phones. The file is static reference markup only; wire it to the protected API and saved watch state during implementation.

### 3.1.1 Seat preview popup

Add an `👁️ Seats` button to every active watcher header. It opens the watcher-level popup shown in [seat-preview-popup-template.html](seat-preview-popup-template.html). The popup shows all seats from a selected enabled showtime's real Cineplex `seat-layout`: watched labels are yellow and every other selectable seat is blue. Keep actual gaps, aisles, and unavailable/non-seat positions from the API rather than assuming a rectangular theatre. The static template uses a simple rectangle only to demonstrate the colour and interaction contract. The popup is informational: it does not change what is scanned, and blue seats never create alerts.

Stopped watches must remain visible in a separate compact `Stopped watches` section. Their `Edit` button opens the same form with the saved values; saving it revalidates the full configuration and restarts that watch. Do not require the user to create a duplicate watch merely to restart or change it.

### 3.2 Protected web API

The web form uses the existing UI-origin and bearer-token security model. The Worker returns `202 Accepted` after dispatching the Action; the Action performs validation and persistence.

| Request | Meaning |
|---|---|
| `POST /api/seat-watches` | Create a watch. |
| `PATCH /api/seat-watches/<watchId>` | Replace one watch's editable configuration. |
| `DELETE /api/seat-watches/<watchId>` | Soft-stop one watch; retain its configuration. |

Create and edit payloads may include display metadata in this shape:

```json
{
  "name": "Dune",
  "theatreId": "9406",
  "theatreName": "Scotiabank Theatre Toronto",
  "showtimes": [
    { "id": "405743", "startsAt": "2026-12-14T18:00:00-05:00", "displayTime": "Dec 14, 6:00 PM" }
  ],
  "rule": { "E": [[9, 17]], "F": [[14, 23]], "G": [[14, 23]], "H": [[14, 23]], "I": [[14, 23]] }
}
```

`startsAt` and `displayTime` are optional metadata. They make date grouping and
human-readable output better, but neither is required to scan seats. In
particular, Telegram users must provide only a watch name and showtime ID:

```text
/watchshowtime Dune 405765
```

When a showtime is registered, the Action makes one metadata request before the
seat validation:

```text
GET /prod/cpx/theatrical/api/v1/theatres/<theatreId>/showtimes/<showtimeId>
```

Use its `showDate` and `showtime.showStartDateTime` to save `showDate`,
`startsAt`, and a formatted `displayTime`. The Action automatically discovers
the temporary public browser header from Cineplex's public website; no user or
GitHub secret setup is required. This request is never part of the five-minute
scan. The Action verifies that the returned theatre and Vista session ID match
the requested IDs. It stores only these display fields—not the full response—
and does not log the header or raw body.

The Action validates all supplied showtimes before saving a new web-form configuration. If any new showtime cannot provide valid layout and availability responses, reject the request without saving a partial watch.

The Worker dispatches `check-seat-watches.yml` with these `workflow_dispatch` inputs:

| Input | Used by |
|---|---|
| `operation` | `create`, `edit`, `stop`, `add_showtime`, `stop_showtime`, `refresh`, or `scan`. |
| `watch_id` | Existing watch for operations other than create. |
| `payload` | Create/edit JSON or the single showtime ID. Never log this raw value. |
| `request_id` | Correlates Worker and Action logs. |
| `chat_id` | Command-result recipient only; omit for scheduled or web-triggered scans. |

The workflow needs `contents: write` permission for the four committed seat-watch files. It must validate every input again; Worker validation is not a substitute for Action validation.

### 3.3 Validation rules

- Theatre ID and every showtime ID contain digits only.
- Parse comma-separated showtime IDs by trimming whitespace and dropping blank items. Reject an empty result.
- De-duplicate repeated submitted IDs. Reject a showtime already attached to the same watch: `Showtime #<id> is already watched for <name>.`
- A seat range is `start-end`, both positive integers, with `start <= end`. Reject malformed or overlapping ranges; never silently change a rule.
- Watch IDs are lowercase slugs created once from the name. Name matching is case-insensitive. Reject a second watch whose normalized name collides with an existing watch.
- Validate a newly added showtime with one layout request and one availability request before saving it.
- A full edit that changes theatre, showtimes, or seat ranges invalidates old selected-seat mappings and alert-list entries. Reload layouts and treat seats matching the new rule as newly available.

## 4. Telegram commands and recipient rules

All seat-management commands use the existing authorized-chat check. Command replies go only to the issuing chat. Availability and failure alerts go to the existing configured Telegram recipient list.

```text
/watchshowtime Dune 405765
/stopshowtime Dune 405741
/stopseats Dune
/listseats
/seatinfo Dune
/refreshseats Dune          optional manual immediate scan
```

| Command | Contract |
|---|---|
| `/watchshowtime <watch name> <showtimeId>` | Adds one validated showtime to an existing enabled watch. No date or time is entered by the user. |
| `/stopshowtime <watch name> <showtimeId>` | Disables that showtime and removes its available-seat alert entries. |
| `/stopseats <watch name>` | Disables every showtime in that watch and clears its alert entries; does not delete configuration. |
| `/listseats` | Shows a short summary for every enabled watch. |
| `/seatinfo <watch name>` | Shows detailed current state for one watch. |
| `/refreshseats <watch name>` | Optional: queues one immediate scan without changing the normal schedule. |

For `/watchshowtime` and `/stopshowtime`, the final whitespace-separated value is the numeric showtime ID; every earlier word is the watch name. Example: `/watchshowtime Dune Part Three 405765` targets `Dune Part Three`.

Unknown or ambiguous names return a clear error, for example:

```text
No seat watch named “Dune”. Example: /seatinfo Dune
```

## 5. Persistent state

Only the seat-watch Action writes these committed files. No file may contain credentials, tokens, authorization headers, or Telegram chat IDs.

### 5.1 `seat-watches.json` — configuration

```json
{
  "watches": {
    "dune": {
      "id": "dune",
      "name": "Dune",
      "enabled": true,
      "theatreId": "9406",
      "theatreName": "Scotiabank Theatre Toronto",
      "rule": { "E": [[9, 17]], "F": [[14, 23]], "G": [[14, 23]], "H": [[14, 23]], "I": [[14, 23]] },
      "showtimes": {
        "405743": {
          "enabled": true,
          "startsAt": "2026-12-14T18:00:00-05:00",
          "displayTime": "Dec 14, 6:00 PM"
        }
      }
    }
  }
}
```

### 5.2 `seat-watch-state.json` — derived scan state

```json
{
  "watches": {
    "dune": {
      "lastCheckedAt": "2026-09-13T18:35:02Z",
      "lastCheckStatus": "success",
      "showtimes": {
        "405743": {
          "lastCheckedAt": "2026-09-13T18:35:02Z",
          "lastCheckStatus": "success",
          "selectedSeats": {
            "1_6_20": { "label": "F20", "status": "Available" }
          }
        }
      }
    }
  }
}
```

Store `lastError` only for a failed showtime and clear it after its next successful scan.

### 5.3 `available-seat-list.json` — alert de-duplication

This file is the set of selected seats that were available after their latest successful scan. A full identity is required because `F20` can exist in multiple showtimes.

```json
{
  "Dune|9406|405743|1_6_20": {
    "watchName": "Dune",
    "theatreId": "9406",
    "showtimeId": "405743",
    "seatId": "1_6_20",
    "seatLabel": "F20",
    "availableSince": "2026-09-13T18:35:02Z"
  }
}
```

### 5.4 `seat-watch.log` — durable operational log

Keep a rolling committed text file containing the newest 1,000 lines only. It is human-readable and separate from JSON state.

```text
[26-09-13 03:09:02] [info] watch=Dune showtime=405743 cineplex availability call initiated
[26-09-13 03:09:03] [info] watch=Dune showtime=405743 selected_available=23
[26-09-13 03:09:04] [info] watch=Dune showtime=405743 telegram availability alert sent seats=E10,E12,F22
[26-09-13 03:09:06] [error] watch=Dune showtime=405750 cineplex availability call failed after 3 attempts: HTTP 503
```

Use Montreal time and `YY-MM-DD HH:MM:SS`. Log workflow start/end, API-call start, selected-seat count, layout refresh, alert sent, Telegram delivery failure, final API failure, configuration change, and completed showtime. Write the same sanitized event to the GitHub Actions log.

Never log tokens, authorization headers, chat IDs, raw Cineplex bodies, or raw exception/request bodies. The Worker logs command dispatches; the committed Action log is the durable scan record.

## 6. Seat selection and Cineplex contract

For each showtime, call both endpoints:

```text
.../theatre/<theatreId>/showtime/<showtimeId>/seat-layout
.../theatre/<theatreId>/showtime/<showtimeId>/seat-availability
```

Use `seat-layout` to map a seat ID such as `1_6_20` to its visible `seat.label`, such as `F20`. Use the ID to look up its value in `seatAvailabilities`; use the readable label in Telegram and UI output.

Do **not** use `columnPhysicalNumber` for the rule. Split `seat.label` into its row and number. The initial Dune rule is:

```python
(row in {"F", "G", "H", "I"} and 13 < label_number < 24) \
or (row == "E" and 8 < label_number < 18)
```

Examples: `F20`, `H15`, and `E10` are included; `F24`, `E18`, and `D15` are excluded. A normal Dune layout selects 49 seats: E9-E17 (9) plus F14-F23 through I14-I23 (40).

Only the exact availability value `Available` is available. Treat all other values as not available. `isSoldOut` does not replace per-seat status. `isPostShowtime: true` completes the showtime as described below.

Before release, reproduce a current live layout/availability request pair. Captured fixture files are dated design evidence, not proof that the live API contract has not changed.

## 7. Scan lifecycle and alert algorithm

### 7.1 First scan

For each newly added showtime:

1. Fetch layout and build/save the selected `{ seatId, label }` mapping.
2. Fetch availability.
3. Run the normal available-seat algorithm.
4. Currently available selected seats are new and receive one grouped alert.

### 7.2 Scheduled scan

The dedicated workflow runs on `*/5 * * * *`. GitHub can run late, so “next check” is an estimate; state comparison, not exact timing, guarantees de-duplication.

For each enabled, non-completed showtime:

1. Fetch availability with a 30-second timeout.
2. Retry a transient network/HTTP error at most twice with short backoff.
3. Do not retry malformed JSON or a valid response with an unexpected shape.
4. On success, evaluate selected seats and update state.
5. On final failure, preserve the prior available-seat list, record the error, log it, and send one Telegram failure alert for that showtime.
6. Continue scanning all other showtimes.

If none of the saved selected seat IDs exist in a successful availability response, reload the layout once. Replace the saved mapping only if the refreshed layout produces one or more selected seats. A failed refresh preserves the earlier mapping and records the failure.

On successful `isPostShowtime: true`, disable only that showtime, clear its alert-list entries, mark it `completed`, log the event, and do not send a seat-availability alert. It remains visible as completed in the web form but is not scanned or shown in `/listseats`. It can only be added again as a new validated showtime.

### 7.3 Available-seat algorithm

For each successful enabled showtime scan:

1. Build `currentlyAvailable` from selected seats whose value is exactly `Available`.
2. Compare every full seat identity with `available-seat-list.json`.
3. Seats already present: do not alert.
4. Missing seats: add to `newlyAvailable` and the in-memory alert list.
5. Remove this showtime's alert-list entries absent from `currentlyAvailable`; these seats are no longer available, missing, or no longer selected.
6. When `newlyAvailable` is non-empty, send one Telegram message for that watch + showtime, grouped by row. Never send one message per seat.
7. Persist state and the updated alert list after the scan has determined all intended changes.

Alert delivery is **at least once**: a rare duplicate is acceptable; silently missing a seat is not. If Telegram accepts a message but the workflow stops before committing state, the next scan may repeat that grouped alert. Keep alerts clear and compact so a duplicate is harmless.

Example grouped availability alert:

```text
🪑 <b>New selected seats — Dune</b>
Scotia Bank · #9406

<b>Dec 14 · #405743 · 6:00 PM</b>
<a href="https://www.cineplex.com/ticketing/preview?theatreId=9406&amp;showtimeId=405743">E: 10, 12</a>
<a href="https://www.cineplex.com/ticketing/preview?theatreId=9406&amp;showtimeId=405743">F: 22</a>

—
⏹ <code>/stopshowtime Dune 405743</code>
🌐 <a href="https://ettersay.github.io/cplex-watcher/">Web interface</a>
```

Example final failure alert:

```text
❌ <b>Seat scan failed — Dune</b>
Scotia Bank · #9406

<a href="https://www.cineplex.com/ticketing/preview?theatreId=9406&amp;showtimeId=405750">#405750 · Dec 14, 10:30 PM</a>

HTTP 503 from Cineplex seat availability
The watcher will retry automatically in about 5 min.

📖 <code>/seatinfo Dune</code>
```

If Telegram delivery fails, log that delivery failure. Telegram cannot receive an alert about its own delivery outage.

## 8. Workflow safety and persistence

Every operation that can write seat-watch files shares one GitHub Actions concurrency group, for example `seat-watch-write`, with `cancel-in-progress: false`:

- scheduled scans;
- web-form create, edit, and stop;
- `/watchshowtime`, `/stopshowtime`, `/stopseats`;
- optional `/refreshseats`.

This queues later work behind active work and prevents two runs from scanning, alerting, and committing the same state at once.

One Action run must:

1. Check out the current branch and read all four seat-watch files.
2. Apply validated command or form changes when applicable.
3. Scan enabled showtimes and calculate all state/log changes in memory.
4. Send required grouped availability or final-failure alerts.
5. Write changed files once.
6. Make one commit and push only when files changed.

If a final push conflicts with another authorized change, retry checkout/rebase once and rerun from fresh files. Never force-push or overwrite newer configuration.

## 9. Telegram rendering

Use Telegram HTML parse mode. Escape every saved watch name, theatre name, seat label, and error text before rendering. Every shown showtime must link directly to:

```text
https://www.cineplex.com/ticketing/preview?theatreId=<theatreId>&showtimeId=<showtimeId>
```

If a response exceeds Telegram's message limit, send the summary and available-seat section first, then send numbered continuation messages. Never silently omit a configured showtime.

### 9.1 Approved alert and command templates

Use these Telegram HTML templates. Replace `PREVIEW_URL` with the official Cineplex preview URL for the theatre/showtime.

**New seats alert**

```html
🪑 <b>New selected seats — Dune</b>
Scotia Bank · #9406

<b>Dec 14 · #405743 · 6:00 PM</b>
<a href="PREVIEW_URL">E: 10, 12</a>
<a href="PREVIEW_URL">F: 22</a>

—
⏹ <code>/stopshowtime Dune 405743</code>
🌐 <a href="https://ettersay.github.io/cplex-watcher/">Web interface</a>
```

**Final scan failure**

```html
❌ <b>Seat scan failed — Dune</b>
Scotia Bank · #9406

<a href="PREVIEW_URL">#405750 · Dec 14, 10:30 PM</a>

HTTP 503 from Cineplex
The watcher will retry automatically in about 5 min.

📖 <code>/seatinfo Dune</code>
```

**Successful add-showtime command**

```html
✅ <b>Showtime added</b>

<b>Dune</b> · Scotia Bank · #9406
<a href="PREVIEW_URL">#405765 · Dec 14, 9:15 PM</a>

📖 <code>/seatinfo Dune</code>
🌐 <a href="https://ettersay.github.io/cplex-watcher/">Web interface</a>
```

### 9.2 `/listseats`

Use one compact, action-first block per enabled watch. `Seats found` is the latest count of selected seats currently known to be `Available`.

The complete first line for each watch is one Telegram HTML link. Its target is the enabled showtime with selected seats available and the earliest `startsAt` value. If no selected seats are available, target the earliest enabled showtime instead. This ensures every watch opens a useful Cineplex preview page while prioritizing the first available result.

```html
🎟 Seat watches

<a href="FIRST_AVAILABLE_SHOWTIME_PREVIEW_URL">🟢 <b>Dune</b> · Scotia Bank · #9406 · 5 🪑 · 10 🎬</a>
↳ 📖 <code>/seatinfo Dune</code> · 👁 in 4 min

<a href="FIRST_AVAILABLE_SHOWTIME_PREVIEW_URL">❌ <b>Dune 2</b> · #8303 · 20 🪑 · 5 🎬</a>
↳ 📖 <code>/seatinfo Dune 2</code> · ⚠️ failed

<a href="EARLIEST_ENABLED_SHOWTIME_PREVIEW_URL">⚪ <b>Odyssey</b> · Scotia Bank · #9406 · 0 🪑 · 1 🎬</a>
↳ 📖 <code>/seatinfo Odyssey</code> · 👁 in 6 min

—
🌐 <a href="https://ettersay.github.io/cplex-watcher/">Web interface</a>
➕ <code>/watchshowtime WatchName ShowtimeId</code>
```

Use `⏳` after a latest complete successful scan and `❌` after a latest failed scan. Failed watches retain their last known count and use `⚠️ failed` instead of a next-check estimate. Times in other output use Montreal time in `YY-MM-DD HH:MM:SS`.

### 9.3 `/seatinfo <watch name>`

Show the watch summary, then two complete sections for successfully scanned showtimes: those with selected seats available, and those with none. Every enabled successful showtime appears exactly once across the two sections. Group each section by show date, place every showtime on its own clickable line, and show time only because the parent heading already gives the date. Do not include occupied or out-of-rule seats in availability details.

For the Dune rule, E18 and E19 must not appear because the E range ends at E17.

```text
🎟 <b>Dune</b> · Scotia Bank · #9406 · 10 🪑 · 6 🎬

🟢 <b>Available</b>

<b>Monday, Dec 14 · 10 🪑 · 🎬 2</b>
• <a href="https://www.cineplex.com/ticketing/preview?theatreId=9406&amp;showtimeId=405743">#405743 · 6:00 PM · 3 🪑</a>
• <a href="https://www.cineplex.com/ticketing/preview?theatreId=9406&amp;showtimeId=405765">#405765 · 9:15 PM · 7 🪑</a>

⚪ <b>Still watching</b>

<b>Tuesday, Dec 15 · 0 🪑 · 🎬 2</b>
• <a href="https://www.cineplex.com/ticketing/preview?theatreId=9406&amp;showtimeId=405740">#405740 · 3:00 PM · 0 🪑</a>
• <a href="https://www.cineplex.com/ticketing/preview?theatreId=9406&amp;showtimeId=405745">#405745 · 7:30 PM · 0 🪑</a>

—
🕒 Checked at 26-09-13 14:35:02
🌐 <a href="https://ettersay.github.io/cplex-watcher/">Web interface</a> · ➕ <code>/watchshowtime Dune ShowtimeId</code> · ⏹ <code>/stopshowtime Dune ShowtimeId</code>
```

If no selected seats are available, omit the empty first section but list all enabled successful showtimes in the no-availability section.

Failed showtimes never appear as zero-seat showtimes. Add this third section only when needed:

```text
Failed showtimes:
  • ❌ <a href="https://www.cineplex.com/ticketing/preview?theatreId=9406&amp;showtimeId=405750">#405750</a> — Dec 14, 8:00 PM
    HTTP 503 from Cineplex seat availability
```

Do not present stale results as fresh data.

## 10. Required verification before release

1. Reproduce a current live Cineplex layout/availability pair before relying on dated fixtures.
2. A layout fixture includes F20, H15, and E10; excludes F24, E18, and D15.
3. The Dune rule selects 49 seats from the normal fixture.
4. An all-`Occupied` availability fixture sends no availability alert.
5. Changing one selected seat to `Available` sends one grouped message containing its readable label and preview link.
6. Repeating an unchanged scan sends no new availability alert.
7. A seat becoming occupied then available again sends one new alert.
8. Multiple new seats in one showtime produce one grouped alert, not one alert per seat.
9. A workflow stop after Telegram accepts an alert can produce one harmless later duplicate; it must not suppress the seat forever.
10. A failed availability request preserves its prior alert-list entries, records a sanitized error, and sends one failure message after retries are exhausted.
11. Failed showtimes render only in `Failed showtimes`, never in the no-availability section.
12. `/watchshowtime` and `/stopshowtime` change only the requested existing watch/showtime; invalid commands make no change.
13. Web-form create/edit/stop uses protected endpoints, validates all data, and a rule edit invalidates stale mappings/alert entries.
14. A post-showtime response completes only that showtime and prevents future scans.
15. Missing saved IDs trigger one layout refresh; a failed refresh preserves state and records the error.
16. Overlapping scheduled, web, and Telegram operations share concurrency and cannot concurrently commit or duplicate a scan alert.
17. A protected browser form request dispatches the documented Action inputs, and the Action rejects a malformed or unauthorized payload without changing files.
18. Test malformed JSON, missing labels, API failures, Telegram HTML escaping, message splitting, log trimming, and the full first-scan → available → occupied → re-available lifecycle.
