import { computePosition, flip, shift, offset as floatingOffset } from "@floating-ui/dom";
import { $, state, invoke, formatClock } from "./state.js";
import { formatRecurringDays, eventMetaText, enterEditMode } from "./schedule.js";
import { render } from "./main.js";

// Format a unix timestamp's date as YYYY-MM-DD in local time.
function localDateKey(unixSecs) {
  const d = new Date(unixSecs * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Does this event fire within the current effective day (today, before reset)?
// state.current.date is the effective date the backend computed using the
// configured reset time, so comparing the trigger's local date to it tells us
// whether the event belongs to today's tracking window. Dormant recurring
// events point to a future day by construction, so they're excluded too.
function firesToday(ev) {
  if (!state.current || !state.current.date) return true; // unknown → show (safe default)
  return localDateKey(ev.trigger_at) === state.current.date;
}

const EVENT_DOT_DIAMETER = 8;
// Negative gap => dots overlap by half (centers 4px apart = diameter / 2).
const EVENT_DOT_GAP = -4;

let eventPopoverId = null; // id of event shown in the popover
let eventPopoverTick = null; // live-update interval for the popover's meta text
let dotResizeRaf = 0;

export function renderEventMarkers(barEl, svgNS, limit_secs, elapsed_secs) {
  const dotsHost = document.getElementById("event-dots");

  const events = state.current.events || [];
  const now = Math.floor(Date.now() / 1000);

  // Index existing dots by event id so we can update them in place rather
  // than recreating them every tick. Rebuilding each tick would destroy the
  // node under the cursor and reset :hover / .is-active, making the hover
  // highlight pulsate once per second.
  const existing = new Map(); // eventId -> element
  if (dotsHost) {
    for (const el of dotsHost.querySelectorAll(".event-dot")) {
      if (el.dataset.eventId != null) {
        existing.set(String(el.dataset.eventId), el);
      }
    }
  }
  const seen = new Set();

  // Position = fraction of elapsed axis (the same axis the blue fill uses).
  // For upcoming events, estimate the elapsed time at trigger using a simple
  // rate of 1 elapsed-sec per wall-clock sec while time is running.
  let leftCount = 0;
  let inactiveCount = 0;
  let rightCount = 0;
  const leftTitles = [];
  const inactiveTitles = [];
  const rightTitles = [];
  const dots = []; // {el, pct}

  for (const ev of events) {
    // Only show events that fire within today's tracking window. A dormant
    // recurring event (e.g. Mon/Wed on a Tuesday) or any future-dated event
    // is excluded from both dots and the +N overflow badge.
    if (!firesToday(ev)) continue;

    let x; // percentage position on bar (elapsed / limit)
    const triggered = ev.triggered;
    // Missed: marked done without ever firing. Split by reason:
    // inactive/replaced → gray +N; before_work / legacy → amber left +N.
    const missed = triggered && ev.elapsed_at_trigger == null;

    if (missed) {
      const reason = ev.miss_reason || "before_work";
      if (reason === "inactive" || reason === "replaced") {
        inactiveCount++;
        inactiveTitles.push(formatEventTitle(ev));
      } else {
        leftCount++;
        leftTitles.push(formatEventTitle(ev));
      }
      continue;
    }

    if (triggered && ev.elapsed_at_trigger != null) {
      // Already fired: place at the elapsed time captured at trigger
      x = limit_secs > 0 ? (ev.elapsed_at_trigger / limit_secs) * 100 : 0;
    } else {
      // Upcoming (or past-but-not-yet-marked): estimate elapsed at trigger
      // (~1:1 with wall-clock). Allow negative secsUntil so a clock time
      // before any work lands left of the bar (x < 0 → left +N).
      const secsUntil = ev.trigger_at - now;
      const estElapsed = elapsed_secs + secsUntil;
      x = limit_secs > 0 ? (estElapsed / limit_secs) * 100 : 200;
    }

    // Out-of-range → counts for +N badges
    if (x < 0) {
      leftCount++;
      leftTitles.push(formatEventTitle(ev));
      continue;
    }
    if (x > 100) {
      rightCount++;
      rightTitles.push(formatEventTitle(ev));
      continue;
    }

    // A fired break already has a teal .progress-break segment (sized by its
    // duration), so a dot would be redundant — skip it. Missed breaks are
    // handled above as left overflow, not here.
    if (triggered && ev.event_type === "break") continue;

    // Reuse the existing dot for this event if present, else create one.
    // (True circle via HTML — the non-uniformly stretched SVG would squash an
    // SVG <circle> into an ellipse.)
    const key = String(ev.id);
    let el = existing.get(key);
    if (!el) {
      el = document.createElement("div");
      el.className = "event-dot";
      el.dataset.eventId = ev.id;
      if (dotsHost) dotsHost.appendChild(el);
    }
    // Keep class/label fresh without recreating the node.
    el.classList.toggle("triggered", !!triggered);
    el.classList.toggle("break-type", ev.event_type === "break");
    el.dataset.eventLabel = formatEventLabel(ev);
    seen.add(key);
    dots.push({ el, pct: Math.min(x, 100) });
  }

  // Drop dots for events that are no longer visible on the bar.
  if (dotsHost) {
    for (const [key, el] of existing) {
      if (!seen.has(key)) el.remove();
    }
  }

  // Position dots: convert each to pixels, then spread overlapping ones
  // side-by-side so close events stay individually clickable.
  if (dotsHost) positionEventDots(dotsHost, dots);

  // Overflow badges
  const leftBadge = $("#event-overflow-left");
  const inactiveBadge = $("#event-overflow-inactive");
  const rightBadge = $("#event-overflow-right");
  if (inactiveCount > 0) {
    inactiveBadge.textContent = `+${inactiveCount}`;
    inactiveBadge.title = "Missed while system not active\n" + inactiveTitles.join("\n");
    inactiveBadge.hidden = false;
  } else {
    inactiveBadge.hidden = true;
  }
  if (leftCount > 0) {
    leftBadge.textContent = `+${leftCount}`;
    leftBadge.title = leftTitles.join("\n");
    leftBadge.hidden = false;
  } else {
    leftBadge.hidden = true;
  }
  if (rightCount > 0) {
    rightBadge.textContent = `+${rightCount}`;
    rightBadge.title = rightTitles.join("\n");
    rightBadge.hidden = false;
  } else {
    rightBadge.hidden = true;
  }
}

// Lay out event dots along the bar. Each dot's natural X reflects its real
// time position; when neighbors overlap they are nudged apart horizontally
// ("spread along bar"), so X becomes approximate only where collisions occur.
function positionEventDots(host, dots) {
  const W = host.clientWidth;
  if (W <= 0) return;
  const r = EVENT_DOT_DIAMETER / 2;
  const spacing = EVENT_DOT_DIAMETER + EVENT_DOT_GAP;

  // Natural X in pixels (clamp to bar).
  const pts = dots.map(d => ({
    el: d.el,
    x: Math.max(r, Math.min(W - r, (d.pct / 100) * W)),
  }));
  pts.sort((a, b) => a.x - b.x);

  // Forward pass: push overlapping dots to the right.
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].x - pts[i - 1].x < spacing) {
      pts[i].x = pts[i - 1].x + spacing;
    }
  }
  // Backward pass: if the run hit the right edge, pull neighbors back left.
  for (let i = pts.length - 2; i >= 0; i--) {
    if (pts[i + 1].x - pts[i].x < spacing) {
      pts[i].x = pts[i + 1].x - spacing;
    }
  }
  // Final clamp to bar bounds.
  for (const p of pts) {
    p.x = Math.max(r, Math.min(W - r, p.x));
    p.el.style.left = `${p.x}px`;
  }
}

function formatEventTitle(ev) {
  if (ev.event_type === "break") {
    const m = Math.round(ev.duration_secs / 60);
    return `Break (${m}m) ${formatClock(ev.trigger_at)}`;
  }
  return `${ev.title || "Reminder"} ${formatClock(ev.trigger_at)}`;
}

function formatEventLabel(ev) {
  const clock = formatClock(ev.trigger_at);
  if (ev.event_type === "break") {
    const m = Math.round(ev.duration_secs / 60);
    return `${ev.triggered ? "✓ " : ""}Break ${m}m — ${clock}`;
  }
  return `${ev.triggered ? "✓ " : ""}${ev.title || "Reminder"} — ${clock}`;
}

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

// Generic floating tooltip: any element carrying data-tooltip shows this on
// hover, positioned via floating-ui (same look as the progress-bar tooltips).
const uiTooltip = document.getElementById("ui-tooltip");
if (uiTooltip) {
  document.addEventListener("mouseover", async (e) => {
    const target = e.target.closest("[data-tooltip]");
    if (!target) return;
    uiTooltip.innerHTML = `<div class="tt-time">${target.dataset.tooltip}</div>`;
    uiTooltip.hidden = false;
    const { x, y } = await computePosition(target, uiTooltip, {
      placement: "top",
      middleware: [floatingOffset(6), flip(), shift({ padding: 8 })],
    });
    uiTooltip.style.left = `${x}px`;
    uiTooltip.style.top = `${y}px`;
  });
  document.addEventListener("mouseout", (e) => {
    const target = e.target.closest("[data-tooltip]");
    if (!target) return;
    if (e.relatedTarget && target.contains(e.relatedTarget)) return;
    uiTooltip.hidden = true;
  });
  // Hide the tooltip on mousedown so it doesn't linger after a click removes
  // the hovered element (e.g. Skip → re-render removes the button before
  // mouseout fires). mousedown precedes the click handler, so this always
  // fires while the node still exists.
  document.addEventListener("mousedown", (e) => {
    if (!e.target.closest("[data-tooltip]")) return;
    uiTooltip.hidden = true;
  });
}

// Event marker tooltip (dots live in #event-dots overlay)
const eventTooltip = document.getElementById("event-tooltip");
const eventDotsHost = document.getElementById("event-dots");
if (eventDotsHost && eventTooltip) {
  eventDotsHost.addEventListener("mouseover", async (e) => {
    const dot = e.target.closest(".event-dot");
    if (!dot || !dot.dataset.eventLabel) return;
    dot.classList.add("is-active");
    eventTooltip.innerHTML = `<div class="tt-time">${dot.dataset.eventLabel}</div>`;
    eventTooltip.hidden = false;
    const { x, y } = await computePosition(dot, eventTooltip, {
      placement: "top",
      middleware: [floatingOffset(6), flip(), shift({ padding: 8 })],
    });
    eventTooltip.style.left = `${x}px`;
    eventTooltip.style.top = `${y}px`;
  });
  eventDotsHost.addEventListener("mouseout", (e) => {
    const dot = e.target.closest(".event-dot");
    if (dot) dot.classList.remove("is-active");
    if (!eventDotsHost.contains(e.relatedTarget)) {
      eventTooltip.hidden = true;
    }
  });
  // Click a dot → open the detail popover.
  eventDotsHost.addEventListener("click", (e) => {
    const dot = e.target.closest(".event-dot");
    if (!dot || dot.dataset.eventId == null) return;
    e.stopPropagation();
    const id = parseInt(dot.dataset.eventId, 10);
    openEventDotPopover(id, dot);
  });
}

// ===== Event dot detail popover =====
function refreshEventPopoverMeta() {
  if (eventPopoverId == null) return;
  const ev = state.current?.events?.find(e => e.id === eventPopoverId);
  if (!ev) return;
  const metaEl = $("#event-popover-meta");
  const now = Math.floor(Date.now() / 1000);
  const recur = formatRecurringDays(ev.recurring_days);
  metaEl.textContent = recur
    ? `${eventMetaText(ev, now)} · ${recur}`
    : eventMetaText(ev, now);
}

async function openEventDotPopover(id, anchor) {
  const ev = state.current.events.find(e => e.id === id);
  if (!ev) return;
  eventPopoverId = id;

  // Populate content. Title text goes in the span (the skip icon sits at the
  // row's right edge via flex); the skip icon shows only for recurring events
  // armed to fire today (not triggered, not dormant-for-another-day).
  const titleTextEl = $("#event-popover-title-text");
  if (ev.event_type === "break") {
    const m = Math.round(ev.duration_secs / 60);
    titleTextEl.textContent = `${ev.triggered ? "✓ " : ""}Break · ${m}m`;
  } else {
    titleTextEl.textContent = `${ev.triggered ? "✓ " : ""}${ev.title || "Reminder"}`;
  }
  const isRecurring = (ev.recurring_days || []).length > 0;
  // Skip only makes sense for today's occurrence — gate on firesToday so a
  // dormant recurring event pointing to tomorrow doesn't show skip.
  const canSkip = isRecurring && !ev.triggered && firesToday(ev);
  $("#event-popover-skip").hidden = !canSkip;
  refreshEventPopoverMeta();

  // Show backdrop + popover
  const popover = $("#event-popover");
  const backdrop = $("#event-popover-backdrop");
  popover.hidden = false;
  backdrop.hidden = false;

  // Hide the hover tooltip while the popover is open.
  eventTooltip.hidden = true;

  // Position next to the dot using the same floating-ui flow as the tooltip.
  const { x, y } = await computePosition(anchor, popover, {
    placement: "top",
    middleware: [floatingOffset(8), flip(), shift({ padding: 8 })],
  });
  popover.style.left = `${x}px`;
  popover.style.top = `${y}px`;

  // Live-update the meta text (countdown / "due now" / snoozed timer) every
  // second, mirroring the Today's Events list. Cleared on close.
  stopEventPopoverTick();
  eventPopoverTick = setInterval(refreshEventPopoverMeta, 1000);
}

function stopEventPopoverTick() {
  if (eventPopoverTick) {
    clearInterval(eventPopoverTick);
    eventPopoverTick = null;
  }
}

export function closeEventDotPopover() {
  stopEventPopoverTick();
  $("#event-popover").hidden = true;
  $("#event-popover-backdrop").hidden = true;
  eventPopoverId = null;
}

// Wire popover buttons + dismiss interactions (once).
(function initEventDotPopover() {
  const popover = $("#event-popover");
  const backdrop = $("#event-popover-backdrop");
  if (!popover) return;

  $("#event-popover-edit").addEventListener("click", () => {
    if (eventPopoverId == null) return;
    const id = eventPopoverId;
    closeEventDotPopover();
    enterEditMode(id);
  });

  $("#event-popover-delete").addEventListener("click", async () => {
    if (eventPopoverId == null) return;
    const id = eventPopoverId;
    closeEventDotPopover();
    state.current = await invoke("delete_event", { id });
    render();
  });

  $("#event-popover-skip").addEventListener("click", async () => {
    if (eventPopoverId == null) return;
    const id = eventPopoverId;
    closeEventDotPopover();
    state.current = await invoke("skip_event", { id });
    render();
  });

  // Click the dimmed backdrop → close.
  backdrop.addEventListener("click", closeEventDotPopover);

  // Escape → close.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !popover.hidden) closeEventDotPopover();
  });
})();

// Re-spread dots immediately when the bar resizes (not just on next tick).
window.addEventListener("resize", () => {
  if (dotResizeRaf) cancelAnimationFrame(dotResizeRaf);
  dotResizeRaf = requestAnimationFrame(() => {
    if (!state.current) return;
    const host = document.getElementById("event-dots");
    if (!host) return;
    const r = EVENT_DOT_DIAMETER / 2;
    const spacing = EVENT_DOT_DIAMETER + EVENT_DOT_GAP;
    const W = host.clientWidth;
    if (W <= 0) return;
    const pts = Array.from(host.querySelectorAll(".event-dot"))
      .map(el => ({ el, x: parseFloat(el.style.left) }))
      .filter(p => !Number.isNaN(p.x))
      .sort((a, b) => a.x - b.x);
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].x - pts[i - 1].x < spacing) pts[i].x = pts[i - 1].x + spacing;
    }
    for (let i = pts.length - 2; i >= 0; i--) {
      if (pts[i + 1].x - pts[i].x < spacing) pts[i].x = pts[i + 1].x - spacing;
    }
    for (const p of pts) {
      p.x = Math.max(r, Math.min(W - r, p.x));
      p.el.style.left = `${p.x}px`;
    }
  });
});
