# Cineplex Watcher web interface

This is a static GitHub Pages interface. It validates a local token with the Cloudflare Worker, loads sales-started and active watches from public JSON files, submits up to 10 newline-separated titles, and can stop an active watch through the Cloudflare Worker.

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
