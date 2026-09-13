const REPOSITORY_RAW_URL = "https://raw.githubusercontent.com/ettersAy/cplex-watcher/main";
const WORKER_URL = "https://cplex-watcher.cplexwatcher.workers.dev";
const UI_TOKEN_STORAGE_KEY = "UI_ACCESS_TOKEN";

const app = document.querySelector("#app");
const titlesInput = document.querySelector("#movie-titles");
const queueForm = document.querySelector("#queue-form");
const queueResult = document.querySelector("#queue-result");
const watchesElement = document.querySelector("#watches");
const loadStatus = document.querySelector("#load-status");
const scanButton = document.querySelector("#scan");
const scanResult = document.querySelector("#scan-result");
let currentMovies = [];
let currentSalesStarted = [];
let currentState = {};
const scanResults = new Map();

function movieKey(url) {
  return new URL(url).pathname.split("/").filter(Boolean).at(-1);
}

function getToken() {
  return localStorage.getItem(UI_TOKEN_STORAGE_KEY) || "";
}

function showApp() {
  app.hidden = false;
}

function redirectToLogin() {
  window.location.replace("./login.html");
}

function formatDate(value) {
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

function nextCheck() {
  const now = new Date();
  const next = new Date(now);
  next.setUTCSeconds(0, 0);
  next.setUTCMinutes(now.getUTCMinutes() < 30 ? 30 : 60);
  return Math.max(1, Math.ceil((next - now) / 60_000));
}

async function authenticatedRequest(path, method, payload, token = getToken()) {
  const response = await fetch(`${WORKER_URL}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok) {
    if (response.status === 401) {
      localStorage.removeItem(UI_TOKEN_STORAGE_KEY);
      redirectToLogin();
    }
    throw new Error(body.error || "Could not submit the request.");
  }
  return body;
}

function verifyToken(token) {
  return authenticatedRequest("/api/verify", "POST", {}, token);
}

function watchCard(movie, { salesStarted = false } = {}) {
  const check = scanResults.get(movie.url) || currentState?.[movieKey(movie.url)];
  const failed = !salesStarted && (!check || check.lastCheckStatus === "failed" || Boolean(check.lastError));
  const saleDetected = salesStarted || (!failed && check?.hasShowtimes);
  const article = document.createElement("article");
  article.className = "watch";
  const summary = document.createElement("div");
  summary.className = "watch-summary";
  const icon = document.createElement("span");
  icon.className = "watch-icon";
  icon.textContent = failed ? "🔴" : (saleDetected ? "🎉" : "⏳");
  const link = document.createElement("a");
  link.href = movie.url;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = movie.name || check?.name || movieKey(movie.url).replace(/-/g, " ");
  const details = document.createElement("span");
  details.className = "watch-details";
  details.textContent = `${saleDetected ? "Sales started" : (failed ? "Check failed" : "Watching")} · ${salesStarted ? "" : `👁️ in ${nextCheck()} min · `}${failed ? "❌" : "☀️"} Last check ${formatDate(check?.lastCheckedAt || movie.salesStartedAt)}`;
  if (check?.lastError && !salesStarted) {
    const error = document.createElement("span");
    error.className = "watch-error";
    error.textContent = ` · 📢 ${check.lastError}`;
    details.append(error);
  }
  summary.append(icon, link, details);
  article.append(summary);

  if (!salesStarted) {
    const stopButton = document.createElement("button");
    stopButton.type = "button";
    stopButton.className = "stop";
    stopButton.textContent = "Stop watching";
    stopButton.addEventListener("click", async () => {
      stopButton.disabled = true;
      queueResult.textContent = "Stopping watch…";
      try {
        const body = await authenticatedRequest("/api/queue", "DELETE", { url: movie.url });
        queueResult.textContent = `${body.message} Waiting for GitHub Actions to update the list…`;
        const removed = await waitForRemoval(movie.url);
        queueResult.textContent = removed ? "Stopped watching. The list is up to date." : "Stop request accepted. Refresh in a moment if the item is still shown.";
      } catch (error) {
        queueResult.textContent = error.message;
        stopButton.disabled = false;
      }
    });
    article.append(stopButton);
  }
  return article;
}

function appendWatchSection(title, movies, options) {
  const heading = document.createElement("h3");
  heading.className = "watch-section-heading";
  heading.textContent = title;
  watchesElement.append(heading);
  if (!movies.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = options.salesStarted ? "No ticket sales have started yet." : "No movies are currently being watched.";
    watchesElement.append(empty);
    return;
  }
  for (const movie of movies) watchesElement.append(watchCard(movie, options));
}

function renderWatches() {
  watchesElement.replaceChildren();
  appendWatchSection("🎉 Sales started", currentSalesStarted, { salesStarted: true });
  appendWatchSection("⏳ Watching", currentMovies, { salesStarted: false });
}

async function loadRepositoryFile(path) {
  const response = await fetch(`${REPOSITORY_RAW_URL}/${path}?v=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Could not load ${path}: HTTP ${response.status}`);
  return response.json();
}

async function loadWatches() {
  loadStatus.textContent = "Loading watches…";
  watchesElement.replaceChildren();
  try {
    const [movies, state, salesStarted] = await Promise.all([
      loadRepositoryFile("movies.json"),
      loadRepositoryFile("state.json"),
      loadRepositoryFile("sales-started.json"),
    ]);
    currentMovies = [...new Map(movies.map((movie) => [movie.url, movie])).values()];
    currentSalesStarted = [...new Map(salesStarted.map((movie) => [movie.url, movie])).values()];
    currentState = state.movies;
    renderWatches();
    loadStatus.textContent = `${currentSalesStarted.length} sale${currentSalesStarted.length === 1 ? "" : "s"} started · ${currentMovies.length} active ${currentMovies.length === 1 ? "watch" : "watches"}.`;
  } catch (error) {
    loadStatus.textContent = error.message;
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function waitForRemoval(url) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await wait(3_000);
    await loadWatches();
    if (!currentMovies.some((movie) => movie.url === url)) return true;
  }
  return false;
}

queueForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const titles = titlesInput.value.trim();
  if (!titles) return;
  queueResult.textContent = "Submitting searches…";
  try {
    const body = await authenticatedRequest("/api/queue", "POST", { titles });
    queueResult.textContent = `${body.message} Telegram will notify you of the result.`;
    titlesInput.value = "";
  } catch (error) {
    queueResult.textContent = error.message;
  }
});

scanButton.addEventListener("click", async () => {
  if (!currentMovies.length) {
    scanResult.textContent = "There are no active watches to scan.";
    return;
  }
  scanButton.disabled = true;
  let failures = 0;
  for (let index = 0; index < currentMovies.length; index += 1) {
    const movie = currentMovies[index];
    scanResult.textContent = `Scanning ${index + 1}/${currentMovies.length}: ${movie.name || movieKey(movie.url)}…`;
    try {
      const result = await authenticatedRequest("/api/scan", "POST", { url: movie.url });
      scanResults.set(movie.url, result.movie);
    } catch (error) {
      failures += 1;
      scanResults.set(movie.url, {
        ...currentState?.[movieKey(movie.url)],
        url: movie.url,
        lastCheckedAt: new Date().toISOString(),
        lastCheckStatus: "failed",
        lastError: error.message,
      });
    }
    renderWatches();
    if (index < currentMovies.length - 1) await wait(5_000);
  }
  scanResult.textContent = failures ? `Scan finished with ${failures} failed ${failures === 1 ? "check" : "checks"}. Results are shown only in this page session.` : "Scan finished. Results are shown only in this page session.";
  scanButton.disabled = false;
});

document.querySelector("#refresh").addEventListener("click", loadWatches);

const savedToken = getToken();
if (savedToken) {
  verifyToken(savedToken).then(() => {
    showApp();
    return loadWatches();
  }).catch(redirectToLogin);
} else {
  redirectToLogin();
}
