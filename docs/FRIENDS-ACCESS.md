# Share Cineplex Watcher with friends

There are two access levels:

| Account | Watches and alerts | Commands |
|---|---|---|
| Owner/main list | Every shared movie, including movies added by friends | Shared movie/seat management and personal notification settings |
| Secondary friend | Movies they add, plus their existing George Michael subscription | `/watch`, personal `/list`, `/stop`, `/start`; `/stopwatch` is a personal stop alias |

One shared movie check serves everyone. Friends never receive the owner's unrelated movies or another friend's movies unless they subscribe to the same movie themselves. Their weekly reminders follow the same rule. Personal opt-outs always apply.

## Everyday commands

```text
/watch Movie Name
/list
/stop Movie Name
/stop all
/stop reminder
/start all
/start reminder
```

A friend's `/watch` adds the movie to their list and the owner's shared list. It also works when the owner already watches that movie. The final confirmation goes to the sender after the Action saves the subscription. Movies already on sale get an immediate result and appear in personal sales history, without creating an active watch.

`/stop Movie Name` and `/stop all` affect only the sender. The owner's watch remains. `/stop reminder` disables only the weekly message. Adding a movie does not undo an existing stop setting; the reply explains how to resume paused alerts.

For the owner, `/stopwatch` still removes the shared watch. For a secondary friend, it means `/stop` and cannot delete someone else's watch. Seat-management commands remain limited to main accounts.

## Add a secondary friend

1. Have the friend open a private chat with [@cplxwatcher_bot](https://t.me/cplxwatcher_bot), press **Start**, and send `/id`. They send their chat ID privately to the owner.
2. In [GitHub Actions secrets](https://github.com/ettersAy/cplex-watcher/settings/secrets/actions), add the ID to `TELEGRAM_GEORGE_MICHAEL_ALERT_CHAT_IDS`, preserving any existing IDs. Commas or whitespace separate multiple accounts. This historical secret name now holds the secondary list; no replacement secret is needed.
3. Keep secondary friends out of `TELEGRAM_CHAT_IDS` in both GitHub and Cloudflare. Main-list membership grants all shared watches and management commands.
4. Initialize the private account registry, without sending Telegram messages:

   ```bash
   gh workflow run telegram-reminders.yml --repo ettersAy/cplex-watcher -f operation=initialize
   gh run list --repo ettersAy/cplex-watcher --workflow telegram-reminders.yml --limit 3
   ```

   Wait for the initialization run to succeed. The existing `TELEGRAM_PREFERENCES_KEY` must match in GitHub and Cloudflare; do not rotate it. The repository saves HMAC identifiers, never chat IDs.
5. The friend can now send `/watch Movie Name` and `/list`. The existing secondary friend already has a registry entry, so deploying the feature needs no secret change or reinitialization.

The historical George Michael subscription remains for all secondary accounts. They can stop it personally using `/stop George Michael` while it is active.

## Main accounts and web access

To deliberately give another person full shared access, add their private ID to `TELEGRAM_CHAT_IDS` in **both** GitHub and Cloudflare, then initialize the registry. Cloudflare accepts the secret with:

```bash
cd /Users/Ayoub/Developer/cplex-watcher/cloudflare-worker
npx wrangler secret put TELEGRAM_CHAT_IDS
```

The GitHub fallback is `TELEGRAM_CHAT_ID`; the Worker fallback is `ADMIN_CHAT_ID`. Keep the main lists consistent.

The [web interface](https://ettersay.github.io/cplex-watcher/login.html) uses a shared `UI_ACCESS_TOKEN` and manages everyone's watches. Give it only to people who should have that access; it is not a personal-list interface.

## Deploy and verify

Push the updated Action and Python files **before** deploying the Worker, because the Worker sends the new `recipient_key` workflow input. Then:

```bash
cd /Users/Ayoub/Developer/cplex-watcher/cloudflare-worker
npx wrangler deploy
npx wrangler tail cplex-watcher --format pretty
```

Have the friend send `/watch` for a real desired movie. Verify the acknowledgement, successful Action, final Telegram reply, and saved `subscribers` entry. Their `/list` should show that movie and exclude unrelated owner movies; the owner's `/list` should include it too. Repeating the command must not duplicate the movie. Test stopping only when the friend intends to stop it.

See [the implementation and verification record](Incidents/03-friend-personal-watch-access.md) for the exact source, evidence and remaining verification boundary. Unit tests do not prove that a friend received a Telegram message.

## Remove access

Remove the ID from its GitHub secret and from Cloudflare `TELEGRAM_CHAT_IDS` if it had main access. Run `operation=initialize` again: this removes obsolete registry entries while preserving current accounts' settings. The sender also validates the current secret list, so a removed account cannot add new subscriptions or receive alerts. Rotate `UI_ACCESS_TOKEN` if that person had shared web access.

## Troubleshooting

| Symptom | Check |
|---|---|
| Friend's `/watch` is ignored | Confirm the new Worker is deployed and initialization succeeded after adding the secondary ID. Do not add the friend to the main list as a workaround. |
| Friend receives everyone's movies | Remove them from both main lists; keep them only in the secondary secret. |
| `/watch` confirms a movie but says alerts are paused | Their previous `/stop` setting is still active. `/start all` restores their subscribed watches. |
| Friend can acknowledge a command but it fails later | Inspect the matching Action; confirm GitHub and Worker use the same HMAC key and that the account remains configured. |
| `/list` is briefly stale | Public movie JSON can be cached. Check the state commit and retry shortly; do not create a second watch. |
| Friend has no weekly message | Check the weekly job's role/outcome log. Only active, non-paused watches produce reminders. `/stop all` pauses both alerts and reminders; the friend can use `/start all` to resume their watches. If they also used `/stop reminder`, they must separately use `/start reminder`. |

Active movies in `/list` show who is watching. Owners see every movie and generic labels or counts for subscribed friends, including paused subscriptions. Friends see only their own subscriptions, with **You** and **Owner** labels, never other friends. Their active subscriptions remain visible and marked paused when alerts are off. The weekly reminder uses the same role labels but is sent only for active, non-paused watches. It does not change any subscription or notification preference.
