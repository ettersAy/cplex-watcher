# Cineplex Ticket Watcher operations guide

This guide documents the deployed watcher as of 2026-09-13. It describes the current architecture only; old Cloudflare KV watch records and the GitHub-Action-to-Worker callback are retired.

## Architecture

```text
Telegram /watch ─┐
                 ├─> Cloudflare Worker ─> GitHub Actions lookup/check
Web page /queue ─┘                              │
       ▲                                        ├─> movies.json (active URLs)
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
| `state.json` | Last successful or failed check for each active watch, including `hasShowtimes`, timestamp, and error. |
| GitHub Pages | Static admin page. It reads `movies.json` and `state.json` directly and posts new titles to the Worker. |
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

Each active movie has:

```text
• Clickable movie title
  Status: Success | Failed
  Sales: Started | Not Yet | Unable to determine
  Next check in X min
  Last check: YY-MM-DD HH:MM:SS
  Error: …                 # only when a check failed
```

- Timestamps are formatted from the stored UTC timestamp.
- `Status: Failed` and `Sales: Unable to determine` mean the last GitHub Action check failed; the error is retained in `state.json`.
- `Status: Success` with `Sales: Not Yet` means the latest official Cineplex check found no showtimes.

## Ticket-sale alert behavior

The scheduled `Check Cineplex ticket sales` workflow runs on this cron schedule:

```text
*/30 * * * *
```

`watcher.py` reads Cineplex's `hasShowtimes` value:

| `hasShowtimes` | Displayed sales status | Telegram alert |
|---|---|---|
| `false` | Not Yet | No alert. |
| `true` | Started | Sends one alert, then stores `alerted: true`. |
| Check error | Unable to determine | No sale alert; stores the error. |

The alert is sent directly from GitHub Actions with its Telegram secrets. This avoids the previous Worker callback HTTP 403 issue.

## Web interface

URL: <https://ettersay.github.io/cplex-watcher/>

The page is intentionally basic:

- Shows the same active-watch data as `/list`.
- Links every title to the official Cineplex page.
- Lets the admin submit one title through the protected queue endpoint.
- Does not include a database or a separate persistent web queue. A successful search appears after the GitHub Action updates `movies.json`; refresh the page then.

### Web queue API

```text
POST https://cplex-watcher.cplexwatcher.workers.dev/api/queue
Origin: https://ettersay.github.io
Authorization: Bearer <UI_ACCESS_TOKEN>
Content-Type: application/json

{"title":"Movie Name"}
```

| HTTP status | Meaning |
|---|---|
| `202` | Search was accepted and a GitHub Action was dispatched. |
| `400` | Invalid JSON or title is missing/longer than 140 characters. |
| `401` | UI access token is missing or incorrect. |
| `403` | Browser origin is not the configured GitHub Pages origin. |
| `502` | GitHub Action dispatch failed. |
| `503` | `UI_ACCESS_TOKEN` has not been configured. |

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

The token stays in `sessionStorage` only. Closing the browser session clears it. Do not put it in `web/app.js`, `wrangler.toml`, a `.env` file, GitHub secrets visible in logs, or documentation.

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
npx wrangler secret put ADMIN_CHAT_ID
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put GITHUB_ACTIONS_TOKEN
npx wrangler secret put UI_ACCESS_TOKEN
```

| Secret | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Lets the Worker acknowledge Telegram commands and answer `/list`. |
| `ADMIN_CHAT_ID` | Limits Telegram bot commands to the admin chat. |
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
| `TELEGRAM_CHAT_ID` | Admin chat that receives those Action messages. |

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
| `legacy_cron_ignored` | A retired Cloudflare cron invoked the harmless compatibility handler. |

### Check GitHub Actions

```bash
cd /Users/Ayoub/Developer/cplex-watcher
gh run list --workflow check-tickets.yml --limit 10
gh run view RUN_ID --log-failed
```

Expected workflow steps:

1. **Find requested movie** for `/watch` or web requests.
2. **Save requested movie**, which deduplicates by official URL.
3. **Check movies and notify Telegram**.
4. **Send registration result to Telegram**.
5. **Save alert state**, which commits changed `movies.json` and `state.json`.

### End-to-end smoke test

1. Start `wrangler tail`.
2. Send `/watch Runner` or submit a title through the web page.
3. Confirm the immediate acknowledgement or `202` queued response.
4. Find the corresponding Action run and wait for completion.
5. Confirm the final Telegram result.
6. Send `/list` or refresh the web page and confirm the watch state.

## Troubleshooting

| Symptom | Check | Likely resolution |
|---|---|---|
| Telegram command has no response | `wrangler tail`; webhook result | Verify webhook URL, `TELEGRAM_WEBHOOK_SECRET`, bot token, and `ADMIN_CHAT_ID`. |
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
