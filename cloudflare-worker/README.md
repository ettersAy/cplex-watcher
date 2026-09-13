# Immediate Telegram bot (Cloudflare Worker)

This is the immediate-reply version of the Cineplex watcher. It accepts Telegram commands through a webhook and checks watched movies every 30 minutes.

## Commands

```text
/watch Runner
/list
```

## Deploy

1. Create a free [Cloudflare account](https://dash.cloudflare.com/sign-up).
2. Install Wrangler on your Mac:

   ```bash
   npm install -g wrangler
   wrangler login
   ```

3. In this `cloudflare-worker` folder, create the state store:

   ```bash
   wrangler kv namespace create WATCHES
   ```

4. Copy the returned namespace ID into `wrangler.toml`, replacing `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.
5. Deploy:

   ```bash
   wrangler deploy
   ```

   Wrangler prints a Worker URL such as `https://cplex-watcher.<your-subdomain>.workers.dev`.

6. Add these Worker secrets. Do not put secret values in `wrangler.toml`.

   ```bash
   wrangler secret put TELEGRAM_BOT_TOKEN
   wrangler secret put ADMIN_CHAT_ID
   wrangler secret put TELEGRAM_WEBHOOK_SECRET
   ```

   For `TELEGRAM_WEBHOOK_SECRET`, use a long random value. For example:

   ```bash
   openssl rand -hex 32
   ```

7. Register the Telegram webhook. Replace the Worker URL only; Terminal asks for the token and webhook secret without showing them.

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

8. In Telegram, press **Start** on your bot and send:

   ```text
   /watch Runner
   ```

The existing GitHub Actions watcher can remain as a backup, but disable it to avoid duplicate checks once this Worker is running.
