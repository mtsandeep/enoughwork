const { emit } = window.__TAURI__.event;

let acted = false;

// All state comes from the main window via events — no Rust calls needed
document.getElementById("btn-resume").addEventListener("click", async () => {
  if (acted) return;
  acted = true;
  await emit("break-action", { action: "resume" });
});

document.getElementById("btn-extend").addEventListener("click", async () => {
  if (acted) return; // prevent spam
  acted = true;
  await emit("break-action", { action: "extend" });
  // Re-allow after a beat so extend can be pressed again
  setTimeout(() => { acted = false; }, 500);
});

// Listen for tick updates from main window
const CIRCUMFERENCE = 2 * Math.PI * 88;
const ringFill = document.getElementById("break-ring-fill");
const timeEl = document.getElementById("break-time");
const subtitleEl = document.getElementById("break-subtitle");
const container = document.querySelector(".break-overlay-container");

ringFill.style.strokeDasharray = CIRCUMFERENCE;
ringFill.style.strokeDashoffset = 0;

function renderTick({ remaining, total, elapsed_secs, ended }) {
  const elapsed = total - remaining;
  const pct = total > 0 ? Math.min(elapsed / total, 1) : 0;
  ringFill.style.strokeDashoffset = CIRCUMFERENCE * pct;

  if (ended) {
    timeEl.textContent = "Break's over!";
    container.classList.add("break-ended");
    acted = false;
  } else {
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    timeEl.textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    container.classList.remove("break-ended");
  }

  const h = Math.floor(elapsed_secs / 3600);
  const m = Math.floor((elapsed_secs % 3600) / 60);
  subtitleEl.textContent = `Work time: ${h}h ${String(m).padStart(2, "0")}m`;
}

// Set initial display from URL params so the overlay shows correct time immediately
const params = new URLSearchParams(window.location.search);
const initRemaining = parseInt(params.get("remaining")) || 0;
const initTotal = parseInt(params.get("total")) || 0;
const initElapsedSecs = parseInt(params.get("elapsed_secs")) || 0;
if (initTotal > 0) {
  renderTick({ remaining: initRemaining, total: initTotal, elapsed_secs: initElapsedSecs, ended: initRemaining <= 0 });
}

const { listen } = window.__TAURI__.event;

listen("break-tick", (event) => {
  renderTick(event.payload);
});

listen("break-close", async () => {
  const { getCurrentWindow } = window.__TAURI__.window;
  const win = getCurrentWindow();
  await win.close();
});
