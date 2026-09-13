# Cineplex Ticket Watcher

Personal Cineplex movie-availability watcher with Telegram notifications and a small web interface.

- Web interface: <https://ettersay.github.io/cplex-watcher/>
- Worker health endpoint: <https://cplex-watcher.cplexwatcher.workers.dev/>
- Detailed setup, operations, and troubleshooting: [docs/OPERATIONS.md](docs/OPERATIONS.md)

## What it does

1. You submit `/watch Movie Name` in Telegram or use the web page.
2. The Cloudflare Worker starts a GitHub Actions lookup.
3. The Action finds the official Cineplex movie URL and deduplicates watches by URL.
4. GitHub Actions checks every active movie every 30 minutes.
5. When Cineplex reports ticket sales started, the Action alerts the admin in Telegram once.

The app uses GitHub Actions for Cineplex requests because Cineplex blocks Cloudflare Worker requests.

## Everyday use

Telegram:

```text
/watch Runner
/list
```

Web page:

1. Open <https://ettersay.github.io/cplex-watcher/>.
2. Enter one movie title per line and your private UI access token.
3. Click **Queue movies**.
4. Telegram receives the final lookup result. Refresh the page after a successful registration.

Use **Stop watching** on any active-watch card to remove that exact movie URL. Telegram confirms the result after GitHub Actions completes the removal.

`/list` and the web page show clickable Cineplex links, check status, ticket-sale state, next scheduled check, last check, and any saved error.

## Important security rules

- Never commit or paste bot tokens, GitHub tokens, Telegram API credentials, or `UI_ACCESS_TOKEN` into source files.
- The web page does not contain the UI token. It stores the value you enter only in browser `sessionStorage`.
- GitHub Pages is static; the private token is sent only over HTTPS to the Cloudflare Worker.

## Main commands

Deploy a Worker update:

```bash
cd /Users/Ayoub/Developer/cplex-watcher/cloudflare-worker
npx wrangler deploy
```

Watch live Worker logs:

```bash
npx wrangler tail cplex-watcher --format pretty
```

View recent ticket-check runs:

```bash
cd /Users/Ayoub/Developer/cplex-watcher
gh run list --workflow check-tickets.yml --limit 10
```

See [docs/OPERATIONS.md](docs/OPERATIONS.md) for the complete setup and recovery runbook.
