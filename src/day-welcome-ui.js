/** Shared day-welcome UI for interrupt overlays (limit / break / reminder / mini).
 *  Reuses each host window's existing CSS classes — no duplicate stylesheet. */

export function timeGreeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good Morning";
  if (h < 17) return "Good Afternoon";
  return "Good Evening";
}

export function welcomeLines(lastLabel) {
  const label = lastLabel || "yesterday's session";
  return {
    line1: `Yesterday paused on ${label}.`,
    line2: "Welcome to a fresh new day!",
  };
}

/**
 * Replace the current overlay document with the day-welcome greeting.
 * Keeps the same window; swaps content using that page's existing classes.
 *
 * @param {'overlay'|'event'|'notify'} variant
 */
export function applyDayWelcome(lastLabel, { mini = false, variant = "overlay" } = {}) {
  const lines = welcomeLines(lastLabel);
  const greeting = timeGreeting();

  if (variant === "notify" || (variant === "event" && mini)) {
    // Light mini popup (notify.html / event-notify mini)
    const isEvent = variant === "event";
    document.body.classList.toggle("mini", isEvent);
    document.body.innerHTML = isEvent
      ? `
      <div class="event-container" id="event-container">
        <div class="event-title" id="day-welcome-greeting"></div>
        <div class="event-time" id="day-welcome-body">
          <div class="day-welcome-line1"></div>
          <div class="day-welcome-line2"></div>
        </div>
        <div class="event-buttons">
          <button type="button" class="event-btn event-btn-ok" id="day-welcome-start">Lets Start</button>
        </div>
      </div>`
      : `
      <div class="notify-container">
        <div class="notify-title" id="day-welcome-greeting"></div>
        <div class="notify-subtitle" id="day-welcome-body">
          <div class="day-welcome-line1"></div>
          <div class="day-welcome-line2"></div>
        </div>
        <div class="notify-buttons">
          <button type="button" class="notify-btn notify-btn-stop" id="day-welcome-start">Lets Start</button>
        </div>
      </div>`;
  } else if (variant === "event") {
    // Fullscreen reminder styles (inline in event-notify.html)
    document.body.innerHTML = `
      <div class="event-container" id="event-container">
        <div class="event-title" id="day-welcome-greeting"></div>
        <div class="event-time" id="day-welcome-body">
          <div class="day-welcome-line1"></div>
          <div class="day-welcome-line2"></div>
        </div>
        <div class="event-buttons">
          <button type="button" class="event-btn event-btn-ok" id="day-welcome-start">Lets Start</button>
        </div>
      </div>`;
  } else {
    // Limit / break overlays load styles.css → overlay.css
    document.body.innerHTML = `
      <div class="overlay-container">
        <div class="overlay-title" id="day-welcome-greeting"></div>
        <div class="overlay-subtitle" id="day-welcome-body">
          <div class="day-welcome-line1"></div>
          <div class="day-welcome-line2"></div>
        </div>
        <div class="overlay-buttons">
          <button type="button" class="overlay-btn overlay-btn-stop" id="day-welcome-start">Lets Start</button>
        </div>
      </div>`;
  }

  document.getElementById("day-welcome-greeting").textContent = greeting;
  document.querySelector(".day-welcome-line1").textContent = lines.line1;
  document.querySelector(".day-welcome-line2").textContent = lines.line2;

  // Stack the two body lines (no extra stylesheet — just block layout)
  const body = document.getElementById("day-welcome-body");
  if (body) {
    body.style.display = "flex";
    body.style.flexDirection = "column";
    body.style.gap = mini ? "4px" : "8px";
  }

  if (mini) {
    const dragRoot = document.querySelector(".notify-container, .event-container");
    dragRoot?.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      try {
        window.__TAURI__.window.getCurrentWindow().startDragging();
      } catch (_) {}
    });
  }

  let acted = false;
  document.getElementById("day-welcome-start")?.addEventListener("click", async () => {
    if (acted) return;
    acted = true;
    const { emit } = window.__TAURI__.event;
    await emit("day-welcome-start", {});
  });
}

/** Listen for day-welcome and morph this overlay window. */
export function listenForDayWelcome({ mini = false, variant = "overlay" } = {}) {
  const { listen, emit } = window.__TAURI__.event;
  const { getCurrentWindow } = window.__TAURI__.window;

  listen("day-welcome", (event) => {
    const label = event.payload?.last_label || event.payload?.lastLabel;
    applyDayWelcome(label, { mini, variant });
  });

  // Tell main this window is ready to receive day-welcome (multi-monitor race fix)
  try {
    const win = getCurrentWindow();
    emit("interrupt-overlay-ready", { label: win.label, mini: !!mini });
  } catch (_) {}
}
