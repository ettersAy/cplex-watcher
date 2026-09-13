# Share Cineplex Watcher with friends

Use this guide when you and friends share the same movie watch lists. Everyone uses the same bot, active-watch list, sales-started list, and optional web UI token.

## What each person can do

After authorization, each friend can send the bot:

```text
/watch Movie Name
/stopwatch Movie Name
/list
```

- A command acknowledgement and its final search/removal result go to the person who sent the command.
- `movies.json`, `sales-started.json`, and `state.json` are shared by everyone.
- When ticket sales start, every authorized person receives this Telegram message:

```text
Go run buy your ticket for the movie Movie Name.
```

`Movie Name` is a clickable link to its official Cineplex page.

## Before starting

Only the watcher owner changes configuration. Do not put chat IDs, bot tokens, UI tokens, or GitHub tokens in the repository, screenshots, or messages sent to people who do not need access.

The owner needs:

- Local access to this repository and `wrangler` authentication.
- Admin access to the `ettersAy/cplex-watcher` GitHub repository.
- The friends' Telegram chat IDs.

## 1. Ask each friend for their chat ID

Each friend must open a **private chat** with [@cplxwatcher_bot](https://t.me/cplxwatcher_bot), press **Start**, and send:

```text
/id
```

The bot replies with that person's Telegram chat ID. Each friend sends their number only to the watcher owner.

`/id` is deliberately available before authorization. It only returns the sender's own chat ID; it does not grant watcher access.

Do not use a group chat ID unless you deliberately want the entire Telegram group to share bot responses.

## 2. Build the authorized-recipient list

Create one comma-separated list containing the owner's chat ID and every friend chat ID. Example only:

```text
111111111,222222222,333333333
```

Keep this exact list private. You will enter the same list in Cloudflare and GitHub.

## 3. Authorize commands in Cloudflare

From the Worker directory, set the `TELEGRAM_CHAT_IDS` secret. Wrangler prompts privately; paste the complete comma-separated list when prompted.

```bash
cd /Users/Ayoub/Developer/cplex-watcher/cloudflare-worker
npx wrangler secret put TELEGRAM_CHAT_IDS
```

This allows the listed people to use `/watch`, `/stopwatch`, and `/list`. The existing `ADMIN_CHAT_ID` secret remains only as a one-person fallback; once `TELEGRAM_CHAT_IDS` exists, it takes priority.

Confirm only the secret name, never its value:

```bash
npx wrangler secret list --name cplex-watcher
```

Expected: `TELEGRAM_CHAT_IDS` appears in the list.

## 4. Configure GitHub Actions sale-alert recipients

1. Open <https://github.com/ettersAy/cplex-watcher/settings/secrets/actions>.
2. Select **New repository secret**.
3. Set the name to `TELEGRAM_CHAT_IDS`.
4. Paste the **same complete comma-separated list** from step 2 as the secret value.
5. Select **Add secret**.

GitHub Actions uses this secret only for the scheduled ticket-sale alert. The previous `TELEGRAM_CHAT_ID` secret remains a fallback until the new secret is set.

## 5. Deploy the shared-access code

The Worker must be deployed after pulling the code containing this feature:

```bash
cd /Users/Ayoub/Developer/cplex-watcher
git pull --ff-only
cd cloudflare-worker
npx wrangler deploy
```

The GitHub Actions workflow is used automatically from the repository's `main` branch after the shared-access change is pushed. No manual Pages deployment is required for Telegram-only sharing.

## 6. Test each part safely

Open a Worker log tail first:

```bash
cd /Users/Ayoub/Developer/cplex-watcher/cloudflare-worker
npx wrangler tail cplex-watcher --format pretty
```

Then test in this order:

1. The owner sends `/list`; the owner receives the shared list.
2. One friend sends `/list`; that friend receives the same shared list.
3. One friend sends `/watch` with a movie not already on the list; that friend receives the acknowledgement and final lookup result.
4. Confirm the Worker log records the friend command and GitHub Actions has a successful `Check Cineplex ticket sales` run.
5. When Cineplex later reports sales started, confirm every listed person receives the same clickable sale-alert message.

Do not add a fake watch just to force a sale alert. The scheduled check runs every 30 minutes and sends the alert once when a real watch first reports sales started.

## Optional: share the web interface

The login page is <https://ettersay.github.io/cplex-watcher/login.html>. A friend who knows the shared `UI_ACCESS_TOKEN` can add movies, stop active watches, refresh the lists, and run manual scans.

The web token gives the same shared queue permissions as the owner. Share it only with people who should be able to change the shared lists.

## Remove a friend's access

1. Remove the friend's chat ID from the comma-separated list.
2. Update the Cloudflare `TELEGRAM_CHAT_IDS` secret using step 3.
3. Update the GitHub `TELEGRAM_CHAT_IDS` repository secret using step 4.
4. Deploy the Worker again:

   ```bash
   cd /Users/Ayoub/Developer/cplex-watcher/cloudflare-worker
   npx wrangler deploy
   ```

5. If the friend also knew the web UI token, rotate it:

   ```bash
   openssl rand -hex 32
   npx wrangler secret put UI_ACCESS_TOKEN
   ```

   Give the replacement token only to people who should retain web access. Existing browsers with the old token redirect to the login page after their next protected request.

## Troubleshooting

| Symptom | Check | Fix |
|---|---|---|
| Friend receives no `/watch` or `/list` response | Ask them to send `/id` again | Ensure their exact private-chat ID is in Cloudflare `TELEGRAM_CHAT_IDS`, then deploy the Worker. |
| Friend receives a command reply but no sale alert | Compare the two configured lists | Add the same ID to GitHub `TELEGRAM_CHAT_IDS`. |
| Only the owner receives alerts | Check that GitHub has `TELEGRAM_CHAT_IDS`, not only `TELEGRAM_CHAT_ID` | Add the multi-recipient secret and wait for the next scheduled check. |
| Wrong people can change web watches | Review who knows the UI token | Rotate `UI_ACCESS_TOKEN` and share the replacement only with trusted people. |
| No sale alert yet | Inspect `sales-started.json` and the latest Action run | Alerts are sent only once, when a real active watch first reports `hasShowtimes: true`. |
