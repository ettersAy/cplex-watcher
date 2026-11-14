# Cineplex Ticket Watcher operations guide

This guide documents the deployed watcher as of 2026-09-13. It describes the current architecture only; old Cloudflare KV watch records and the GitHub-Action-to-Worker callback are retired.

## Architecture

```text
Telegram /watch ─┐
                 ├─> Cloudflare Worker ─> GitHub Actions lookup/check
Web page /queue ─┘                              │
       ▲                                        ├─> movies.json (active URLs)
       │                                        ├─> sales-started.json (completed sales)
       │                                        ├─> state.json (latest checks)
GitHub Pages <── reads public JSON ─────────────┘
                                                 └─> Telegram admin alert
```

### Responsibilities

| Component | Responsibility |
|---|---|
| Cloudflare Worker | Validates Telegram updates, protects the web queue API, dispatches GitHub Actions, and formats `/list`. |
| GitHub Actions | Looks up titles, deduplicates Cineplex URLs, performs 30-minute checks, persists check state, and sends Telegram messages. |
| `movies.json` | Source of truth for active watches. Each entry is one official Cineplex URL. |
| `sales-started.json` | Movies moved out of the active queue after Cineplex reports that sales started. |
| `state.json` | Last successful or failed check for each active watch, including `hasShowtimes`, timestamp, and error. |
| GitHub Pages | Static admin page. It validates a local browser token, then reads the public JSON lists and posts new titles to the Worker. |
| Telegram | Admin command and notification channel. |

## Commands and expected results

### `/watch Movie Name`

The Worker immediately replies:

```text
Searching Cineplex for Movie Name. I will reply when the watch is registered.
```

The Action then sends one result:

| Result | Meaning |
|---|---|
| `Started watching …` | A matching movie has no showtimes yet and was added to `movies.json`. |
| `Already watching …` | The matching official Cineplex URL already exists in `movies.json`; no duplicate is added. |
| `Tickets are already on sale …` | The movie has showtimes, so it is not added as a future-sale watch. |
| Search error | The title was not found, was ambiguous, or Cineplex could not be checked. |

### `/list`

Sales-started movies are listed first, then active watches. Each movie uses one compact line:

```text
⏳ Clickable movie title 👁️ in X min ☀️ Last check YY-MM-DD HH:MM:SS
```

- Timestamps are displayed in Montréal time (`America/Toronto`) in `YY-MM-DD HH:MM:SS` format. Stored timestamps remain UTC.
- `Status: Failed` and `Sales: Unable to determine` mean the last GitHub Action check failed; the error is retained in `state.json`.
- `Status: Success` with `Sales: Not Yet` means the latest official Cineplex check found no showtimes.

## Ticket-sale alert behavior

The scheduled `Check Cineplex ticket sales` workflow runs on this cron schedule:

```text
*/30 * * * *
```

`watcher.py` uses Cineplex's national `hasShowtimes` value for ordinary watches. The George Michael Montréal rule below replaces that value with a local bookable-session check.

| `hasShowtimes` | Displayed sales status | Telegram alert |
|---|---|---|
| `false` | Not Yet | No alert. |
| `true` | Started | Sends one alert, moves the movie to `sales-started.json`, then removes it from `movies.json`. |
| Check error | Unable to determine | No sale alert; stores the error. |

The alert is sent directly from GitHub Actions with its Telegram secrets. This avoids the previous Worker callback HTTP 403 issue.

### George Michael — Montréal only

**Prepared locally on 2026-11-14; deployment is pending.**

For the `george-michael-the-faith-tour` URL, `get_movie()` reads the current Cineplex film ID, then checks these public theatrical API endpoints:

1. `theatres?language=en&filmId={filmId}`: find theatres showing that movie, and match their `location.city` to Montréal (accent-insensitive).
2. For matching theatres, `dates/bookable?language=en&filmId={filmId}&locationId={theatreId}`: get actual available dates.
3. For those dates, `showtimes?language=en&filmId={filmId}&locationId={theatreId}&date={M/D/YYYY}`: require the correct film and theatre, an online-enabled session with a `vistaSessionId`, and neither `isInThePast` nor `isSoldOut`.

The search stops at the first bookable Montréal session. With no Montréal theatre in the movie's theatre list, the check needs the movie page and one theatre lookup. No date-range polling, seat-layout requests, or additional scheduler is involved. The shared seat-metadata API helper uses Cineplex's verified public frontend key, and rediscovers it once per process only if rejected. A failed refresh propagates the original API error.

This means Montréal city, not the wider metropolitan area: Laval, Brossard, Kirkland, and Mont-Royal are separate cities in Cineplex's directory. The theatre IDs are not hardcoded.

`state.json` records `city`, the original `nationalHasShowtimes`, and the first matching `showtime`; its existing `hasShowtimes` field now means Montréal availability for this movie. Both scheduled checks and `/watch` registration use `get_movie()`, so a national sale does not reject a new Montréal watch. Telegram sale messages include Montréal, the theatre, and the local screening time. Existing recipients, including `TELEGRAM_GEORGE_MICHAEL_ALERT_CHAT_IDS`, are preserved.

On the first updated run, `rearm_montreal_watch()` moves the old national result back into the active queue and clears its national alert flag. The saved `city` marks that correction as complete, so later successful Montréal alerts stay completed. A movie absent from both the active and completed lists is not recreated. Other movie records are preserved.

API failures are saved as failed checks and leave the movie active. Missing Telegram configuration or failed delivery also retains the movie for retry while allowing other movies to run. A partial failure across multiple Telegram recipients can resend to an earlier successful recipient on retry; per-recipient delivery state is not tracked.

Verification on 2026-11-14:

- The changed `get_movie()` returned `nationalHasShowtimes: true`, `hasShowtimes: false`, `city: Montréal`, and no local session for the supplied George Michael URL.
- A positive control in Toronto returned theatre `7400`, session `314899`, December 9 at 19:00. This was a read-only API check; no ticket purchase or Telegram message was sent.
- The production-state rehearsal used temporary JSON files and live Cineplex reads: George Michael returned to the active list, six other completed movies were preserved, and no Telegram message was sent.
- All 26 focused tests passed with `python3 -m unittest discover -s tests -v`; the existing seat-watcher checks passed with `/opt/homebrew/bin/python3 scripts/test-seat-watcher.py`. The changed shared helper also returned live seat metadata successfully for the Toronto control session.
- Production state still records the national alert from `2026-11-11T22:57:42.764734+00:00`; the local migration has not been run against production.

Publish the Python changes through the existing GitHub repository, then run the normal ticket check and inspect its saved state. No Cloudflare Worker or Pages deployment is required for this change. Preserve the upstream workflow's concurrency group and push-retry logic when merging the local branch. The configured schedule is every 30 minutes; GitHub controls the actual start time.

## Web interface

URL: <https://ettersay.github.io/cplex-watcher/>

The page is intentionally basic:

- Shows sales-started movies first, followed by the active-watch data from `/list`.
- Links every title to the official Cineplex page.
- Lets the admin submit 1 to 10 titles, one title per line, through the protected queue endpoint.
- Lets the admin stop watching an active movie by its exact official Cineplex URL. After the request is accepted, the page waits for the GitHub Action and reloads the list.
- Does not include a database or a separate persistent web queue. A successful search or removal appears after the GitHub Action updates `movies.json`; refresh the page then.

Each light-weight card uses icons to summarize the latest state:

| Icon | Meaning |
|---|---|
| `⏳` | Watching; ticket sales have not started. |
| `🎉` | Ticket sales started. |
| `🔴` | Last check failed. |
| `☀️` | Last check succeeded. |
| `❌` | Last check failed; ticket availability is unknown. |
| `📢` | Saved check error follows. |

### Web queue API

```text
POST https://cplex-watcher.cplexwatcher.workers.dev/api/queue
Origin: https://ettersay.github.io
Authorization: Bearer <UI_ACCESS_TOKEN>
Content-Type: application/json

{"titles":"Movie Name\nAnother Movie Name"}
```

The Worker trims blank lines, keeps the first occurrence of repeated titles without case sensitivity, and accepts at most 10 titles of 140 characters each. One request dispatches one Action, which processes the titles sequentially before updating shared state.

Stop watching uses the same protected endpoint:

```text
DELETE https://cplex-watcher.cplexwatcher.workers.dev/api/queue
Origin: https://ettersay.github.io
Authorization: Bearer <UI_ACCESS_TOKEN>
Content-Type: application/json

{"url":"https://www.cineplex.com/movie/example"}
```

The Action removes the exact URL from `movies.json` and the matching state entry from `state.json`, then sends a Telegram confirmation.

### Legacy manual scan endpoint

The current `web/app.js` reads the saved ticket state and does not call `/api/scan`. That older endpoint still returns national movie-page data and does not send sale alerts. The Montréal rule is enforced by the Python scheduled and registration paths described above.

The former **Scan all** button requested one protected Worker scan for each active Cineplex URL, waited five seconds between requests, and updated the cards as results arrived.

The static GitHub Pages site cannot request Cineplex directly because Cineplex does not permit browser CORS access. The page therefore calls Worker JavaScript, which requests Cineplex's static movie data endpoint. This is not a GitHub Action.

Manual scan results are deliberately temporary:

- They update the current browser page only.
- They do not write `state.json`.
- They do not set `alerted` or send Telegram sale alerts.
- The 30-minute GitHub Action remains the persistent, one-alert-only ticket-sale monitor.

The endpoint is:

```text
POST https://cplex-watcher.cplexwatcher.workers.dev/api/scan
Origin: https://ettersay.github.io
Authorization: Bearer <UI_ACCESS_TOKEN>
Content-Type: application/json

{"url":"https://www.cineplex.com/movie/example"}
```

| HTTP status | Meaning |
|---|---|
| `202` | Search or stop-watching request was accepted and a GitHub Action was dispatched. |
| `400` | Invalid JSON, invalid Cineplex URL, or no valid titles (more than 10 titles or a title longer than 140 characters). |
| `401` | UI access token is missing or incorrect. |
| `403` | Browser origin is not the configured GitHub Pages origin. |
| `502` | GitHub Action dispatch failed. |
| `503` | `UI_ACCESS_TOKEN` has not been configured. |

### Stop a watch from Telegram

```text
/stopwatch Runner
```

The bot acknowledges the request, GitHub Actions matches the title against active watch names and URL slugs, then removes the matching active URL and check state. Telegram sends either `Stopped watching …`, `No active watch found …`, or an ambiguity message directing you to the web page. It never needs a fresh Cineplex lookup to stop a watch.

### Create or rotate the UI access token

1. Generate a random value locally:

   ```bash
   openssl rand -hex 32
   ```

2. Store it in Cloudflare. The prompt does not echo the value:

   ```bash
   cd /Users/Ayoub/Developer/cplex-watcher/cloudflare-worker
   npx wrangler secret put UI_ACCESS_TOKEN
   ```

3. Enter the same value in the web page's **UI access token** field.

The access page is `login.html`; after Cloudflare validates the token it redirects to the watcher listing at `/cplex-watcher/`. The listing immediately redirects back to `login.html` when `UI_ACCESS_TOKEN` is absent or invalid. A valid token is stored in that browser's `localStorage` as `UI_ACCESS_TOKEN`. Do not put the token in `web/app.js`, `wrangler.toml`, a committed `.env` file, GitHub secrets visible in logs, or documentation.

## Fresh setup

### 1. Cloudflare Worker

```bash
git clone https://github.com/ettersAy/cplex-watcher.git
cd cplex-watcher/cloudflare-worker
npm install --global wrangler
wrangler login
npx wrangler deploy
```

The Worker configuration has two non-secret variables:

```toml
[vars]
GITHUB_REPOSITORY = "ettersAy/cplex-watcher"
UI_ORIGIN = "https://ettersay.github.io"
```

If the repository owner or GitHub Pages URL changes, update both values before deploying.

### 2. Cloudflare secrets

Run the following from `cloudflare-worker/`. Each command prompts privately; never put values in `wrangler.toml`.

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_IDS
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put GITHUB_ACTIONS_TOKEN
npx wrangler secret put UI_ACCESS_TOKEN
```

| Secret | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Lets the Worker acknowledge Telegram commands and answer `/list`. |
| `TELEGRAM_CHAT_IDS` | Comma-separated private Telegram chat IDs authorized to use bot commands. Falls back to `ADMIN_CHAT_ID` when absent. |
| `TELEGRAM_WEBHOOK_SECRET` | Verifies that incoming updates came through Telegram's webhook. |
| `GITHUB_ACTIONS_TOKEN` | Fine-grained GitHub token used only to dispatch `check-tickets.yml`. |
| `UI_ACCESS_TOKEN` | Shared private token required by the GitHub Pages queue form. |

List only secret names, never values:

```bash
npx wrangler secret list --name cplex-watcher
```

### 3. GitHub fine-grained token for dispatch

1. Sign in to GitHub as the owner of `ettersAy/cplex-watcher`.
2. Open **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens**.
3. Choose **Generate new token**.
4. Select **Only select repositories** and choose `ettersAy/cplex-watcher`.
5. Under **Repository permissions**, set **Actions** to **Read and write**. Keep unrelated permissions at **No access**.
6. Generate the token and copy it immediately.
7. Store it with `npx wrangler secret put GITHUB_ACTIONS_TOKEN`.

Use an expiry you will remember to renew. If dispatch begins returning an authorization error, create a replacement token and update the Worker secret.

### 4. GitHub Actions secrets

In GitHub: **Repository** → **Settings** → **Secrets and variables** → **Actions**. Add these repository secrets:

| Secret | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Lets Actions send registration results and sale alerts. |
| `TELEGRAM_CHAT_IDS` | Comma-separated private Telegram chat IDs that receive ticket-sale alerts. Falls back to `TELEGRAM_CHAT_ID` when absent. |

The current flow does **not** use `WORKER_CALLBACK_URL` or `WATCHER_CALLBACK_SECRET`. Do not recreate them for this design.

### 5. Set the Telegram webhook

Run this from any local terminal. It prompts for secret values and does not write them to a file:

```bash
python3 - <<'PY'
from getpass import getpass
from urllib.parse import urlencode
from urllib.request import urlopen

token = getpass("Telegram bot token: ").strip()
secret = getpass("Webhook secret: ").strip()
worker_url = input("Worker URL: ").strip().rstrip("/")

print("Bot check:", urlopen(f"https://api.telegram.org/bot{token}/getMe").read().decode())
url = f"https://api.telegram.org/bot{token}/setWebhook?" + urlencode({
    "url": worker_url + "/telegram",
    "secret_token": secret,
})
print("Webhook result:", urlopen(url).read().decode())
PY
```

Use the deployed Worker URL, for example `https://cplex-watcher.cplexwatcher.workers.dev`. A successful webhook result contains `"ok":true`.

### 6. GitHub Pages

The workflow `.github/workflows/deploy-pages.yml` publishes the `web/` folder when it changes. GitHub Pages must use **GitHub Actions** as its build source.

Current URL:

```text
https://ettersay.github.io/cplex-watcher/
```

## Deployment and verification

### Deploy code changes

```bash
cd /Users/Ayoub/Developer/cplex-watcher
git add cloudflare-worker/src.js cloudflare-worker/wrangler.toml web .github/workflows
git commit -m "Describe the change"
git push origin main

cd cloudflare-worker
npx wrangler deploy
```

Only stage files you intentionally changed. Do not use `git add .` if local credentials, temporary files, or another person's work may be present.

### Watch Worker logs

```bash
cd /Users/Ayoub/Developer/cplex-watcher/cloudflare-worker
npx wrangler tail cplex-watcher --format pretty
```

Useful log events:

| Event | Meaning |
|---|---|
| `watch_requested` | Telegram `/watch` command passed validation. |
| `github_dispatch_started` | Worker is starting the Action request. |
| `github_dispatch_accepted` | GitHub accepted the workflow dispatch. |
| `web_watch_requested` | A valid web queue request was received. |
| `web_watch_queued` | GitHub accepted a web queue request. |
| `watch_list_requested` | `/list` successfully loaded active watches. |
| `web_scan_started` / `web_scan_completed` | A manual Scan all request started or returned a Cineplex status. |
| `stop_watch_requested` / `stop_watch_dispatch_accepted` | Telegram `/stopwatch` lookup was accepted. |
| `legacy_cron_ignored` | A retired Cloudflare cron invoked the harmless compatibility handler. |

### Check GitHub Actions

```bash
cd /Users/Ayoub/Developer/cplex-watcher
gh run list --workflow check-tickets.yml --limit 10
gh run view RUN_ID --log-failed
```

Expected workflow steps:

1. **Find requested movies** for `/watch` or web requests; multi-line web titles run sequentially in one Action.
2. **Save requested movies**, which deduplicates by official URL, or **Remove requested movie** for a stop request.
3. **Check movies and notify Telegram**.
4. **Send registration result to Telegram**.
5. **Save alert state**, which commits changed `movies.json` and `state.json`.

### End-to-end smoke test

1. Start `wrangler tail`.
2. Send `/watch Runner`, submit one or more lines through the web page, or stop one active watch.
3. Confirm the immediate acknowledgement or `202` queued response.
4. Find the corresponding Action run and wait for completion.
5. Confirm the final Telegram result.
6. Send `/list` or refresh the web page and confirm the watch state.

## Troubleshooting

| Symptom | Check | Likely resolution |
|---|---|---|
| Telegram command has no response | `wrangler tail`; webhook result | Verify webhook URL, `TELEGRAM_WEBHOOK_SECRET`, bot token, and the sender's ID in `TELEGRAM_CHAT_IDS`. |
| Worker says it cannot start the search | Worker logs show dispatch failure | Replace or correct `GITHUB_ACTIONS_TOKEN`; it needs **Actions: Read and write** for this repository. |
| Action title lookup fails with Cineplex 403 | Action log | Keep lookup in GitHub Actions. Do not move it back to Cloudflare. The current static Next-data fallback is designed for hosted-runner anti-bot pages. |
| Web form returns 503 | `UI_ACCESS_TOKEN` missing | Run `npx wrangler secret put UI_ACCESS_TOKEN`. |
| Web form returns 401 | Wrong token | Re-enter the correct token or rotate it in Cloudflare and the browser session. |
| Web form returns 403 | Wrong browser origin | Confirm `UI_ORIGIN` matches the GitHub Pages origin, then deploy the Worker. |
| `/list` shows failed/unable status | Read displayed error and `state.json` | The latest check failed. Wait for the next Action run or inspect its logs. |
| Duplicate movie appears requested | Compare official URL in `movies.json` | The Action deduplicates by canonical URL; exact duplicate URLs are not added. |
| Cloudflare reports a scheduled-event warning | Tail log | The Worker exports a harmless `scheduled()` handler; GitHub Actions is the actual ticket scheduler. |

## Current repository map

| Path | Purpose |
|---|---|
| `cloudflare-worker/src.js` | Telegram webhook, `/list`, protected `/api/queue`, GitHub Action dispatch. |
| `cloudflare-worker/wrangler.toml` | Worker name and public configuration. |
| `.github/workflows/check-tickets.yml` | Lookup, 30-minute checks, Telegram notifications, persistent state commits. |
| `.github/workflows/deploy-pages.yml` | Deploys `web/` to GitHub Pages. |
| `register_watch.py` | Finds a Cineplex movie title on the GitHub runner. |
| `watcher.py` | Reads ticket availability and persists success/failure state. |
| `movies.json` | Active canonical Cineplex URLs. |
| `state.json` | Latest status, last check, alert flag, and failure details. |
| `web/` | Static admin interface. |
