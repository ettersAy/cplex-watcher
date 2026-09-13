# Cineplex Ticket Watcher

Checks the Cineplex pages in `movies.json` every 30 minutes and sends one Telegram alert when tickets become available.

## One-time GitHub setup

1. Create a new **public GitHub repository** named `cineplex-ticket-watcher`.
2. Upload every file from this folder, preserving the `.github/workflows/check-tickets.yml` path.
3. In GitHub, open **Settings → Secrets and variables → Actions → New repository secret**.
4. Add these two secrets after your Telegram bot is ready:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
5. Open **Actions → Check Cineplex ticket sales → Run workflow** once to test it.

The repository can be public because the Telegram values are stored as GitHub secrets and are never committed.

## Add or remove movies

Edit `movies.json`. Add one Cineplex movie URL per line, for example:

```json
[
  {"url": "https://www.cineplex.com/movie/cat-in-the-hat"},
  {"url": "https://www.cineplex.com/movie/another-movie"}
]
```

## How it decides tickets are on sale

The watcher reads Cineplex's `hasShowtimes` value from the official movie page:

- `true` → tickets have started
- `false` → tickets are not yet available

`state.json` prevents duplicate Telegram messages. Do not delete it unless you intentionally want new alerts for movies already marked as started.

## Important

GitHub scheduled jobs can occasionally start a few minutes late. This is still fully free and requires no server.
