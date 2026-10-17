import { listenForDayWelcome } from "./day-welcome-ui.js";
import { mountSnoozeControl } from "./snooze-control.js";

const { emit } = window.__TAURI__.event;
const { getCurrentWindow } = window.__TAURI__.window;

const params = new URLSearchParams(window.location.search);
const eventId = parseInt(params.get("id")) || 0;
const title = params.get("title") || "Reminder";
const mode = params.get("mode") || "fullscreen"; // "fullscreen" | "mini"
const scheduledAt = parseInt(params.get("at")) || 0;
// "reminder" (default) | "task-start" | "task-done"
const kind = params.get("kind") || "reminder";

if (mode === "mini") {
  document.body.classList.add("mini");
}

listenForDayWelcome({ mini: mode === "mini", variant: "event" });

document.getElementById("event-title").textContent = decodeURIComponent(title).replace(/\+/g, " ");

// Task variants: label, primary action, and an explicit secondary button so a
// start notification can be declined without starting the sub-timer.
// Primary button → the event the main window handles ("event-dismiss" for
// reminders, "task-start" / "task-dismiss" for tasks).
let primaryAction = "event-dismiss";
if (kind === "task-start") {
  document.getElementById("event-label").textContent = "Task";
  document.getElementById("btn-ok").textContent = "Start";
  document.getElementById("btn-dismiss").textContent = "Dismiss";
  document.getElementById("btn-dismiss").hidden = false;
  primaryAction = "task-start";
} else if (kind === "task-done") {
  document.getElementById("event-label").textContent = "Task Done";
  // "Done" is the primary (acknowledge); "Restart" runs the block again.
  document.getElementById("btn-ok").textContent = "Done";
  document.getElementById("btn-dismiss").textContent = "Restart";
  document.getElementById("btn-dismiss").hidden = false;
  primaryAction = "task-dismiss";
}
if (kind !== "reminder") {
  // Mini task cards use the fullscreen yellow primary (see <style>).
  document.body.classList.add("task");
}

if (scheduledAt) {
  const d = new Date(scheduledAt * 1000);
  let h = d.getHours();
  const min = String(d.getMinutes()).padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  const prefix = kind === "task-done" ? "Ended at" : "Scheduled for";
  document.getElementById("event-time").textContent = `${prefix} ${h}:${min} ${ampm}`;
} else {
  document.getElementById("event-time").textContent = "";
}

// Self-position for mini popup (fallback when work area unknown)
if (mode === "mini" && params.get("selfpos") === "1") {
  (async () => {
    try {
      const { invoke } = window.__TAURI__.core;
      await invoke("plugin:positioner|move_window", { position: 3 });
      const win = getCurrentWindow();
      const pos = await win.outerPosition();
      const monitors = await window.__TAURI__.window.availableMonitors();
      let sf = 1;
      for (const m of monitors) {
        if (pos.x >= m.position.x && pos.x < m.position.x + m.size.width &&
            pos.y >= m.position.y && pos.y < m.position.y + m.size.height) {
          sf = m.scaleFactor;
          break;
        }
      }
      const marginPhys = Math.round(16 * sf);
      await win.setPosition(
        new window.__TAURI__.dpi.PhysicalPosition(pos.x - marginPhys, pos.y - marginPhys)
      );
    } catch (e) {
      console.warn("Positioner failed:", e);
    }
    await getCurrentWindow().show();
  })();
}

// Drag mini popup
if (mode === "mini") {
  document.getElementById("event-container").addEventListener("mousedown", (e) => {
    if (e.target.closest("button, .snooze-ctl")) return;
    getCurrentWindow().startDragging();
  });
}

let acted = false;
document.getElementById("btn-ok").addEventListener("click", async () => {
  if (acted) return;
  acted = true;
  await emit(primaryAction, { id: eventId });
});

// Secondary button: start notification → Dismiss (stays startable from the
// events list); done notification → Restart (run the block again).
document.getElementById("btn-dismiss").addEventListener("click", async () => {
  if (acted) return;
  acted = true;
  if (kind === "task-done") {
    await emit("task-restart", { id: eventId });
  } else {
    await emit("event-dismiss", { id: eventId });
  }
});

// Snooze: reminders keep it everywhere; task-start keeps it fullscreen only
// (the mini popup has no room for three controls); task-done never snoozes.
const mountSnooze = kind === "reminder" || (kind === "task-start" && mode !== "mini");
mountSnooze
  ? mountSnoozeControl(document.getElementById("snooze-slot"), {
      category: "event",
      kind: "snooze",
      theme: mode === "mini" ? "light" : "dark",
      btnClass: "event-btn event-btn-snooze",
      showEdit: mode !== "mini", // no room for the popover in the mini popup
      getEndsAtBase: mode === "mini" ? null : () => Math.floor(Date.now() / 1000),
      onApply: async (m) => {
        if (acted) return;
        acted = true;
        await emit("event-snooze", { id: eventId, minutes: m });
      },
    })
  : document.getElementById("snooze-slot").remove();
