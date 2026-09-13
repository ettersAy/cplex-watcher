const REPOSITORY_RAW_URL = "https://raw.githubusercontent.com/ettersAy/cplex-watcher/main";
const WORKER_URL = "https://cplex-watcher.cplexwatcher.workers.dev";
const tokenInput = document.querySelector("#ui-token");
const titlesInput = document.querySelector("#movie-titles");
const queueForm = document.querySelector("#queue-form");
const queueResult = document.querySelector("#queue-result");
const watchesElement = document.querySelector("#watches");
const loadStatus = document.querySelector("#load-status");

tokenInput.value = sessionStorage.getItem("cplex-watcher-ui-token") || "";

function movieKey(url) {
  return new URL(url).pathname.split("/").filter(Boolean).at(-1);
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not available";
  const twoDigits = (number) => String(number).padStart(2, "0");
  return `${twoDigits(date.getUTCFullYear() % 100)}-${twoDigits(date.getUTCMonth() + 1)}-${twoDigits(date.getUTCDate())} ${twoDigits(date.getUTCHours())}:${twoDigits(date.getUTCMinutes())}:${twoDigits(date.getUTCSeconds())}`;
}

function nextCheck() {
  const now = new Date();
  const next = new Date(now);
  next.setUTCSeconds(0, 0);
  next.setUTCMinutes(now.getUTCMinutes() < 30 ? 30 : 60);
  return Math.max(1, Math.ceil((next - now) / 60_000));
}

function watchCard(movie, state) {
  const check = state?.[movieKey(movie.url)];
  const failed = !check || check.lastCheckStatus === "failed" || Boolean(check.lastError);
  const salesStarted = !failed && check.hasShowtimes;
  const article = document.createElement("article");
  article.className = "watch";
  const summary = document.createElement("div");
  summary.className = "watch-summary";
  const icon = document.createElement("span");
  icon.className = "watch-icon";
  icon.textContent = failed ? "🔴" : (salesStarted ? "🎉" : "⏳");
  const link = document.createElement("a");
  link.href = movie.url;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = movie.name || check?.name || movieKey(movie.url).replace(/-/g, " ");
  const details = document.createElement("span");
  details.className = "watch-details";
  details.textContent = `${failed ? "Check failed" : (salesStarted ? "Sales started" : "Watching")} · 👁️ in ${nextCheck()} min · ${failed ? "❌" : "☀️"} Last check ${formatDate(check?.lastCheckedAt)}`;
  if (check?.lastError) {
    const error = document.createElement("span");
    error.className = "watch-error";
    error.textContent = ` · 📢 ${check.lastError}`;
    details.append(error);
  }
  const stopButton = document.createElement("button");
  stopButton.type = "button";
  stopButton.className = "stop";
  stopButton.textContent = "Stop watching";
  stopButton.addEventListener("click", async () => {
    const token = tokenInput.value.trim();
    if (!token) {
      queueResult.textContent = "Enter your UI access token before stopping a watch.";
      tokenInput.focus();
      return;
    }
    sessionStorage.setItem("cplex-watcher-ui-token", token);
    stopButton.disabled = true;
    queueResult.textContent = "Submitting stop-watching request…";
    try {
      const body = await queueRequest("DELETE", { url: movie.url }, token);
      queueResult.textContent = body.message;
    } catch (error) {
      queueResult.textContent = error.message;
      stopButton.disabled = false;
    }
  });
  summary.append(icon, link, details);
  article.append(summary, stopButton);
  return article;
}

async function queueRequest(method, payload, token) {
  const response = await fetch(`${WORKER_URL}/api/queue`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Could not submit the request.");
  return body;
}

async function loadWatches() {
  loadStatus.textContent = "Loading watches…";
  watchesElement.replaceChildren();
  try {
    const [moviesResponse, stateResponse] = await Promise.all([
      fetch(`${REPOSITORY_RAW_URL}/movies.json`, { cache: "no-store" }),
      fetch(`${REPOSITORY_RAW_URL}/state.json`, { cache: "no-store" }),
    ]);
    if (!moviesResponse.ok) throw new Error(`Could not load movies: HTTP ${moviesResponse.status}`);
    if (!stateResponse.ok) throw new Error(`Could not load check state: HTTP ${stateResponse.status}`);
    const movies = await moviesResponse.json();
    const state = await stateResponse.json();
    const uniqueMovies = [...new Map(movies.map((movie) => [movie.url, movie])).values()];
    if (!uniqueMovies.length) {
      loadStatus.textContent = "No movies are being watched.";
      return;
    }
    for (const movie of uniqueMovies) watchesElement.append(watchCard(movie, state.movies));
    loadStatus.textContent = `${uniqueMovies.length} active ${uniqueMovies.length === 1 ? "watch" : "watches"}.`;
  } catch (error) {
    loadStatus.textContent = error.message;
  }
}

queueForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const titles = titlesInput.value.trim();
  const token = tokenInput.value.trim();
  if (!titles || !token) return;
  sessionStorage.setItem("cplex-watcher-ui-token", token);
  queueResult.textContent = "Submitting searches…";
  try {
    const body = await queueRequest("POST", { titles }, token);
    queueResult.textContent = `${body.message} Telegram will notify you of the result.`;
    titlesInput.value = "";
  } catch (error) {
    queueResult.textContent = error.message;
  }
});

document.querySelector("#refresh").addEventListener("click", loadWatches);
loadWatches();
