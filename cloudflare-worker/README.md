# Immediate Telegram bot (Cloudflare Worker)

This Worker accepts Telegram commands immediately. GitHub Actions performs Cineplex searches and the 30-minute checks because Cineplex rejects requests from the Cloudflare network.

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
   wrangler secret put GITHUB_ACTIONS_TOKEN
   wrangler secret put WATCHER_CALLBACK_SECRET
   ```

   For `TELEGRAM_WEBHOOK_SECRET`, use a long random value. For example:

   ```bash
   openssl rand -hex 32
   ```

7. Create a fine-grained GitHub personal access token for this repository with **Actions: Read and write**, then enter it for `GITHUB_ACTIONS_TOKEN`.

8. Generate a separate callback secret with `openssl rand -hex 32`. Enter it for `WATCHER_CALLBACK_SECRET`, and add both of these repository Actions secrets in GitHub:

   - `WORKER_CALLBACK_URL`: `https://cplex-watcher.<your-subdomain>.workers.dev/internal/watch-result`
   - `WATCHER_CALLBACK_SECRET`: the same callback value entered in the Worker.

9. Register the Telegram webhook. Replace the Worker URL only; Terminal asks for the token and webhook secret without showing them.

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

10. In Telegram, press **Start** on your bot and send:

   ```text
   /watch Runner
   ```

Keep the GitHub Actions watcher enabled: it is the component that can reach Cineplex and sends the final registration result back to this Worker.
