// Scheduled items: the quick-add event form + the events list page.
// (Named "schedule" to avoid colliding with DOM/Tauri "events"; mirrors the
// Rust `ScheduledEvent` type.) Existing function names keep their `Event*`
// names — only the file was renamed.

import { $, state, invoke, formatClock } from "./state.js";
import { closeEventDotPopover } from "./progress-bar.js";
import { render } from "./main.js";

// ===== Quick Add Event Form =====
let evtType = "reminder";            // "reminder" | "break"
let evtOverlay = "fullscreen";       // "fullscreen" | "mini"
let evtBreakMin = 15;
let evtBreakCustom = false;          // custom break duration mode (stepper shown)
let evtBreakEditing = false;         // custom break duration inline-edit mode
let evtTimeMode = "clock";           // "clock" (at HH:MM) | "relative" (in Xh Ym)
let evtRelMin = 5;                   // minutes from now (relative mode)
let evtRelEditing = false;           // relative time manual-edit mode
let evtRecurring = false;            // repeat daily toggle
let evtRecurDays = new Set();        // selected weekdays (0=Sun..6=Sat)
let editingConfirmMode = false;      // true when the form is editing an existing event
let eventsEditingId = null;          // id of the event being edited

const evtPanel = $("#event-add-panel");

function resetEventForm() {
  evtType = "reminder";
  evtOverlay = "fullscreen";
  evtBreakMin = 15;
  evtBreakCustom = false;
  hideEventBreakEditor();
  evtTimeMode = "clock";
  $("#event-title-input").value = "";
  // default clock = now + 30 min, rounded to next minute
  const def = new Date(Date.now() + 30 * 60 * 1000);
  def.setSeconds(0, 0);
  const hh = String(def.getHours()).padStart(2, "0");
  const mm = String(def.getMinutes()).padStart(2, "0");
  $("#event-clock-input").value = `${hh}:${mm}`;
  evtRelMin = 30;
  updateEventRelDisplay();
  closeEventRelEdit();
  evtRecurring = false;
  evtRecurDays = new Set();
  $("#event-recurring-toggle").checked = false;
  applyEventFormState();
}

// ===== Custom break duration editor (inline h/m + tick) =====
const BREAK_PRESET_MINS = [5, 10, 15, 20, 30, 60];

function customBreakLabel() {
  const h = Math.floor(evtBreakMin / 60);
  const m = evtBreakMin % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

function isBreakPreset() {
  return BREAK_PRESET_MINS.includes(evtBreakMin);
}

// Sync the h/m input fields to the current value
function syncEventBreakInputs() {
  $("#event-break-h-input").value = Math.floor(evtBreakMin / 60);
  $("#event-break-m-input").value = evtBreakMin % 60;
}

// Show the h/m editor in place of the "Custom" button
function showEventBreakEditor() {
  evtBreakEditing = true;
  syncEventBreakInputs();
  $("#event-break-custom-btn").hidden = true;
  $("#event-break-custom-editor").hidden = false;
  $("#event-break-h-input").focus();
  $("#event-break-h-input").select();
}

// Collapse the editor back to the value pill
function hideEventBreakEditor() {
  evtBreakEditing = false;
  $("#event-break-custom-editor").hidden = true;
  $("#event-break-custom-btn").hidden = false;
}

function saveEventBreakEdit() {
  const h = Math.max(0, parseInt($("#event-break-h-input").value) || 0);
  const m = Math.max(0, parseInt($("#event-break-m-input").value) || 0);
  evtBreakMin = Math.max(1, Math.min(h * 60 + m, 180));
  evtBreakCustom = !isBreakPreset();
  hideEventBreakEditor();
  applyEventFormState();
}

function applyEventFormState() {
  // type toggle
  document.querySelectorAll("#event-type-toggle .event-type-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.type === evtType);
  });
  // type-dependent field visibility
  $("#event-title-field").hidden = evtType !== "reminder";
  $("#event-duration-field").hidden = evtType !== "break";
  $("#event-overlay-field").hidden = evtType !== "reminder";
  // duration quick picks
  const presetMins = Array.from(document.querySelectorAll("#event-break-picks .break-quick-btn[data-min]"))
    .map(b => parseInt(b.dataset.min));
  const isPreset = presetMins.includes(evtBreakMin);
  document.querySelectorAll("#event-break-picks .break-quick-btn[data-min]").forEach(b => {
    b.classList.toggle("active", isPreset && parseInt(b.dataset.min) === evtBreakMin);
  });
  // Custom slot: shows "Custom" until a value is committed, then the value
  // with a pencil (editable). evtBreakCustom is the single source of truth.
  $("#event-break-custom-btn").classList.toggle("active", evtBreakCustom);
  $("#event-break-custom-label").textContent = evtBreakCustom ? customBreakLabel() : "Custom";
  // Toggle the pencil via attribute (SVG .hidden IDL property is unreliable).
  const pencilEl = document.getElementById("event-break-custom-pencil");
  if (pencilEl) {
    if (evtBreakCustom) pencilEl.removeAttribute("hidden");
    else pencilEl.setAttribute("hidden", "");
  }
  if (!evtBreakEditing) syncEventBreakInputs();
  // Selecting a preset collapses any open editor
  if (isPreset && evtBreakEditing) hideEventBreakEditor();
  // overlay pills
  document.querySelectorAll("#event-overlay-toggle .event-pill-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.overlay === evtOverlay);
  });
  // time mode
  const isClock = evtTimeMode === "clock";
  $("#event-time-clock").hidden = !isClock;
  $("#event-time-relative").hidden = isClock;
  $("#event-mode-btn").textContent = isClock ? "in Xh Ym" : "at HH:MM";
  // recurring field only available in clock mode
  $("#event-recurring-field").hidden = !isClock;
  $("#event-day-picks").hidden = !isClock || !evtRecurring;
  $("#event-recurring-toggle").checked = evtRecurring;
  document.querySelectorAll("#event-day-picks .event-day-btn").forEach(b => {
    b.classList.toggle("active", evtRecurDays.has(parseInt(b.dataset.day)));
  });
}

function computeEventTriggerAt() {
  const now = Math.floor(Date.now() / 1000);
  if (evtTimeMode === "relative") {
    return now + evtRelMin * 60;
  }
  // clock mode: today's HH:MM, or tomorrow if already past
  const [hh, mm] = ($("#event-clock-input").value || "00:00").split(":").map(Number);
  const d = new Date();
  d.setHours(hh || 0, mm || 0, 0, 0);
  let ts = Math.floor(d.getTime() / 1000);
  if (ts <= now) ts += 24 * 3600;
  return ts;
}

// ===== Relative time stepper (- 0h 05m +) =====
function updateEventRelDisplay() {
  const h = Math.floor(evtRelMin / 60);
  const m = evtRelMin % 60;
  $("#event-rel-display").textContent = `${h}h ${String(m).padStart(2, "0")}m`;
}

function openEventRelEdit() {
  evtRelEditing = true;
  const h = Math.floor(evtRelMin / 60);
  const m = evtRelMin % 60;
  $("#event-rel-h-input").value = h;
  $("#event-rel-m-input").value = m;
  $("#event-rel-display").hidden = true;
  $("#event-rel-edit").hidden = false;
  $("#event-rel-down").hidden = true;
  $("#event-rel-up").hidden = true;
  $("#event-rel-tick").hidden = false;
  $("#event-rel-value").classList.add("editing");
  $("#event-rel-h-input").focus();
  $("#event-rel-h-input").select();
}

function closeEventRelEdit() {
  evtRelEditing = false;
  $("#event-rel-display").hidden = false;
  $("#event-rel-edit").hidden = true;
  $("#event-rel-down").hidden = false;
  $("#event-rel-up").hidden = false;
  $("#event-rel-tick").hidden = true;
  $("#event-rel-value").classList.remove("editing");
}

function saveEventRelEdit() {
  const h = Math.max(0, parseInt($("#event-rel-h-input").value) || 0);
  const m = Math.max(0, parseInt($("#event-rel-m-input").value) || 0);
  evtRelMin = Math.max(1, Math.min(h * 60 + m, 1440));
  updateEventRelDisplay();
  closeEventRelEdit();
}

function snapRelUp(mins) {
  if (mins < 30) return 30;
  return Math.min(Math.ceil((mins + 1) / 30) * 30, 1440);
}

function snapRelDown(mins) {
  if (mins <= 30) return 5;
  return Math.max(Math.floor((mins - 1) / 30) * 30, 5);
}

$("#event-rel-up").addEventListener("click", () => {
  evtRelMin = snapRelUp(evtRelMin);
  updateEventRelDisplay();
});

$("#event-rel-down").addEventListener("click", () => {
  evtRelMin = snapRelDown(evtRelMin);
  updateEventRelDisplay();
});

$("#event-rel-value").addEventListener("click", () => {
  if (!evtRelEditing) openEventRelEdit();
});

$("#event-rel-tick").addEventListener("click", saveEventRelEdit);

$("#event-rel-h-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveEventRelEdit();
  if (e.key === "Escape") closeEventRelEdit();
});

$("#event-rel-m-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveEventRelEdit();
  if (e.key === "Escape") closeEventRelEdit();
});

$("#btn-event-add").addEventListener("click", () => {
  if (evtPanel.hidden) {
    resetEventForm();
    evtPanel.hidden = false;
  } else {
    evtPanel.hidden = true;
  }
});

$("#event-add-cancel").addEventListener("click", () => {
  evtPanel.hidden = true;
});

$("#event-add-close").addEventListener("click", () => {
  evtPanel.hidden = true;
  editingConfirmMode = false;
  eventsEditingId = null;
});

document.querySelectorAll("#event-type-toggle .event-type-btn").forEach(b => {
  b.addEventListener("click", () => {
    evtType = b.dataset.type;
    applyEventFormState();
  });
});

document.querySelectorAll("#event-overlay-toggle .event-pill-btn").forEach(b => {
  b.addEventListener("click", () => {
    evtOverlay = b.dataset.overlay;
    applyEventFormState();
  });
});

$("#event-recurring-toggle").addEventListener("change", (e) => {
  evtRecurring = e.target.checked;
  // Default to weekdays if turning on with nothing selected
  if (evtRecurring && evtRecurDays.size === 0) {
    evtRecurDays = new Set([1, 2, 3, 4, 5]);
  }
  if (!evtRecurring) evtRecurDays = new Set();
  applyEventFormState();
});

document.querySelectorAll("#event-day-picks .event-day-btn").forEach(b => {
  b.addEventListener("click", () => {
    const day = parseInt(b.dataset.day);
    if (evtRecurDays.has(day)) evtRecurDays.delete(day);
    else evtRecurDays.add(day);
    applyEventFormState();
  });
});

document.querySelectorAll("#event-break-picks .break-quick-btn[data-min]").forEach(b => {
  b.addEventListener("click", () => {
    evtBreakMin = parseInt(b.dataset.min);
    evtBreakCustom = false;
    applyEventFormState();
  });
});

// "Custom" button → reveal the h/m editor with a tick (re-edit if already set)
$("#event-break-custom-btn").addEventListener("click", () => {
  if (evtBreakEditing) return;
  showEventBreakEditor();
});
$("#event-break-tick").addEventListener("click", saveEventBreakEdit);
$("#event-break-h-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveEventBreakEdit();
  if (e.key === "Escape") { hideEventBreakEditor(); applyEventFormState(); }
});
$("#event-break-m-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveEventBreakEdit();
  if (e.key === "Escape") { hideEventBreakEditor(); applyEventFormState(); }
});

$("#event-mode-btn").addEventListener("click", () => {
  evtTimeMode = evtTimeMode === "clock" ? "relative" : "clock";
  applyEventFormState();
});

$("#event-add-confirm").addEventListener("click", async () => {
  const trigger_at = computeEventTriggerAt();
  const title = $("#event-title-input").value.trim();
  if (evtType === "reminder" && !title) {
    $("#event-title-input").focus();
    return;
  }
  // Recurring only applies in clock mode with the toggle on
  const recurringDays = (evtTimeMode === "clock" && evtRecurring)
    ? Array.from(evtRecurDays)
    : [];
  const payload = {
    eventType: evtType,
    title: evtType === "reminder" ? title : "",
    triggerAt: trigger_at,
    durationSecs: evtType === "break" ? evtBreakMin * 60 : 0,
    overlayType: evtOverlay,
    recurringDays,
  };
  if (editingConfirmMode && eventsEditingId != null) {
    state.current = await invoke("update_event", { id: eventsEditingId, ...payload });
    editingConfirmMode = false;
    eventsEditingId = null;
  } else {
    state.current = await invoke("create_event", payload);
  }
  evtPanel.hidden = true;
  render();
});

// ===== Events List Page =====
const eventsPage = $("#events-page");
let eventsListTick = null;

function openEventsList() {
  eventsPage.hidden = false;
  renderEventsList();
  startEventsListTick();
}

$("#btn-events-list").addEventListener("click", openEventsList);

// Clicking a progress-bar overflow badge (+N) opens Today's Events so the user
// can see what's beyond the bar.
$("#event-overflow-left").addEventListener("click", openEventsList);
$("#event-overflow-inactive").addEventListener("click", openEventsList);
$("#event-overflow-right").addEventListener("click", openEventsList);

$("#events-back").addEventListener("click", () => {
  eventsPage.hidden = true;
  stopEventsListTick();
  eventsEditingId = null;
});

function openEventForm(type) {
  eventsPage.hidden = true;
  stopEventsListTick();
  resetEventForm();
  if (type) {
    evtType = type;
    applyEventFormState();
  }
  evtPanel.hidden = false;
}

$("#events-add-reminder").addEventListener("click", () => openEventForm("reminder"));
$("#events-add-break").addEventListener("click", () => openEventForm("break"));

function startEventsListTick() {
  stopEventsListTick();
  eventsListTick = setInterval(() => {
    if (!eventsPage.hidden) tickEventRowTimes();
  }, 1000);
}

function stopEventsListTick() {
  if (eventsListTick) {
    clearInterval(eventsListTick);
    eventsListTick = null;
  }
}

// Summarize recurring weekdays into a compact label, e.g. "Daily", "Mon-Fri", "Mon, Wed, Fri"
export function formatRecurringDays(days) {
  const arr = (days || []).slice().sort((a, b) => a - b);
  if (arr.length === 0) return "";
  if (arr.length === 7) return "Daily";
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  // Mon-Fri weekday run
  const weekday = [1, 2, 3, 4, 5];
  const isWeekday = weekday.every(d => arr.includes(d)) && arr.length === 5;
  if (isWeekday) return "Mon-Fri";
  return arr.map(d => names[d]).join(", ");
}

// Compute the meta line for a single event (clock · status/countdown)
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// "5:35pm" today, or "Wed 5:35pm" if the trigger falls on a different day.
function formatClockWithDay(unixSecs, nowSecs) {
  const d = new Date(unixSecs * 1000);
  const now = new Date(nowSecs * 1000);
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
  const clock = formatClock(unixSecs);
  return sameDay ? clock : `${WEEKDAYS[d.getDay()]} ${clock}`;
}

export function eventMetaText(ev, now) {
  // Dormant recurring event (not scheduled today): count down to the next
  // scheduled fire instead of showing "triggered". The backend advances
  // trigger_at to that next fire on creation/rollover, so formatRelative
  // produces e.g. "in 1d 2h 30m".
  const isDormantRecurring = ev.triggered
    && !ev.recurred_today
    && (ev.recurring_days || []).length > 0;
  if (ev.triggered && !isDormantRecurring) {
    if (ev.miss_reason === "skipped") {
      return `${formatClockWithDay(ev.trigger_at, now)} · skipped for today`;
    }
    if (ev.miss_reason === "inactive" || ev.miss_reason === "replaced") {
      return `${formatClockWithDay(ev.trigger_at, now)} · missed (away)`;
    }
    if (ev.miss_reason === "before_work") {
      return `${formatClockWithDay(ev.trigger_at, now)} · missed (before work)`;
    }
    return `${formatClockWithDay(ev.trigger_at, now)} · triggered`;
  }
  if (ev.snoozed_until) {
    const left = Math.max(0, Math.ceil(ev.snoozed_until - now));
    const m = Math.floor(left / 60);
    if (m > 0) return `${formatClockWithDay(ev.trigger_at, now)} · snoozed (${m}m)`;
    return `${formatClockWithDay(ev.trigger_at, now)} · snoozed (${left}s)`;
  }
  return `${formatClockWithDay(ev.trigger_at, now)} · ${formatRelative(ev.trigger_at, now)}`;
}

// Live-update only the meta text and state styling on each row (avoids full
// re-render). This keeps triggered/snoozed styling in sync when an event fires
// or a snooze elapses while the page is open.
function tickEventRowTimes() {
  const now = Math.floor(Date.now() / 1000);
  const rows = document.querySelectorAll("#events-list .event-row");
  rows.forEach(row => {
    const id = parseInt(row.dataset.id);
    const ev = state.current.events.find(e => e.id === id);
    if (!ev) return;
    const textEl = row.querySelector(".event-row-meta-text");
    if (textEl) textEl.textContent = eventMetaText(ev, now);
    // Sync state-driven classes so a row fades/unsnoozes live without re-open.
    // Dormant recurring (not scheduled today) is treated as upcoming, not faded.
    const isDormantRecurring = ev.triggered && !ev.recurred_today && (ev.recurring_days || []).length > 0;
    const isDone = ev.triggered && !isDormantRecurring;
    row.classList.toggle("event-row-triggered", isDone);
    row.classList.toggle("event-row-snoozed", !isDone && !!ev.snoozed_until);
    // Dot: triggered → gray; otherwise keep its break/reminder color.
    const dot = row.querySelector(".event-row-dot");
    if (dot) dot.classList.toggle("triggered-dot", isDone);
  });
}

// Load an existing event into the quick-add form in "edit" mode. Used by both
// the events list row Edit button and the progress-bar dot popover.
export function enterEditMode(id) {
  const ev = state.current.events.find(e => e.id === id);
  if (!ev) return;
  eventsEditingId = id;
  // Load event into quick-add form
  evtType = ev.event_type;
  evtOverlay = ev.overlay_type || "fullscreen";
  evtBreakMin = Math.max(1, Math.round((ev.duration_secs || 0) / 60));
  $("#event-title-input").value = ev.title || "";
  evtTimeMode = "clock";
  const d = new Date(ev.trigger_at * 1000);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  $("#event-clock-input").value = `${hh}:${mm}`;
  evtRelMin = 30;
  updateEventRelDisplay();
  closeEventRelEdit();
  // Load recurring state
  const days = ev.recurring_days || [];
  evtRecurring = days.length > 0;
  evtRecurDays = new Set(days);
  applyEventFormState();
  eventsPage.hidden = true;
  evtPanel.hidden = false;
  // Swap confirm handler to update mode
  editingConfirmMode = true;
  // Close the dot popover if it's open
  closeEventDotPopover();
}

export function renderEventsList() {
  const list = $("#events-list");
  const events = (state.current.events || []).slice().sort((a, b) => a.trigger_at - b.trigger_at);
  if (events.length === 0) {
    list.innerHTML = `<div class="events-empty"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="17" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="16" y1="2" x2="16" y2="6"/></svg><span>No events scheduled for today.<br>Click "Add Reminder" or "Add Scheduled Break" to create one.</span></div>`;
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  const todayKey = state.current?.date || "";
  list.innerHTML = events.map(ev => {
    const isBreak = ev.event_type === "break";
    const isRecurring = (ev.recurring_days || []).length > 0;
    // Dormant recurring (not scheduled today) is treated as upcoming, not faded.
    const isDormantRecurring = ev.triggered && !ev.recurred_today && isRecurring;
    const isDone = ev.triggered && !isDormantRecurring;
    // Does this event fire within today's effective tracking window? Used to
    // gate the skip button — skipping only makes sense for today's occurrence.
    const evDate = new Date(ev.trigger_at * 1000);
    const evKey = `${evDate.getFullYear()}-${String(evDate.getMonth() + 1).padStart(2, "0")}-${String(evDate.getDate()).padStart(2, "0")}`;
    const firesToday = !todayKey || evKey === todayKey;
    let stateClass = "";
    if (isDone) stateClass = "event-row-triggered";
    else if (ev.snoozed_until) stateClass = "event-row-snoozed";
    const dotClass = isBreak ? "break-dot" : "" + (isDone ? " triggered-dot" : "");
    const title = isBreak ? `Break (${Math.round(ev.duration_secs / 60)}m)` : (ev.title || "Reminder");
    const meta = eventMetaText(ev, now);
    const recurLabel = isRecurring ? formatRecurringDays(ev.recurring_days) : "";
    const badgeText = isBreak ? "Break" : (ev.overlay_type === "mini" ? "Mini" : "Fullscreen");
    const badgeClass = isBreak ? "event-badge-break" : (ev.overlay_type === "mini" ? "event-badge-mini" : "event-badge-fullscreen");
    const recurBadge = isRecurring
      ? `<span class="event-badge event-badge-recurring" title="Recurring">${recurLabel}</span>`
      : "";
    const editIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
    const trashIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
    // Skip button: only for recurring events armed to fire today (not yet
    // triggered, not dormant-for-another-day). After skip → triggered + done
    // for today, re-armed next scheduled day at rollover.
    const skipIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/></svg>`;
    const canSkip = isRecurring && !isDone && firesToday;
    const skipBtn = canSkip
      ? `<button class="event-row-btn" data-action="skip" data-tooltip="Skip for today">${skipIcon}</button>`
      : "";
    return `
      <div class="event-row ${stateClass}" data-id="${ev.id}">
        <div class="event-row-dot ${dotClass}"></div>
        <div class="event-row-info">
          <div class="event-row-title">${escapeHtml(title)}</div>
          <div class="event-row-meta"><span class="event-row-meta-text">${meta}</span><span class="event-badge ${badgeClass}">${badgeText}</span>${recurBadge}</div>
        </div>
        <div class="event-row-actions">
          ${skipBtn}
          <button class="event-row-btn" data-action="edit" data-tooltip="Edit">${editIcon}</button>
          <button class="event-row-btn danger" data-action="remove" data-tooltip="Remove">${trashIcon}</button>
        </div>
      </div>`;
  }).join("");

  // Wire row actions
  list.querySelectorAll(".event-row").forEach(row => {
    const id = parseInt(row.dataset.id);
    row.querySelector('[data-action="remove"]').addEventListener("click", async () => {
      state.current = await invoke("delete_event", { id });
      renderEventsList();
      render();
    });
    row.querySelector('[data-action="edit"]').addEventListener("click", () => {
      enterEditMode(id);
    });
    const skipBtnEl = row.querySelector('[data-action="skip"]');
    if (skipBtnEl) {
      skipBtnEl.addEventListener("click", async () => {
        state.current = await invoke("skip_event", { id });
        renderEventsList();
        render();
      });
    }
  });
}

// (confirm handler defined above supports both create and edit)

function formatRelative(targetTs, nowTs) {
  const diff = targetTs - nowTs;
  if (diff <= 0) return "due now";
  const m = Math.floor(diff / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  const hr = h % 24;
  const mr = m % 60;
  if (d > 0) return `in ${d}d ${hr}h ${mr}m`;
  if (h > 0) return `in ${h}h ${mr}m`;
  if (m > 0) return `in ${m}m`;
  return `in ${diff}s`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
