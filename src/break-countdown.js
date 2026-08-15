import { listenForDayWelcome } from "./day-welcome-ui.js";
import { mountSnoozeControl } from "./snooze-control.js";

const { emit, listen } = window.__TAURI__.event;

listenForDayWelcome({ mini: false, variant: "overlay" });

let acted = false;

// All state comes from the main window via events — no Rust calls needed
document.getElementById("btn-resume").addEventListener("click", async () => {
  if (acted) return;
  acted = true;
  await emit("break-action", { action: "resume" });
});

let lastRemaining = 0;
let lastTotal = 0;
const breakCtl = mountSnoozeControl(document.getElementById("snooze-slot"), {
  kind: "break-adjust",
  theme: "dark",
  btnClass: "break-overlay-btn break-overlay-extend",
  applyLabel: "Update Break",
  fixedPrimaryMins: 5,
  popoverDefaultMins: () => Math.ceil(lastTotal / 60),
  // The preview anchors on the break start: a staged total N ends at start + N.
  getEndsAtBase: () => {
    if (lastTotal <= 0 || lastRemaining <= 0) return 0;
    const elapsedSecs = lastTotal - lastRemaining;
    return Math.floor(Date.now() / 1000) - elapsedSecs;
  },
  onApply: (m, source) => {
    if (acted) return;
    acted = true;
    // Primary: +5 increment. Popover: set total duration.
    emit("break-action", {
      action: source === "apply" ? "set" : "adjust",
      minutes: m,
    });
    setTimeout(() => { acted = false; }, 100);
  },
});

// Listen for tick updates from main window
const CIRCUMFERENCE = 2 * Math.PI * 88;
const ringFill = document.getElementById("break-ring-fill");
const timeEl = document.getElementById("break-time");
const subtitleEl = document.getElementById("break-subtitle");
const titleEl = document.getElementById("break-title");
const superchargeEl = document.getElementById("break-supercharge");
const container = document.querySelector(".break-overlay-container");

ringFill.style.strokeDasharray = CIRCUMFERENCE;
ringFill.style.strokeDashoffset = 0;

function renderTick({ remaining, total, elapsed_secs, ended, over_secs }) {
  lastRemaining = remaining;
  lastTotal = total;
  const elapsed = total - remaining;
  const pct = total > 0 ? Math.min(elapsed / total, 1) : 0;
  ringFill.style.strokeDashoffset = CIRCUMFERENCE * pct;

  if (ended) {
    const os = over_secs || 0;
    const oh = Math.floor(os / 3600);
    const om = Math.floor((os % 3600) / 60);
    const osR = os % 60;
    if (oh > 0) {
      timeEl.textContent = `${oh}:${String(om).padStart(2, "0")}:${String(osR).padStart(2, "0")}`;
      timeEl.classList.add("has-hours");
    } else {
      timeEl.textContent = `${om}:${String(osR).padStart(2, "0")}`;
      timeEl.classList.remove("has-hours");
    }

    // Ring fills up in blocks of `total` duration, resets each block
    const blockPct = total > 0 ? (os % total) / total : 0;
    ringFill.style.strokeDashoffset = CIRCUMFERENCE * (1 - blockPct);

    // Supercharging message — only after 1 minute
    if (os >= 60) {
      const totalMin = Math.floor(os / 60);
      const sh = Math.floor(totalMin / 60);
      const sm = totalMin % 60;
      superchargeEl.textContent = sh > 0
        ? `+${sh}h ${String(sm).padStart(2, "0")}m Super Charging`
        : `+${totalMin}m Super Charging`;
      superchargeEl.style.visibility = "visible";
    }

    titleEl.textContent = "You're Recharged!";
    titleEl.style.visibility = "visible";
    container.classList.add("break-ended");
    acted = false;
  } else {
    const h = Math.floor(remaining / 3600);
    const m = Math.floor((remaining % 3600) / 60);
    const s = remaining % 60;
    if (h > 0) {
      timeEl.textContent = `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
      timeEl.classList.add("has-hours");
    } else {
      timeEl.textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
      timeEl.classList.remove("has-hours");
    }
    container.classList.remove("break-ended");
    titleEl.style.visibility = "hidden";
    superchargeEl.style.visibility = "hidden";
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
const initOverSecs = parseInt(params.get("over_secs")) || 0;
if (initTotal > 0) {
  renderTick({ remaining: initRemaining, total: initTotal, elapsed_secs: initElapsedSecs, ended: initRemaining <= 0, over_secs: initOverSecs });
}

listen("break-tick", (event) => {
  renderTick(event.payload);
});

listen("break-close", async () => {
  const { getCurrentWindow } = window.__TAURI__.window;
  const win = getCurrentWindow();
  await win.close();
});
