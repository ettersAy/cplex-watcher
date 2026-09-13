# Cineplex Ticket Watcher

A free Telegram bot that watches official Cineplex movie pages and alerts you when tickets start selling.

The recommended version combines a **Cloudflare Worker** for immediate Telegram commands with **GitHub Actions** for Cineplex searches and 30-minute checks. Cineplex currently rejects requests from Cloudflare, while the GitHub Ubuntu runner can read the official movie pages.

## Bot commands

```text
/watch Runner
/list
```

`/watch Runner` replies immediately that it is searching. GitHub Actions finds the matching Cineplex page, then the bot sends a second message confirming the watch (or asking for a more specific title).

## Install and deploy the immediate bot

### 1. Clone this repository

Open Terminal on your Mac and run:

```bash
git clone https://github.com/ettersAy/cplex-watcher.git
cd cplex-watcher/cloudflare-worker
```

### 2. Install Node.js and Cloudflare Wrangler

Check whether Node.js is already installed:

```bash
node --version
npm --version
```

If either command says `command not found`, install the current **LTS** version from [nodejs.org](https://nodejs.org/), then reopen Terminal.

Install the Cloudflare command-line tool and sign in:

```bash
npm install --global wrangler
wrangler login
```

A browser window opens. Log in to your free Cloudflare account and approve access.

### 3. Create the Worker state storage

This storage remembers watched movies and prevents duplicate alerts.

```bash
wrangler kv namespace create WATCHES
```

Copy the `id` from the result. It looks similar to this:

```text
id = "abc123..."
```

Open `wrangler.toml`:

```bash
open -e wrangler.toml
```

Replace this value:

```toml
id = "REPLACE_WITH_YOUR_KV_NAMESPACE_ID"
```

with your real KV namespace ID. Save the file.

### 4. Deploy the Worker

```bash
wrangler deploy
```

Copy the Worker URL printed at the end. It looks similar to:

```text
https://cplex-watcher.<your-subdomain>.workers.dev
```

There is no separate build command: `wrangler deploy` builds and deploys this plain JavaScript Worker.

### 5. Add the Worker secrets

Run each command below. Terminal asks for the value privately; it does not show what you paste.

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put ADMIN_CHAT_ID
wrangler secret put TELEGRAM_WEBHOOK_SECRET
wrangler secret put GITHUB_ACTIONS_TOKEN
wrangler secret put WATCHER_CALLBACK_SECRET
```

Use these values:

| Secret | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | The current token from BotFather. Never commit or paste it into GitHub. |
| `ADMIN_CHAT_ID` | Your numeric Telegram chat ID. |
| `TELEGRAM_WEBHOOK_SECRET` | A long random value only used between Telegram and Cloudflare. |
| `GITHUB_ACTIONS_TOKEN` | A fine-grained GitHub personal access token for this repository with **Actions: Read and write** permission. |
| `WATCHER_CALLBACK_SECRET` | A new long random value shared with the GitHub Action only. |

Generate a webhook secret, then copy its output when `wrangler secret put TELEGRAM_WEBHOOK_SECRET` asks for it:

```bash
openssl rand -hex 32
```

### 6. Connect GitHub Actions to the Worker

The repository already has the `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` GitHub Actions secrets for sale notifications. Add these two more repository secrets at **GitHub → Settings → Secrets and variables → Actions**:

| GitHub secret | Value |
|---|---|
| `WORKER_CALLBACK_URL` | `https://cplex-watcher.cplexwatcher.workers.dev/internal/watch-result` |
| `WATCHER_CALLBACK_SECRET` | The exact same new value entered for the Worker secret above. |

To create the shared callback value without putting it in a file, run this once and use the printed value for both prompts:

```bash
openssl rand -hex 32
```

## Complete hybrid setup and recovery runbook

Use this section after a fresh clone, when replacing a revoked Telegram token, or when `/watch` says it cannot start the Cineplex search.

### 1. Understand the two services

The Worker accepts Telegram updates and stores the current watch list in Cloudflare KV. It does **not** request Cineplex itself because Cineplex returns HTTP 403 to Cloudflare.

GitHub Actions runs on an Ubuntu runner that can read Cineplex. The Worker starts the `Check Cineplex ticket sales` workflow; the workflow finds the title, adds its official URL to `movies.json`, and calls the Worker back with the result. The scheduled workflow checks every saved URL every 30 minutes.

```text
Telegram /watch Title
  -> Cloudflare Worker: acknowledgement and pending watch
  -> GitHub Actions: Cineplex title lookup
  -> Cloudflare Worker: confirmed watch or helpful error message
  -> GitHub Actions schedule: ticket-sale checks every 30 minutes
```

### 2. Create the GitHub fine-grained token

The Worker needs a token only to start this repository's GitHub Actions workflow. The required GitHub API endpoint needs the repository **Actions: Read and write** permission.

1. Sign in to GitHub as the owner of `ettersAy/cplex-watcher`.
2. Click your profile picture, then **Settings**.
3. In the left sidebar, open **Developer settings**.
4. Open **Personal access tokens** → **Fine-grained tokens**.
5. Click **Generate new token**.
6. Set a descriptive token name, such as `cplex-watcher-dispatch`.
7. Choose an expiry you will remember to renew, for example 90 days.
8. Under **Resource owner**, choose your personal account.
9. Under **Repository access**, choose **Only select repositories**, then select `ettersAy/cplex-watcher`.
10. Under **Repository permissions**, find **Actions** and set it to **Read and write**. Leave all other permissions as **No access**.
11. Click **Generate token**, then copy the token immediately. GitHub shows it only once. Never commit it, paste it into a chat, or put it in a file.

GitHub's current documentation confirms that creating a workflow-dispatch event requires the fine-grained repository permission **Actions: write**: <https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event>.

### 3. Store the GitHub token in Cloudflare

From the repository's Worker folder, run:

```bash
cd /Users/Ayoub/Developer/cplex-watcher/cloudflare-worker
npx wrangler secret put GITHUB_ACTIONS_TOKEN
```

When prompted, paste the token from step 2. Nothing appears while pasting; press Enter once. Do not use `wrangler.toml` for this value.

Confirm only the secret **names** (never values):

```bash
npx wrangler secret list --name cplex-watcher
```

The result must include these active Worker secrets:

```text
ADMIN_CHAT_ID
TELEGRAM_BOT_TOKEN
TELEGRAM_WEBHOOK_SECRET
GITHUB_ACTIONS_TOKEN
WATCHER_CALLBACK_SECRET
```

`TELEGRAM_CHAT_ID` is an older unused Worker secret. The Worker uses `ADMIN_CHAT_ID`; do not delete `TELEGRAM_CHAT_ID` until you have verified the bot after this setup.

### 4. Verify the GitHub Actions secrets

Open `https://github.com/ettersAy/cplex-watcher/settings/secrets/actions`. The following must exist:

| Secret | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Sends ticket-sale alerts from the scheduled GitHub Action. |
| `TELEGRAM_CHAT_ID` | Receives ticket-sale alerts from the scheduled GitHub Action. |
| `WORKER_CALLBACK_URL` | `https://cplex-watcher.cplexwatcher.workers.dev/internal/watch-result` |
| `WATCHER_CALLBACK_SECRET` | Authenticates GitHub's result callback to the Worker. Must match the Worker secret of the same name. |

The callback secret is not the Telegram webhook secret and not the GitHub dispatch token. Keep all three separate.

### 5. Deploy source changes

Whenever files under `cloudflare-worker/` change:

```bash
cd /Users/Ayoub/Developer/cplex-watcher/cloudflare-worker
npx wrangler deploy
```

Whenever `.github/workflows/check-tickets.yml`, `register_watch.py`, `watcher.py`, or `movies.json` changes, push the repository so GitHub Actions uses that revision:

```bash
cd /Users/Ayoub/Developer/cplex-watcher
git add .github/workflows/check-tickets.yml register_watch.py watcher.py movies.json
git commit -m "Update Cineplex watcher"
git push
```

Do not include tokens, webhook secrets, `.wrangler/`, or local helper files containing credentials in a commit.

### 6. Test the complete path

First, open live Worker logs in one Terminal:

```bash
cd /Users/Ayoub/Developer/cplex-watcher/cloudflare-worker
npx wrangler tail cplex-watcher --format pretty
```

Then send `/watch Runner` to the bot. Expected sequence:

1. Telegram immediately replies: `Searching Cineplex for Runner. I will reply when the watch is registered.`
2. A GitHub Actions run appears at <https://github.com/ettersAy/cplex-watcher/actions/workflows/check-tickets.yml>.
3. The bot sends a second result. At the time this runbook was written, `Runner` was already on sale, so that result should say tickets are already on sale rather than starting a watch.
4. Send `/list`. It should answer immediately. A pending search appears as `(searching)`; a registered movie shows by title.

Stop `wrangler tail` with `Ctrl-C` after the test.

### 7. Diagnose failures without exposing secrets

| Symptom | Check | Meaning and fix |
|---|---|---|
| `/list` does not reply | `npx wrangler tail cplex-watcher --format pretty` | Check for a Telegram send error or an invalid webhook secret. |
| `/watch` replies that it could not start the search | Worker logs | `GITHUB_ACTIONS_TOKEN` is missing, expired, or lacks **Actions: Read and write**. Replace it with `npx wrangler secret put GITHUB_ACTIONS_TOKEN`. |
| `/watch` acknowledges but no second reply arrives | Open the triggered GitHub Actions run | Check the `Find requested movie` and `Report registration result to Worker` steps. Verify both callback GitHub secrets from step 4. |
| Worker log says `Cineplex sitemap returned HTTP 403` | Worker logs | This is the original Cloudflare-origin block. The Worker must not query Cineplex; confirm the deployed Worker has the hybrid source and GitHub Actions is enabled. |
| GitHub Action says callback returned 403 | GitHub Action log | `WATCHER_CALLBACK_SECRET` differs between GitHub and Cloudflare. Generate a new value, replace both copies, then deploy the Worker. |
| GitHub Action says callback returned 404 | GitHub Action log | The pending KV watch expired or the callback belongs to an older Worker deployment. Send `/watch` again after confirming the Worker is deployed. |

To inspect Telegram's webhook delivery state privately:

```bash
python3 - <<'PY'
from getpass import getpass
from urllib.request import urlopen

token = getpass("Telegram bot token: ").strip()
print(urlopen(f"https://api.telegram.org/bot{token}/getWebhookInfo").read().decode())
PY
```

Look for `pending_update_count`, `last_error_message`, and the expected URL ending in `/telegram`. Do not paste the token into the command itself or share the output if it includes sensitive values.

## If Telegram says `404 Not Found`: revoke and replace the bot token

A Telegram `404 Not Found` during the `Bot check` means Telegram does not accept the token. Create a new token in BotFather:

1. Open Telegram and search for **@BotFather**.
2. Send:

   ```text
   /mybots
   ```

3. Select your Cineplex watcher bot.
4. Select **API Token**.
5. Select **Revoke current token** and confirm.
6. BotFather gives you a new token. Copy it immediately and keep it private.
7. In Terminal, return to the `cloudflare-worker` folder and replace the Cloudflare secret:

   ```bash
   wrangler secret put TELEGRAM_BOT_TOKEN
   ```

8. Paste the new token when Terminal asks. Nothing appears while pasting; press Enter.
9. Run **Step 6** again and paste the same new token when it asks for the Telegram bot token.

Paste only the raw token, similar to this:

```text
1234567890:AAExampleTokenText
```

Do not paste `bot` before it, the API URL, the bot username, quotes, or spaces.

### 7. Connect Telegram to the Worker

Run this command. It asks for values privately:

```bash
python3 - <<'PY'
from getpass import getpass
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import urlopen

token = getpass("Telegram bot token: ").strip()
secret = getpass("Webhook secret: ").strip()
worker_url = input("Worker URL: ").strip().rstrip("/")

try:
    # Checks the token before changing the webhook.
    print("Bot check:", urlopen(f"https://api.telegram.org/bot{token}/getMe").read().decode())

    url = f"https://api.telegram.org/bot{token}/setWebhook?" + urlencode({
        "url": worker_url + "/telegram",
        "secret_token": secret,
    })
    print("Webhook result:", urlopen(url).read().decode())
except HTTPError as error:
    print("Telegram error:", error.read().decode())
PY
```

Paste:

1. Your **current API token** from BotFather — not the bot username or URL.
2. The same `TELEGRAM_WEBHOOK_SECRET` value used in step 5.
3. Your Worker URL from step 4.

The result must contain:

```json
{"ok":true}
```

### 8. Test it

1. Open your Telegram bot and press **Start**.
2. Send:

   ```text
   /watch Runner
   ```

3. The bot should first answer immediately:

   ```text
   Searching Cineplex for Runner. I will reply when the watch is registered.
   ```

4. Within a few minutes, it sends either the matching watch confirmation or a title-specific error. Send `/list` to see pending and confirmed watches.

## Updating the Worker later

After changing a file in `cloudflare-worker/`:

```bash
cd cplex-watcher/cloudflare-worker
wrangler deploy
git add .
git commit -m "Update Cineplex watcher"
git push
```

## GitHub Actions watcher

Keep **Check Cineplex ticket sales** enabled. It performs the Cineplex title lookup requested by the Worker, saves newly registered URLs in `movies.json`, and checks every saved URL every 30 minutes.

## How ticket availability is detected

The watcher reads Cineplex's official `hasShowtimes` value:

- `true` → tickets are on sale
- `false` → tickets are not yet available
