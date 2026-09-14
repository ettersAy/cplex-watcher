# Cineplex Watcher web interface

This is a static GitHub Pages interface with four tabs:

- **📊 Dashboard** combines real saved seat and ticket-watch totals, latest scan times, estimated next scans, and recent scan summaries. Refresh reloads saved data; it does not start a scan.
- **🎟 Seat watcher** lists and manages saved seat watches, grouped by show date.
- **🎫 Ticket watcher** uses compact ticket cards. It reads active ticket watches, saved scan state, and sales-started state from the repository. From this tab a user can add a movie name (one per line) or stop a still-watching movie.
- **📖 Guide** provides Telegram command examples and explains seat-alert de-duplication.

Both tabs validate the local access token with the Cloudflare Worker before loading protected seat-watch data or submitting a change.

For the complete architecture, deployment, logs, and troubleshooting guide, see [docs/OPERATIONS.md](../docs/OPERATIONS.md).

## First-time setup

1. Create a private random value locally:

   ```bash
   openssl rand -hex 32
   ```

2. Store that value as the Worker secret. Do not commit it or paste it into a source file:

   ```bash
   cd cloudflare-worker
   npx wrangler secret put UI_ACCESS_TOKEN
   ```

3. Open `login.html`, then enter the same value in the access form. The page validates it with Cloudflare, stores it in the browser's `localStorage` as `UI_ACCESS_TOKEN`, and redirects to the watcher listing. The listing redirects back to `login.html` if the token is missing or invalid.

The Worker accepts `POST /api/queue` only from `https://ettersay.github.io` and only with `Authorization: Bearer <UI_ACCESS_TOKEN>`.
