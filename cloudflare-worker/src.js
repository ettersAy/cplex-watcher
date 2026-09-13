async function telegram(env, chatId, text, options = {}) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true, ...options }),
  });

  if (!response.ok) {
    throw new Error(`Telegram sendMessage failed: ${await response.text()}`);
  }
}

async function dispatchWatch(env, title, requestId) {
  if (!env.GITHUB_ACTIONS_TOKEN || !env.GITHUB_REPOSITORY) {
    throw new Error("GitHub Actions dispatch is not configured");
  }

  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/check-tickets.yml/dispatches`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.GITHUB_ACTIONS_TOKEN}`,
      "content-type": "application/json",
      "user-agent": "CineplexTicketWatcher",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({ ref: "main", inputs: { title, request_id: requestId } }),
  });
  if (!response.ok) throw new Error(`GitHub Actions dispatch failed: ${await response.text()}`);
}

async function handleWatch(env, chatId, title) {
  if (!title) return telegram(env, chatId, "Please provide a movie name. Example: /watch Runner");

  const requestId = crypto.randomUUID();
  console.log(JSON.stringify({ event: "watch_requested", requestId, title }));

  try {
    console.log(JSON.stringify({ event: "github_dispatch_started", requestId }));
    await dispatchWatch(env, title, requestId);
    console.log(JSON.stringify({ event: "github_dispatch_accepted", requestId }));
  } catch (error) {
    console.error("Could not dispatch GitHub Actions watch:", error);
    return telegram(env, chatId, "I could not start the Cineplex search. Please try again shortly.");
  }

  return telegram(env, chatId, `Searching Cineplex for ${title}. I will reply when the watch is registered.`);
}

function movieKey(url) {
  return new URL(url).pathname.split("/").filter(Boolean).at(-1);
}

function nameFromUrl(url) {
  const slug = movieKey(url) || url;
  return slug.replace(/-/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

async function getManagedWatches(env) {
  if (!env.GITHUB_REPOSITORY) throw new Error("GitHub repository is not configured");

  const response = await fetch(`https://raw.githubusercontent.com/${env.GITHUB_REPOSITORY}/main/movies.json`, {
    headers: { accept: "application/json", "user-agent": "CineplexTicketWatcher" },
  });
  if (!response.ok) throw new Error(`Could not load watched movies: HTTP ${response.status}`);

  const movies = await response.json();
  if (!Array.isArray(movies) || movies.some((movie) => !movie || typeof movie.url !== "string")) {
    throw new Error("Watched movies file has an invalid format");
  }
  return movies;
}

async function getWatchState(env) {
  const response = await fetch(`https://raw.githubusercontent.com/${env.GITHUB_REPOSITORY}/main/state.json`, {
    headers: { accept: "application/json", "user-agent": "CineplexTicketWatcher", "cache-control": "no-cache" },
  });
  if (!response.ok) throw new Error(`Could not load watch state: HTTP ${response.status}`);

  const state = await response.json();
  if (!state || typeof state !== "object" || !state.movies || typeof state.movies !== "object") {
    throw new Error("Watch state file has an invalid format");
  }
  return state.movies;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function nextScheduledCheck() {
  const now = new Date();
  const next = new Date(now);
  next.setUTCSeconds(0, 0);
  next.setUTCMinutes(now.getUTCMinutes() < 30 ? 30 : 60);
  const minutes = Math.max(1, Math.ceil((next - now) / 60_000));
  return `in ${minutes} min (${formatTimestamp(next)})`;
}

function formatTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not available";
  const twoDigits = (number) => String(number).padStart(2, "0");
  return `${twoDigits(date.getUTCFullYear() % 100)}-${twoDigits(date.getUTCMonth() + 1)}-${twoDigits(date.getUTCDate())} ${twoDigits(date.getUTCHours())}:${twoDigits(date.getUTCMinutes())}:${twoDigits(date.getUTCSeconds())}`;
}

function formatWatch(movie, check, stateError) {
  const name = movie.name || check?.name || nameFromUrl(movie.url);
  const link = `<a href="${escapeHtml(movie.url)}">${escapeHtml(name)}</a>`;
  const failed = Boolean(stateError || !check || check.lastCheckStatus === "failed" || check.lastError);
  const status = failed ? "Failed" : "Success";
  const sales = failed ? "Unable to determine" : (check.hasShowtimes ? "Started" : "Not Yet");
  const error = stateError || check?.lastError;
  return [
    `• ${link}`,
    `  Status: ${status}`,
    `  Sales: ${sales}`,
    `  Next scheduled check: ${nextScheduledCheck()}`,
    `  Last check: ${formatTimestamp(check?.lastCheckedAt)}`,
    ...(error ? [`  Error: ${escapeHtml(error)}`] : []),
  ].join("\n");
}

async function handleList(env, chatId) {
  try {
    const [movies, stateResult] = await Promise.all([
      getManagedWatches(env),
      getWatchState(env).then((state) => ({ state })).catch((error) => ({ error: error.message })),
    ]);
    const uniqueMovies = [...new Map(movies.map((movie) => [movie.url, movie])).values()];
    console.log(JSON.stringify({ event: "watch_list_requested", count: uniqueMovies.length }));
    const descriptions = uniqueMovies.map((movie) => formatWatch(movie, stateResult.state?.[movieKey(movie.url)], stateResult.error));
    await telegram(env, chatId, descriptions.length ? `Watching:\n\n${descriptions.join("\n\n")}` : "You are not watching any movies.", { parse_mode: "HTML" });
  } catch (error) {
    console.error("Could not load watched movies:", error);
    await telegram(env, chatId, "I could not load the active watches. Please try again shortly.");
  }
}

async function handleUpdate(request, env) {
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  const update = await request.json();
  const message = update.message;
  if (!message?.text) return new Response("ok");

  const chatId = String(message.chat.id);
  if (chatId !== String(env.ADMIN_CHAT_ID)) return new Response("ok");

  const command = message.text.match(/^\/watch(?:@\w+)?\s+(.+)$/i);
  if (command) {
    await handleWatch(env, chatId, command[1].trim());
  } else if (/^\/list(?:@\w+)?$/i.test(message.text)) {
    await handleList(env, chatId);
  } else {
    await telegram(env, chatId, "Use /watch Movie Name\nExample: /watch Runner\n\nUse /list to see your watched movies.");
  }

  return new Response("ok");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/telegram") return handleUpdate(request, env);
    return Response.json({ status: "ok", service: "Cineplex ticket watcher" });
  },
  async scheduled(_event, _env, _ctx) {
    // An older Cloudflare cron trigger may remain active after the schedule
    // moved to GitHub Actions. Keep it harmless and visible until removed.
    console.log(JSON.stringify({ event: "legacy_cron_ignored", scheduler: "github-actions" }));
  },
};
