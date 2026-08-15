import { listenForDayWelcome } from "./day-welcome-ui.js";
import { mountSnoozeControl } from "./snooze-control.js";

const { invoke } = window.__TAURI__.core;
const { emit } = window.__TAURI__.event;

listenForDayWelcome({ mini: false, variant: "overlay" });

// Load custom overlay text
invoke("get_settings").then(settings => {
  const title = document.getElementById("overlay-title");
  const subtitle = document.getElementById("overlay-subtitle");
  if (title) title.textContent = settings.overlay_title;
  if (subtitle) subtitle.textContent = settings.overlay_subtitle;
});

let acted = false;

mountSnoozeControl(document.getElementById("snooze-slot"), {
  category: "limit",
  kind: "snooze",
  theme: "dark",
  btnClass: "overlay-btn overlay-btn-snooze",
  getEndsAtBase: () => Math.floor(Date.now() / 1000),
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
