const CINEPLEX_NEXT_BUILD_ID = "sutiBBvJ_DUSdtn7Z8k2n";

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

function allowedTelegramChatIds(env) {
  const value = env.TELEGRAM_CHAT_IDS || env.ADMIN_CHAT_ID || "";
  return new Set(value.split(/[\s,]+/).map((chatId) => chatId.trim()).filter(Boolean));
}

async function dispatchWatch(env, titles, requestId, chatId = "") {
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
    body: JSON.stringify({ ref: "main", inputs: { title: titles[0], titles: titles.join("\n"), operation: "watch", request_id: requestId, chat_id: chatId } }),
  });
  if (!response.ok) throw new Error(`GitHub Actions dispatch failed: ${await response.text()}`);
}

async function dispatchRemoval(env, url, requestId) {
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
    body: JSON.stringify({ ref: "main", inputs: { operation: "remove", url, request_id: requestId } }),
  });
  if (!response.ok) throw new Error(`GitHub Actions removal dispatch failed: ${await response.text()}`);
}

async function dispatchStopWatch(env, title, requestId, chatId = "") {
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
    body: JSON.stringify({ ref: "main", inputs: { title, operation: "remove_by_title", request_id: requestId, chat_id: chatId } }),
  });
  if (!response.ok) throw new Error(`GitHub Actions stop-watch dispatch failed: ${await response.text()}`);
}

async function dispatchSeatWatch(env, operation, watchId, payload, requestId, chatId) {
  if (!env.GITHUB_ACTIONS_TOKEN || !env.GITHUB_REPOSITORY) {
    throw new Error("GitHub Actions dispatch is not configured");
  }
  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/check-seat-watches.yml/dispatches`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.GITHUB_ACTIONS_TOKEN}`,
      "content-type": "application/json",
      "user-agent": "CineplexTicketWatcher",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({ ref: "main", inputs: { operation, watch_id: watchId, payload: JSON.stringify(payload), request_id: requestId, chat_id: chatId } }),
  });
  if (!response.ok) throw new Error(`GitHub Actions seat-watch dispatch failed: ${await response.text()}`);
}

function queueCorsHeaders(env) {
  return {
    "access-control-allow-origin": env.UI_ORIGIN,
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

function queueAuthenticationError(request, env) {
  if (request.headers.get("Origin") !== env.UI_ORIGIN) {
    return queueResponse(env, { error: "This request origin is not allowed." }, 403);
  }
  if (!env.UI_ACCESS_TOKEN) {
    console.error("UI_ACCESS_TOKEN is not configured");
    return queueResponse(env, { error: "The web queue is not configured yet." }, 503);
  }
  const authorization = request.headers.get("Authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (token !== env.UI_ACCESS_TOKEN) {
    return queueResponse(env, { error: "Invalid UI access token." }, 401);
  }
  return null;
}

function parseMovieTitles(body) {
  const value = typeof body?.titles === "string" ? body.titles : (typeof body?.title === "string" ? body.title : "");
  const titles = [...new Map(value.split(/\r?\n/).map((title) => title.trim()).filter(Boolean).map((title) => [title.toLocaleLowerCase(), title])).values()];
  if (!titles.length || titles.length > 10 || titles.some((title) => title.length > 140)) {
    return null;
  }
  return titles;
}

function isCineplexMovieUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname === "www.cineplex.com" && url.pathname.startsWith("/movie/");
  } catch {
    return false;
  }
}

function queueResponse(env, body, status = 200) {
  return Response.json(body, { status, headers: queueCorsHeaders(env) });
}

async function handleSeatWatchRead(request, env) {
  const authenticationError = queueAuthenticationError(request, env);
  if (authenticationError) return authenticationError;
  try {
    const [watches, state] = await Promise.all([getSeatWatches(env), getSeatWatchState(env)]);
    return queueResponse(env, { watches, state });
  } catch (error) {
    console.error("Could not load web seat-watch state:", error);
    return queueResponse(env, { error: "Could not load seat watches. Please try again shortly." }, 502);
  }
}

function seatWatchId(value) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value || "") ? value : null;
}

async function handleSeatWatchMutation(request, env, operation, watchId = "", suppliedPayload = null) {
  const authenticationError = queueAuthenticationError(request, env);
  if (authenticationError) return authenticationError;
  let payload = {};
  if (suppliedPayload) {
    payload = suppliedPayload;
  } else if (operation !== "stop") {
    try {
      payload = await request.json();
    } catch {
      return queueResponse(env, { error: "Request body must be JSON." }, 400);
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return queueResponse(env, { error: "Seat-watch payload must be a JSON object." }, 400);
    }
  }
  if (operation !== "create" && !seatWatchId(watchId)) {
    return queueResponse(env, { error: "Seat watch ID is invalid." }, 400);
  }
  const requestId = crypto.randomUUID();
  console.log(JSON.stringify({ event: "web_seat_watch_requested", requestId, operation, watchId }));
  try {
    await dispatchSeatWatch(env, operation, watchId, payload, requestId, "");
    console.log(JSON.stringify({ event: "web_seat_watch_queued", requestId, operation, watchId }));
    return queueResponse(env, { requestId, message: "Seat-watch request queued. Refresh in a moment to see the saved result." }, 202);
  } catch (error) {
    console.error("Could not dispatch web seat-watch request:", error);
    return queueResponse(env, { error: "Could not start the seat-watch request. Please try again shortly." }, 502);
  }
}

async function handleQueue(request, env) {
  const authenticationError = queueAuthenticationError(request, env);
  if (authenticationError) return authenticationError;

  let body;
  try {
    body = await request.json();
  } catch {
    return queueResponse(env, { error: "Request body must be JSON." }, 400);
  }
  const titles = parseMovieTitles(body);
  if (!titles) {
    return queueResponse(env, { error: "Provide 1 to 10 movie titles, one per line, with at most 140 characters each." }, 400);
  }

  const requestId = crypto.randomUUID();
  console.log(JSON.stringify({ event: "web_watch_requested", requestId, count: titles.length, titles }));
  try {
    await dispatchWatch(env, titles, requestId);
    console.log(JSON.stringify({ event: "web_watch_queued", requestId }));
    return queueResponse(env, { requestId, message: `Searching Cineplex for ${titles.length} ${titles.length === 1 ? "movie" : "movies"}.` }, 202);
  } catch (error) {
    console.error("Could not dispatch web watch:", error);
    return queueResponse(env, { error: "Could not start the Cineplex search. Please try again shortly." }, 502);
  }
}

async function handleRemoveWatch(request, env) {
  const authenticationError = queueAuthenticationError(request, env);
  if (authenticationError) return authenticationError;

  let body;
  try {
    body = await request.json();
  } catch {
    return queueResponse(env, { error: "Request body must be JSON." }, 400);
  }
  const url = typeof body?.url === "string" ? body.url.trim() : "";
  if (!isCineplexMovieUrl(url)) {
    return queueResponse(env, { error: "A valid official Cineplex movie URL is required." }, 400);
  }

  const requestId = crypto.randomUUID();
  console.log(JSON.stringify({ event: "web_watch_removal_requested", requestId, url }));
  try {
    await dispatchRemoval(env, url, requestId);
    console.log(JSON.stringify({ event: "web_watch_removal_queued", requestId }));
    return queueResponse(env, { requestId, message: "Stop-watching request queued. Telegram will confirm the result." }, 202);
  } catch (error) {
    console.error("Could not dispatch web watch removal:", error);
    return queueResponse(env, { error: "Could not start the stop-watching request. Please try again shortly." }, 502);
  }
}

function findMovieDetails(value) {
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findMovieDetails(child);
      if (found) return found;
    }
  } else if (value && typeof value === "object") {
    if ("hasShowtimes" in value && ("releaseDate" in value || "title" in value)) return value;
    for (const child of Object.values(value)) {
      const found = findMovieDetails(child);
      if (found) return found;
    }
  }
  return null;
}

async function scanCineplexMovie(url) {
  const slug = new URL(url).pathname.replace(/\/$/, "").split("/").at(-1);
  const dataUrl = `https://www.cineplex.com/next-static-files/_next/data/${CINEPLEX_NEXT_BUILD_ID}/movie/${slug}.json`;
  const response = await fetch(dataUrl, { headers: { "user-agent": "CineplexTicketWatcher/1.0 (personal ticket availability monitor)" } });
  if (!response.ok) throw new Error(`Cineplex scan returned HTTP ${response.status}`);
  const details = findMovieDetails(await response.json());
  if (!details) throw new Error("Cineplex scan did not include ticket status");
  return {
    name: details.title || details.movieTitle || slug,
    releaseDate: details.releaseDate || null,
    hasShowtimes: Boolean(details.hasShowtimes),
    url,
    lastCheckedAt: new Date().toISOString(),
    lastCheckStatus: "success",
  };
}

async function handleScan(request, env) {
  const authenticationError = queueAuthenticationError(request, env);
  if (authenticationError) return authenticationError;

  let body;
  try {
    body = await request.json();
  } catch {
    return queueResponse(env, { error: "Request body must be JSON." }, 400);
  }
  const url = typeof body?.url === "string" ? body.url.trim() : "";
  if (!isCineplexMovieUrl(url)) return queueResponse(env, { error: "A valid official Cineplex movie URL is required." }, 400);

  console.log(JSON.stringify({ event: "web_scan_started", url }));
  try {
    const movie = await scanCineplexMovie(url);
    console.log(JSON.stringify({ event: "web_scan_completed", url, hasShowtimes: movie.hasShowtimes }));
    return queueResponse(env, { movie });
  } catch (error) {
    console.error("Could not scan Cineplex movie:", error);
    return queueResponse(env, { error: `Cineplex scan failed: ${error.message}` }, 502);
  }
}

function handleVerifyUiToken(request, env) {
  const authenticationError = queueAuthenticationError(request, env);
  if (authenticationError) return authenticationError;
  return queueResponse(env, { valid: true });
}

async function handleWatch(env, chatId, title) {
  if (!title) return telegram(env, chatId, "Please provide a movie name. Example: /watch Runner");

  const requestId = crypto.randomUUID();
  console.log(JSON.stringify({ event: "watch_requested", requestId, title }));

  try {
    console.log(JSON.stringify({ event: "github_dispatch_started", requestId }));
    await dispatchWatch(env, [title], requestId, chatId);
    console.log(JSON.stringify({ event: "github_dispatch_accepted", requestId }));
  } catch (error) {
    console.error("Could not dispatch GitHub Actions watch:", error);
    return telegram(env, chatId, "I could not start the Cineplex search. Please try again shortly.");
  }

  return telegram(env, chatId, `Searching Cineplex for ${title}. I will reply when the watch is registered.`);
}

async function handleStopWatch(env, chatId, title) {
  if (!title) return telegram(env, chatId, "Please provide a movie name. Example: /stopwatch Runner");

  const requestId = crypto.randomUUID();
  console.log(JSON.stringify({ event: "stop_watch_requested", requestId, title }));
  try {
    await dispatchStopWatch(env, title, requestId, chatId);
    console.log(JSON.stringify({ event: "stop_watch_dispatch_accepted", requestId }));
  } catch (error) {
    console.error("Could not dispatch GitHub Actions stop watch:", error);
    return telegram(env, chatId, "I could not start the stop-watching search. Please try again shortly.");
  }
  return telegram(env, chatId, `Searching active watches for ${title}. I will reply when the watch is stopped.`);
}

async function handleWatchShowtime(env, chatId, value) {
  const command = parseSeatShowtimeCommand(value);
  if (!command) return telegram(env, chatId, "Use /watchshowtime Watch Name ShowtimeId\nExample: /watchshowtime Dune 405765");
  try {
    const found = findSeatWatch(await getSeatWatches(env), command.name);
    if (!found || !found.watch.enabled) {
      return telegram(env, chatId, `No enabled seat watch named ${command.name}. Create it first in the web interface.`);
    }
    const requestId = crypto.randomUUID();
    console.log(JSON.stringify({ event: "seat_showtime_add_requested", requestId, watchId: found.id, showtimeId: command.showtimeId }));
    await dispatchSeatWatch(env, "add_showtime", found.id, { id: command.showtimeId }, requestId, chatId);
    console.log(JSON.stringify({ event: "seat_showtime_add_queued", requestId, watchId: found.id, showtimeId: command.showtimeId }));
    return telegram(env, chatId, `⏳ Adding #${command.showtimeId} to ${found.watch.name}. I will reply after Cineplex validates it.`);
  } catch (error) {
    console.error("Could not dispatch seat-showtime add:", error);
    return telegram(env, chatId, "I could not start the seat-watch request. Please try again shortly.");
  }
}

async function handleStopShowtime(env, chatId, value) {
  const command = parseSeatShowtimeCommand(value);
  if (!command) return telegram(env, chatId, "Use /stopshowtime Watch Name ShowtimeId\nExample: /stopshowtime Dune 405854");
  try {
    const found = findSeatWatch(await getSeatWatches(env), command.name);
    if (!found || !found.watch.enabled) {
      return telegram(env, chatId, `No enabled seat watch named ${command.name}.`);
    }
    const showtime = found.watch.showtimes?.[command.showtimeId];
    if (!showtime || !showtime.enabled) {
      return telegram(env, chatId, `Showtime #${command.showtimeId} is not active for ${found.watch.name}.`);
    }
    const requestId = crypto.randomUUID();
    console.log(JSON.stringify({ event: "seat_showtime_stop_requested", requestId, watchId: found.id, showtimeId: command.showtimeId }));
    await dispatchSeatWatch(env, "stop_showtime", found.id, { id: command.showtimeId }, requestId, chatId);
    console.log(JSON.stringify({ event: "seat_showtime_stop_queued", requestId, watchId: found.id, showtimeId: command.showtimeId }));
    return telegram(env, chatId, `⏳ Stopping #${command.showtimeId} for ${found.watch.name}. I will reply when it is saved.`);
  } catch (error) {
    console.error("Could not dispatch seat-showtime stop:", error);
    return telegram(env, chatId, "I could not start the stop request. Please try again shortly.");
  }
}

async function handleStopSeats(env, chatId, name) {
  if (!name) return telegram(env, chatId, "Use /stopseats Watch Name\nExample: /stopseats Dune");
  try {
    const found = findSeatWatch(await getSeatWatches(env), name);
    if (!found || !found.watch.enabled) {
      return telegram(env, chatId, `No enabled seat watch named ${name}.`);
    }
    const requestId = crypto.randomUUID();
    console.log(JSON.stringify({ event: "seat_watch_stop_requested", requestId, watchId: found.id }));
    await dispatchSeatWatch(env, "stop", found.id, {}, requestId, chatId);
    console.log(JSON.stringify({ event: "seat_watch_stop_queued", requestId, watchId: found.id }));
    return telegram(env, chatId, `⏳ Stopping the seat watch for ${found.watch.name}. I will reply when it is saved.`);
  } catch (error) {
    console.error("Could not dispatch seat-watch stop:", error);
    return telegram(env, chatId, "I could not start the stop request. Please try again shortly.");
  }
}

async function handleRefreshSeats(env, chatId, name) {
  if (!name) return telegram(env, chatId, "Use /refreshseats Watch Name\nExample: /refreshseats Dune");
  try {
    const found = findSeatWatch(await getSeatWatches(env), name);
    if (!found || !found.watch.enabled) return telegram(env, chatId, `No enabled seat watch named ${name}.`);
    const requestId = crypto.randomUUID();
    console.log(JSON.stringify({ event: "seat_watch_refresh_requested", requestId, watchId: found.id }));
    await dispatchSeatWatch(env, "refresh", found.id, {}, requestId, chatId);
    console.log(JSON.stringify({ event: "seat_watch_refresh_queued", requestId, watchId: found.id }));
    return telegram(env, chatId, `⏳ Refreshing ${found.watch.name} now. I will reply after the seat check.`);
  } catch (error) {
    console.error("Could not dispatch seat-watch refresh:", error);
    return telegram(env, chatId, "I could not start the seat refresh. Please try again shortly.");
  }
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
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${env.GITHUB_ACTIONS_TOKEN}`, "user-agent": "CineplexTicketWatcher", "cache-control": "no-cache" },
  });
  if (!response.ok) throw new Error(`Could not load watch state: HTTP ${response.status}`);

  const state = await response.json();
  if (!state || typeof state !== "object" || !state.movies || typeof state.movies !== "object") {
    throw new Error("Watch state file has an invalid format");
  }
  return state.movies;
}

async function getSalesStarted(env) {
  if (!env.GITHUB_REPOSITORY) throw new Error("GitHub repository is not configured");

  const response = await fetch(`https://raw.githubusercontent.com/${env.GITHUB_REPOSITORY}/main/sales-started.json`, {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${env.GITHUB_ACTIONS_TOKEN}`, "user-agent": "CineplexTicketWatcher", "cache-control": "no-cache" },
  });
  if (!response.ok) throw new Error(`Could not load sales-started list: HTTP ${response.status}`);
  const movies = await response.json();
  if (!Array.isArray(movies)) throw new Error("Sales-started list has an invalid format");
  return movies;
}

async function getSeatWatches(env) {
  return getSeatWatcherFile(env, "seat-watches.json", "watches");
}

async function getSeatWatcherFile(env, filename, property) {
  if (!env.GITHUB_REPOSITORY || !env.GITHUB_ACTIONS_TOKEN) throw new Error("GitHub state reader is not configured");
  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/contents/${filename}?ref=main`, {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${env.GITHUB_ACTIONS_TOKEN}`, "user-agent": "CineplexTicketWatcher", "cache-control": "no-cache" },
  });
  if (!response.ok) throw new Error(`Could not load ${filename}: HTTP ${response.status}`);
  const content = await response.json();
  const config = JSON.parse(atob(String(content.content || "").replace(/\s/g, "")));
  if (!config || typeof config !== "object" || !config[property] || typeof config[property] !== "object") {
    throw new Error(`${filename} has an invalid format`);
  }
  return config[property];
}

async function getSeatWatchState(env) {
  return getSeatWatcherFile(env, "seat-watch-state.json", "watches");
}

async function getAvailableSeatList(env) {
  if (!env.GITHUB_REPOSITORY) throw new Error("GitHub repository is not configured");
  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/contents/available-seat-list.json?ref=main`, {
    headers: { accept: "application/json", "user-agent": "CineplexTicketWatcher", "cache-control": "no-cache" },
  });
  if (!response.ok) throw new Error(`Could not load available-seat-list.json: HTTP ${response.status}`);
  const content = await response.json();
  const seats = JSON.parse(atob(String(content.content || "").replace(/\s/g, "")));
  if (!seats || typeof seats !== "object" || Array.isArray(seats)) {
    throw new Error("available-seat-list.json has an invalid format");
  }
  return seats;
}

function normalizeSeatWatchName(value) {
  return String(value).toLocaleLowerCase().replace(/[^a-z0-9]+/g, "");
}

function parseSeatShowtimeCommand(value) {
  const parts = value.trim().split(/\s+/);
  const showtimeId = parts.pop();
  const name = parts.join(" ");
  if (!name || !/^\d+$/.test(showtimeId || "")) return null;
  return { name, showtimeId };
}

function findSeatWatch(watches, requestedName) {
  const target = normalizeSeatWatchName(requestedName);
  const matches = Object.entries(watches).filter(([, watch]) => normalizeSeatWatchName(watch?.name) === target);
  if (matches.length !== 1) return null;
  return { id: matches[0][0], watch: matches[0][1] };
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
  return `in ${minutes} min`;
}

function formatTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not available";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function enabledSeatShowtimeIds(watch) {
  return Object.entries(watch.showtimes || {})
    .filter(([, showtime]) => showtime?.enabled)
    .sort(([, left], [, right]) => String(left?.startsAt || "").localeCompare(String(right?.startsAt || "")))
    .map(([showtimeId]) => showtimeId);
}

function seatWatchSummaryHtml(watch, watchState) {
  const showtimeIds = enabledSeatShowtimeIds(watch);
  const availableSeats = showtimeIds.flatMap((showtimeId) => Object.values(watchState?.showtimes?.[showtimeId]?.selectedSeats || {})
    .filter((seat) => seat?.status === "Available")
    .map((seat) => ({ ...seat, showtimeId })));
  const firstAvailableShowtimeId = availableSeats.find((seat) => seat.showtimeId)?.showtimeId;
  const linkShowtimeId = firstAvailableShowtimeId || showtimeIds[0];
  const failed = watchState?.lastCheckStatus === "failed" || showtimeIds.some((showtimeId) => watchState?.showtimes?.[showtimeId]?.lastCheckStatus === "failed");
  const icon = failed ? "❌" : (availableSeats.length ? "🟢" : "⚪");
  const scanStatus = failed ? "⚠️ failed" : `👁 ${nextScheduledCheck()}`;
  const line = `${icon} <b>${escapeHtml(watch.name)}</b> · ${escapeHtml(watch.theatreName)} · #${escapeHtml(watch.theatreId)} · ${availableSeats.length} 🪑 · ${showtimeIds.length} 🎬`;
  return `<a href="${escapeHtml(`https://www.cineplex.com/ticketing/preview?theatreId=${watch.theatreId}&showtimeId=${linkShowtimeId}`, true)}">${line}</a>\n↳ 📖 <code>/seatinfo ${escapeHtml(watch.name)}</code> · ${scanStatus}`;
}

function availableSeatCount(selectedSeats) {
  return Object.values(selectedSeats || {}).filter((seat) => seat?.status === "Available").length;
}

function seatInfoDate(showtime) {
  const date = new Date(showtime?.startsAt || showtime?.showDate);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(date);
}

function seatInfoTime(showtime) {
  const displayTime = String(showtime?.displayTime || "");
  return displayTime.includes(", ") ? displayTime.split(", ").at(-1) : displayTime || "Time unavailable";
}

function seatInfoShowtimeLink(watch, showtimeId, showtime, availableCount) {
  const label = `#${showtimeId} · ${seatInfoTime(showtime)} · ${availableCount} 🪑`;
  const url = `https://www.cineplex.com/ticketing/preview?theatreId=${watch.theatreId}&showtimeId=${showtimeId}`;
  return `<a href="${escapeHtml(url, true)}">${escapeHtml(label)}</a>`;
}

function seatInfoDateGroups(watch, entries) {
  const groups = new Map();
  for (const entry of entries) {
    const label = seatInfoDate(entry.showtime);
    const group = groups.get(label) || { label, availableCount: 0, entries: [] };
    group.availableCount += entry.availableCount;
    group.entries.push(entry);
    groups.set(label, group);
  }
  return [...groups.values()].map((group) => [
    `<b>${escapeHtml(group.label)} · ${group.availableCount} 🪑 · 🎬 ${group.entries.length}</b>`,
    ...group.entries.map((entry) => `• ${seatInfoShowtimeLink(watch, entry.showtimeId, entry.showtime, entry.availableCount)}`),
  ].join("\n")).join("\n\n");
}

async function handleSeatInfo(env, chatId, name) {
  if (!name) return telegram(env, chatId, "Use /seatinfo Watch Name\nExample: /seatinfo Dune");
  try {
    const [watches, states] = await Promise.all([getSeatWatches(env), getSeatWatchState(env)]);
    const found = findSeatWatch(watches, name);
    if (!found || !found.watch.enabled) {
      return telegram(env, chatId, `No enabled seat watch named ${name}. Example: /seatinfo Dune`);
    }
    const { watch } = found;
    const watchState = states[found.id] || {};
    const successful = [];
    const failed = [];
    for (const showtimeId of enabledSeatShowtimeIds(watch)) {
      const showtime = watch.showtimes[showtimeId];
      const showtimeState = watchState.showtimes?.[showtimeId];
      if (showtimeState?.lastCheckStatus === "failed") {
        failed.push({ showtimeId, showtime, error: showtimeState.lastError || "Seat check failed" });
      } else if (showtimeState?.lastCheckStatus === "success") {
        successful.push({
          showtimeId, showtime,
          availableCount: availableSeatCount(showtimeState.selectedSeats),
        });
      }
    }
    const withAvailability = successful.filter((item) => item.availableCount);
    const withoutAvailability = successful.filter((item) => !item.availableCount);
    const availableCount = withAvailability.reduce((count, item) => count + item.availableCount, 0);
    const showtimeCount = enabledSeatShowtimeIds(watch).length;
    const sections = [
      `🎟 <b>${escapeHtml(watch.name)}</b> · ${escapeHtml(watch.theatreName)} · #${escapeHtml(watch.theatreId)} · ${availableCount} 🪑 · ${showtimeCount} 🎬`,
    ];
    if (withAvailability.length) {
      sections.push(`🟢 <b>Available</b>\n\n${seatInfoDateGroups(watch, withAvailability)}`);
    }
    if (withoutAvailability.length) {
      sections.push(`⚪ <b>Still watching</b>\n\n${seatInfoDateGroups(watch, withoutAvailability)}`);
    }
    if (failed.length) {
      sections.push(`❌ <b>Failed</b>\n\n${failed.map((item) => `• #${escapeHtml(item.showtimeId)} · ${escapeHtml(seatInfoTime(item.showtime))}\n  ${escapeHtml(item.error)}`).join("\n")}`);
    }
    if (!successful.length && !failed.length) sections.push("No completed seat scan yet.");
    sections.push(`—\n🕒 Checked at ${formatTimestamp(watchState.lastCheckedAt)}\n🌐 <a href="https://ettersay.github.io/cplex-watcher/">Web interface</a> · ➕ <code>/watchshowtime ${escapeHtml(watch.name)} ShowtimeId</code> · ⏹ <code>/stopshowtime ${escapeHtml(watch.name)} ShowtimeId</code>`);
    console.log(JSON.stringify({ event: "seat_watch_info_requested", watchId: found.id }));
    await telegram(env, chatId, sections.join("\n\n"), { parse_mode: "HTML" });
  } catch (error) {
    console.error("Could not load seat watch details:", error);
    await telegram(env, chatId, "I could not load the seat watch details. Please try again shortly.");
  }
}

async function handleSeatList(env, chatId) {
  try {
    const watches = await getSeatWatches(env);
    const stateResult = await getSeatWatchState(env).then((states) => ({ states })).catch((error) => ({ error }));
    const enabledWatches = Object.values(watches)
      .filter((watch) => watch?.enabled && enabledSeatShowtimeIds(watch).length)
      .sort((left, right) => String(left.name).localeCompare(String(right.name)));
    console.log(JSON.stringify({ event: "seat_watch_list_requested", activeCount: enabledWatches.length }));
    if (!enabledWatches.length) {
      await telegram(env, chatId, "🎟 <b>Seat watches</b>\n\nNo enabled seat watches. Add one from the web interface.", { parse_mode: "HTML" });
      return;
    }
    const blocks = enabledWatches.map((watch) => seatWatchSummaryHtml(watch, stateResult.states?.[watch.id]));
    await telegram(env, chatId, [
      "🎟 <b>Seat watches</b>",
      ...(stateResult.error ? ["⚠️ Latest seat-scan details are temporarily unavailable. The watch list is still shown."] : []),
      blocks.join("\n\n"),
      "—\n🌐 <a href=\"https://ettersay.github.io/cplex-watcher/\">Web interface</a>\n➕ <code>/watchshowtime WatchName ShowtimeId</code>",
    ].join("\n\n"), { parse_mode: "HTML" });
  } catch (error) {
    console.error("Could not load seat watches:", error);
    const detail = error instanceof Error ? error.message.slice(0, 180) : "Unexpected list-render error";
    await telegram(env, chatId, `I could not load the seat watches: ${escapeHtml(detail)}.`);
  }
}

function formatWatch(movie, check, stateError, salesStarted = false) {
  const name = movie.name || check?.name || nameFromUrl(movie.url);
  const link = `<a href="${escapeHtml(movie.url)}">${escapeHtml(name)}</a>`;
  const hasSalesStarted = salesStarted || check?.hasShowtimes;
  const failed = !salesStarted && Boolean(stateError || !check || check.lastCheckStatus === "failed" || check.lastError);
  const error = stateError || check?.lastError;
  const icon = failed ? "🔴" : (hasSalesStarted ? "🎉" : "⏳");
  const lastCheckIcon = failed ? "❌" : "☀️";
  return [
    icon,
    link,
    ...(!salesStarted ? [`👁️ ${nextScheduledCheck()}`] : []),
    `${lastCheckIcon} Last check ${formatTimestamp(check?.lastCheckedAt || movie.salesStartedAt)}`,
    ...(error ? [`📢 ${escapeHtml(error)}`] : []),
  ].join(" ");
}

async function handleList(env, chatId) {
  try {
    const [salesStarted, movies, stateResult] = await Promise.all([
      getSalesStarted(env),
      getManagedWatches(env),
      getWatchState(env).then((state) => ({ state })).catch((error) => ({ error: error.message })),
    ]);
    const uniqueMovies = [...new Map(movies.map((movie) => [movie.url, movie])).values()];
    const uniqueSalesStarted = [...new Map(salesStarted.map((movie) => [movie.url, movie])).values()];
    console.log(JSON.stringify({ event: "watch_list_requested", activeCount: uniqueMovies.length, salesStartedCount: uniqueSalesStarted.length }));
    const sections = [];
    if (uniqueSalesStarted.length) {
      sections.push(`🎉 Sales started:\n${uniqueSalesStarted.map((movie) => formatWatch(movie, stateResult.state?.[movieKey(movie.url)], stateResult.error, true)).join("\n")}`);
    }
    if (uniqueMovies.length) {
      sections.push(`⏳ \n${uniqueMovies.map((movie) => formatWatch(movie, stateResult.state?.[movieKey(movie.url)], stateResult.error)).join("\n")}`);
    }
    await telegram(env, chatId, sections.length ? sections.join("\n\n") : "You are not watching any movies.", { parse_mode: "HTML" });
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
  if (/^\/id(?:@\w+)?$/i.test(message.text)) {
    await telegram(env, chatId, `Your Telegram chat ID is ${chatId}. Send it to the watcher owner so they can authorize you.`);
    return new Response("ok");
  }
  if (!allowedTelegramChatIds(env).has(chatId)) return new Response("ok");

  const watchCommand = message.text.match(/^\/watch(?:@\w+)?\s+(.+)$/i);
  const stopCommand = message.text.match(/^\/stopwatch(?:@\w+)?\s+(.+)$/i);
  const watchShowtimeCommand = message.text.match(/^\/watchshowtime(?:@\w+)?\s+(.+)$/i);
  const stopShowtimeCommand = message.text.match(/^\/stopshowtime(?:@\w+)?\s+(.+)$/i);
  const stopSeatsCommand = message.text.match(/^\/stopseats(?:@\w+)?\s+(.+)$/i);
  const refreshSeatsCommand = message.text.match(/^\/refreshseats(?:@\w+)?\s+(.+)$/i);
  if (watchShowtimeCommand) {
    await handleWatchShowtime(env, chatId, watchShowtimeCommand[1]);
  } else if (stopShowtimeCommand) {
    await handleStopShowtime(env, chatId, stopShowtimeCommand[1]);
  } else if (stopSeatsCommand) {
    await handleStopSeats(env, chatId, stopSeatsCommand[1].trim());
  } else if (refreshSeatsCommand) {
    await handleRefreshSeats(env, chatId, refreshSeatsCommand[1].trim());
  } else if (watchCommand) {
    await handleWatch(env, chatId, watchCommand[1].trim());
  } else if (stopCommand) {
    await handleStopWatch(env, chatId, stopCommand[1].trim());
  } else if (/^\/listseats(?:@\w+)?$/i.test(message.text)) {
    await handleSeatList(env, chatId);
  } else {
    const seatInfoCommand = message.text.match(/^\/seatinfo(?:@\w+)?\s+(.+)$/i);
    if (seatInfoCommand) {
      await handleSeatInfo(env, chatId, seatInfoCommand[1].trim());
    } else if (/^\/list(?:@\w+)?$/i.test(message.text)) {
      await handleList(env, chatId);
    } else {
      await telegram(env, chatId, "Use /watch Movie Name\nUse /stopwatch Movie Name\nUse /watchshowtime Watch Name ShowtimeId\nUse /stopshowtime Watch Name ShowtimeId\nUse /stopseats Watch Name\nUse /refreshseats Watch Name\nUse /listseats and /seatinfo Watch Name for seat watches\nExample: /watchshowtime Dune 405765\n\nUse /list to see your watched movies.");
    }
  }

  return new Response("ok");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if ((url.pathname === "/api/queue" || url.pathname === "/api/scan" || url.pathname === "/api/verify" || url.pathname === "/api/seat-watches" || url.pathname.startsWith("/api/seat-watches/")) && request.method === "OPTIONS") {
      if (request.headers.get("Origin") !== env.UI_ORIGIN) return new Response("Forbidden", { status: 403 });
      return new Response(null, { status: 204, headers: queueCorsHeaders(env) });
    }
    if (url.pathname === "/api/queue" && request.method === "POST") return handleQueue(request, env);
    if (url.pathname === "/api/queue" && request.method === "DELETE") return handleRemoveWatch(request, env);
    if (url.pathname === "/api/scan" && request.method === "POST") return handleScan(request, env);
    if (url.pathname === "/api/verify" && request.method === "POST") return handleVerifyUiToken(request, env);
    if (url.pathname === "/api/seat-watches" && request.method === "GET") return handleSeatWatchRead(request, env);
    if (url.pathname === "/api/seat-watches" && request.method === "POST") return handleSeatWatchMutation(request, env, "create");
    const showtimePath = /^\/api\/seat-watches\/([^/]+)\/showtimes\/(\d+)$/.exec(url.pathname);
    if (showtimePath && request.method === "DELETE") return handleSeatWatchMutation(request, env, "stop_showtime", decodeURIComponent(showtimePath[1]), { id: showtimePath[2] });
    if (url.pathname.startsWith("/api/seat-watches/")) {
      const watchId = decodeURIComponent(url.pathname.slice("/api/seat-watches/".length));
      if (request.method === "PATCH") return handleSeatWatchMutation(request, env, "edit", watchId);
      if (request.method === "DELETE") return handleSeatWatchMutation(request, env, "stop", watchId);
    }
    if (request.method === "POST" && url.pathname === "/telegram") return handleUpdate(request, env);
    return Response.json({ status: "ok", service: "Cineplex ticket watcher" });
  },
  async scheduled(_event, _env, _ctx) {
    // An older Cloudflare cron trigger may remain active after the schedule
    // moved to GitHub Actions. Keep it harmless and visible until removed.
    console.log(JSON.stringify({ event: "legacy_cron_ignored", scheduler: "github-actions" }));
  },
};
