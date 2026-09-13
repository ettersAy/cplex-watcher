const REPOSITORY_RAW_URL = "https://raw.githubusercontent.com/ettersAy/cplex-watcher/main";
const WORKER_URL = "https://cplex-watcher.cplexwatcher.workers.dev";
const tokenInput = document.querySelector("#ui-token");
const titleInput = document.querySelector("#movie-title");
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
  const article = document.createElement("article");
  article.className = "watch";
  const link = document.createElement("a");
  link.href = movie.url;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = movie.name || check?.name || movieKey(movie.url).replace(/-/g, " ");
  const details = document.createElement("dl");
  const rows = [
    ["Status", failed ? "Failed" : "Success"],
    ["Sales", failed ? "Unable to determine" : (check.hasShowtimes ? "Started" : "Not Yet")],
    ["Next check", `in ${nextCheck()} min`],
    ["Last check", formatDate(check?.lastCheckedAt)],
  ];
  if (check?.lastError) rows.push(["Error", check.lastError]);
  for (const [label, value] of rows) {
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = value;
    details.append(term, description);
  }
  article.append(link, details);
  return article;
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
  const title = titleInput.value.trim();
  const token = tokenInput.value.trim();
  if (!title || !token) return;
  sessionStorage.setItem("cplex-watcher-ui-token", token);
  queueResult.textContent = "Submitting search…";
  try {
    const response = await fetch(`${WORKER_URL}/api/queue`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ title }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Could not queue the movie.");
    queueResult.textContent = `${body.message} Telegram will notify you of the result.`;
    titleInput.value = "";
  } catch (error) {
    queueResult.textContent = error.message;
  }
});

document.querySelector("#refresh").addEventListener("click", loadWatches);
loadWatches();
