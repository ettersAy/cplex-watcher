# Cineplex Watcher web interface

This is a static GitHub Pages interface. It loads active watches from the public `movies.json` and `state.json` files, and sends new title requests to the Cloudflare Worker.

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

3. Enter the same value into the page's **UI access token** field. The page stores it only in `sessionStorage`; closing the browser session removes it.

The Worker accepts `POST /api/queue` only from `https://ettersay.github.io` and only with `Authorization: Bearer <UI_ACCESS_TOKEN>`.
