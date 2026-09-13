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
