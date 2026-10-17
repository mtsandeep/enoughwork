// Task sub-timers: the compact strip above the main timer, the full-window
// expanded page (ring + controls + tabs), and the popout floating window.
// Rendering is fed by the main render() loop; all actions go through the
// Rust task commands and re-render via main.js.

import { $, state, invoke, listen, emit, WebviewWindow } from "./state.js";
import { render } from "./main.js";

function nowSecs() {
  return Math.floor(Date.now() / 1000);
}

export function taskRemainingSecs(ev, now = nowSecs()) {
  if (ev.task_state === "running" && ev.task_ends_at) return Math.max(0, ev.task_ends_at - now);
  // Paused and stopped both freeze their remaining time (stopped keeps it so
  // the display holds the position where the task ended).
  if (ev.task_state === "paused" || ev.task_state === "stopped") return ev.task_remaining_secs || 0;
  return 0;
}

function tasksOf(st) {
  return (st?.events || []).filter((e) => e.event_type === "task");
}

// Live sub-timers, soonest-ending first (running before paused).
function activeTasks(st) {
  const now = nowSecs();
  return tasksOf(st)
    .filter((e) => e.task_state === "running" || e.task_state === "paused")
    .sort((a, b) => {
      const pa = a.task_state === "running" ? 0 : 1;
      const pb = b.task_state === "running" ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return taskRemainingSecs(a, now) - taskRemainingSecs(b, now);
    });
}

// What the strip shows: the most urgent live task. A manual stop lingers on
// the strip for a few seconds (frozen time + Restart) before it disappears;
// completed tasks hide immediately (the completion card owns Done/Restart).
let stripLinger = null; // { id, untilSecs }
let lingerTimer = null;
const prevTaskStates = new Map(); // id -> task_state at last render

function updateLinger(tasks, now) {
  for (const t of tasks) {
    const prev = prevTaskStates.get(t.id);
    if (prev && (prev === "running" || prev === "paused") && t.task_state === "stopped") {
      stripLinger = { id: t.id, until: now + 5 };
      if (lingerTimer) clearTimeout(lingerTimer);
      lingerTimer = setTimeout(render, 5000);
    }
    prevTaskStates.set(t.id, t.task_state);
  }
  // Expired, or the task moved on (restarted/deleted) — drop the linger.
  if (stripLinger) {
    const t = tasks.find((e) => e.id === stripLinger.id);
    if (now >= stripLinger.until || !t || t.task_state !== "stopped") {
      stripLinger = null;
    }
  }
}

function displayTask(st) {
  const live = activeTasks(st)[0];
  if (live) return live;
  if (stripLinger) {
    const t = (st.events || []).find((e) => e.id === stripLinger.id);
    if (t && t.task_state === "stopped") return t;
  }
  return null;
}

function setText(el, str) {
  if (el.textContent !== str) el.textContent = str;
}

function setHidden(el, v) {
  if (el.hidden !== v) el.hidden = v;
}

// ===== Strip =====
function renderStrip(st) {
  const strip = $("#task-strip");
  const display = displayTask(st);
  const show = display && display.id !== popoutTaskId;
  setHidden(strip, !show);
  if (!show || !display) return;

  const now = nowSecs();
  const total = display.duration_secs || 0;
  const elapsed = Math.max(0, total - taskRemainingSecs(display, now));

  setText($("#task-strip-title"), display.title || "Task");
  setText($("#task-strip-time"), formatClockTime(elapsed));
  const stState = display.task_state;
  strip.classList.toggle("paused", stState === "paused");
  strip.classList.toggle("stopped", stState === "stopped");

  // Buttons stay in place across state changes; inapplicable ones disable
  // (e.g. pause/stop/popout during the post-stop linger — no layout shift).
  const live = stState === "running" || stState === "paused";
  $("#task-strip-toggle").disabled = !live;
  $("#task-strip-stop").disabled = !live;
  $("#task-strip-popout").disabled = !live;
  $("#task-strip-restart").disabled = !(live || stState === "stopped");
  const paused = display.task_state === "paused";
  $("#task-strip-ic-pause").style.display = paused ? "none" : "";
  $("#task-strip-ic-play").style.display = paused ? "" : "none";
  $("#task-strip-toggle").title = paused ? "Resume" : "Pause";

  const actives = activeTasks(st);
  const extra = actives.filter((e) => e.id !== display.id).length;
  const countEl = $("#task-strip-count");
  setHidden(countEl, extra <= 0);
  if (extra > 0) setText(countEl, `+${extra}`);
}

// ===== Expanded page =====
let pageOpen = false;
let pageTaskId = null;
const CIRCUMFERENCE = 2 * Math.PI * 88;

// Without a dash pattern the offset has no effect — the ring would draw as a
// full circle (same setup as the break countdown ring).
$("#task-ring-fill").style.strokeDasharray = CIRCUMFERENCE;

function formatClockTime(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatDurShort(secs) {
  const m = Math.round(secs / 60);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}

function renderPage(st) {
  const page = $("#task-page");
  setHidden(page, false);
  const tasks = tasksOf(st);
  const actives = activeTasks(st);
  const sel =
    tasks.find((e) => e.id === pageTaskId && e.task_state !== "dismissed") ||
    actives[0] ||
    tasksOf(st).find((e) => e.task_state === "done") ||
    null;
  if (!sel) {
    closeTaskPage();
    return;
  }
  pageTaskId = sel.id;

  const now = nowSecs();
  const remaining = taskRemainingSecs(sel, now);
  const total = sel.duration_secs || 0;
  const isDone = sel.task_state === "done";
  const isStopped = sel.task_state === "stopped";
  const live = sel.task_state === "running" || sel.task_state === "paused";

  setText($("#task-page-title"), sel.title || "Task");
  const timeEl = $("#task-page-time");
  // Elapsed counting up from 0; done shows the full block, stopped freezes
  // where it ended. Clamped so a duration edit can never render negative.
  setText(timeEl, formatClockTime(Math.max(0, Math.min(total, total - remaining))));
  timeEl.classList.toggle("has-hours", total >= 3600);
  setText($("#task-page-sub"), `of ${formatClockTime(total)}`);

  const stateEl = $("#task-page-state");
  const stateText =
    sel.task_state === "paused" ? "Paused"
    : isDone ? "Done ✓"
    : isStopped ? "Stopped"
    : "";
  setText(stateEl, stateText);

  // Ring: fills up as the task progresses — same direction as the popout bar.
  const ringFill = $("#task-ring-fill");
  const elapsed = Math.max(0, Math.min(total, total - remaining));
  const frac = total > 0 ? Math.min(Math.max(elapsed / total, 0), 1) : 0;
  ringFill.style.strokeDashoffset = CIRCUMFERENCE * (1 - frac);
  $("#task-page-body").classList.toggle("task-done", isDone);
  $("#task-page-body").classList.toggle("task-paused", sel.task_state === "paused");

  // Controls stay in place across state changes; inapplicable ones disable.
  const paused = sel.task_state === "paused";
  const toggleBtn = $("#task-page-toggle");
  $("#task-page-ic-pause").style.display = paused ? "none" : "";
  $("#task-page-ic-play").style.display = paused ? "" : "none";
  setText($("#task-page-toggle-label"), paused ? "Resume" : "Pause");
  toggleBtn.disabled = !live;
  $("#task-page-stop").disabled = !live;
  $("#task-page-restart").disabled = !(live || isDone || isStopped);
  // Pop Out works in every state — it just shows the frozen timer + Restart.
  $("#task-page-popout").disabled = false;
  setHidden($("#task-page-dismiss"), !isDone);

  // Tabs across live/finished tasks when more than one is in play.
  const tabsEl = $("#task-tabs");
  const others = tasksOf(st).filter((e) => e.task_state !== "dismissed" && e.id !== sel.id);
  setHidden(tabsEl, others.length === 0);
  if (others.length > 0) {
    const wanted = [sel, ...others]
      .map((e) => {
        const eTotal = e.duration_secs || 0;
        const label = e.id === sel.id
          ? (e.title || "Task")
          : `${e.title || "Task"} · ${formatDurShort(Math.max(0, eTotal - taskRemainingSecs(e, now)))}`;
        return `<button class="task-tab${e.id === sel.id ? " active" : ""}" data-id="${e.id}">${escapeHtml(label)}</button>`;
      })
      .join("");
    if (tabsEl.innerHTML !== wanted) tabsEl.innerHTML = wanted;
    tabsEl.querySelectorAll(".task-tab").forEach((b) => {
      b.addEventListener("click", () => {
        pageTaskId = parseInt(b.dataset.id, 10);
        render();
      });
    });
  } else if (tabsEl.innerHTML !== "") {
    tabsEl.innerHTML = "";
  }
}

function openTaskPage(id) {
  pageOpen = true;
  pageTaskId = id ?? null;
  render();
}

function closeTaskPage() {
  pageOpen = false;
  pageTaskId = null;
  setHidden($("#task-page"), true);
}

// ===== Popout floating window =====
let popoutWin = null;
let popoutTaskId = null;

export function isTaskPopoutOpen() {
  return popoutTaskId != null;
}

export async function openTaskPopout(id) {
  const ev = state.current?.events?.find((e) => e.id === id);
  if (!ev) return;
  await closeTaskPopout();
  const now = nowSecs();
  const url =
    `src/windows/task-timer.html?id=${id}&title=${encodeURIComponent(ev.title || "Task")}` +
    `&remaining=${taskRemainingSecs(ev, now)}&total=${ev.duration_secs || 0}&state=${ev.task_state}`;
  popoutTaskId = id;
  closeTaskPage();
  try {
    popoutWin = new WebviewWindow("task-timer-0", {
      url,
      width: 300,
      height: 140,
      transparent: true,
      decorations: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      title: "EnoughWork",
    });
    popoutWin.once("tauri://destroyed", () => {
      popoutWin = null;
      popoutTaskId = null;
      render();
    });
  } catch (e) {
    console.error("Task popout failed:", e);
    popoutWin = null;
    popoutTaskId = null;
  }
  render();
}

export async function closeTaskPopout() {
  if (popoutWin) {
    try { await popoutWin.close(); } catch {}
  }
  popoutWin = null;
  popoutTaskId = null;
}

// ===== Entry point from the main render loop =====
// The main window reports its visibility; when hidden to tray with a popout
// open, we skip the strip/page DOM work (the earlier CPU discipline) and only
// feed the popout its tick.
let windowVisible = true;
export function setTaskWindowVisible(v) {
  windowVisible = v;
}

function emitTaskTick(st) {
  if (popoutTaskId == null) return;
  const pt = (st.events || []).find(
    (e) => e.id === popoutTaskId && e.task_state !== "dismissed"
  );
  if (pt) {
    emit("task-tick", {
      id: pt.id,
      title: pt.title,
      state: pt.task_state,
      remaining: taskRemainingSecs(pt),
      total: pt.duration_secs || 0,
    });
  } else {
    closeTaskPopout();
  }
}

export function renderTaskUI(st) {
  if (!st) return;
  if (!windowVisible) {
    emitTaskTick(st);
    return;
  }
  updateLinger(tasksOf(st), nowSecs());
  renderStrip(st);

  if (pageOpen) renderPage(st);
  else setHidden($("#task-page"), true);

  emitTaskTick(st);
}

// ===== Actions =====
async function runTaskCommand(cmd, id, extra = {}) {
  state.current = await invoke(cmd, { id, ...extra });
  render();
}

function stripTaskId() {
  const d = displayTask(state.current);
  return d ? d.id : null;
}

$("#task-strip-main").addEventListener("click", () => {
  const id = stripTaskId();
  if (id != null) openTaskPage(id);
});

$("#task-strip-toggle").addEventListener("click", () => {
  const d = displayTask(state.current);
  if (!d) return;
  runTaskCommand(d.task_state === "paused" ? "resume_task" : "pause_task", d.id);
});

$("#task-strip-restart").addEventListener("click", () => {
  const id = stripTaskId();
  if (id != null) runTaskCommand("restart_task", id);
});

$("#task-strip-stop").addEventListener("click", () => {
  const id = stripTaskId();
  if (id != null) runTaskCommand("stop_task", id);
});

$("#task-strip-popout").addEventListener("click", () => {
  const id = stripTaskId();
  if (id != null) openTaskPopout(id);
});

$("#task-page-close").addEventListener("click", closeTaskPage);

$("#task-page-toggle").addEventListener("click", () => {
  if (pageTaskId == null) return;
  const ev = state.current?.events?.find((e) => e.id === pageTaskId);
  if (!ev) return;
  runTaskCommand(ev.task_state === "paused" ? "resume_task" : "pause_task", pageTaskId);
});

$("#task-page-restart").addEventListener("click", () => {
  if (pageTaskId != null) runTaskCommand("restart_task", pageTaskId);
});

$("#task-page-stop").addEventListener("click", () => {
  if (pageTaskId != null) runTaskCommand("stop_task", pageTaskId);
});

$("#task-page-popout").addEventListener("click", () => {
  if (pageTaskId != null) openTaskPopout(pageTaskId);
});

$("#task-page-dismiss").addEventListener("click", () => {
  if (pageTaskId != null) runTaskCommand("dismiss_task", pageTaskId);
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && pageOpen) closeTaskPage();
});

// Actions from the popout window (pause/resume/restart/stop/pop-in).
listen("task-action", async (event) => {
  const { id, action } = event.payload;
  if (id == null) return;
  if (action === "popin") {
    // Return to the main window strip — not the expanded page.
    await closeTaskPopout();
    render();
    return;
  }
  const cmd = {
    pause: "pause_task",
    resume: "resume_task",
    restart: "restart_task",
    stop: "stop_task",
  }[action];
  if (cmd) await runTaskCommand(cmd, id);
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
