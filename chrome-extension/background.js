const WORKER = "https://cplex-watcher.cplexwatcher.workers.dev";

async function addPreview(url) {
  const { uiAccessToken = "" } = await chrome.storage.local.get("uiAccessToken");
  if (!uiAccessToken) return { error: "Enter your access token in the extension first." };
  const response = await fetch(`${WORKER}/api/extension/watchseat`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${uiAccessToken}` }, body: JSON.stringify({ url }) });
  const value = await response.json().catch(() => ({}));
  return response.ok ? value : { error: value.error || "Could not contact the seat watcher." };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "watch-preview" || typeof message.url !== "string") return;
  addPreview(message.url).then(sendResponse).catch((error) => sendResponse({ error: error.message }));
  return true;
});
