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

async function getWatches(env) {
  return JSON.parse((await env.WATCHES.get("watches")) || "{}");
}

async function saveWatches(env, watches) {
  await env.WATCHES.put("watches", JSON.stringify(watches));
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
  const watches = await getWatches(env);
  watches[`pending:${requestId}`] = { title, status: "pending", requestedAt: new Date().toISOString() };
  await saveWatches(env, watches);

  try {
    await dispatchWatch(env, title, requestId);
  } catch (error) {
    delete watches[`pending:${requestId}`];
    await saveWatches(env, watches);
    console.error("Could not dispatch GitHub Actions watch:", error);
    return telegram(env, chatId, "I could not start the Cineplex search. Please try again shortly.");
  }

  return telegram(env, chatId, `Searching Cineplex for ${title}. I will reply when the watch is registered.`);
}

async function handleWatchResult(request, env) {
  if (request.headers.get("X-Watcher-Callback-Secret") !== env.WATCHER_CALLBACK_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  const result = await request.json();
  const pendingKey = `pending:${result.request_id}`;
  const watches = await getWatches(env);
  const pending = watches[pendingKey];
  if (!pending) return new Response("Unknown request", { status: 404 });

  if (result.status === "watching" && result.movie?.url) {
    delete watches[pendingKey];
    watches[result.movie.url] = { ...result.movie, alerted: false };
    await saveWatches(env, watches);
    await telegram(env, env.ADMIN_CHAT_ID, `Started watching ${result.movie.name}.\nNext check: within 30 minutes.\n${result.movie.url}`);
  } else if (result.status === "already_on_sale" && result.movie?.url) {
    delete watches[pendingKey];
    await saveWatches(env, watches);
    await telegram(env, env.ADMIN_CHAT_ID, `Tickets are already on sale for ${result.movie.name}.\n${result.movie.url}`);
  } else {
    watches[pendingKey] = { ...pending, status: "failed" };
    await saveWatches(env, watches);
    await telegram(env, env.ADMIN_CHAT_ID, result.error || `I could not find a Cineplex movie matching “${pending.title}”.`);
  }

  return new Response("ok");
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
    const descriptions = watches.map((movie) => {
      if (movie.status === "pending") return `• ${movie.title} (searching)`;
      if (movie.status === "failed") return `• ${movie.title} (search failed)`;
      return `• ${movie.name}`;
    });
    await telegram(env, chatId, descriptions.length ? `Watching:\n${descriptions.join("\n")}` : "You are not watching any movies.");
  } else {
    await telegram(env, chatId, "Use /watch Movie Name\nExample: /watch Runner\n\nUse /list to see your watched movies.");
  }

  return new Response("ok");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/telegram") return handleUpdate(request, env);
    if (request.method === "POST" && url.pathname === "/internal/watch-result") return handleWatchResult(request, env);
    return Response.json({ status: "ok", service: "Cineplex ticket watcher" });
  },
};
