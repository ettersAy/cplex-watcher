# Cineplex Ticket Watcher

A free Telegram bot that watches official Cineplex movie pages and alerts you when tickets start selling.

The recommended version is the **Cloudflare Worker** in `cloudflare-worker/`. It replies immediately to Telegram commands and checks watched movies every 30 minutes.

## Bot commands

```text
/watch Runner
/list
```

`/watch Runner` finds the matching Cineplex page, replies immediately, and starts monitoring it. If several titles match, the bot asks you for a more specific title.

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

### 5. Add the three private Worker secrets

Run each command below. Terminal asks for the value privately; it does not show what you paste.

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put ADMIN_CHAT_ID
wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

Use these values:

| Secret | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | The current token from BotFather. Never commit or paste it into GitHub. |
| `ADMIN_CHAT_ID` | Your numeric Telegram chat ID. |
| `TELEGRAM_WEBHOOK_SECRET` | A long random value only used between Telegram and Cloudflare. |

Generate a webhook secret, then copy its output when `wrangler secret put TELEGRAM_WEBHOOK_SECRET` asks for it:

```bash
openssl rand -hex 32
```

### 6. Connect Telegram to the Worker

Run this command. It asks for values privately:

```bash
python3 - <<'PY'
from getpass import getpass
from urllib.parse import urlencode
from urllib.request import urlopen

token = getpass("Telegram bot token: ")
secret = getpass("Webhook secret: ")
worker_url = input("Worker URL: ").rstrip("/")
url = f"https://api.telegram.org/bot{token}/setWebhook?" + urlencode({
    "url": worker_url + "/telegram",
    "secret_token": secret,
})
print(urlopen(url).read().decode())
PY
```

Paste:

1. Your bot token.
2. The same `TELEGRAM_WEBHOOK_SECRET` value used in step 5.
3. Your Worker URL from step 4.

The result must contain:

```json
{"ok":true}
```

### 7. Test it

1. Open your Telegram bot and press **Start**.
2. Send:

   ```text
   /watch Runner
   ```

3. The bot should answer immediately:

   ```text
   Started watching Runner.
   Next check: within 30 minutes.
   ```

4. Send `/list` to see every watched movie.

## Updating the Worker later

After changing a file in `cloudflare-worker/`:

```bash
cd cplex-watcher/cloudflare-worker
wrangler deploy
git add .
git commit -m "Update Cineplex watcher"
git push
```

## Original GitHub Actions watcher

The older GitHub Actions watcher checks the three fixed URLs in `movies.json`. Once the Cloudflare Worker works, disable the GitHub workflow to avoid duplicate checks:

1. Open [Actions](https://github.com/ettersAy/cplex-watcher/actions).
2. Open **Check Cineplex ticket sales**.
3. Click the **…** menu.
4. Click **Disable workflow**.

## How ticket availability is detected

The watcher reads Cineplex's official `hasShowtimes` value:

- `true` → tickets are on sale
- `false` → tickets are not yet available
