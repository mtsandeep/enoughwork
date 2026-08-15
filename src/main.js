// Main orchestrator: render loop, state refresh, limit controls, action
// buttons, debug bar, and startup bootstrap. Feature modules are imported for
// their side effects (event wiring) and the few functions render() needs.

import { $, state, invoke, listen, emit, formatTime } from "./state.js";
import { renderEventMarkers } from "./progress-bar.js";
import {
  openOverlay,
  closeAllOverlays,
  openBreakOverlay,
  closeBreakOverlay,
  presentDayWelcomeIfOverlayOpen,
  demoDayWelcome,
} from "./overlays.js";
import { applyPendingSettings, debugBar, checkForUpdate, startAutoUpdate } from "./settings.js";
import { mountSnoozeControl } from "./snooze-control.js";
import "./break-picker.js";
import "./schedule.js";

// Snooze control (owns its own label from the sticky defaults)
const snoozeCtl = mountSnoozeControl($("#snooze-slot"), {
  category: "limit",
  kind: "snooze",
  theme: "light",
  btnClass: "btn btn-snooze",
  getEndsAtBase: () => Math.floor(Date.now() / 1000),
  onApply: async (m) => {
    state.current = await invoke("snooze", { minutes: m });
    render();
  },
});

let prevBreakStatus = false;

async function refreshState() {
  try {
    state.current = await invoke("get_state");
    render();
  } catch (e) {
    console.error("get_state error:", e);
  }
}
export { refreshState };

function render() {
  if (!state.current) return;

  const { elapsed_secs, limit_mins, status, snooze_until } = state.current;
  const limit_secs = limit_mins * 60;

  // Open/close break overlay on status change.
  // Skip close when pending_welcome — leftover break window is morphing to greeting.
  const isOnBreak = status === "on_break";
  if (isOnBreak && !prevBreakStatus) openBreakOverlay();
  if (!isOnBreak && prevBreakStatus && !state.current.pending_welcome) closeBreakOverlay();
  prevBreakStatus = isOnBreak;

  // Broadcast break-tick to overlay windows
  if (isOnBreak && state.current.break_until) {
    const now = Math.floor(Date.now() / 1000);
    const remaining = Math.max(0, state.current.break_until - now);
    const total = state.current.break_duration_secs || 0;
    emit("break-tick", {
      remaining,
      total,
      elapsed_secs: state.current.elapsed_secs || 0,
      ended: remaining <= 0,
      over_secs: remaining <= 0 ? Math.max(0, now - state.current.break_until) : 0,
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
  const segments = state.current.break_segments || [];
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
  if (status === "on_break" && state.current.break_started_at) {
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
    const currentBreakDur = Math.max(0, now - state.current.break_started_at);
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

  // ===== Scheduled event markers + overflow badges =====
  renderEventMarkers(barEl, svgNS, limit_secs, elapsed_secs);

  // Show snooze button when at/past limit or limit_reached or snoozed
  const pastLimit = elapsed_secs >= limit_secs;
  snoozeCtl.setHidden(!pastLimit && status !== "limit_reached" && status !== "snoozed");

  // Show/hide stop and resume based on status
  $("#btn-stop").hidden = status === "stopped";
  $("#btn-resume").hidden = status !== "stopped";

  // Take Break button — only when active
  $("#btn-take-break").hidden = status !== "active";

  // Quick-add event icon — only when active (same row as Take Break)
  $("#btn-event-add").hidden = status !== "active";

  // Resume Work button — only when on break
  $("#btn-resume-break").hidden = status !== "on_break";

  // Stop/snooze hidden during break
  if (status === "on_break") {
    $("#btn-stop").hidden = true;
    snoozeCtl.setHidden(true);
    $("#btn-resume").hidden = true;
  }

  // Break stats
  const breakStatsEl = $("#break-stats");
  if (state.current.break_count > 0 && state.current.total_break_secs >= 60 && status !== "on_break") {
    const bm = Math.floor(state.current.total_break_secs / 60);
    breakStatsEl.textContent = `Breaks today: ${state.current.break_count} (${bm}m total)`;
    breakStatsEl.hidden = false;
  } else {
    breakStatsEl.hidden = true;
  }

  // Snooze bar
  const snoozeBar = $("#snooze-bar");
  if (status === "snoozed" && snooze_until) {
    const now = Date.now() / 1000;
    const remaining = Math.max(0, Math.ceil(snooze_until - now));
    const total = state.current.total_snooze_secs || 0;
    const elapsed = total - remaining;
    const pct2 = total > 0 ? Math.min((elapsed / total) * 100, 100) : 0;

    snoozeBar.hidden = false;
    $("#snooze-progress").style.width = pct2 + "%";

    // Show snooze button during snooze to extend
    snoozeCtl.setHidden(false);
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
  const isQuiet = state.current.quiet_overlay || false;
  quietBtn.classList.toggle("active", isQuiet);
  quietBtn.title = isQuiet ? "Mini Notification Enabled (today only)" : "Fullscreen Overlay Enabled";
  $("#quiet-icon-on").style.display = isQuiet ? "none" : "";
  $("#quiet-icon-off").style.display = isQuiet ? "" : "none";
}
export { render };

// ===== Limit controls — + and − buttons (snap to 30-min boundaries) =====
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
  const st = await invoke("get_state");
  state.current = await invoke("set_limit", { minutes: snapUp(st.limit_mins) });
  render();
});

$("#limit-down").addEventListener("click", async () => {
  const st = await invoke("get_state");
  state.current = await invoke("set_limit", { minutes: snapDown(st.limit_mins) });
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
  if (!state.current) return;
  const h = Math.floor(state.current.limit_mins / 60);
  const m = state.current.limit_mins % 60;
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
  state.current = await invoke("set_limit", { minutes: totalMins });
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
$("#btn-stop").addEventListener("click", async () => {
  state.current = await invoke("stop_for_today");
  render();
});

$("#btn-resume").addEventListener("click", async () => {
  state.current = await invoke("resume_tracking");
  render();
});

listen("day-rolled", async () => {
  // Prevent render from closing leftover break windows before morph.
  prevBreakStatus = false;
  await refreshState();
});

$("#btn-quiet-overlay").addEventListener("click", async () => {
  const newVal = !(state.current?.quiet_overlay || false);
  state.current = await invoke("set_quiet_overlay", { enabled: newVal });
  render();
});

// Apply pending settings when window hides to tray
const mainWindow = window.__TAURI__.window.getCurrentWindow();
mainWindow.onCloseRequested(() => {
  applyPendingSettings();
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
  const st = await invoke("get_state");
  await invoke("set_limit", { minutes: st.limit_mins }); // ensure limit is set
  // Set elapsed to equal limit by calling a special debug command
  await invoke("debug_set_elapsed", { secs: st.limit_mins * 60 });
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

// Debug: 1 min snooze (remember:false — don't poison the sticky default)
$("#dbg-1min-snooze").addEventListener("click", async () => {
  state.current = await invoke("snooze", { minutes: 1, remember: false });
  render();
});

// Debug: show animation overlay
$("#dbg-show-anim").addEventListener("click", async () => {
  const { WebviewWindow } = window.__TAURI__.webviewWindow;
  const animWin = new WebviewWindow("anim-preview", {
    url: "src/windows/animation.html",
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
  state.current = await invoke("start_break", {
    durationSecs: 60,
    label: null,
    eventId: null,
  });
  render();
});

// Debug: open limit overlays on all monitors, then morph each into the greeting
$("#dbg-day-welcome")?.addEventListener("click", async () => {
  await demoDayWelcome("Stand up stretch");
});

// Debug: 1 min reminder (fullscreen)
$("#dbg-1min-event").addEventListener("click", async () => {
  const triggerAt = Math.floor(Date.now() / 1000) + 60;
  state.current = await invoke("create_event", {
    eventType: "reminder",
    title: "Test Reminder",
    triggerAt: triggerAt,
    durationSecs: 0,
    overlayType: "fullscreen",
  });
  render();
});

// Refresh every second
setInterval(refreshState, 1000);

// Initial load — script is at end of body, DOM is ready
(async () => {
  await refreshState();

  // Crash/restart: pending_welcome only matters if an interrupt window survived
  // (it won't). Clear it so we don't leave the day stuck on "stopped".
  if (state.current?.pending_welcome) {
    await presentDayWelcomeIfOverlayOpen(state.current.pending_welcome.last_label);
  }

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
