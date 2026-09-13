const WORKER_URL = "https://cplex-watcher.cplexwatcher.workers.dev";
const UI_TOKEN_STORAGE_KEY = "UI_ACCESS_TOKEN";
const form = document.querySelector("#access-form");
const tokenInput = document.querySelector("#access-token");
const result = document.querySelector("#access-result");

async function verifyToken(token) {
  const response = await fetch(`${WORKER_URL}/api/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: "{}",
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Could not verify the access token.");
}

function openWatcher() {
  window.location.replace("./");
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const token = tokenInput.value.trim();
  if (!token) return;
  result.textContent = "Checking access token…";
  try {
    await verifyToken(token);
    localStorage.setItem(UI_TOKEN_STORAGE_KEY, token);
    openWatcher();
  } catch (error) {
    localStorage.removeItem(UI_TOKEN_STORAGE_KEY);
    result.textContent = error.message;
  }
});

const savedToken = localStorage.getItem(UI_TOKEN_STORAGE_KEY);
if (savedToken) {
  result.textContent = "Checking saved access token…";
  verifyToken(savedToken).then(openWatcher).catch(() => {
    localStorage.removeItem(UI_TOKEN_STORAGE_KEY);
    result.textContent = "Your saved access token is invalid. Enter the current token.";
    tokenInput.focus();
  });
} else {
  tokenInput.focus();
}
