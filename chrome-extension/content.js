const validPreview = () => { const url = new URL(location.href); return /^\d+$/.test(url.searchParams.get("theatreId") || "") && /^\d+$/.test(url.searchParams.get("showtimeId") || ""); };

if (validPreview() && !document.querySelector("#cplex-seat-watcher-prompt")) {
  const box = document.createElement("aside");
  box.id = "cplex-seat-watcher-prompt";
  box.innerHTML = '<strong>🎟 Seat watcher</strong><span>Add this Cineplex showtime to your seat watcher?</span><div><button type="button" data-action="add">Add showtime</button><button type="button" data-action="dismiss">Not now</button></div><p></p>';
  const status = box.querySelector("p");
  box.addEventListener("click", async (event) => {
    const action = event.target.dataset.action;
    if (action === "dismiss") { box.remove(); return; }
    if (action !== "add") return;
    event.target.disabled = true; status.textContent = "Adding…";
    const result = await chrome.runtime.sendMessage({ type: "watch-preview", url: location.href });
    status.textContent = result.error || result.message || "Request sent.";
  });
  document.documentElement.append(box);
}
