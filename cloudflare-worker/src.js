const CINEPLEX_SITEMAP = "https://www.cineplex.com/dynamic-sitemap.xml";
const CINEPLEX_USER_AGENT = "CineplexTicketWatcher/2.0 (personal ticket availability monitor)";

function normalise(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function telegram(env, chatId, text) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });

  if (!response.ok) {
    throw new Error(`Telegram sendMessage failed: ${await response.text()}`);
  }
}

function findMovieDetails(value) {
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findMovieDetails(child);
      if (found) return found;
    }
    return null;
  }

  if (value && typeof value === "object") {
    if ("hasShowtimes" in value && ("releaseDate" in value || "title" in value)) return value;
    for (const child of Object.values(value)) {
      const found = findMovieDetails(child);
      if (found) return found;
    }
  }
  return null;
}

async function getMovie(url) {
  const response = await fetch(url, { headers: { "user-agent": CINEPLEX_USER_AGENT } });
  if (!response.ok) throw new Error(`Cineplex returned HTTP ${response.status}`);

  const page = await response.text();
  const match = page.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) throw new Error("Cineplex page did not contain movie data");

  const details = findMovieDetails(JSON.parse(match[1]));
  if (!details) throw new Error("Cineplex page did not contain ticket status");

  return {
    name: details.title || details.movieTitle || url.split("/").pop(),
    releaseDate: details.releaseDate || null,
    hasShowtimes: Boolean(details.hasShowtimes),
    url,
  };
}

async function findMovieByTitle(title) {
  const query = normalise(title);
  if (!query) return { error: "Please provide a movie name. Example: /watch Runner" };

  const response = await fetch(CINEPLEX_SITEMAP, { headers: { "user-agent": CINEPLEX_USER_AGENT } });
  if (!response.ok) throw new Error(`Cineplex sitemap returned HTTP ${response.status}`);

  const urls = [...(await response.text()).matchAll(/<loc>(.*?)<\/loc>/g)]
    .map((match) => match[1])
    .filter((url) => url.includes("/movie/"));
  const candidates = urls.filter((url) => normalise(decodeURIComponent(url.split("/").pop())).includes(query)).slice(0, 12);

  if (!candidates.length) return { error: `I could not find a Cineplex movie matching “${title}”.` };

  const details = (await Promise.all(candidates.map(async (url) => {
    try { return await getMovie(url); } catch { return null; }
  }))).filter(Boolean);

  const exact = details.find((movie) => normalise(movie.name) === query);
  if (exact) return { movie: exact };

  const matches = details.filter((movie) => normalise(movie.name).includes(query));
  if (matches.length === 1) return { movie: matches[0] };
  if (matches.length > 1) {
    return { error: `I found several matches. Send a more specific title:\n${matches.map((movie) => `• ${movie.name}`).join("\n")}` };
  }
  return { error: `I could not confirm a Cineplex movie matching “${title}”.` };
}

async function getWatches(env) {
  return JSON.parse((await env.WATCHES.get("watches")) || "{}");
}

async function saveWatches(env, watches) {
  await env.WATCHES.put("watches", JSON.stringify(watches));
}

async function handleWatch(env, chatId, title) {
  const result = await findMovieByTitle(title);
  if (result.error) return telegram(env, chatId, result.error);

  const movie = result.movie;
  if (movie.hasShowtimes) {
    return telegram(env, chatId, `Tickets are already on sale for ${movie.name}.\n${movie.url}`);
  }

  const watches = await getWatches(env);
  watches[movie.url] = { ...movie, alerted: false };
  await saveWatches(env, watches);
  return telegram(env, chatId, `Started watching ${movie.name}.\nNext check: within 30 minutes.\n${movie.url}`);
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
    const watches = Object.values(await getWatches(env));
    await telegram(env, chatId, watches.length ? `Watching:\n${watches.map((movie) => `• ${movie.name}`).join("\n")}` : "You are not watching any movies.");
  } else {
    await telegram(env, chatId, "Use /watch Movie Name\nExample: /watch Runner\n\nUse /list to see your watched movies.");
  }

  return new Response("ok");
}

async function checkWatches(env) {
  const watches = await getWatches(env);
  let changed = false;

  for (const watch of Object.values(watches)) {
    if (watch.alerted) continue;
    try {
      const current = await getMovie(watch.url);
      watches[watch.url] = { ...watch, ...current };
      if (current.hasShowtimes) {
        await telegram(env, env.ADMIN_CHAT_ID, `Tickets are now on sale!\n\n${current.name}\n${current.url}`);
        watches[watch.url].alerted = true;
      }
      changed = true;
    } catch (error) {
      console.error(`Could not check ${watch.url}:`, error);
    }
  }

  if (changed) await saveWatches(env, watches);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/telegram") return handleUpdate(request, env);
    return Response.json({ status: "ok", service: "Cineplex ticket watcher" });
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(checkWatches(env));
  },
};
