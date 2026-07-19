import { state, invoke, listen, emit, emitTo, WebviewWindow } from "./state.js";
import { render } from "./main.js";
import { getMainWorkArea, bottomRightPosition, getMonitors } from "./window-utils.js";

function allInterruptWindows() {
  const list = [];
  for (const w of overlayWindows) list.push(w);
  for (const w of breakOverlayWindows) list.push(w);
  for (const w of eventNotifyWindows) list.push(w);
  if (notifyWindow) list.push(notifyWindow);
  if (animWindow) list.push(animWindow);
  return list;
}

function hasOpenInterruptWindows() {
  return allInterruptWindows().length > 0;
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Wait until a webview has been created (or timeout). */
async function waitWindowCreated(w, timeoutMs = 4000) {
  try {
    await Promise.race([
      w.once("tauri://created"),
      delay(timeoutMs),
    ]);
  } catch (_) {}
}

/**
 * Broadcast day-welcome to every interrupt window by label (emitTo) plus a
 * global emit, with retries so late-loading monitors still morph.
 */
async function broadcastDayWelcome(lastLabel) {
  const payload = { last_label: lastLabel || "yesterday's session" };
  const windows = allInterruptWindows();

  // Wait for freshly spawned webviews to exist
  await Promise.all(windows.map((w) => waitWindowCreated(w)));
  // Give JS modules time to register listen("day-welcome")
  await delay(200);

  const send = async () => {
    try { await emit("day-welcome", payload); } catch (_) {}
    for (const w of windows) {
      const label = w.label;
      if (!label) continue;
      try { await emitTo(label, "day-welcome", payload); } catch (_) {}
    }
  };

  await send();
  await delay(300);
  await send();
  await delay(600);
  await send();
}

/**
 * Morph leftover interrupt windows into the day greeting.
 * If none are open (closed / crash / restart), skip — no new window.
 */
export async function presentDayWelcomeIfOverlayOpen(lastLabel) {
  if (!hasOpenInterruptWindows()) {
    // No leftover UI — clear pending welcome and start a normal day.
    if (state.current?.pending_welcome) {
      state.current = await invoke("dismiss_day_welcome");
      render();
    }
    return false;
  }
  await broadcastDayWelcome(lastLabel);
  return true;
}

/** Debug helper: open limit overlays on all monitors, then morph reliably. */
export async function demoDayWelcome(lastLabel = "Stand up stretch") {
  await openOverlay();
  await broadcastDayWelcome(lastLabel);
}

// ===== Break Overlay Window =====
// Owned here because overlays manages all window lifecycle. Declared at
// import time (matches the original top-level `let`).
let breakOverlayWindows = [];
let breakOverlayId = 0;

function breakOverlayUrl() {
  if (!state.current || !state.current.break_until) return "src/windows/break-countdown.html";
  const now = Math.floor(Date.now() / 1000);
  const remaining = Math.max(0, state.current.break_until - now);
  const total = state.current.break_duration_secs || 0;
  const elapsed_secs = state.current.elapsed_secs || 0;
  const over_secs = remaining <= 0 ? Math.max(0, now - state.current.break_until) : 0;
  return `src/windows/break-countdown.html?remaining=${remaining}&total=${total}&elapsed_secs=${elapsed_secs}&over_secs=${over_secs}`;
}

export async function openBreakOverlay() {
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

export async function closeBreakOverlay() {
  for (const w of breakOverlayWindows) {
    try { await w.close(); } catch {}
  }
  breakOverlayWindows = [];
}

// Listen for break actions from overlay windows
listen("break-action", async (event) => {
  const { action } = event.payload;
  if (action === "resume") {
    state.current = await invoke("resume_from_break");
    await closeBreakOverlay();
    render();
  } else if (action === "extend") {
    state.current = await invoke("extend_break", { addSecs: 300 });
    render();
  }
});

// ===== Overlay & Animation Windows =====
let overlayWindows = [];
let animWindow = null;
let notifyWindow = null;
let animSafetyTimeout = null;
// Declared early so closeAllOverlays can clear it (reminder id set below).
let showingReminderId = null;

export async function closeAllOverlays() {
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
  for (const w of eventNotifyWindows) {
    try { await w.close(); } catch {}
  }
  eventNotifyWindows = [];
  showingReminderId = null;
  if (animSafetyTimeout) {
    clearTimeout(animSafetyTimeout);
    animSafetyTimeout = null;
  }
}

export async function openOverlay() {
  await closeAllOverlays();
  await new Promise(r => setTimeout(r, 100));

  const snapshot = await invoke("get_state");

  if (snapshot.quiet_overlay) {
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
    url: `src/windows/animation.html?type=${encodeURIComponent(animType)}`,
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
    url: hasWorkArea ? "src/windows/notify.html" : "src/windows/notify.html?selfpos=1",
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
        url: "src/windows/overlay.html",
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
      url: "src/windows/overlay.html",
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
        url: "src/windows/overlay.html",
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

// ===== Scheduled Event: trigger + overlay =====
let eventNotifyWindows = [];
let eventNotifyId = 0;

function eventNotifyUrl(ev, mode) {
  const title = encodeURIComponent(ev.title || "Reminder");
  return `src/windows/event-notify.html?id=${ev.id}&title=${title}&mode=${mode}&at=${ev.trigger_at}`;
}

/** Close whatever interrupt is up so the next one can take the screen. */
async function prepareInterruptReplace() {
  // End an in-progress break as done (manual or scheduled).
  if (state.current?.status === "on_break") {
    state.current = await invoke("resume_from_break");
    await closeBreakOverlay();
  }
  // Unacknowledged reminder → silent miss
  if (showingReminderId != null) {
    const id = showingReminderId;
    showingReminderId = null;
    state.current = await invoke("mark_event_missed", { id, reason: "replaced" });
    await closeEventNotify();
  }
  // Limit / notify / anim windows
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
  if (animSafetyTimeout) {
    clearTimeout(animSafetyTimeout);
    animSafetyTimeout = null;
  }
}

async function openEventNotifyFullscreen(ev) {
  eventNotifyId++;
  const url = eventNotifyUrl(ev, "fullscreen");
  try {
    const monitors = await getMonitors();
    if (monitors && monitors.length > 1) {
      for (let i = 0; i < monitors.length; i++) {
        const pos = monitors[i].position;
        const label = `event-notify-${eventNotifyId}-${i}`;
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
        eventNotifyWindows.push(w);
      }
    } else {
      const label = `event-notify-${eventNotifyId}`;
      const w = new WebviewWindow(label, {
        url,
        fullscreen: true,
        alwaysOnTop: true,
        decorations: false,
        skipTaskbar: true,
        backgroundColor: "#0f0f1a",
        title: "EnoughWork",
      });
      eventNotifyWindows.push(w);
    }
  } catch (e) {
    console.error("Event notify overlay failed:", e);
  }
}

async function openEventNotifyMini(ev) {
  const popupW = 320;
  const popupH = 200;
  const margin = 16;

  let posX = 100, posY = 100;
  let hasWorkArea = false;
  try {
    const workArea = await getMainWorkArea();
    if (workArea) {
      const pos = await bottomRightPosition(workArea, popupW, popupH, margin);
      posX = pos.x;
      posY = pos.y;
      hasWorkArea = true;
    }
  } catch (_) {}

  const url = hasWorkArea
    ? eventNotifyUrl(ev, "mini")
    : eventNotifyUrl(ev, "mini") + "&selfpos=1";
  const w = new WebviewWindow("event-notify-mini", {
    url,
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
  eventNotifyWindows.push(w);
}

async function closeEventNotify() {
  for (const w of eventNotifyWindows) {
    try { await w.close(); } catch {}
  }
  eventNotifyWindows = [];
  showingReminderId = null;
}

// Rust emits this when an event's time arrives (only while time is running)
listen("event-triggered", async (event) => {
  const ev = event.payload;
  await prepareInterruptReplace();

  if (ev.event_type === "break") {
    state.current = await invoke("start_break", {
      durationSecs: ev.duration_secs,
      label: ev.title || "a break",
      eventId: ev.id,
    });
    render();
  } else {
    showingReminderId = ev.id;
    if (ev.overlay_type === "mini") {
      await openEventNotifyMini(ev);
    } else {
      await openEventNotifyFullscreen(ev);
    }
    render();
  }
});

// Reminder overlay actions
listen("event-dismiss", async (event) => {
  const { id } = event.payload;
  showingReminderId = null;
  state.current = await invoke("dismiss_event", { id });
  await closeEventNotify();
  render();
});

listen("event-snooze", async (event) => {
  const { id } = event.payload;
  showingReminderId = null;
  state.current = await invoke("snooze_event", { id });
  await closeEventNotify();
  render();
});

// Day rollover: morph leftover interrupt windows into the greeting.
// If nothing is open, skip greeting entirely.
listen("day-rolled", async (event) => {
  showingReminderId = null;
  const welcome = event.payload;
  if (welcome && (welcome.last_label || welcome.lastLabel)) {
    await presentDayWelcomeIfOverlayOpen(welcome.last_label || welcome.lastLabel);
  } else if (hasOpenInterruptWindows()) {
    // Clean day but stale windows — just close them
    await closeAllOverlays();
  }
});

listen("day-welcome-start", async () => {
  showingReminderId = null;
  state.current = await invoke("dismiss_day_welcome");
  await closeAllOverlays();
  render();
});
