const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { WebviewWindow } = window.__TAURI__.webviewWindow;

const $ = (sel) => document.querySelector(sel);

function formatTime(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
}

let currentState = null;

async function refreshState() {
  try {
    currentState = await invoke("get_state");
    render();
  } catch (e) {
    console.error("get_state error:", e);
  }
}

function render() {
  if (!currentState) return;

  const { elapsed_secs, limit_mins, status, snooze_until } = currentState;
  const limit_secs = limit_mins * 60;
  const pct = Math.min((elapsed_secs / limit_secs) * 100, 100);

  // Elapsed time - big
  $("#elapsed").textContent = formatTime(elapsed_secs);

  // Limit - smaller, below (no seconds)
  const lh = Math.floor(limit_secs / 3600);
  const lm = Math.floor((limit_secs % 3600) / 60);
  $("#limit-text").textContent = `${lh}h ${String(lm).padStart(2, "0")}m`;

  // Progress bar
  const progressEl = $("#progress");
  progressEl.style.width = pct + "%";
  progressEl.classList.toggle("over-limit", elapsed_secs >= limit_secs);

  // Show snooze button when at/past limit or limit_reached or snoozed
  const pastLimit = elapsed_secs >= limit_secs;
  $("#btn-snooze").hidden = !pastLimit && status !== "limit_reached" && status !== "snoozed";

  // Show/hide stop and resume based on status
  $("#btn-stop").hidden = status === "stopped";
  $("#btn-resume").hidden = status !== "stopped";

  // Snooze bar
  const snoozeBar = $("#snooze-bar");
  if (status === "snoozed" && snooze_until) {
    const now = Date.now() / 1000;
    const remaining = Math.max(0, Math.ceil(snooze_until - now));
    const started = currentState.snooze_started_at || snooze_until - 30 * 60;
    const total = snooze_until - started;
    const elapsed = total - remaining;
    const pct = total > 0 ? Math.min((elapsed / total) * 100, 100) : 0;

    snoozeBar.hidden = false;
    $("#snooze-progress").style.width = pct + "%";

    // Show snooze button during snooze to extend
    $("#btn-snooze").hidden = false;
  } else {
    snoozeBar.hidden = true;
  }

  // Status
  const statusEl = $("#status");
  statusEl.className = "status-text";
  if (status === "active") {
    statusEl.textContent = "Active";
    statusEl.classList.add("status-active");
  } else if (status === "snoozed") {
    const remainingSecs = snooze_until
      ? Math.max(0, snooze_until - Math.floor(Date.now() / 1000))
      : 0;
    const rh = Math.floor(remainingSecs / 3600);
    const rm = Math.floor((remainingSecs % 3600) / 60);
    const rs = remainingSecs % 60;
    let timeStr;
    if (rh > 0) {
      timeStr = `${rh}h ${String(rm).padStart(2, "0")}m ${String(rs).padStart(2, "0")}s`;
    } else if (rm > 0) {
      timeStr = `${rm}m ${String(rs).padStart(2, "0")}s`;
    } else {
      timeStr = `${rs}s`;
    }
    statusEl.textContent = `Snoozed (${timeStr} left)`;
    statusEl.classList.add("status-snoozed");
  } else if (status === "limit_reached") {
    statusEl.textContent = "Limit reached";
    statusEl.classList.add("status-stopped");
  } else if (status === "stopped") {
    statusEl.textContent = "Stopped — resumes tomorrow";
    statusEl.classList.add("status-stopped");
  }

  // Limit setting display
  const lH = Math.floor(limit_mins / 60);
  const lM = limit_mins % 60;
  $("#limit-display").textContent = lM > 0 ? `${lH}h ${String(lM).padStart(2, "0")}m` : `${lH}h 00m`;
}

// Limit controls — + and − buttons (snap to 30-min boundaries)
function snapUp(mins) {
  if (mins < 30) return 30;
  const next = Math.ceil((mins + 1) / 30) * 30;
  return Math.min(next, 1440);
}

function snapDown(mins) {
  if (mins <= 1) return 1;
  if (mins <= 30) return 1;
  const prev = Math.floor((mins - 1) / 30) * 30;
  return Math.max(prev, 1);
}

$("#limit-up").addEventListener("click", async () => {
  const state = await invoke("get_state");
  currentState = await invoke("set_limit", { minutes: snapUp(state.limit_mins) });
  render();
});

$("#limit-down").addEventListener("click", async () => {
  const state = await invoke("get_state");
  currentState = await invoke("set_limit", { minutes: snapDown(state.limit_mins) });
  render();
});

// Click on value text to edit directly
const limitDownBtn = $("#limit-down");
const limitUpBtn = $("#limit-up");
const limitDisplay = $("#limit-display");
const limitEdit = $("#limit-edit");
const limitInputH = $("#limit-input-h");
const limitInputM = $("#limit-input-m");
const limitTickBtn = $("#limit-tick");
const limitError = $("#limit-error");

function openLimitEdit() {
  if (!currentState) return;
  const h = Math.floor(currentState.limit_mins / 60);
  const m = currentState.limit_mins % 60;
  limitInputH.value = h;
  limitInputM.value = m;
  limitDisplay.hidden = true;
  limitEdit.hidden = false;
  limitDownBtn.hidden = true;
  limitUpBtn.hidden = true;
  limitTickBtn.hidden = false;
  limitError.hidden = true;
  $("#limit-value").classList.add("editing");
  limitInputH.focus();
  limitInputH.select();
}

function closeLimitEdit() {
  limitEdit.hidden = true;
  limitDisplay.hidden = false;
  limitDownBtn.hidden = false;
  limitUpBtn.hidden = false;
  limitTickBtn.hidden = true;
  limitError.hidden = true;
  $("#limit-value").classList.remove("editing");
}

function validateLimitEdit() {
  const h = parseInt(limitInputH.value);
  const m = parseInt(limitInputM.value);
  if (isNaN(h) || isNaN(m) || h < 0 || m < 0 || m > 59 || h * 60 + m < 1) {
    return false;
  }
  return true;
}

async function saveLimitEdit() {
  if (!validateLimitEdit()) {
    limitError.hidden = false;
    return;
  }
  const h = Math.max(0, parseInt(limitInputH.value) || 0);
  const m = Math.max(0, parseInt(limitInputM.value) || 0);
  const totalMins = Math.min(h * 60 + m, 1440);
  currentState = await invoke("set_limit", { minutes: totalMins });
  closeLimitEdit();
  render();
}

limitDisplay.addEventListener("click", () => {
  if (!limitEdit.hidden) return;
  openLimitEdit();
});

limitTickBtn.addEventListener("click", saveLimitEdit);

limitInputH.addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveLimitEdit();
  if (e.key === "Escape") closeLimitEdit();
});

limitInputM.addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveLimitEdit();
  if (e.key === "Escape") closeLimitEdit();
});

// Action buttons
$("#btn-snooze").addEventListener("click", async () => {
  currentState = await invoke("snooze", { minutes: 30 });
  render();
});

$("#btn-stop").addEventListener("click", async () => {
  currentState = await invoke("stop_for_today");
  render();
});

$("#btn-resume").addEventListener("click", async () => {
  currentState = await invoke("resume_tracking");
  render();
});

let overlayWindows = [];

async function openOverlay() {
  // Close existing overlays and wait
  for (const w of overlayWindows) {
    try { await w.close(); } catch {}
  }
  overlayWindows = [];

  // Brief pause to let OS clean up old windows
  await new Promise(r => setTimeout(r, 200));

  try {
    const monitors = await window.__TAURI__.window.availableMonitors();

    if (!monitors || monitors.length <= 1) {
      throw new Error("single monitor");
    }

    // Create fullscreen overlay on each monitor
    for (let i = 0; i < monitors.length; i++) {
      const pos = monitors[i].position;
      const w = new WebviewWindow(`overlay-${i}`, {
        url: "overlay.html",
        fullscreen: true,
        x: pos.x,
        y: pos.y,
        alwaysOnTop: true,
        decorations: false,
        skipTaskbar: true,
        backgroundColor: "#0f0f1a",
        title: "EnoughWork",
      });
      overlayWindows.push(w);
    }
  } catch (e) {
    console.error("Multi-monitor overlay failed:", e);
    const w = new WebviewWindow("overlay-0", {
      url: "overlay.html",
      fullscreen: true,
      alwaysOnTop: true,
      decorations: false,
      skipTaskbar: true,
      backgroundColor: "#0f0f1a",
      title: "EnoughWork",
    });
    overlayWindows.push(w);
  }
}

// Listen for show-overlay event from Rust
listen("show-overlay", openOverlay);

// ===== Settings =====
const settingsPage = $("#settings-page");
const gearBtn = $("#settings-gear");
const backBtn = $("#settings-back");
const autostartToggle = $("#setting-autostart");
const debugBarToggle = $("#setting-debug-bar");
const resetTimeInput = $("#setting-reset-time");
const overlayTitleInput = $("#setting-overlay-title");
const overlaySubtitleInput = $("#setting-overlay-subtitle");
const debugBar = $(".debug-bar");

let settingsLoaded = false;

async function loadSettings() {
  const settings = await invoke("get_settings");
  resetTimeInput.value = settings.reset_time || "00:00";
  overlayTitleInput.value = settings.overlay_title;
  overlaySubtitleInput.value = settings.overlay_subtitle;
  const autostart = await invoke("get_autostart");
  autostartToggle.checked = autostart;
  debugBarToggle.checked = !debugBar.hasAttribute("hidden");
  settingsLoaded = true;
}

gearBtn.addEventListener("click", async () => {
  settingsPage.hidden = false;
  if (!settingsLoaded) await loadSettings();
});

backBtn.addEventListener("click", () => {
  settingsPage.hidden = true;
  // Save on back
  invoke("save_settings", {
    overlayTitle: overlayTitleInput.value || "Enough Work!",
    overlaySubtitle: overlaySubtitleInput.value || "You've done enough for today. Time to step away.",
    resetTime: resetTimeInput.value || "00:00",
  });
});

autostartToggle.addEventListener("change", async () => {
  await invoke("toggle_autostart", { enable: autostartToggle.checked });
});

debugBarToggle.addEventListener("change", () => {
  debugBar.hidden = !debugBarToggle.checked;
});

// Listen for overlay-close event
listen("close-overlay", async () => {
  for (const w of overlayWindows) {
    try { await w.close(); } catch {}
  }
  overlayWindows = [];
  await refreshState();
});

// Debug: show overlay
$("#dbg-show-overlay").addEventListener("click", openOverlay);

// Debug: set elapsed to limit
$("#dbg-set-limit").addEventListener("click", async () => {
  const state = await invoke("get_state");
  await invoke("set_limit", { minutes: state.limit_mins }); // ensure limit is set
  // Set elapsed to equal limit by calling a special debug command
  await invoke("debug_set_elapsed", { secs: state.limit_mins * 60 });
  await refreshState();
});

// Debug: clear state
$("#dbg-clear").addEventListener("click", async () => {
  await invoke("debug_clear_state");
  await refreshState();
});

// Debug: set limit to 1 min
$("#dbg-1min").addEventListener("click", async () => {
  await invoke("set_limit", { minutes: 1 });
  await refreshState();
});

// Debug: 1 min snooze
$("#dbg-1min-snooze").addEventListener("click", async () => {
  currentState = await invoke("snooze", { minutes: 1 });
  render();
});

// Refresh every second
setInterval(refreshState, 1000);

// Initial load
window.addEventListener("DOMContentLoaded", async () => {
  await refreshState();
  const dev = await invoke("is_dev");
  if (dev) {
    const badge = document.createElement("div");
    badge.className = "dev-badge";
    badge.textContent = "DEV";
    document.body.appendChild(badge);
    debugBar.hidden = false;
  }
});
