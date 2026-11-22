// Private Telegram confirmations authenticate the exact bot prompt and account.
const confirmationLifetimeMs = 10 * 60 * 1000;
const domain = "cineplex-telegram-command-confirmation-v1";
const instructions = "\n\nReply Yes within 10 minutes to confirm, or No to cancel.";
const ownerInstructions = "\n\nReply Stop too to stop your own watch, or Keep watching. No reply keeps your watch. This offer expires in 10 minutes.";
const base64Url = (bytes) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const decodeBase64Url = (text) => Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

async function signatureKey(secret) {
  if (!secret) throw new Error("Telegram confirmation signing is unavailable");
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function signedData(chatId, payload) {
  // Authenticated owner/friend identity is not stored inside the readable token.
  return new TextEncoder().encode(JSON.stringify([domain, String(chatId), payload]));
}

function validProposal(proposal) {
  return proposal && typeof proposal.operation === "string" && /^[a-z_]{1,40}$/.test(proposal.operation)
    && typeof proposal.target === "string" && proposal.target.length <= 240
    && typeof proposal.scope === "string" && /^[A-Za-z0-9_-]{0,64}$/.test(proposal.scope)
    && typeof proposal.prompt === "string" && proposal.prompt.length > 0 && proposal.prompt.length <= 1000;
}

async function issueConfirmation(secret, chat, proposal, now = Date.now()) {
  if (chat?.type !== "private" || !/^\d+$/.test(String(chat.id)) || !validProposal(proposal)) {
    throw new Error("Invalid Telegram confirmation request");
  }
  const nonce = base64Url(crypto.getRandomValues(new Uint8Array(16)));
  const expiresAt = now + confirmationLifetimeMs;
  // Keep visible consequence only once, and bind it verbatim into the signature.
  const prompt = proposal.prompt + instructions;
  const payload = base64Url(new TextEncoder().encode(JSON.stringify([proposal.operation, proposal.target, proposal.scope, nonce, expiresAt])));
  const mac = base64Url(new Uint8Array(await crypto.subtle.sign(
    "HMAC", await signatureKey(secret), signedData(chat.id, [payload, prompt])
  )));
  return { text: `${prompt}\nConfirmation code: ${payload}.${mac}`, replyMarkup: { force_reply: true } };
}

async function readConfirmation(secret, botId, message, now = Date.now()) {
  if (message?.chat?.type !== "private" || !/^\d+$/.test(String(message.chat.id))
      || !["yes", "no", "stop too", "keep watching"].includes(message.text?.trim().toLowerCase())
      || message.from?.is_bot !== false || String(message.from?.id) !== String(message.chat.id)) return null;
  const reply = message.reply_to_message;
  if (!/^\d+$/.test(String(botId)) || reply?.from?.is_bot !== true || String(reply.from.id) !== String(botId)
      || String(reply.chat?.id) !== String(message.chat.id) || reply.chat?.type !== "private"
      || !Number.isSafeInteger(reply.message_id) || typeof reply.text !== "string" || reply.text.length > 3600) return null;
  const match = reply.text.match(/^([\s\S]+)\nConfirmation code: ([A-Za-z0-9_-]{1,2200})\.([A-Za-z0-9_-]{43})$/);
  if (!match) return null;
  const [, prompt, payload, mac] = match;
  try {
    const verified = await crypto.subtle.verify("HMAC", await signatureKey(secret), decodeBase64Url(mac),
      signedData(message.chat.id, [payload, prompt]));
    if (!verified) return null;
    const [operation, target, scope, nonce, expiresAt] = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64Url(payload)));
    const response = message.text.trim().toLowerCase();
    const offer = operation === "unfollow_owner_offer";
    const suffix = offer ? ownerInstructions : instructions;
    if ((!offer && response !== "yes" && response !== "no") || !prompt.endsWith(suffix)
        || !validProposal({ operation, target, scope, prompt: prompt.slice(0, -suffix.length) }) || !/^[A-Za-z0-9_-]{22}$/.test(nonce)
        || !Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + confirmationLifetimeMs) return null;
    return { operation, target, scope, nonce, expiresAt, keep: offer && response === "keep watching", cancel: response === "no" };
  } catch {
    return null;
  }
}

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

async function notificationRecipientKey(env, chatId) {
  if (!env.TELEGRAM_PREFERENCES_KEY) throw new Error("Telegram preferences key is not configured");
  const bytes = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", bytes.encode(env.TELEGRAM_PREFERENCES_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, bytes.encode(chatId));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function dispatchNotificationWorkflow(env, inputs) {
  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/telegram-reminders.yml/dispatches`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json", authorization: `Bearer ${env.GITHUB_ACTIONS_TOKEN}`,
      "content-type": "application/json", "user-agent": "CineplexTicketWatcher",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({ ref: "main", inputs }),
  });
  if (!response.ok) throw new Error(`GitHub notification dispatch failed: HTTP ${response.status}`);
}

function reminderWeek(now) {
  const local = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hourCycle: "h23",
  }).formatToParts(now).map(({ type, value }) => [type, value]));
  // Use UTC only for calendar arithmetic after converting to the Montréal date.
  const date = new Date(`${local.year}-${local.month}-${local.day}T00:00:00Z`);
  const daysSinceSaturday = (date.getUTCDay() + 1) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceSaturday - (daysSinceSaturday === 0 && Number(local.hour) < 12 ? 7 : 0));
  return date.toISOString().slice(0, 10);
}

async function checkWeeklyReminder(env, scheduledTime) {
  const week = reminderWeek(new Date(scheduledTime));
  const requestId = `weekly-${week}`;
  const runName = `Telegram remind ${requestId}`;
  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/telegram-reminders.yml/runs?branch=main&event=workflow_dispatch&per_page=100`, {
    headers: {
      accept: "application/vnd.github+json", authorization: `Bearer ${env.GITHUB_ACTIONS_TOKEN}`,
      "user-agent": "CineplexTicketWatcher", "cache-control": "no-cache",
    },
  });
  if (!response.ok) throw new Error(`Could not check weekly reminder runs: HTTP ${response.status}`);
  const runs = (await response.json()).workflow_runs.filter((run) => run.display_title === runName);
  const finished = runs.find((run) => run.conclusion === "success");
  const pending = runs.find((run) => run.status !== "completed");
  if (finished || pending) {
    console.log(JSON.stringify({ event: finished ? "weekly_reminder_complete" : "weekly_reminder_pending", week, runId: (finished || pending).id }));
    return;
  }
  await dispatchNotificationWorkflow(env, { operation: "remind", request_id: requestId });
  console.log(JSON.stringify({ event: "weekly_reminder_queued", week, requestId }));
}

const TICKET_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const TICKET_CHECK_RUN_PREFIX = "Ticket check ticket-check-";

async function checkTickets(env, scheduledTime) {
  // Never dispatch an expired slot when Cloudflare delivers an old event late.
  const slot = Math.floor(scheduledTime / TICKET_CHECK_INTERVAL_MS);
  if (slot !== Math.floor(Date.now() / TICKET_CHECK_INTERVAL_MS)) return;

  const requestId = `ticket-check-${slot}`;
  const endpoint = `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/check-tickets.yml`;
  const headers = {
    accept: "application/vnd.github+json", authorization: `Bearer ${env.GITHUB_ACTIONS_TOKEN}`,
    "user-agent": "CineplexTicketWatcher", "x-github-api-version": "2022-11-28",
  };
  const response = await fetch(`${endpoint}/runs?branch=main&event=workflow_dispatch&per_page=100`, {
    headers: { ...headers, "cache-control": "no-cache" },
  });
  if (!response.ok) throw new Error(`Could not check ticket workflow runs: HTTP ${response.status}`);
  const runs = (await response.json()).workflow_runs;
  const completed = runs.some((run) => run.display_title === `Ticket check ${requestId}` && run.conclusion === "success");
  const busy = runs.some((run) => run.display_title?.startsWith(TICKET_CHECK_RUN_PREFIX) && run.status !== "completed");
  if (completed || busy) return;

  const dispatch = await fetch(`${endpoint}/dispatches`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ ref: "main", inputs: { operation: "check", request_id: requestId } }),
  });
  if (!dispatch.ok) throw new Error(`GitHub ticket check dispatch failed: HTTP ${dispatch.status}`);
  console.log(JSON.stringify({ event: "ticket_check_queued", requestId }));
}

async function handleNotificationPreference(env, chatId, operation, query) {
  const requestId = crypto.randomUUID();
  try {
    const recipientKey = await notificationRecipientKey(env, chatId);
    const recipients = await getSeatWatcherFile(env, "notification-preferences.json", "recipients");
    // Friends can manage themselves without gaining shared-watch administration.
    if (!Object.hasOwn(recipients, recipientKey)) return;
    if (!query || query.length > 200) {
      await telegram(env, chatId, "Use /stop Movie Name, /stop all, or /stop reminder.\nResume with /start all or /start reminder.");
      return;
    }
    await dispatchNotificationWorkflow(env, { operation, query, recipient_key: recipientKey, request_id: requestId });
    console.log(JSON.stringify({ event: "notification_preference_queued", requestId, operation }));
    await telegram(env, chatId, "Updating your notification preferences. I'll confirm when saved.");
  } catch (error) {
    console.error("Could not update notification preference:", error);
    await telegram(env, chatId, "I could not update your notification preferences. Please try again shortly.");
  }
}

async function dispatchWatch(env, titles, requestId, recipientKey = "") {
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
    body: JSON.stringify({ ref: "main", inputs: { title: titles[0], titles: titles.join("\n"), operation: "watch", request_id: requestId, recipient_key: recipientKey } }),
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

async function dispatchConfirmedTicket(env, confirmation, recipientKey) {
  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/check-tickets.yml/dispatches`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json", authorization: `Bearer ${env.GITHUB_ACTIONS_TOKEN}`,
      "content-type": "application/json", "user-agent": "CineplexTicketWatcher",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({ ref: "main", inputs: { operation: confirmation.cancel ? "cancel" : confirmation.keep ? "keep" : "unfollow", title: confirmation.target,
      request_id: confirmation.nonce, recipient_key: recipientKey, confirmation_expires: String(confirmation.expiresAt) } }),
  });
  if (!response.ok) throw new Error(`Ticket confirmation dispatch failed: HTTP ${response.status}`);
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

function extensionAuthenticationError(request, env) {
  if (!env.UI_ACCESS_TOKEN) return Response.json({ error: "The extension queue is not configured yet." }, { status: 503, headers: { "access-control-allow-origin": "*" } });
  const authorization = request.headers.get("Authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (token !== env.UI_ACCESS_TOKEN) return Response.json({ error: "Invalid extension access token." }, { status: 401, headers: { "access-control-allow-origin": "*" } });
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

async function handleSeatWatchLayout(request, env, watchId, showtimeId) {
  const authenticationError = queueAuthenticationError(request, env);
  if (authenticationError) return authenticationError;
  if (!seatWatchId(watchId) || !/^\d+$/.test(showtimeId || "")) {
    return queueResponse(env, { error: "Seat watch or showtime is invalid." }, 400);
  }
  try {
    const watch = (await getSeatWatches(env))[watchId];
    if (!watch?.enabled || !watch.showtimes?.[showtimeId]?.enabled) {
      return queueResponse(env, { error: "This showtime is not enabled for the seat watch." }, 404);
    }
    const response = await fetch(`https://apis.cineplex.com/prod/ticketing/api/v1/theatre/${encodeURIComponent(watch.theatreId)}/showtime/${encodeURIComponent(showtimeId)}/seat-layout`, {
      headers: { accept: "application/json", "user-agent": "CineplexTicketWatcher/1.0 (personal ticket availability monitor)" },
    });
    if (!response.ok) throw new Error(`Cineplex seat layout returned HTTP ${response.status}`);
    const layout = await response.json();
    if (!Array.isArray(layout?.standardSeats?.rows) || !Number.isInteger(layout?.totalColumns)) {
      throw new Error("Cineplex seat layout has an unexpected format");
    }
    console.log(JSON.stringify({ event: "web_seat_layout_loaded", watchId, showtimeId }));
    return queueResponse(env, { showtimeId, layout });
  } catch (error) {
    console.error("Could not load web seat layout:", error);
    return queueResponse(env, { error: "Could not load the Cineplex seat layout. Please try again shortly." }, 502);
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
  } else if (operation !== "stop" && operation !== "delete") {
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

async function handleExtensionWatchSeat(request, env) {
  const authenticationError = extensionAuthenticationError(request, env);
  if (authenticationError) return authenticationError;
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: "Request body must be JSON." }, { status: 400, headers: { "access-control-allow-origin": "*" } }); }
  const preview = parseSeatPreviewUrl(typeof body?.url === "string" ? body.url : "");
  if (!preview) return Response.json({ error: "Provide an official Cineplex preview URL with theatreId or locationId and showtimeId." }, { status: 400, headers: { "access-control-allow-origin": "*" } });
  try {
    const watches = await getSeatWatches(env);
    const existing = Object.values(watches).find((watch) => String(watch.theatreId) === preview.theatreId && watch.showtimes?.[preview.showtimeId]);
    if (existing) return Response.json({ status: "already_watched", message: `#${preview.showtimeId} is already in ${existing.name}. Nothing changed.` }, { headers: { "access-control-allow-origin": "*" } });
    const requestId = crypto.randomUUID();
    console.log(JSON.stringify({ event: "extension_seat_preview_watch_requested", requestId, ...preview }));
    await dispatchSeatWatch(env, "watch_preview", "", preview, requestId, "");
    return Response.json({ status: "queued", message: `Reading #${preview.showtimeId} from Cineplex. It will be added after validation.` }, { status: 202, headers: { "access-control-allow-origin": "*" } });
  } catch (error) {
    console.error("Could not dispatch extension preview seat watch:", error);
    return Response.json({ error: "Could not start the preview seat watch. Please try again shortly." }, { status: 502, headers: { "access-control-allow-origin": "*" } });
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
    await dispatchWatch(env, [title], requestId, await notificationRecipientKey(env, chatId));
    console.log(JSON.stringify({ event: "github_dispatch_accepted", requestId }));
  } catch (error) {
    console.error("Could not dispatch GitHub Actions watch:", error);
    return telegram(env, chatId, "I could not start the Cineplex search. Please try again shortly.");
  }

  return telegram(env, chatId, `Searching Cineplex for ${title}. I will reply when the watch is registered.`);
}

async function proposeStop(env, message, query, command) {
  const chatId = String(message.chat.id);
  const recipients = await getSeatWatcherFile(env, "notification-preferences.json", "recipients");
  const context = await listContext(env, chatId, recipients);
  if (!Object.hasOwn(recipients, context.viewerKey)) return;
  if (!query || query.length > 200) {
    return telegram(env, chatId, "Use /stop Movie Name, /stop all, or /stop reminder.");
  }
  const preference = recipients[context.viewerKey];
  const setting = command === "stop" ? query.toLowerCase() : "";
  let proposal;
  if (setting === "all" || setting === "reminder") {
    if (setting === "all" ? preference.stoppedAll : preference.remindersEnabled === false) {
      return telegram(env, chatId, setting === "all" ? "Your alerts are already paused. Nothing changed." : "Your weekly reminder is already off. Nothing changed.");
    }
    proposal = { operation: "pause_preferences", target: setting, scope: "",
      prompt: setting === "all"
        ? "This will pause your ticket and seat alerts and the weekly reminder. Your movies stay on your list and checks continue. Nobody else's alerts change."
        : "This will turn off only your weekly reminder. Your ticket and seat alerts and everyone else's settings stay unchanged." };
  } else {
    const normalized = (value) => String(value).toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]/gu, "");
    const requested = normalized(query.replace(/^ticket:/i, ""));
    const owner = context.ownerKeys.has(context.viewerKey);
    const watched = (await getManagedWatches(env)).filter((movie) => ticketScope(movie, context.viewerKey, owner));
    const exact = watched.filter((movie) => requested && [movieKey(movie.url), movie.name].some((value) => value && normalized(value) === requested));
    const matches = exact.length ? exact : watched.filter((movie) => requested && normalized(movie.name || movieKey(movie.url)).includes(requested));
    if (matches.length !== 1) return telegram(env, chatId, matches.length
      ? "Several of your active movies match. Use the exact movie name from /list. Nothing changed."
      : "No matching active movie on your list. Nothing changed.");
    const movie = matches[0];
    const name = String(movie.name || nameFromUrl(movie.url)).replace(/\s+/g, " ").slice(0, 120);
    const privateAdmins = [...allowedTelegramChatIds(env)].filter((id) => /^[1-9][0-9]*$/.test(id));
    let adminNote = "";
    if (!owner && privateAdmins.length === 1) {
      const adminKey = await notificationRecipientKey(env, privateAdmins[0]);
      adminNote = ticketScope(movie, adminKey, true)
        ? " The admin will be notified; their own watch will keep running unless they stop it."
        : " The admin will be notified. Their watch settings will not change.";
    }
    proposal = { operation: "unfollow_ticket", target: movieKey(movie.url), scope: "",
      prompt: `This will remove ${name} from your followed movies. You will stop receiving ticket alerts and weekly reminders for this movie. Other people can keep following it.` + adminNote };
  }
  const pending = await issueConfirmation(env.TELEGRAM_PREFERENCES_KEY, message.chat, proposal);
  await telegram(env, chatId, pending.text, { reply_markup: pending.replyMarkup });
}

async function applyTelegramApproval(env, message) {
  const chatId = String(message.chat.id);
  const response = message.text.trim().toLowerCase();
  const recipients = await getSeatWatcherFile(env, "notification-preferences.json", "recipients");
  const context = await listContext(env, chatId, recipients);
  if (!Object.hasOwn(recipients, context.viewerKey)) return;
  const botId = String(env.TELEGRAM_BOT_TOKEN || "").split(":")[0];
  const confirmation = await readConfirmation(env.TELEGRAM_PREFERENCES_KEY, botId, message);
  if (!confirmation) {
    if (response !== "keep watching") await telegram(env, chatId, "No valid confirmation found. Reply directly to the latest confirmation message before it expires. Nothing changed.");
    return;
  }
  if (confirmation.operation === "unfollow_owner_offer" && !context.ownerKeys.has(context.viewerKey)) return;
  if (confirmation.operation === "unfollow_ticket" || confirmation.operation === "unfollow_owner_offer") {
    await dispatchConfirmedTicket(env, confirmation, context.viewerKey);
  } else if (confirmation.operation === "pause_preferences" && ["all", "reminder"].includes(confirmation.target)) {
    await dispatchNotificationWorkflow(env, { operation: "stop", query: confirmation.target, recipient_key: context.viewerKey,
      request_id: confirmation.nonce, confirmation_expires: String(confirmation.expiresAt),
      confirmation_cancel: confirmation.cancel ? "true" : "" });
  }
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

async function handleWatchSeat(env, chatId, value) {
  const preview = parseSeatPreviewUrl(value);
  if (!preview) return telegram(env, chatId, "Use /watchseat CineplexPreviewUrl\nExample: /watchseat https://www.cineplex.com/ticketing/preview?theatreId=9406&showtimeId=405853");
  try {
    const watches = await getSeatWatches(env);
    const existing = Object.values(watches).find((watch) => String(watch.theatreId) === preview.theatreId && watch.showtimes?.[preview.showtimeId]);
    if (existing) return telegram(env, chatId, `ℹ️ #${preview.showtimeId} is already in ${existing.name}. Nothing changed.`);
    const requestId = crypto.randomUUID();
    console.log(JSON.stringify({ event: "seat_preview_watch_requested", requestId, ...preview }));
    await dispatchSeatWatch(env, "watch_preview", "", preview, requestId, chatId);
    console.log(JSON.stringify({ event: "seat_preview_watch_queued", requestId, ...preview }));
    return telegram(env, chatId, `⏳ Reading #${preview.showtimeId} from Cineplex. I will add it to its movie watch after validation.`);
  } catch (error) {
    console.error("Could not dispatch preview seat watch:", error);
    return telegram(env, chatId, "I could not start the preview seat watch. Please try again shortly.");
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
  const bytes = Uint8Array.from(atob(String(content.content || "").replace(/\s/g, "")), (char) => char.charCodeAt(0));
  const config = JSON.parse(new TextDecoder().decode(bytes));
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

function parseSeatPreviewUrl(value) {
  try {
    const url = new URL(value.trim());
    const theatreId = url.searchParams.get("theatreId") || url.searchParams.get("locationId");
    const showtimeId = url.searchParams.get("showtimeId");
    if (url.hostname !== "www.cineplex.com" || !/^\/ticketing\/preview\/?$/i.test(url.pathname) || !/^\d+$/.test(theatreId || "") || !/^\d+$/.test(showtimeId || "")) return null;
    return { theatreId, showtimeId };
  } catch {
    return null;
  }
}

function findSeatWatch(watches, requestedName, { activeShowtimesOnly = false } = {}) {
  const target = normalizeSeatWatchName(requestedName);
  const candidates = Object.entries(watches).filter(([, watch]) => {
    return !activeShowtimesOnly || (watch?.enabled && Object.values(watch.showtimes || {}).some((showtime) => showtime?.enabled !== false));
  });
  const exact = candidates.filter(([, watch]) => normalizeSeatWatchName(watch?.name) === target);
  if (exact.length === 1) return { id: exact[0][0], watch: exact[0][1] };
  const partial = candidates.filter(([, watch]) => normalizeSeatWatchName(watch?.name).includes(target));
  if (partial.length !== 1) return null;
  return { id: partial[0][0], watch: partial[0][1] };
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
    const found = findSeatWatch(watches, name, { activeShowtimesOnly: true });
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

function ticketScope(movie, recipientKey, owner = false) {
  return !movie.unfollowers?.includes(recipientKey)
    && (owner || movieKey(movie.url) === "george-michael-the-faith-tour" || movie.subscribers?.includes(recipientKey));
}

function alertStatus(preference = {}, watchKey) {
  if (preference.stoppedAll) return "off (all alerts paused)";
  if (watchKey && preference.stoppedWatches?.includes(watchKey)) return "off (paused for this title)";
  return "on";
}

function accountLabels({ viewerKey, ownerKeys, recipients }) {
  const labels = new Map([[viewerKey, "You"]]);
  for (const [keys, role] of [[[...ownerKeys].sort().filter((key) => key !== viewerKey), "Other owner"],
    [Object.keys(recipients).sort().filter((key) => !ownerKeys.has(key)), "Friend"]]) {
    keys.forEach((key, index) => labels.set(key, keys.length === 1 ? role : `${role} ${index + 1}`));
  }
  return labels;
}

function titleText(value, max = 120) {
  const chars = Array.from(String(value || "").replace(/\s+/g, " ").trim());
  return escapeHtml(chars.length > max ? chars.slice(0, max).join("") + "…" : chars.join(""));
}

function titleName(movie, check) {
  return titleText(movie.name || check?.name || nameFromUrl(movie.url));
}

function ticketLink(movie, check) {
  const name = titleName(movie, check);
  return /^https:\/\/www\.cineplex\.com\/movie\/[a-z0-9-]{1,240}\/?$/i.test(movie.url)
    ? `<a href="${escapeHtml(movie.url)}">${name}</a>` : name;
}

function ticketLabel(check, unavailable) {
  if (unavailable || !check?.lastCheckedAt) return "Ticket status unknown";
  if (check.lastCheckStatus === "failed" || check.lastError) return "Last check failed";
  if (check.lastCheckStatus !== "success" || typeof check.hasShowtimes !== "boolean") return "Ticket status unknown";
  return check.hasShowtimes ? "Tickets on sale" : "Tickets not on sale";
}

function ticketListEntry(movie, state, unavailable, context, labels) {
  const slug = movieKey(movie.url);
  const check = state[slug];
  const watchKey = `ticket:${slug}`;
  const details = [];
  const base = `• ${ticketLink(movie, check)} · ${ticketLabel(check, unavailable)}`;
  details.push(base);
  if (check?.lastCheckedAt) details.push(`Last ${ticketLabel(check, unavailable) === "Last check failed" ? "attempt" : "scan"}: ${formatTimestamp(check.lastCheckedAt)}`);
  if (context.ownerKeys.has(context.viewerKey)) {
    const scope = [...labels.entries()].filter(([key]) => ticketScope(movie, key, context.ownerKeys.has(key)));
    const shown = scope.slice(0, 12);
    const more = scope.length > shown.length ? `; ${scope.length - shown.length} more in /state` : "";
    details.push(`Following: ${shown.map(([, label]) => label).join(" and ") || "No one"}${more}`);
    details.push(`Ticket alerts: ${shown.map(([key, label]) => `${label} ${alertStatus(context.recipients[key], watchKey)}`).join("; ") || "No recipients"}${more}`);
  } else {
    details.push(`Your ticket alerts: ${alertStatus(context.recipients[context.viewerKey], watchKey)}`);
  }
  return details.join("\n");
}

function watchHints(preference = {}) {
  const hints = [];
  if (preference.stoppedAll || preference.stoppedWatches?.length) {
    hints.push("<code>/start all</code> resumes all your alerts and clears title pauses.");
  }
  if (preference.remindersEnabled === false) {
    hints.push("<code>/start reminder</code> turns on weekly reminders.");
  }
  return hints;
}

function boundedHtml(blocks, maxLength = 3800) {
  const pages = [];
  let page = "";
  for (const block of blocks) {
    // Keep a movie's status and alerts on one page; split only large accounts between complete lines.
    const entries = block.length <= maxLength ? [block] : block.split("\n").filter(Boolean);
    for (const item of entries) {
      const separator = entries.length === 1 ? "\n\n" : "\n";
      if (page && page.length + separator.length + item.length > maxLength) {
        pages.push(page);
        page = "";
      }
      page += (page ? separator : "") + item;
    }
  }
  if (page) pages.push(page);
  return pages;
}

async function sendWatchPages(env, chatId, blocks) {
  for (const text of boundedHtml(blocks)) await telegram(env, chatId, text, { parse_mode: "HTML" });
}

function nextReminderDate(now) {
  const date = new Date(`${reminderWeek(now)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 7);
  return new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric", timeZone: "UTC" }).format(date);
}

const stateClock = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Toronto", weekday: "short", month: "short", day: "numeric",
  hour: "numeric", minute: "2-digit", hour12: true,
});

function stateDate(value) {
  return Number.isFinite(Date.parse(value)) ? stateClock.format(new Date(value)) : "not recorded";
}

function weeklyState(preference, eligible, now, seatsUnknown = false) {
  const enabled = preference.remindersEnabled !== false;
  const status = !enabled ? "🔕 <b>OFF</b> · disabled by preference"
    : preference.stoppedAll ? "⏸ <b>BLOCKED</b> · all alerts paused"
    : eligible === null ? "❔ <b>UNKNOWN</b> · active seat data unavailable"
    : !eligible ? "⏸ <b>BLOCKED</b> · no active watches with alerts on"
    : `🟢 <b>ON</b> · ${eligible}${seatsUnknown ? "+ eligible (seat status unknown)" : " eligible"} · next Sat ${nextReminderDate(now)}, noon`;
  const last = /^\d{4}-\d{2}-\d{2}$/.test(preference.lastReminderWeek || "")
    ? preference.lastReminderWeek : "";
  return [
    `Weekly setting: <b>${enabled ? "ON" : "OFF"}</b> · scheduled reminder: ${status}`,
    last ? `Last accepted week: ${last} (not receipt)` : "Last accepted week: none recorded",
  ];
}

function activeSeatScope(seats, now) {
  const clock = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    second: "2-digit", hourCycle: "h23",
  }).formatToParts(now).map(({ type, value }) => [type, value]));
  const local = `${clock.year}-${clock.month}-${clock.day}T${clock.hour}:${clock.minute}:${clock.second}`;
  return Object.entries(seats).filter(([, watch]) => watch?.enabled && Object.values(watch.showtimes || {}).some((showtime) => {
    if (!showtime?.enabled || showtime.completed) return false;
    const start = showtime.showStartDateTimeUtc || showtime.startsAt;
    if (!start) return true;
    if (/^\d{4}-\d{2}-\d{2}T\d\d:\d\d(?::\d\d)?(?:\.\d+)?$/.test(start)) {
      return (start.length === 16 ? start + ":00" : start.slice(0, 19)) > local;
    }
    return Date.parse(start) > now.getTime();
  }));
}

function accountState(label, key, context, movies, seats, now) {
  const preference = context.recipients[key] || {};
  const isOwner = context.ownerKeys.has(key);
  const scoped = movies.filter((movie) => ticketScope(movie, key, isOwner));
  const ticketOn = scoped.filter((movie) => alertStatus(preference, `ticket:${movieKey(movie.url)}`) === "on").length;
  const seatOn = isOwner && seats ? seats.filter(([id]) => alertStatus(preference, `seat:${id}`) === "on").length : 0;
  const eligible = isOwner && seats === null && !preference.stoppedAll && !ticketOn ? null : ticketOn + seatOn;
  const lines = [
    `👤 <b>${label}${isOwner ? " (owner)" : ""}</b>`,
    preference.stoppedAll ? "🔕 <b>Alerts off</b> · all alerts paused" : "🔔 <b>Alerts enabled</b> · individual pauses may apply",
    `Ticket alerts: ${ticketOn}/${scoped.length} subscribed titles on`,
  ];
  if (isOwner) lines.push(seats === null ? "Seat alerts: ❔ <b>UNKNOWN</b>"
    : `Seat alerts: ${seatOn}/${seats.length} active watches on`);
  lines.push(...weeklyState(preference, eligible, now, isOwner && seats === null));
  if (key === context.viewerKey) lines.push(...watchHints(preference));
  return lines.join("\n");
}

function ticketDashboardCard(movie, check, unavailable, context, labels, isOwner, now) {
  const slug = movieKey(movie.url);
  const key = `ticket:${slug}`;
  const result = ticketLabel(check, unavailable);
  const icon = result === "Last check failed" ? "⚠️" : result === "Ticket status unknown" ? "❔"
    : result === "Tickets on sale" ? "🟢" : "⏳";
  const stale = result.startsWith("Tickets ") && now.getTime() - Date.parse(check?.lastCheckedAt) > 60 * 60_000;
  const lines = [`${icon} <b>${ticketLink(movie, check)}</b> · ${result}${stale ? " (last known)" : ""}`];
  if (check?.lastCheckedAt) lines.push(`${result === "Last check failed" ? "Last attempt" : "Last scan"}: ${stateDate(check.lastCheckedAt)}`);
  if (isOwner) {
    lines.push(`Scope: ${slug === "george-michael-the-faith-tour" ? "Montréal" : "Canada-wide"}`);
    const followers = [...labels.entries()].filter(([recipient]) => ticketScope(movie, recipient, context.ownerKeys.has(recipient)));
    const alertSetting = ([recipient]) => alertStatus(context.recipients[recipient], key);
    const alerts = followers.filter((row) => alertSetting(row) === "on");
    const muted = followers.filter((row) => alertSetting(row) !== "on");
    // Wrap labels on separate complete lines so a large registry cannot exceed Telegram's message limit.
    for (const [audience, title] of [[followers, "Following"], [alerts, "Ticket alerts on"], [muted, "Ticket alerts off"]]) {
      if (!audience.length) lines.push(`${title}: none`);
      for (let i = 0; i < audience.length; i += 25) {
        lines.push(`${i ? "  " : title + ": "}${audience.slice(i, i + 25).map((row) => row[1] + (audience === muted ? " " + alertSetting(row).slice(4) : "")).join(", ")}`);
      }
    }
  } else {
    const status = alertStatus(context.recipients[context.viewerKey], key);
    lines.push(status === "on" ? "🔔 Your ticket alerts: <b>ON</b>" : `🔕 Your ticket alerts: <b>OFF</b> ${status.slice(4)}`);
  }
  return lines.join("\n");
}

function ticketHeartbeat(pending, state, unavailable, now) {
  if (unavailable) return "❔ <b>UNKNOWN</b> · ticket scan state unavailable";
  if (!pending.length) return "⚪ <b>IDLE</b> · no active ticket watches";
  const maxAge = 60 * 60_000;
  const checks = pending.map((movie) => state[movieKey(movie.url)]);
  const dated = checks.filter((check) => Number.isFinite(Date.parse(check?.lastCheckedAt)));
  const latest = (rows) => rows.sort((a, b) => Date.parse(b.lastCheckedAt) - Date.parse(a.lastCheckedAt))[0]?.lastCheckedAt;
  const successes = dated.filter((check) => ticketLabel(check, false).startsWith("Tickets "));
  const failures = dated.filter((check) => ticketLabel(check, false) === "Last check failed");
  const recent = successes.filter((check) => now.getTime() - Date.parse(check.lastCheckedAt) <= maxAge).length;
  const stale = successes.length - recent;
  const unknown = pending.length - successes.length - failures.length;
  const success = latest(successes), failed = latest(failures), newest = latest(dated);
  const result = failures.length ? "⚠️ <b>CHECK FAILED</b> · at least one latest result failed"
    : stale ? "⚠️ <b>STALE</b> · some saved results are over an hour old"
    : unknown ? "❔ <b>UNKNOWN</b> · some titles have no confirmed result"
    : "🟢 <b>RECENT</b> · all active titles have a saved result within an hour";
  return [result, `${recent} recent · ${stale} stale · ${failures.length} failed · ${unknown} unknown`,
    ...(newest && newest === success ? [`Last attempt succeeded: ${stateDate(success)}`]
      : [`Last attempt: ${stateDate(newest)}`, `Latest success: ${stateDate(success)}`]),
    ...(failed ? [`Latest failure: ${stateDate(failed)}`] : [])].join("\n");
}

function stateCount(count, singular) {
  return `${count} ${singular}${count === 1 ? "" : singular.endsWith("watch") ? "es" : "s"}`;
}

async function handleList(env, chatId, context, command) {
  try {
    const isOwner = context.ownerKeys.has(context.viewerKey);
    const now = new Date();
    const [salesStarted, movies, stateResult, seatResult] = await Promise.all([
      command === "state" && !isOwner ? [] : getSalesStarted(env).catch(() => null),
      getManagedWatches(env),
      getWatchState(env).then((state) => ({ state })).catch(() => ({ state: {}, unavailable: true })),
      command === "state" && isOwner ? getSeatWatches(env).then((seats) => activeSeatScope(seats, now)).catch(() => null) : null,
    ]);
    const { state, unavailable } = stateResult;
    const preference = context.recipients[context.viewerKey] || {};
    const visible = (movie) => isOwner
      ? [...new Set([...context.ownerKeys, ...Object.keys(context.recipients)])].some((key) => ticketScope(movie, key, context.ownerKeys.has(key)))
      : ticketScope(movie, context.viewerKey);
    const visibleHistory = (movie) => isOwner || (visible(movie) && alertStatus(preference, `ticket:${movieKey(movie.url)}`) === "on");
    const unique = (rows) => [...new Map(rows.map((movie) => [movie.url, movie])).values()];
    const pending = unique(movies.filter(visible));
    const started = unique((salesStarted || []).filter(visibleHistory));
    const labels = isOwner ? accountLabels(context) : new Map([[context.viewerKey, "You"]]);
    const sections = [];
    if (command === "state") {
      sections.push(isOwner ? "🎬 <b>Watcher dashboard</b>" : "🎬 <b>Your watcher settings</b>");
      if (isOwner) {
        const paused = [...labels.keys()].filter((key) => context.recipients[key]?.stoppedAll).length;
        const remindersOff = [...labels.keys()].filter((key) => context.recipients[key]?.remindersEnabled === false).length;
        sections.push([`📊 <b>Overview</b>`, `🎟 ${stateCount(pending.length, "active ticket watch")} · ${salesStarted === null ? "sales history unavailable" : `${stateCount(started.length, "sale")} recorded`}`,
          `🪑 ${seatResult === null ? "Seat status unavailable" : stateCount(seatResult.length, "active seat watch")} · <code>/listseats</code>`,
          ...(paused || remindersOff ? [`🔕 ${stateCount(paused, "all-alert pause")} · ${stateCount(remindersOff, "separate weekly opt-out")}. Each account manages its own settings.`] : [])].join("\n"));
        sections.push("📡 <b>Ticket checks</b>\n" + ticketHeartbeat(pending, state, unavailable, now));
        sections.push("👥 <b>Per-account settings</b>");
      }
      for (const [key, label] of labels) sections.push(accountState(label, key, context, pending, seatResult, now));
      sections.push(isOwner ? "🎟 <b>Active ticket watches</b>" : "🎟 <b>Your active tickets</b>");
      for (const movie of pending) sections.push(ticketDashboardCard(movie, state[movieKey(movie.url)], unavailable, context, labels, isOwner, now));
      if (!pending.length) sections.push("No active ticket watches.");
      sections.push("Use <code>/list</code> for the watchlist and recent sales.");
    } else {
      sections.push("<b>Ticket watchlist</b>");
      if (pending.length && env.TICKET_SCHEDULER_ENABLED === "true") sections.push(`Next expected ticket scan: ${nextScheduledCheck()}`);
      if (pending.length) {
        sections.push("<b>Active watches</b>");
        for (const movie of pending) sections.push(ticketListEntry(movie, state, unavailable, context, labels));
      } else sections.push("No active ticket watches.");
      if (started.length) {
        sections.push("<b>Recent ticket sales</b>");
        started.sort((a, b) => (Date.parse(b.salesStartedAt) || 0) - (Date.parse(a.salesStartedAt) || 0));
        for (const movie of started.slice(0, 6)) {
          const when = Number.isFinite(Date.parse(movie.salesStartedAt)) ? ` · ${formatTimestamp(movie.salesStartedAt)}` : "";
          sections.push(`• ${ticketLink(movie, state[movieKey(movie.url)])}${when}`);
        }
      }
      if (salesStarted === null) sections.push("Recent ticket sales are temporarily unavailable.");
      sections.push(...watchHints(preference), "Use <code>/state</code> for alert and weekly reminder settings.");
    }
    await sendWatchPages(env, chatId, sections);
  } catch (error) {
    console.error("Could not load watch information:", error instanceof Error ? error.name : "unknown");
    await telegram(env, chatId, "I could not load the watch information. Please try again shortly.");
  }
}

async function listContext(env, chatId, recipients) {
  const ownerKeys = new Set(await Promise.all([...allowedTelegramChatIds(env)].map((id) => notificationRecipientKey(env, id))));
  return { ownerKeys, viewerKey: await notificationRecipientKey(env, chatId), recipients };
}

async function handleUpdate(request, env) {
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  const update = await request.json();
  const message = update.message;
  if (!message?.text) return new Response("ok");

  const chatId = String(message.chat.id);
  const watchView = message.text.trim().match(/^\/(list|state)(?:@\w+)?$/i)?.[1].toLowerCase();
  if (watchView) {
    // Never place watch membership or alert settings in a group or channel.
    if (message.chat.type !== "private") return new Response("ok");
    try {
      const recipients = await getSeatWatcherFile(env, "notification-preferences.json", "recipients");
      const context = await listContext(env, chatId, recipients);
      if (!context.ownerKeys.has(context.viewerKey) && !Object.hasOwn(recipients, context.viewerKey)) return new Response("ok");
      await handleList(env, chatId, context, watchView);
    } catch (error) {
      console.error("Could not load watch scope:", error instanceof Error ? error.name : "unknown");
      if (allowedTelegramChatIds(env).has(chatId)) {
        await telegram(env, chatId, "I could not load the watch settings. Please try again shortly.");
      }
    }
    return new Response("ok");
  }
  if (/^\/id(?:@\w+)?$/i.test(message.text)) {
    await telegram(env, chatId, `Your Telegram chat ID is ${chatId}. Send it to the watcher owner so they can authorize you.`);
    return new Response("ok");
  }
  const stopRequest = message.text.trim().match(/^\/(stop|stopwatch)(?:@\w+)?(?:\s+(.+))?$/i);
  const approval = /^(yes|no|stop too|keep watching)$/i.test(message.text.trim());
  if (stopRequest || approval) {
    if (message.chat.type !== "private" || message.from?.is_bot !== false || String(message.from.id) !== chatId) return new Response("ok");
    try {
      if (stopRequest) await proposeStop(env, message, (stopRequest[2] || "").trim(), stopRequest[1].toLowerCase());
      else await applyTelegramApproval(env, message);
    } catch (error) {
      console.error("Could not process confirmation:", error instanceof Error ? error.name : "unknown");
      await telegram(env, chatId, "I could not process that request. Please try again shortly.");
    }
    return new Response("ok");
  }
  const startPreference = message.text.trim().match(/^\/start(?:@\w+)?\s+(.+)$/i);
  if (startPreference) {
    await handleNotificationPreference(env, chatId, "start", startPreference[1].trim());
    return new Response("ok");
  }
  const watchCommand = message.text.match(/^\/watch(?:@\w+)?\s+(.+)$/i);
  if (!allowedTelegramChatIds(env).has(chatId)) {
    try {
      const recipientKey = await notificationRecipientKey(env, chatId);
      const recipients = await getSeatWatcherFile(env, "notification-preferences.json", "recipients");
      if (!Object.hasOwn(recipients, recipientKey)) return new Response("ok");
      if (watchCommand) {
        await handleWatch(env, chatId, watchCommand[1].trim());

      } else {
        await telegram(env, chatId, "Use /watch Movie Name to add to your list.\nUse /list to see your movies and /state for your settings.\nUse /stop Movie Name to unfollow one movie, or /stop all to pause your alerts.\nUse /start all to resume them.");
      }
    } catch (error) {
      console.error("Could not process personal watch command:", error);
      await telegram(env, chatId, "I could not load your watch settings. Please try again shortly.");
    }
    return new Response("ok");
  }

  const watchShowtimeCommand = message.text.match(/^\/watchshowtime(?:@\w+)?\s+(.+)$/i);
  const watchSeatCommand = message.text.match(/^\/watchseat(?:@\w+)?\s+(.+)$/i);
  const stopShowtimeCommand = message.text.match(/^\/stopshowtime(?:@\w+)?\s+(.+)$/i);
  const stopSeatsCommand = message.text.match(/^\/stopseats(?:@\w+)?\s+(.+)$/i);
  const refreshSeatsCommand = message.text.match(/^\/refreshseats(?:@\w+)?\s+(.+)$/i);
  if (watchSeatCommand) {
    await handleWatchSeat(env, chatId, watchSeatCommand[1]);
  } else if (watchShowtimeCommand) {
    await handleWatchShowtime(env, chatId, watchShowtimeCommand[1]);
  } else if (stopShowtimeCommand) {
    await handleStopShowtime(env, chatId, stopShowtimeCommand[1]);
  } else if (stopSeatsCommand) {
    await handleStopSeats(env, chatId, stopSeatsCommand[1].trim());
  } else if (refreshSeatsCommand) {
    await handleRefreshSeats(env, chatId, refreshSeatsCommand[1].trim());
  } else if (watchCommand) {
    await handleWatch(env, chatId, watchCommand[1].trim());

  } else if (/^\/listseats(?:@\w+)?$/i.test(message.text)) {
    await handleSeatList(env, chatId);
  } else {
    const seatInfoCommand = message.text.match(/^\/seatinfo(?:@\w+)?\s+(.+)$/i);
    if (seatInfoCommand) {
      await handleSeatInfo(env, chatId, seatInfoCommand[1].trim());
    } else {
      await telegram(env, chatId, "Use /watch Movie Name\nUse /stopwatch Movie Name\nUse /watchseat CineplexPreviewUrl\nUse /watchshowtime Watch Name ShowtimeId\nUse /stopshowtime Watch Name ShowtimeId\nUse /stopseats Watch Name\nUse /refreshseats Watch Name\nUse /listseats and /seatinfo Watch Name for seat watches\nExample: /watchseat https://www.cineplex.com/ticketing/preview?theatreId=9406&showtimeId=405765\n\nUse /list to see your watched movies and /state for alert and reminder settings.");
    }
  }

  return new Response("ok");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/extension/watchseat" && request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "authorization, content-type" } });
    if ((url.pathname === "/api/queue" || url.pathname === "/api/scan" || url.pathname === "/api/verify" || url.pathname === "/api/seat-watches" || url.pathname.startsWith("/api/seat-watches/")) && request.method === "OPTIONS") {
      if (request.headers.get("Origin") !== env.UI_ORIGIN) return new Response("Forbidden", { status: 403 });
      return new Response(null, { status: 204, headers: queueCorsHeaders(env) });
    }
    if (url.pathname === "/api/queue" && request.method === "POST") return handleQueue(request, env);
    if (url.pathname === "/api/extension/watchseat" && request.method === "POST") return handleExtensionWatchSeat(request, env);
    if (url.pathname === "/api/queue" && request.method === "DELETE") return handleRemoveWatch(request, env);
    if (url.pathname === "/api/scan" && request.method === "POST") return handleScan(request, env);
    if (url.pathname === "/api/verify" && request.method === "POST") return handleVerifyUiToken(request, env);
    if (url.pathname === "/api/seat-watches" && request.method === "GET") return handleSeatWatchRead(request, env);
    if (url.pathname === "/api/seat-watches" && request.method === "POST") return handleSeatWatchMutation(request, env, "create");
    const layoutPath = /^\/api\/seat-watches\/([^/]+)\/showtimes\/(\d+)\/layout$/.exec(url.pathname);
    if (layoutPath && request.method === "GET") return handleSeatWatchLayout(request, env, decodeURIComponent(layoutPath[1]), layoutPath[2]);
    const showtimePath = /^\/api\/seat-watches\/([^/]+)\/showtimes\/(\d+)$/.exec(url.pathname);
    if (showtimePath && request.method === "DELETE") return handleSeatWatchMutation(request, env, "stop_showtime", decodeURIComponent(showtimePath[1]), { id: showtimePath[2] });
    if (url.pathname.startsWith("/api/seat-watches/")) {
      const watchId = decodeURIComponent(url.pathname.slice("/api/seat-watches/".length));
      if (request.method === "PATCH") return handleSeatWatchMutation(request, env, "edit", watchId);
      if (request.method === "DELETE") return handleSeatWatchMutation(request, env, "delete", watchId);
    }
    if (request.method === "POST" && url.pathname === "/telegram") return handleUpdate(request, env);
    return Response.json({ status: "ok", service: "Cineplex ticket watcher" });
  },
  async scheduled(event, env) {
    if (event.cron !== "*/5 * * * *") {
      console.log(JSON.stringify({ event: "legacy_cron_ignored" }));
      return;
    }
    const jobs = [["Weekly reminder", checkWeeklyReminder(env, event.scheduledTime)]];
    if (env.TICKET_SCHEDULER_ENABLED === "true") {
      jobs.push(["Ticket check", checkTickets(env, event.scheduledTime)]);
    }
    const results = await Promise.allSettled(jobs.map(([, job]) => job));
    const errors = results.flatMap((result, index) => {
      if (result.status === "fulfilled") return [];
      console.error(`${jobs[index][0]} scheduler failed; retrying at the next tick:`, result.reason);
      return [result.reason];
    });
    if (errors.length) throw errors[0];
  },
};
