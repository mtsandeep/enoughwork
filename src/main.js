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
import { applyPendingSettings, debugBar, checkForUpdate, startAutoUpdate, openUpdateNotifyPopup } from "./settings.js";
import { mountSnoozeControl } from "./snooze-control.js";
import { STOPPED_MESSAGES } from "./stopped-messages.js";
import "./break-picker.js";
import "./schedule.js";
import "./theme.js";
import { renderTaskUI, isTaskPopoutOpen, setTaskWindowVisible } from "./task-timer.js";

// Snooze control (owns its own label from the sticky defaults)
const snoozeCtl = mountSnoozeControl($("#snooze-slot"), {
  category: "limit",
  kind: "snooze",
  theme: "auto",
  btnClass: "btn btn-snooze",
  getEndsAtBase: () => Math.floor(Date.now() / 1000),
  onApply: async (m) => {
    state.current = await invoke("snooze", { minutes: m });
    render();
  },
});

let prevBreakStatus = false;

let lastBarMin = -1;
let lastBarLimit = -1;

let offClockCollapsed = false;
let prevOffClockActive = false;

// Over-work UI stays hidden until this much has accumulated past a stop.
const OFF_CLOCK_THRESHOLD_SECS = 10 * 60;

function formatSnoozeDur(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return h > 0
    ? `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`
    : `${m}m ${String(s).padStart(2, "0")}s`;
}

const SNOOZE_ICON = `<svg class="status-snooze-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/><path d="M5 3 2 6"/><path d="m22 6-3-3"/></svg>`;

// One end-of-day message per day, stable across restarts.
function stoppedMessageFor(dateStr) {
  const dayIdx = Math.floor(new Date(`${dateStr}T00:00:00`).getTime() / 86400000);
  return STOPPED_MESSAGES[dayIdx % STOPPED_MESSAGES.length];
}

// Re-render only when something displayed changed; hidden windows skip
// the DOM work except while on_break (its overlay countdown is fed by render).
let lastRenderSig = null;
let forceRender = true;

// Everything render() displays, hashed; the minute bucket keeps
// wall-clock-derived bits (upcoming event dots) fresh.
function renderSignature(st) {
  const now = Math.floor(Date.now() / 1000);
  const snoozeLeft = st.status === "snoozed" && st.snooze_until ? Math.max(0, st.snooze_until - now) : 0;
  const breakLeft = st.status === "on_break" && st.break_until ? Math.max(0, st.break_until - now) : 0;
  const evs = (st.events || [])
    .map(e => `${e.id}:${+e.triggered}:${e.miss_reason || ""}:${e.snoozed_until || 0}:${e.elapsed_at_trigger || 0}:${+e.recurred_today}:${e.task_state || ""}:${e.task_ends_at || 0}:${e.task_remaining_secs || 0}:${e.task_state === "running" && e.task_ends_at ? Math.max(0, e.task_ends_at - now) : 0}`)
    .join(",");
  return [
    st.date, st.status, st.elapsed_secs, st.limit_mins,
    snoozeLeft, st.total_snooze_secs, st.still_working_secs,
    breakLeft, st.break_count, st.total_break_secs,
    (st.break_segments || []).length, st.quiet_overlay ? 1 : 0,
    st.pending_welcome ? 1 : 0, Math.floor(now / 60), evs,
  ].join("|");
}

// Same-string writes still dirty the DOM — only touch changed nodes.
function setText(el, str) {
  if (el.textContent !== str) el.textContent = str;
}

function setHidden(el, v) {
  if (el.hidden !== v) el.hidden = v;
}

async function refreshState() {
  try {
    state.current = await invoke("get_state");
    const sig = renderSignature(state.current);
    if (forceRender || sig !== lastRenderSig) {
      lastRenderSig = sig;
      let visible = true;
      try { visible = await mainWindow.isVisible(); } catch { /* keep rendering */ }
      setTaskWindowVisible(visible);
      if (forceRender || visible || state.current.status === "on_break" || isTaskPopoutOpen()) {
        forceRender = false;
        render();
      }
    }
    // Self-heal a pending day-welcome the "day-rolled" event may have missed.
    if (state.current?.pending_welcome) {
      await presentDayWelcomeIfOverlayOpen(state.current.pending_welcome.last_label);
    }
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

  // Includes time actually spent snoozed; the bar and limit math stay on raw elapsed.
  const snoozeTotal = state.current.total_snooze_secs || 0;
  const snoozeRemaining = status === "snoozed" && snooze_until
    ? Math.max(0, snooze_until - Math.floor(Date.now() / 1000))
    : 0;
  setText($("#elapsed"), formatTime(elapsed_secs + Math.max(0, snoozeTotal - snoozeRemaining)));

  // Minute resolution — per-second steps are sub-pixel, and width writes dirty layout.
  const barEl = $("#progress-svg");
  const svgNS = "http://www.w3.org/2000/svg";
  const progressEl = $("#progress");
  const barMin = Math.floor(elapsed_secs / 60);
  if (barMin !== lastBarMin || limit_secs !== lastBarLimit) {
    lastBarMin = barMin;
    lastBarLimit = limit_secs;
    const elapsedPct = limit_secs > 0 ? Math.min((elapsed_secs / limit_secs) * 100, 100) : 0;
    progressEl.setAttribute("width", elapsedPct);
    progressEl.classList.toggle("over-limit", elapsed_secs >= limit_secs);
  }
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

  // ===== Task sub-timers (strip / expanded page / popout feed) =====
  renderTaskUI(state.current);

  // Show snooze button when at/past limit or limit_reached or snoozed
  const pastLimit = elapsed_secs >= limit_secs;
  snoozeCtl.setHidden(!pastLimit && status !== "limit_reached" && status !== "snoozed");

  // Show/hide stop and resume based on status
  setHidden($("#btn-stop"), status === "stopped");
  setHidden($("#btn-resume"), status !== "stopped");

  // Take Break button — only when active
  setHidden($("#btn-take-break"), status !== "active");

  // Quick-add event icon — only when active (same row as Take Break)
  setHidden($("#btn-event-add"), status !== "active");

  // Resume Work button — only when on break
  setHidden($("#btn-resume-break"), status !== "on_break");

  // Stop/snooze hidden during break
  if (status === "on_break") {
    setHidden($("#btn-stop"), true);
    snoozeCtl.setHidden(true);
    setHidden($("#btn-resume"), true);
  }

  // Break stats
  const breakStatsEl = $("#break-stats");
  if (state.current.break_count > 0 && state.current.total_break_secs >= 60 && status !== "on_break") {
    const bm = Math.floor(state.current.total_break_secs / 60);
    setText(breakStatsEl, `Breaks today: ${state.current.break_count} (${bm}m total)`);
    setHidden(breakStatsEl, false);
  } else {
    setHidden(breakStatsEl, true);
  }

  // Status — write only when changed (the snoozed branch embeds SVG HTML)
  const statusEl = $("#status");
  statusEl.className = "status-text";
  delete statusEl.dataset.tooltip;
  let statusHtml = null;
  let statusText = null;
  if (status === "active") {
    statusText = ""; // no status text while normally tracking — space stays reserved
    statusEl.classList.add("status-active");
  } else if (status === "on_break") {
    statusText = "On Break";
    statusEl.classList.add("status-break");
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
    statusHtml = `${SNOOZE_ICON}Snoozed (${timeStr} left)`;
    statusEl.classList.add("status-snoozed");
    const snoozeTotal = state.current.total_snooze_secs || 0;
    const snoozedSoFar = Math.max(0, snoozeTotal - remainingSecs);
    statusEl.dataset.tooltip = `Snoozed ${formatSnoozeDur(snoozedSoFar)} of ${formatSnoozeDur(snoozeTotal)} today`;
  } else if (status === "limit_reached") {
    statusText = "Limit reached";
    statusEl.classList.add("status-stopped");
  } else if (status === "stopped") {
    if (elapsed_secs >= limit_secs) {
      // The day ran its course — the end-of-day note
      statusText = stoppedMessageFor(state.current.date);
      statusEl.classList.add("status-done");
    } else {
      // Voluntary pause before the limit — same card, plain message, no icon
      statusText = "Paused — auto-starts tomorrow";
      statusEl.classList.add("status-done", "paused");
    }
  }
  if (statusHtml !== null) {
    if (statusEl.innerHTML !== statusHtml) statusEl.innerHTML = statusHtml;
  } else if (statusEl.textContent !== statusText) {
    statusEl.textContent = statusText;
  }

  // Off-the-clock tally: time at the machine since the day was stopped.
  const stillWorking = state.current.still_working_secs || 0;
  const offClockActive = status === "stopped" && stillWorking > OFF_CLOCK_THRESHOLD_SECS;
  if (offClockActive && !prevOffClockActive) offClockCollapsed = false;
  prevOffClockActive = offClockActive;
  const offClockBtn = $("#btn-off-clock");
  offClockBtn.classList.toggle("visible", offClockActive && offClockCollapsed);
  $("#off-clock-overlay").classList.toggle("visible", offClockActive && !offClockCollapsed);
  if (offClockActive) {
    const tally = formatTime(stillWorking);
    setText($("#off-clock-time"), tally);
    setText(offClockBtn, tally);
  }

  // Limit setting display
  const lH = Math.floor(limit_mins / 60);
  const lM = limit_mins % 60;
  setText($("#limit-display"), lM > 0 ? `${lH}h ${String(lM).padStart(2, "0")}m` : `${lH}h 00m`);

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

$("#btn-off-clock").addEventListener("click", () => {
  offClockCollapsed = !offClockCollapsed;
  render();
});

$("#off-clock-overlay").addEventListener("click", () => {
  if (!offClockCollapsed) {
    offClockCollapsed = true;
    render();
  }
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

// Sync the moment an overlay fires (limit/break/reminder) so the timer
// shows its final value before the overlay window covers the screen —
// otherwise the last pre-overlay frame reads a second behind and "moves"
// when the user returns.
listen("show-overlay", async () => {
  forceRender = true;
  await refreshState();
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

// Debug: preview the update-available popup (demo mode — buttons are visual-only)
$("#dbg-update-notify")?.addEventListener("click", () => openUpdateNotifyPopup("0.2.7", true));

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

// Poll: 1s while visible, 5s hidden to tray; focus wakes the sleep so a
// reopened window resumes its 1s cadence immediately. Opening the task
// popout wakes it too — the popout needs 1s ticks even while hidden.
export let wakePoll = () => {};
function sleepPoll(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { wakePoll = () => {}; resolve(); }, ms);
    wakePoll = () => { clearTimeout(t); wakePoll = () => {}; resolve(); };
  });
}

(async function pollLoop() {
  for (;;) {
    await refreshState();
    let visible = true;
    try { visible = await mainWindow.isVisible(); } catch { /* assume visible */ }
    const fast = visible || state.current?.status === "on_break" || isTaskPopoutOpen();
    await sleepPoll(fast ? 1000 : 5000);
  }
})();

// Re-showing/focusing the window must repaint even if nothing changed since.
mainWindow.listen("tauri://focus", () => {
  forceRender = true;
  wakePoll();
});

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
