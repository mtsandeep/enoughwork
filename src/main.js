import { computePosition, flip, shift, offset as floatingOffset } from "@floating-ui/dom";

const { invoke } = window.__TAURI__.core;
const { listen, emit } = window.__TAURI__.event;
const { WebviewWindow } = window.__TAURI__.webviewWindow;
const { getMainWorkArea, bottomRightPosition, getMonitors } = await import("./window-utils.js");

const $ = (sel) => document.querySelector(sel);

function formatTime(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
}

function localDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

let currentState = null;
let prevBreakStatus = false;

async function refreshState() {
  try {
    currentState = await invoke("get_state");
    render();
    updateHeatmapColors();
  } catch (e) {
    console.error("get_state error:", e);
  }
}

function render() {
  if (!currentState) return;

  const { elapsed_secs, limit_mins, status, snooze_until } = currentState;
  const limit_secs = limit_mins * 60;

  // Open/close break overlay on status change
  const isOnBreak = status === "on_break";
  if (isOnBreak && !prevBreakStatus) openBreakOverlay();
  if (!isOnBreak && prevBreakStatus) closeBreakOverlay();
  prevBreakStatus = isOnBreak;

  // Broadcast break-tick to overlay windows
  if (isOnBreak && currentState.break_until) {
    const now = Math.floor(Date.now() / 1000);
    const remaining = Math.max(0, currentState.break_until - now);
    const total = currentState.break_duration_secs || 0;
    emit("break-tick", {
      remaining,
      total,
      elapsed_secs: currentState.elapsed_secs || 0,
      ended: remaining <= 0,
    });
  }

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

  // Take Break button — only when active
  $("#btn-take-break").hidden = status !== "active";

  // Resume Work button — only when on break
  $("#btn-resume-break").hidden = status !== "on_break";

  // Stop/snooze hidden during break
  if (status === "on_break") {
    $("#btn-stop").hidden = true;
    $("#btn-snooze").hidden = true;
    $("#btn-resume").hidden = true;
  }

  // Break stats
  const breakStatsEl = $("#break-stats");
  if (currentState.break_count > 0 && status !== "on_break") {
    const bm = Math.floor(currentState.total_break_secs / 60);
    breakStatsEl.textContent = `Breaks today: ${currentState.break_count} (${bm}m total)`;
    breakStatsEl.hidden = false;
  } else {
    breakStatsEl.hidden = true;
  }

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
  } else if (status === "on_break") {
    statusEl.textContent = "On Break";
    statusEl.style.color = "#0d9488";
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

  // Quiet overlay icon
  const quietBtn = $("#btn-quiet-overlay");
  const isQuiet = currentState.quiet_overlay || false;
  quietBtn.classList.toggle("active", isQuiet);
  quietBtn.title = isQuiet ? "Mini Notification Enabled (today only)" : "Fullscreen Overlay Enabled";
  $("#quiet-icon-on").style.display = isQuiet ? "none" : "";
  $("#quiet-icon-off").style.display = isQuiet ? "" : "none";
}

// ===== Break Overlay Window =====
let breakOverlayWindows = [];
let breakOverlayId = 0;

function breakOverlayUrl() {
  if (!currentState || !currentState.break_until) return "src/break-countdown.html";
  const now = Math.floor(Date.now() / 1000);
  const remaining = Math.max(0, currentState.break_until - now);
  const total = currentState.break_duration_secs || 0;
  const elapsed_secs = currentState.elapsed_secs || 0;
  return `src/break-countdown.html?remaining=${remaining}&total=${total}&elapsed_secs=${elapsed_secs}`;
}

async function openBreakOverlay() {
  // Close any existing break overlay first
  await closeBreakOverlay();
  breakOverlayId++;
  const url = breakOverlayUrl();
  try {
    const monitors = await getMonitors();
    if (monitors && monitors.length > 1) {
      for (let i = 0; i < monitors.length; i++) {
        const pos = monitors[i].position;
        const label = `overlay-brk-${breakOverlayId}-${i}`;
        const w = new WebviewWindow(label, {
          url,
          fullscreen: true,
          x: pos.x,
          y: pos.y,
          alwaysOnTop: true,
          decorations: false,
          skipTaskbar: true,
          backgroundColor: "#0f0f1a",
          title: "EnoughWork",
        });
        breakOverlayWindows.push(w);
      }
    } else {
      const label = `overlay-brk-${breakOverlayId}`;
      const w = new WebviewWindow(label, {
        url,
        fullscreen: true,
        alwaysOnTop: true,
        decorations: false,
        skipTaskbar: true,
        backgroundColor: "#0f0f1a",
        title: "EnoughWork",
      });
      breakOverlayWindows.push(w);
    }
  } catch (e) {
    console.error("Break overlay failed:", e);
  }
}

async function closeBreakOverlay() {
  for (const w of breakOverlayWindows) {
    try { await w.close(); } catch {}
  }
  breakOverlayWindows = [];
}

// Listen for break actions from overlay windows
listen("break-action", async (event) => {
  const { action } = event.payload;
  if (action === "resume") {
    currentState = await invoke("resume_from_break");
    await closeBreakOverlay();
    render();
  } else if (action === "extend") {
    currentState = await invoke("extend_break", { addSecs: 300 });
    render();
  }
});

// ===== Heatmap =====
let historyCache = null;
let heatmapBuilt = false;

async function initHeatmap() {
  historyCache = await invoke("get_history");
  buildHeatmap();
}

function buildHeatmap() {
  const container = $("#heatmap");
  if (!container) return;
  const today = new Date();
  let html = "";
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = localDateKey(d);
    html += `<div class="heatmap-square" data-date="${key}" data-today="${i === 0 ? "1" : "0"}"></div>`;
  }
  container.innerHTML = html;
  heatmapBuilt = true;
  updateHeatmapColors();
}

function updateHeatmapColors() {
  if (!historyCache || !heatmapBuilt) return;
  const squares = document.querySelectorAll(".heatmap-square");
  squares.forEach((sq) => {
    const key = sq.dataset.date;
    const isToday = sq.dataset.today === "1";
    const record = isToday
      ? { active_secs: currentState?.active_secs || 0, break_secs: currentState?.total_break_secs || 0 }
      : (historyCache[key] || { active_secs: 0, break_secs: 0 });
    const secs = record.active_secs || 0;
    const breakSecs = record.break_secs || 0;
    const hours = secs / 3600;

    sq.className = "heatmap-square";
    sq.dataset.today = isToday ? "1" : "0";
    if (secs === 0) {
      // default gray
    } else if (hours <= 8.5) {
      sq.classList.add("heatmap-green");
    } else if (hours <= 11) {
      sq.classList.add("heatmap-orange");
    } else {
      sq.classList.add("heatmap-red");
    }

    const h = Math.floor(hours);
    const m = Math.floor((hours - h) * 60);
    sq.dataset.tooltipDate = key;
    sq.dataset.tooltipTime = secs > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : "";
    sq.dataset.tooltipBreak = breakSecs > 0 ? formatBreakMin(breakSecs) : "";
    sq.dataset.tooltipLabel = secs > 0 ? (isToday ? "Today" : "Worked") : "No data";
  });
}

function formatBreakMin(secs) {
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${String(rm).padStart(2, "0")}m` : `${h}h`;
}

// Heatmap tooltip
const heatmapEl = document.getElementById("heatmap");
const heatmapTooltip = document.getElementById("heatmap-tooltip");
if (heatmapEl && heatmapTooltip) {
  heatmapEl.addEventListener("mouseover", async (e) => {
    const sq = e.target.closest(".heatmap-square");
    if (!sq) return;
    const date = sq.dataset.tooltipDate;
    const time = sq.dataset.tooltipTime;
    const breakTime = sq.dataset.tooltipBreak;
    const label = sq.dataset.tooltipLabel;
    let html = `<div class="tt-date">${date}</div>`;
    if (time) {
      html += `<div class="tt-time">${time} work</div>`;
      if (breakTime) html += `<div class="tt-time" style="color:#0d9488">${breakTime} breaks</div>`;
    } else {
      html += `<div class="tt-label">${label}</div>`;
    }
    heatmapTooltip.innerHTML = html;
    heatmapTooltip.hidden = false;

    const { x, y } = await computePosition(sq, heatmapTooltip, {
      placement: "top",
      middleware: [floatingOffset(6), flip(), shift({ padding: 8 })],
    });
    heatmapTooltip.style.left = `${x}px`;
    heatmapTooltip.style.top = `${y}px`;
  });

  heatmapEl.addEventListener("mouseout", (e) => {
    if (!heatmapEl.contains(e.relatedTarget)) {
      heatmapTooltip.hidden = true;
    }
  });
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

// Click on limit-value row to edit directly
const limitDownBtn = $("#limit-down");
const limitUpBtn = $("#limit-up");
const limitValueRow = $("#limit-value");
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

limitValueRow.addEventListener("click", () => {
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

$("#btn-quiet-overlay").addEventListener("click", async () => {
  const newVal = !(currentState?.quiet_overlay || false);
  currentState = await invoke("set_quiet_overlay", { enabled: newVal });
  render();
});

// ===== Break Picker =====
let breakDurationMin = 15;
let breakDurationEditing = false;

async function openBreakPicker() {
  const suggestion = await invoke("suggest_break");
  breakDurationMin = suggestion.suggested_min;

  // Work info
  const wh = Math.floor(suggestion.work_min / 60);
  const wm = suggestion.work_min % 60;
  const workStr = wh > 0 ? `${wh}h ${String(wm).padStart(2, "0")}m` : `${wm}m`;
  $("#break-work-info").innerHTML = `You've been working for <strong>${workStr}</strong>`;

  updateBreakDurationDisplay();
  highlightQuickPick();
  closeBreakDurationEdit();
  $("#break-picker-page").hidden = false;
}

function updateBreakDurationDisplay() {
  const display = $("#break-duration-display");
  if (breakDurationMin >= 60 && breakDurationMin % 60 === 0) {
    display.textContent = `${breakDurationMin / 60}h`;
  } else {
    display.textContent = `${breakDurationMin}m`;
  }
  highlightQuickPick();
}

function highlightQuickPick() {
  document.querySelectorAll(".break-quick-btn").forEach(btn => {
    btn.classList.toggle("active", parseInt(btn.dataset.min) === breakDurationMin);
  });
}

function openBreakDurationEdit() {
  breakDurationEditing = true;
  const input = $("#break-input-m");
  input.value = breakDurationMin;
  $("#break-duration-display").hidden = true;
  $("#break-duration-edit").hidden = false;
  $("#break-duration-row").classList.add("editing");
  input.focus();
  input.select();
}

function closeBreakDurationEdit() {
  breakDurationEditing = false;
  $("#break-duration-display").hidden = false;
  $("#break-duration-edit").hidden = false;
  $("#break-duration-edit").hidden = true;
  $("#break-duration-row").classList.remove("editing");
}

// Take Break button
$("#btn-take-break").addEventListener("click", openBreakPicker);

// Resume Work from main screen during break
$("#btn-resume-break").addEventListener("click", async () => {
  currentState = await invoke("resume_from_break");
  await closeBreakOverlay();
  render();
});

// Close picker
$("#break-picker-close").addEventListener("click", () => {
  $("#break-picker-page").hidden = true;
  closeBreakDurationEdit();
});

// Click anywhere on the row to edit duration
$("#break-duration-row").addEventListener("click", () => {
  if (!breakDurationEditing) openBreakDurationEdit();
});

// Quick pick buttons
document.querySelectorAll(".break-quick-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    breakDurationMin = parseInt(btn.dataset.min);
    updateBreakDurationDisplay();
    closeBreakDurationEdit();
  });
});

// Duration edit: enter/escape
$("#break-input-m").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const val = parseInt(e.target.value);
    if (val > 0 && val <= 120) {
      breakDurationMin = val;
      updateBreakDurationDisplay();
      closeBreakDurationEdit();
    }
  }
  if (e.key === "Escape") {
    closeBreakDurationEdit();
  }
});

// Start Break
$("#btn-start-break").addEventListener("click", async () => {
  if (breakDurationEditing) {
    const val = parseInt($("#break-input-m").value);
    if (val > 0 && val <= 120) breakDurationMin = val;
    closeBreakDurationEdit();
  }
  $("#break-picker-page").hidden = true;
  currentState = await invoke("start_break", { durationSecs: breakDurationMin * 60 });
  render();
});

// ===== Overlay & Animation Windows =====
let overlayWindows = [];
let animWindow = null;
let notifyWindow = null;
let animSafetyTimeout = null;

async function closeAllOverlays() {
  for (const w of overlayWindows) {
    try { await w.close(); } catch {}
  }
  overlayWindows = [];
  if (animWindow) {
    try { await animWindow.close(); } catch {}
    animWindow = null;
  }
  if (notifyWindow) {
    try { await notifyWindow.close(); } catch {}
    notifyWindow = null;
  }
  for (const w of breakOverlayWindows) {
    try { await w.close(); } catch {}
  }
  breakOverlayWindows = [];
  if (animSafetyTimeout) {
    clearTimeout(animSafetyTimeout);
    animSafetyTimeout = null;
  }
}

async function openOverlay() {
  await closeAllOverlays();
  await new Promise(r => setTimeout(r, 100));

  const state = await invoke("get_state");

  if (state.quiet_overlay) {
    // Quiet: just one small popup, nothing else
    await openNotifyPopup();
    return;
  }

  // Default mode
  try {
    const settings = await invoke("get_settings");
    const forceFS = settings.force_fullscreen_overlay === true;
    const isFullscreen = await invoke("is_fullscreen_app_running");
    if (isFullscreen && !forceFS) {
      await openAnimatedNotification();
    } else {
      await openFullscreenOverlay();
    }
  } catch (e) {
    console.error("Overlay check failed, falling back to fullscreen:", e);
    await openFullscreenOverlay();
  }
}

async function openAnimatedNotification() {
  const settings = await invoke("get_settings");
  const animType = settings.animation_type || "star-drop";

  // Get the monitor the fullscreen app is on — must exist
  const monitor = await invoke("get_foreground_monitor");
  if (!monitor) return;

  // Show fullscreen overlay on other monitors
  await openFullscreenOverlayExcept(monitor);

  // No animation — just show notify immediately
  if (animType === "none") {
    await openNotifyPopup(monitor);
    return;
  }

  // Use fullscreen + position on the right monitor instead of explicit size
  // to avoid DPI mismatches
  animWindow = new WebviewWindow("anim-0", {
    url: `src/animation.html?type=${encodeURIComponent(animType)}`,
    fullscreen: true,
    x: monitor.x,
    y: monitor.y,
    transparent: true,
    decorations: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    title: "EnoughWork",
  });

  // Force above fullscreen apps
  try {
    await new Promise(r => setTimeout(r, 200));
    await animWindow.setAlwaysOnTop(true);
  } catch {}

  try {
    await new Promise(r => setTimeout(r, 300));
    await animWindow.setIgnoreCursorEvents(true);
  } catch {}

  // Safety timeout: close anim window after 5s if event doesn't fire
  animSafetyTimeout = setTimeout(async () => {
    if (animWindow) {
      try { await animWindow.close(); } catch {}
      animWindow = null;
    }
    await openNotifyPopup(monitor);
  }, 5000);

  const unlisten = await listen("animation-done", async () => {
    unlisten();
    if (animSafetyTimeout) {
      clearTimeout(animSafetyTimeout);
      animSafetyTimeout = null;
    }
    // Open notify immediately, close anim in parallel
    openNotifyPopup(monitor);
    if (animWindow) {
      try { await animWindow.close(); } catch {}
      animWindow = null;
    }
  });
}

async function openNotifyPopup(targetMonitor) {
  const popupW = 320;
  const popupH = 180;
  const margin = 16;

  let posX = 100, posY = 100;
  try {
    const workArea = targetMonitor || await getMainWorkArea();
    const pos = await bottomRightPosition(workArea, popupW, popupH, margin);
    posX = pos.x;
    posY = pos.y;
  } catch (_) {
    // fallback to default position
  }

  notifyWindow = new WebviewWindow("notify-0", {
    url: "src/notify.html",
    width: popupW,
    height: popupH,
    x: posX,
    y: posY,
    decorations: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    title: "EnoughWork",
  });
}

async function openFullscreenOverlay() {
  try {
    const monitors = await getMonitors();

    if (!monitors || monitors.length <= 1) {
      throw new Error("single monitor");
    }

    for (let i = 0; i < monitors.length; i++) {
      const pos = monitors[i].position;
      const w = new WebviewWindow(`overlay-${overlayWindows.length}`, {
        url: "src/overlay.html",
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

async function openFullscreenOverlayExcept(skipMonitor) {
  try {
    const monitors = await getMonitors();
    if (!monitors || monitors.length <= 1) return;

    for (let i = 0; i < monitors.length; i++) {
      const pos = monitors[i].position;
      // Skip the monitor where the fullscreen app is running
      if (skipMonitor && pos.x === skipMonitor.x && pos.y === skipMonitor.y) continue;

      const w = new WebviewWindow(`overlay-${overlayWindows.length}`, {
        url: "src/overlay.html",
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
    console.error("Multi-monitor overlay (except) failed:", e);
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
const animationTypeSelect = $("#setting-animation-type");
const forceFullscreenToggle = $("#setting-force-fullscreen");
const animationLabel = $("#animation-label");
const debugBar = $(".debug-bar");

let settingsLoaded = false;
let autostartChanged = false;
let settingsSnapshot = null;

async function loadSettings() {
  const settings = await invoke("get_settings");
  resetTimeInput.value = settings.reset_time || "00:00";
  overlayTitleInput.value = settings.overlay_title;
  overlaySubtitleInput.value = settings.overlay_subtitle;
  animationTypeSelect.value = settings.animation_type || "star-drop";
  const forceFS = settings.force_fullscreen_overlay === true;
  forceFullscreenToggle.checked = forceFS;
  const animField = $("#animation-field");
  animField.style.opacity = forceFS ? "0.35" : "";
  animationTypeSelect.disabled = forceFS;
  const autostart = await invoke("get_autostart");
  autostartToggle.checked = autostart;
  autostartChanged = false;
  debugBarToggle.checked = !debugBar.hasAttribute("hidden");
  settingsLoaded = true;
  // Snapshot for dirty check
  settingsSnapshot = {
    overlayTitle: overlayTitleInput.value,
    overlaySubtitle: overlaySubtitleInput.value,
    resetTime: resetTimeInput.value,
    forceFullscreenOverlay: forceFullscreenToggle.checked,
    animationType: animationTypeSelect.value,
  };
  // Version
  const version = await invoke("get_version");
  $("#settings-version").textContent = `v${version}`;
}

gearBtn.addEventListener("click", async () => {
  settingsPage.hidden = false;
  if (!settingsLoaded) {
    await loadSettings();
  } else {
    // Always re-fetch autostart from OS since it can change externally
    const autostart = await invoke("get_autostart");
    autostartToggle.checked = autostart;
    autostartChanged = false;
  }
});

function applyPendingSettings() {
  if (!settingsLoaded) return;
  // Only save if text settings actually changed
  const current = {
    overlayTitle: overlayTitleInput.value || "Enough Work!",
    overlaySubtitle: overlaySubtitleInput.value || "You've done enough for today. Time to step away.",
    resetTime: resetTimeInput.value || "00:00",
    forceFullscreenOverlay: forceFullscreenToggle.checked,
    animationType: animationTypeSelect.value || "star-drop",
  };
  if (settingsSnapshot && (
    current.overlayTitle !== settingsSnapshot.overlayTitle ||
    current.overlaySubtitle !== settingsSnapshot.overlaySubtitle ||
    current.resetTime !== settingsSnapshot.resetTime ||
    current.forceFullscreenOverlay !== settingsSnapshot.forceFullscreenOverlay ||
    current.animationType !== settingsSnapshot.animationType
  )) {
    invoke("save_settings", current);
    settingsSnapshot = { ...current };
  }
  // Apply autostart if changed
  if (autostartChanged) {
    invoke("toggle_autostart", { enable: autostartToggle.checked });
    autostartChanged = false;
  }
}

forceFullscreenToggle.addEventListener("change", () => {
  const fs = forceFullscreenToggle.checked;
  const animField = $("#animation-field");
  animField.style.opacity = fs ? "0.35" : "";
  animationTypeSelect.disabled = fs;
});

backBtn.addEventListener("click", () => {
  settingsPage.hidden = true;
  applyPendingSettings();
});

autostartToggle.addEventListener("change", () => {
  autostartChanged = true;
});

// Apply pending settings when window hides to tray
const mainWindow = window.__TAURI__.window.getCurrentWindow();
mainWindow.onCloseRequested(() => {
  applyPendingSettings();
});

debugBarToggle.addEventListener("change", () => {
  debugBar.hidden = !debugBarToggle.checked;
  document.getElementById("main-content").style.paddingBottom = debugBarToggle.checked ? "48px" : "";
});

// Listen for overlay-close event
listen("close-overlay", async () => {
  await closeAllOverlays();
  await refreshState();
});

// Debug: show overlay
$("#dbg-show-overlay").addEventListener("click", async () => {
  const fs = await invoke("is_fullscreen_app_running");
  const monitor = await invoke("get_foreground_monitor");
  if (fs) {
    await openAnimatedNotification();
  } else {
    await openFullscreenOverlay();
  }
});

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

// Debug: show animation overlay
$("#dbg-show-anim").addEventListener("click", async () => {
  const { WebviewWindow } = window.__TAURI__.webviewWindow;
  const animWin = new WebviewWindow("anim-preview", {
    url: "src/animation.html",
    fullscreen: false,
    width: 800,
    height: 500,
    x: 200,
    y: 200,
    transparent: true,
    decorations: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
  });
  setTimeout(async () => { try { await animWin.close(); } catch(_) {} }, 4000);
});

// Debug: 1 min break
$("#dbg-1min-break").addEventListener("click", async () => {
  currentState = await invoke("start_break", { durationSecs: 60 });
  render();
});

// Refresh every second
setInterval(refreshState, 1000);

// Initial load — script is at end of body, DOM is ready
(async () => {
  await refreshState();
  await initHeatmap();


  const dev = await invoke("is_dev");
  if (dev) {
    const badge = document.createElement("div");
    badge.className = "dev-badge";
    badge.textContent = "DEV";
    document.body.appendChild(badge);
    debugBar.hidden = false;
    document.getElementById("main-content").style.paddingBottom = "48px";
  }
})();
