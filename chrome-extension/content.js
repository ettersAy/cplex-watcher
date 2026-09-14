const validPreview = () => { const url = new URL(location.href); return /^\d+$/.test(url.searchParams.get("theatreId") || "") && /^\d+$/.test(url.searchParams.get("showtimeId") || ""); };

if (validPreview() && !document.querySelector("#cplex-seat-watcher-prompt")) {
  const host = document.createElement("aside");
  host.id = "cplex-seat-watcher-prompt";
  host.style.cssText = "all:initial;bottom:20px;display:block;position:fixed;right:20px;z-index:2147483647";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>:host{all:initial}#box{background:#fff;border:1px solid #cbd8cf;border-radius:14px;box-shadow:0 14px 42px #0008;color:#17211d;display:grid;font:14px/1.4 system-ui,sans-serif;gap:9px;padding:15px;width:min(330px,calc(100vw - 40px))}strong{font-size:16px}span{color:#52695a}div{display:flex;gap:8px}button{appearance:none;border:0;border-radius:8px;cursor:pointer;font:700 14px system-ui,sans-serif;padding:10px 12px}button[data-action=add]{background:#1f7146;color:#fff}button[data-action=dismiss]{background:#edf1ee;color:#28342d}button:disabled{cursor:wait;opacity:.65}p{color:#52695a;font:12px/1.4 system-ui,sans-serif;margin:0;min-height:17px}</style><section id="box"><strong>🎟 Seat watcher</strong><span>Add this showtime to your seat watcher?</span><div><button type="button" data-action="add">Add showtime</button><button type="button" data-action="dismiss">Not now</button></div><p></p></section>`;
  const status = root.querySelector("p");
  root.addEventListener("click", async (event) => {
    const action = event.target.dataset?.action;
    if (action === "dismiss") { host.remove(); return; }
    if (action !== "add") return;
    event.target.disabled = true; status.textContent = "Adding…";
    const result = await chrome.runtime.sendMessage({ type: "watch-preview", url: location.href });
    status.textContent = result.error || result.message || "Request sent.";
  });
  document.body.append(host);
}
