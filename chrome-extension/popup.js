const token = document.querySelector("#token"), status = document.querySelector("#status");
chrome.storage.local.get("uiAccessToken").then(({ uiAccessToken = "" }) => { token.value = uiAccessToken; });
document.querySelector("#save").onclick = async () => { const value = token.value.trim(); if (!value) { status.textContent = "Enter a token first."; return; } await chrome.storage.local.set({ uiAccessToken: value }); status.textContent = "Saved in this Chrome profile."; };
document.querySelector("#clear").onclick = async () => { await chrome.storage.local.remove("uiAccessToken"); token.value = ""; status.textContent = "Token cleared."; };
