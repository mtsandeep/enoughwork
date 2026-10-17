// Popout task sub-timer window. All state comes from the main window via
// task-tick events (same pattern as the break countdown); actions go back via
// task-action emits. No Rust calls from this window.

const { emit, listen } = window.__TAURI__.event;
const { getCurrentWindow } = window.__TAURI__.window;

// Follow the app theme: the pre-paint bootstrap already set the initial
// data-theme; theme.js broadcasts live changes so an open popout follows.
listen("app-theme", (event) => {
  document.documentElement.dataset.theme = event.payload;
});

const params = new URLSearchParams(window.location.search);
const taskId = parseInt(params.get("id")) || 0;

const titleEl = document.getElementById("task-title");
const timeEl = document.getElementById("task-time");
const stateEl = document.getElementById("task-state");
const fillEl = document.getElementById("task-fill");
const container = document.getElementById("task-popout");
const toggleBtn = document.getElementById("btn-toggle");
const icPause = document.getElementById("ic-pause");
const icPlay = document.getElementById("ic-play");

titleEl.textContent = decodeURIComponent(params.get("title") || "Task").replace(/\+/g, " ");

let lastState = "";
let lastFillPct = -1;

function formatClockTime(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function render({ id, title, state, remaining, total }) {
  if (id !== taskId) return; // another task's tick — ignore

  // Same-string writes still mutate the DOM — only write on change.
  if (title && titleEl.textContent !== title) titleEl.textContent = title;

  const done = state === "done";
  const stopped = state === "stopped";
  const paused = state === "paused";
  const live = state === "running" || paused;
  lastState = state;

  // Elapsed time counting up from 0 (the fill bar grows with it); stopped
  // holds the frozen position — the main window sends the frozen remaining.
  const elapsed = Math.max(0, total - remaining);
  const timeText = formatClockTime(elapsed);
  if (timeEl.textContent !== timeText) timeEl.textContent = timeText;
  timeEl.classList.toggle("has-hours", total >= 3600);
  timeEl.classList.toggle("paused", paused);

  // Sub-line: the task's total first, then the state; done replaces it with
  // a green checkmark.
  const ofTotal = `of ${formatClockTime(total)}`;
  const stateText = done
    ? "Done ✓"
    : paused
      ? `${ofTotal} · Paused`
      : stopped
        ? `${ofTotal} · Stopped`
        : ofTotal;
  if (stateEl.textContent !== stateText) stateEl.textContent = stateText;
  stateEl.classList.toggle("done", done);

  // Whole-percent steps only — per-second width writes dirty layout.
  const pct = total > 0 ? Math.min(100, Math.round((elapsed / total) * 100)) : 0;
  if (pct !== lastFillPct) {
    lastFillPct = pct;
    fillEl.style.width = `${pct}%`;
  }

  icPause.style.display = paused ? "none" : "";
  icPlay.style.display = paused ? "" : "none";
  toggleBtn.title = paused ? "Resume" : "Pause";
  // Buttons stay visible across states; inapplicable ones disable.
  toggleBtn.disabled = !live;
  document.getElementById("btn-stop").disabled = !live;
}

// Initial paint from URL params so the window is correct before the first tick.
const init = {
  id: taskId,
  title: null,
  state: params.get("state") || "running",
  remaining: parseInt(params.get("remaining")) || 0,
  total: parseInt(params.get("total")) || 0,
};
render(init);

listen("task-tick", (event) => render(event.payload));

// Actions — handled by the main window, which owns the task state.
toggleBtn.addEventListener("click", () => {
  emit("task-action", { id: taskId, action: lastState === "paused" ? "resume" : "pause" });
});
document.getElementById("btn-restart").addEventListener("click", () => {
  emit("task-action", { id: taskId, action: "restart" });
});
document.getElementById("btn-stop").addEventListener("click", () => {
  emit("task-action", { id: taskId, action: "stop" });
});
document.getElementById("btn-popin").addEventListener("click", async () => {
  await emit("task-action", { id: taskId, action: "popin" });
});

// Transparency toggle: pin the card opaque; the choice persists across
// popout sessions (shared localStorage with the main window).
const glassBtn = document.getElementById("btn-glass");
const glassKey = "taskPopoutSolid";
let solidGlass = localStorage.getItem(glassKey) === "1";

function applyGlass() {
  container.classList.toggle("no-glass", solidGlass);
  document.getElementById("ic-glass").style.display = solidGlass ? "none" : "";
  document.getElementById("ic-solid").style.display = solidGlass ? "" : "none";
  glassBtn.title = solidGlass ? "Enable transparency" : "Disable transparency";
}
applyGlass();

glassBtn.addEventListener("click", () => {
  solidGlass = !solidGlass;
  localStorage.setItem(glassKey, solidGlass ? "1" : "0");
  applyGlass();
  glassBtn.blur(); // keep :focus-within from pinning the drawer open
});

// A clicked button keeps focus, which would pin the drawer open via
// :focus-within — release it so the drawer follows the mouse out again.
document.querySelectorAll(".task-popout-btn").forEach((b) =>
  b.addEventListener("click", () => b.blur())
);

// Drag by clicking anywhere except the buttons
container.addEventListener("mousedown", (e) => {
  if (e.target.closest("button")) return;
  getCurrentWindow().startDragging();
});
