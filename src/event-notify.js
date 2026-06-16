const { emit } = window.__TAURI__.event;
const { getCurrentWindow } = window.__TAURI__.window;

const params = new URLSearchParams(window.location.search);
const eventId = parseInt(params.get("id")) || 0;
const title = params.get("title") || "Reminder";
const mode = params.get("mode") || "fullscreen"; // "fullscreen" | "mini"
const scheduledAt = parseInt(params.get("at")) || 0;

if (mode === "mini") {
  document.body.classList.add("mini");
}

document.getElementById("event-title").textContent = decodeURIComponent(title).replace(/\+/g, " ");

if (scheduledAt) {
  const d = new Date(scheduledAt * 1000);
  let h = d.getHours();
  const min = String(d.getMinutes()).padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  document.getElementById("event-time").textContent = `Scheduled for ${h}:${min} ${ampm}`;
} else {
  document.getElementById("event-time").textContent = "";
}

// Self-position for mini popup (fallback when work area unknown)
if (mode === "mini" && params.get("selfpos") === "1") {
  (async () => {
    try {
      const { invoke } = window.__TAURI__.core;
      await invoke("plugin:positioner|move_window", { position: 3 });
      const win = getCurrentWindow();
      const pos = await win.outerPosition();
      const monitors = await window.__TAURI__.window.availableMonitors();
      let sf = 1;
      for (const m of monitors) {
        if (pos.x >= m.position.x && pos.x < m.position.x + m.size.width &&
            pos.y >= m.position.y && pos.y < m.position.y + m.size.height) {
          sf = m.scaleFactor;
          break;
        }
      }
      const marginPhys = Math.round(16 * sf);
      await win.setPosition(
        new window.__TAURI__.dpi.PhysicalPosition(pos.x - marginPhys, pos.y - marginPhys)
      );
    } catch (e) {
      console.warn("Positioner failed:", e);
    }
    await getCurrentWindow().show();
  })();
}

// Drag mini popup
if (mode === "mini") {
  document.getElementById("event-container").addEventListener("mousedown", (e) => {
    if (e.target.closest("button")) return;
    getCurrentWindow().startDragging();
  });
}

let acted = false;
document.getElementById("btn-ok").addEventListener("click", async () => {
  if (acted) return;
  acted = true;
  await emit("event-dismiss", { id: eventId });
});

document.getElementById("btn-snooze").addEventListener("click", async () => {
  if (acted) return;
  acted = true;
  await emit("event-snooze", { id: eventId });
});
