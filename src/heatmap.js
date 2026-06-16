import { computePosition, flip, shift, offset as floatingOffset } from "@floating-ui/dom";
import { $, state, invoke, localDateKey } from "./state.js";

let historyCache = null;
let heatmapBuilt = false;
let heatmapBuiltDate = null;

export async function initHeatmap() {
  historyCache = await invoke("get_history");
  buildHeatmap();
}

// Returns the effective "today" date key, respecting the configured reset time.
// Uses state.current.date from the Rust backend (computed via effective_date(reset_time)).
// Falls back to raw calendar date if state isn't loaded yet.
function effectiveToday() {
  return state.current?.date || localDateKey(new Date());
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

export function updateHeatmapColors() {
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
      ? { active_secs: state.current?.active_secs || 0, break_secs: state.current?.total_break_secs || 0, elapsed_secs: state.current?.elapsed_secs || 0 }
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
