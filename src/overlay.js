const { invoke } = window.__TAURI__.core;
const { emit } = window.__TAURI__.event;

// Load custom overlay text
invoke("get_settings").then(settings => {
  document.getElementById("overlay-title").textContent = settings.overlay_title;
  document.getElementById("overlay-subtitle").textContent = settings.overlay_subtitle;
});

let acted = false;

document.getElementById("btn-snooze").addEventListener("click", async () => {
  if (acted) return;
  acted = true;
  await invoke("snooze", { minutes: 30 });
  await emit("close-overlay");
});

document.getElementById("btn-stop").addEventListener("click", async () => {
  if (acted) return;
  acted = true;
  await invoke("stop_for_today");
  await emit("close-overlay");
});
