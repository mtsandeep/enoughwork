import { listenForDayWelcome } from "./day-welcome-ui.js";
import { mountSnoozeControl } from "./snooze-control.js";

const { invoke } = window.__TAURI__.core;
const { emit } = window.__TAURI__.event;
const win = window.__TAURI__.window.getCurrentWindow();

listenForDayWelcome({ mini: true, variant: "notify" });

invoke("get_settings").then(settings => {
  const title = document.getElementById("notify-title");
  const subtitle = document.getElementById("notify-subtitle");
  if (title) title.textContent = settings.overlay_title;
  if (subtitle) subtitle.textContent = settings.overlay_subtitle;
});

const params = new URLSearchParams(window.location.search);
if (params.get("selfpos") === "1") {
  (async () => {
    try {
      await invoke("plugin:positioner|move_window", { position: 3 });
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
    await win.show();
  })();
}

document.querySelector(".notify-container")?.addEventListener("mousedown", (e) => {
  if (e.target.closest("button, .snooze-ctl")) return;
  window.__TAURI__.window.getCurrentWindow().startDragging();
});

let acted = false;
mountSnoozeControl(document.getElementById("snooze-slot"), {
  category: "limit",
  kind: "snooze",
  theme: "light",
  btnClass: "notify-btn notify-btn-snooze",
  showEdit: false, // no room for the popover in the mini popup
  onApply: async (m) => {
    if (acted) return;
    acted = true;
    await invoke("snooze", { minutes: m });
    await emit("close-overlay");
  },
});
document.getElementById("btn-stop")?.addEventListener("click", async () => {
  if (acted) return;
  acted = true;
  await invoke("stop_for_today");
  await emit("close-overlay");
});
