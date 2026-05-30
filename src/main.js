import { computePosition, flip, shift, offset as floatingOffset } from "@floating-ui/dom";

const { invoke } = window.__TAURI__.core;
const { listen, emit } = window.__TAURI__.event;
const { WebviewWindow } = window.__TAURI__.webviewWindow;
const { getMainWorkArea, bottomRightPosition, getMonitors } = await import("./window-utils.js");

const $ = (sel) => document.querySelector(sel);

// App constants — change these to update repo url
const GITHUB_REPO = "mtsandeep/enoughwork";
const GITHUB_RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases`;

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
      over_secs: remaining <= 0 ? Math.max(0, now - currentState.break_until) : 0,
    });
  }

  const pct = Math.min((elapsed_secs / limit_secs) * 100, 100);

  // Elapsed time - big
  $("#elapsed").textContent = formatTime(elapsed_secs);

  // Progress bar: simple fill (no break segments for now)
  const barEl = $("#progress-svg");
  const svgNS = "http://www.w3.org/2000/svg";
  const elapsedPct = limit_secs > 0 ? Math.min((elapsed_secs / limit_secs) * 100, 100) : 0;
  const progressEl = $("#progress");
  progressEl.setAttribute("width", elapsedPct);
  progressEl.classList.toggle("over-limit", elapsed_secs >= limit_secs);
  barEl.querySelectorAll(".progress-fill-seg").forEach(el => el.remove());

  // Render break segments
  const segments = currentState.break_segments || [];
  // Remove excess completed break rects (skip "live")
  barEl.querySelectorAll(".progress-break").forEach((el) => {
    if (el.dataset.seg === "live") return;
    if (parseInt(el.dataset.seg) >= segments.length) el.remove();
  });
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.duration < 60) continue; // skip breaks under 1 min
    let el = barEl.querySelector(`.progress-break[data-seg="${i}"]`);
    if (!el) {
      el = document.createElementNS(svgNS, "rect");
      el.classList.add("progress-break");
      el.setAttribute("data-seg", i);
      el.setAttribute("y", "0");
      el.setAttribute("height", "6");
      barEl.appendChild(el);
    }
    const segPct = limit_secs > 0 ? (seg.duration / limit_secs) * 100 : 0;
    const leftPct = limit_secs > 0 ? (seg.active_at_start / limit_secs) * 100 : 0;
    el.setAttribute("x", leftPct);
    el.setAttribute("width", Math.max(seg.duration > 0 ? 0.5 : 0, segPct));
    const bm = Math.floor(seg.duration / 60);
    const bh = Math.floor(bm / 60);
    const bmr = bm % 60;
    el.dataset.breakLabel = bh > 0 ? `Break: ${bh}h ${String(bmr).padStart(2, "0")}m` : `Break: ${bm}m`;
  }

  // Show current ongoing break if active
  if (status === "on_break" && currentState.break_started_at) {
    let el = barEl.querySelector(`.progress-break[data-seg="live"]`);
    if (!el) {
      el = document.createElementNS(svgNS, "rect");
      el.classList.add("progress-break");
      el.setAttribute("data-seg", "live");
      el.setAttribute("y", "0");
      el.setAttribute("height", "6");
      barEl.appendChild(el);
    }
    const now = Math.floor(Date.now() / 1000);
    const currentBreakDur = Math.max(0, now - currentState.break_started_at);
    const segPct = limit_secs > 0 ? (currentBreakDur / limit_secs) * 100 : 0;
    const leftPct = limit_secs > 0 ? ((elapsed_secs - currentBreakDur) / limit_secs) * 100 : 0;
    el.setAttribute("x", leftPct);
    el.setAttribute("width", Math.max(0.5, segPct));
    const bm = Math.floor(currentBreakDur / 60);
    const bh = Math.floor(bm / 60);
    const bmr = bm % 60;
    el.dataset.breakLabel = bh > 0 ? `Break: ${bh}h ${String(bmr).padStart(2, "0")}m` : `Break: ${bm}m`;
  } else {
    const live = barEl.querySelector(`.progress-break[data-seg="live"]`);
    if (live) live.remove();
  }

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
  if (currentState.break_count > 0 && currentState.total_break_secs >= 60 && status !== "on_break") {
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
    const total = currentState.total_snooze_secs || 0;
    const elapsed = total - remaining;
    const pct = total > 0 ? Math.min((elapsed / total) * 100, 100) : 0;

    snoozeBar.hidden = false;
    $("#snooze-progress").style.width = pct + "%";

    // Show snooze button during snooze to extend
    $("#btn-snooze").hidden = false;
    const totalSnoozeMins = Math.round(total / 60);
    $("#btn-snooze").textContent = "Snooze 30m";
  } else {
    snoozeBar.hidden = true;
    $("#btn-snooze").textContent = "Snooze 30m";
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
  const over_secs = remaining <= 0 ? Math.max(0, now - currentState.break_until) : 0;
  return `src/break-countdown.html?remaining=${remaining}&total=${total}&elapsed_secs=${elapsed_secs}&over_secs=${over_secs}`;
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

let heatmapBuiltDate = null;

// Returns the effective "today" date key, respecting the configured reset time.
// Uses currentState.date from the Rust backend (computed via effective_date(reset_time)).
// Falls back to raw calendar date if state isn't loaded yet.
function effectiveToday() {
  return currentState?.date || localDateKey(new Date());
}

function buildHeatmap() {
  const container = $("#heatmap");
  if (!container) return;
  const todayKey = effectiveToday();
  heatmapBuiltDate = todayKey;
  // Parse the effective date to generate the 30-day window
  const [y, m, d] = todayKey.split("-").map(Number);
  const today = new Date(y, m - 1, d);
  let html = "";
  for (let i = 29; i >= 0; i--) {
    const dt = new Date(today);
    dt.setDate(dt.getDate() - i);
    const key = localDateKey(dt);
    html += `<div class="heatmap-square" data-date="${key}" data-today="${i === 0 ? "1" : "0"}"></div>`;
  }
  container.innerHTML = html;
  heatmapBuilt = true;
  updateHeatmapColors();
}

function updateHeatmapColors() {
  if (!historyCache || !heatmapBuilt) return;

  // If effective today changed since heatmap was built, rebuild with fresh history + dates
  const todayKey = effectiveToday();
  if (heatmapBuiltDate && heatmapBuiltDate !== todayKey) {
    initHeatmap();
    return;
  }

  const squares = document.querySelectorAll(".heatmap-square");
  squares.forEach((sq) => {
    const key = sq.dataset.date;
    const isToday = sq.dataset.today === "1";
    const record = isToday
      ? { active_secs: currentState?.active_secs || 0, break_secs: currentState?.total_break_secs || 0, elapsed_secs: currentState?.elapsed_secs || 0 }
      : (historyCache[key] || { active_secs: 0, break_secs: 0, elapsed_secs: 0 });
    const secs = record.active_secs || 0;
    const breakSecs = record.break_secs || 0;
    const elapsedSecs = record.elapsed_secs || 0;
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
    sq.dataset.tooltipTotal = secs > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : "";
    sq.dataset.tooltipWork = elapsedSecs > 0 ? formatBreakMin(elapsedSecs) : "";
    sq.dataset.tooltipBreak = breakSecs >= 60 ? formatBreakMin(breakSecs) : "";
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
    const total = sq.dataset.tooltipTotal;
    const work = sq.dataset.tooltipWork;
    const breakTime = sq.dataset.tooltipBreak;
    const label = sq.dataset.tooltipLabel;
    let html = `<div class="tt-date">${date}</div>`;
    if (total) {
      if (total !== work) html += `<div class="tt-time">${total} awake</div>`;
      if (work) html += `<div class="tt-time">${work} work</div>`;
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
// Progress bar break tooltip
const breakTooltip = document.getElementById("break-tooltip");
const progressSvg = document.getElementById("progress-svg");
if (progressSvg && breakTooltip) {
  progressSvg.addEventListener("mouseover", async (e) => {
    const rect = e.target.closest(".progress-break");
    if (!rect || !rect.dataset.breakLabel) return;
    breakTooltip.innerHTML = `<div class="tt-time">${rect.dataset.breakLabel}</div>`;
    breakTooltip.hidden = false;
    const { x, y } = await computePosition(rect, breakTooltip, {
      placement: "top",
      middleware: [floatingOffset(6), flip(), shift({ padding: 8 })],
    });
    breakTooltip.style.left = `${x}px`;
    breakTooltip.style.top = `${y}px`;
  });
  progressSvg.addEventListener("mouseout", (e) => {
    if (!progressSvg.contains(e.relatedTarget)) {
      breakTooltip.hidden = true;
    }
  });
}

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
  let hasWorkArea = false;
  try {
    const workArea = targetMonitor || await getMainWorkArea();
    if (workArea) {
      const pos = await bottomRightPosition(workArea, popupW, popupH, margin);
      posX = pos.x;
      posY = pos.y;
      hasWorkArea = true;
    }
  } catch (_) {}

  notifyWindow = new WebviewWindow("notify-0", {
    url: hasWorkArea ? "src/notify.html" : "src/notify.html?selfpos=1",
    width: popupW,
    height: popupH,
    x: posX,
    y: posY,
    visible: hasWorkArea,
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
const autoUpdateToggle = $("#setting-auto-update");
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
  autoUpdateToggle.checked = settings.auto_update !== false;
  settingsLoaded = true;
  // Snapshot for dirty check
  settingsSnapshot = {
    overlayTitle: overlayTitleInput.value,
    overlaySubtitle: overlaySubtitleInput.value,
    resetTime: resetTimeInput.value,
    forceFullscreenOverlay: forceFullscreenToggle.checked,
    animationType: animationTypeSelect.value,
    autoUpdate: autoUpdateToggle.checked,
  };
  // Version
  const version = await invoke("get_version");
  $("#settings-version-text").textContent = `v${version}`;
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
    autoUpdate: autoUpdateToggle.checked,
  };
  if (settingsSnapshot && (
    current.overlayTitle !== settingsSnapshot.overlayTitle ||
    current.overlaySubtitle !== settingsSnapshot.overlaySubtitle ||
    current.resetTime !== settingsSnapshot.resetTime ||
    current.forceFullscreenOverlay !== settingsSnapshot.forceFullscreenOverlay ||
    current.animationType !== settingsSnapshot.animationType ||
    current.autoUpdate !== settingsSnapshot.autoUpdate
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
  // Clear update status when leaving settings
  const statusEl = $("#update-status");
  statusEl.hidden = true;
  statusEl.innerHTML = "";
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
});

// Listen for overlay-close event
listen("close-overlay", async () => {
  await closeAllOverlays();
  await refreshState();
});

// Debug: show overlay (respects megaphone/quiet setting)
$("#dbg-show-overlay").addEventListener("click", () => openOverlay());

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
    center: true,
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

// ===== Auto Update =====
let pendingUpdate = null;

async function checkForUpdate(showStatus = false) {
  const statusEl = $("#update-status");
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();

    if (update) {
      pendingUpdate = update;
      const badge = $("#update-badge");
      badge.textContent = `Update available → v${update.version}`;
      badge.hidden = false;
      badge.classList.remove("updating");

      // Shift badge next to DEV badge if present
      const devBadge = document.querySelector(".dev-badge");
      if (devBadge) badge.parentElement.classList.add("has-dev-badge");

      if (showStatus && statusEl) {
        renderUpdateStatus(statusEl, "available", update.version);
      }
    } else {
      pendingUpdate = null;
      if (showStatus && statusEl) {
        statusEl.textContent = "You're on the latest version";
        statusEl.className = "settings-update-status success";
        statusEl.hidden = false;
        setTimeout(() => { statusEl.hidden = true; }, 3000);
      }
    }
  } catch (e) {
    pendingUpdate = null;
    if (showStatus && statusEl) {
      statusEl.innerHTML = `Check failed! <a href="${GITHUB_RELEASES_URL}" target="_blank">Download from GitHub</a>`;
      statusEl.className = "settings-update-status error";
      statusEl.hidden = false;
    }
  }
}

const downloadIcon = `<svg class="update-icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a1 1 0 0 1 1 1v12.586l3.293-3.293a1 1 0 0 1 1.414 1.414l-5 5a1 1 0 0 1-1.414 0l-5-5a1 1 0 1 1 1.414-1.414L11 15.586V3a1 1 0 0 1 1-1zM4 17a1 1 0 0 1 1 1v2h14v-2a1 1 0 1 1 2 0v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a1 1 0 0 1 1-1z"/></svg>`;

function renderUpdateStatus(el, state, version) {
  el.classList.remove("success", "error");
  switch (state) {
    case "available":
      el.innerHTML = `v${version} ${downloadIcon}`;
      el.className = "settings-update-status success clickable";
      el.hidden = false;
      break;
    case "downloading":
      el.textContent = "Downloading...";
      el.className = "settings-update-status";
      el.hidden = false;
      break;
    case "restarting":
      el.textContent = "Restarting...";
      el.className = "settings-update-status";
      el.hidden = false;
      break;
    case "error":
      el.innerHTML = `Error! Try again. <a href="${GITHUB_RELEASES_URL}" target="_blank">Download from GitHub</a>`;
      el.className = "settings-update-status error";
      el.hidden = false;
      break;
  }
}

async function downloadAndUpdate(statusEl) {
  if (!pendingUpdate) return;
  const version = pendingUpdate.version;

  // Update badge
  const badge = $("#update-badge");
  badge.textContent = "Downloading...";
  badge.classList.add("updating");
  // Hide GitHub link if visible
  const ghLink = document.getElementById("badge-gh-link");
  if (ghLink) ghLink.hidden = true;

  // Update settings status
  if (statusEl) renderUpdateStatus(statusEl, "downloading", version);

  try {
    await pendingUpdate.downloadAndInstall();
    badge.textContent = "Restarting...";
    if (statusEl) renderUpdateStatus(statusEl, "restarting", version);
    await new Promise(r => setTimeout(r, 2000));
    await window.__TAURI__.process.relaunch();
  } catch (e) {
    badge.textContent = "Error! Try again";
    badge.classList.remove("updating");
    badge.classList.add("error");
    // Show GitHub link outside badge
    let ghLink = document.getElementById("badge-gh-link");
    if (!ghLink) {
      ghLink = document.createElement("a");
      ghLink.id = "badge-gh-link";
      ghLink.className = "badge-gh-link";
      ghLink.target = "_blank";
      badge.parentElement.appendChild(ghLink);
    }
    ghLink.href = GITHUB_RELEASES_URL;
    ghLink.textContent = "or Download from GitHub";
    ghLink.hidden = false;
    if (statusEl) renderUpdateStatus(statusEl, "error", version);
  }
}

// Update badge click → download + install + restart
$("#update-badge").addEventListener("click", () => downloadAndUpdate(null));

// Settings status click → download + install + restart
$("#update-status").addEventListener("click", () => downloadAndUpdate($("#update-status")));

// Settings "Check for Updates" button
$("#btn-check-updates").addEventListener("click", () => checkForUpdate(true));

// Re-check every 4 hours (only when auto-update is on)
let updateInterval = null;
function startAutoUpdate() {
  if (updateInterval) return;
  updateInterval = setInterval(() => checkForUpdate(false), 4 * 60 * 60 * 1000);
}
function stopAutoUpdate() {
  if (updateInterval) { clearInterval(updateInterval); updateInterval = null; }
}

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
  }

  // Auto-update: check on startup + schedule interval if enabled
  const settings = await invoke("get_settings");
  if (settings.auto_update !== false) {
    checkForUpdate(false);
    startAutoUpdate();
  }
})();
