// Shared snooze/adjust control for every interrupt surface (main window,
// fullscreen overlay, quiet popup, reminder, break countdown). The control
// owns the visuals; the surface owns the action via onApply(). Sticky
// defaults are persisted by the Rust commands, which broadcast
// "snooze-defaults-changed" for label sync across windows.

import "./components/snooze-control.css";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

export const SNOOZE_FACTORY_DEFAULT = 10;
const CHIPS_SNOOZE = [10, 30, 60, 120];
const CHIPS_BREAK = [10, 15, 30, 60];

// ---- helpers ----

function fmtMins(m) {
  if (m >= 60 && m % 60 === 0) return `${m / 60}h`;
  if (m >= 60) return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
  return `${m}m`;
}

function fmtClock(unixSecs) {
  const d = new Date(unixSecs * 1000);
  let h = d.getHours();
  const min = String(d.getMinutes()).padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${min} ${ampm}`;
}

// Per-window defaults cache.
let defaultsPromise = null;
function loadDefaults() {
  if (!defaultsPromise) {
    defaultsPromise = invoke("get_settings").then((s) => ({
      limit: s.snooze_limit_mins ?? SNOOZE_FACTORY_DEFAULT,
      event: s.snooze_event_mins ?? SNOOZE_FACTORY_DEFAULT,
    }));
    defaultsPromise.catch(() => {
      defaultsPromise = null; // retry on next mount
    });
  }
  return defaultsPromise;
}

// ---- module-level label sync ----

const mounted = new Set();

let syncListening = false;
function ensureSyncListener() {
  if (syncListening) return;
  syncListening = true;
  listen("snooze-defaults-changed", (event) => {
    const s = event.payload || {};
    const d = {
      limit: s.snooze_limit_mins ?? SNOOZE_FACTORY_DEFAULT,
      event: s.snooze_event_mins ?? SNOOZE_FACTORY_DEFAULT,
    };
    // Refresh the cached promise so later mounts see the new values too.
    defaultsPromise = Promise.resolve(d);
    for (const inst of mounted) inst.applyDefaults(d);
  });
}

// ---- control ----

/**
 * Mount the snooze/adjust control into `container`.
 *
 * opts:
 *   category: "limit" | "event"       (sticky-default categories; break isn't one)
 *   kind: "snooze" | "break-adjust"   (break-adjust = set-total popover + fixed "+N" primary)
 *   theme: "dark" | "light"
 *   btnClass: surface button classes for the primary button
 *   applyLabel: popover apply button text (default "Snooze" / "Update Break")
 *   labelFormat: (m) => string       (default "Snooze 10m" / "+N min")
 *   fixedPrimaryMins: number         (break-adjust: fixed "+N min" primary, no sticky)
 *   popoverDefaultMins: () => number (break-adjust: popover's opening staged value,
 *                                    e.g. the break's set duration)
 *   getEndsAtBase: () => unixSecs    (optional; enables the "Ends at" preview)
 *   defaults: {limit,event}          (optional preloaded; else get_settings)
 *   onApply: async (minutes, source) => void
 *     source: "primary" (one-click default) | "apply" (popover commit)
 *     Snooze kinds: minutes = snooze duration. Break-adjust: primary minutes =
 *     fixed increment; popover minutes = the new total break duration.
 *
 * Returns { setHidden, destroy, applyDefaults }.
 */
export function mountSnoozeControl(container, opts) {
  const o = {
    kind: "snooze",
    theme: "dark",
    applyLabel: null,
    labelFormat: null,
    fixedPrimaryMins: null,
    popoverDefaultMins: null,
    getEndsAtBase: null,
    defaults: null,
    ...opts,
  };
  const isAdjust = o.kind === "break-adjust";
  const labelFormat =
    o.labelFormat || ((m) => (isAdjust ? `+${m} min` : `Snooze ${fmtMins(m)}`));
  const applyLabel = o.applyLabel || (isAdjust ? "Update Break" : "Snooze");
  const maxCustom = isAdjust ? 120 : 240;

  // Break-adjust uses a fixed primary (+N) and no sticky default.
  let current = isAdjust
    ? o.fixedPrimaryMins ?? SNOOZE_FACTORY_DEFAULT
    : o.defaults?.[o.category] ?? SNOOZE_FACTORY_DEFAULT;
  let staged = null; // popover-staged minutes (chips / custom input)

  // ---- markup ----

  const root = document.createElement("div");
  root.className = `snooze-ctl snooze-root${o.theme === "light" ? " light" : ""}`;

  const row = document.createElement("div");
  row.className = "snooze-row";

  // ✎ opens the popover; mini popups pass showEdit: false.
  let editBtn = null;
  if (o.showEdit !== false) {
    editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "snooze-edit";
    editBtn.title = "Custom…";
    editBtn.setAttribute("aria-label", "Custom duration");
    editBtn.innerHTML =
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
    editBtn.addEventListener("click", togglePop);
    row.appendChild(editBtn);
  }

  const primaryBtn = document.createElement("button");
  primaryBtn.type = "button";
  primaryBtn.className = o.btnClass || "";
  primaryBtn.addEventListener("click", () => apply(current, "primary"));
  row.appendChild(primaryBtn);

  const pop = document.createElement("div");
  pop.className = "snooze-pop";

  // Chips stage a value; the apply button commits it.
  const chips = document.createElement("div");
  chips.className = "snooze-chips";
  const chipList = isAdjust ? CHIPS_BREAK : CHIPS_SNOOZE;
  const chipBtns = chipList.map((m) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "snooze-chip";
    b.textContent = fmtMins(m);
    b.dataset.min = m;
    b.addEventListener("click", () => {
      staged = m;
      closeCustomEdit();
      refreshStage();
    });
    chips.appendChild(b);
    return b;
  });
  pop.appendChild(chips);

  // Staged value: tappable display that morphs into h/m inputs on click.
  const selectedRow = document.createElement("div");
  selectedRow.className = "snooze-selected-row";

  const selectedEl = document.createElement("button");
  selectedEl.type = "button";
  selectedEl.className = "snooze-selected";
  selectedEl.title = "Click to edit";
  selectedEl.addEventListener("click", openCustomEdit);
  selectedRow.appendChild(selectedEl);

  const customRow = document.createElement("span");
  customRow.className = "snooze-custom-row";
  customRow.hidden = true;
  const mkInput = (max, unit) => {
    const i = document.createElement("input");
    i.type = "number";
    i.min = "0";
    i.max = String(max);
    i.placeholder = "0";
    i.title = unit;
    customRow.appendChild(i);
    return i;
  };
  const inH = mkInput(4, "hours");
  customRow.insertAdjacentHTML("beforeend", '<span class="snooze-custom-unit">h</span>');
  const inM = mkInput(59, "minutes");
  customRow.insertAdjacentHTML("beforeend", '<span class="snooze-custom-unit">m</span>');
  const customTick = document.createElement("button");
  customTick.type = "button";
  customTick.className = "snooze-custom-tick";
  customTick.textContent = "✓";
  customTick.title = "Set from these fields";
  customTick.addEventListener("click", stageCustom);
  customRow.appendChild(customTick);
  [inH, inM].forEach((i) =>
    i.addEventListener("keydown", (e) => {
      if (e.key === "Enter") stageCustom();
      if (e.key === "Escape") closeCustomEdit();
      e.stopPropagation();
    })
  );
  selectedRow.appendChild(customRow);
  pop.appendChild(selectedRow);

  // "Ends at" / "Re-trigger at" preview — only when the surface supplies a base
  let endsAt = null;
  if (o.getEndsAtBase) {
    endsAt = document.createElement("div");
    endsAt.className = "snooze-ends-at";
    pop.appendChild(endsAt);
  }

  // Apply — commits the staged value
  const applyBtn = document.createElement("button");
  applyBtn.type = "button";
  applyBtn.className = "snooze-apply";
  applyBtn.textContent = applyLabel;
  applyBtn.addEventListener("click", () => {
    if (staged && staged > 0) apply(staged, "apply");
  });
  pop.appendChild(applyBtn);

  // Reset (sticky categories only — break-adjust has no default to reset)
  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "snooze-reset";
  resetBtn.textContent = `Reset to default (${fmtMins(SNOOZE_FACTORY_DEFAULT)})`;
  resetBtn.hidden = isAdjust;
  resetBtn.addEventListener("click", async () => {
    try {
      await invoke("set_snooze_default", {
        category: o.category,
        minutes: SNOOZE_FACTORY_DEFAULT,
      });
    } catch (_) {}
    applyDefaults({ [o.category]: SNOOZE_FACTORY_DEFAULT });
    staged = SNOOZE_FACTORY_DEFAULT;
    closeCustomEdit();
    refreshStage();
  });
  pop.appendChild(resetBtn);

  root.appendChild(row);
  // Modal backdrop on body: never clipped by small windows, and the theme
  // class keeps the --sc-* tokens resolvable for the popover.
  const backdrop = document.createElement("div");
  backdrop.className = `snooze-backdrop snooze-ctl${o.theme === "light" ? " light" : ""}`;
  backdrop.hidden = true;
  backdrop.appendChild(pop);
  document.body.appendChild(backdrop);
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) closePop(); // click outside panel dismisses
  });
  container.appendChild(root);

  // ---- behavior ----

  function apply(minutes, source) {
    closePop();
    Promise.resolve(o.onApply && o.onApply(minutes, source)).catch(() => {});
    // Optimistic label refresh; the Rust broadcast is authoritative.
    if (!isAdjust) applyDefaults({ [o.category]: minutes });
  }

  function stageCustom() {
    const h = parseInt(inH.value) || 0;
    const m = parseInt(inM.value) || 0;
    const total = h * 60 + m;
    if (total >= 1 && total <= maxCustom) {
      staged = total;
      closeCustomEdit();
      refreshStage();
    }
  }

  function openCustomEdit() {
    inH.value = staged ? Math.floor(staged / 60) || "" : "";
    inM.value = staged ? staged % 60 || "" : "";
    selectedEl.hidden = true;
    customRow.hidden = false;
    selectedRow.classList.add("editing");
    (parseInt(inM.value) ? inM : inH).focus();
    inM.select();
  }

  function closeCustomEdit() {
    selectedEl.hidden = false;
    customRow.hidden = true;
    selectedRow.classList.remove("editing");
  }

  function refreshStage() {
    selectedEl.textContent = staged ? fmtMins(staged) : "—";
    applyBtn.disabled = !staged;
    for (const b of chipBtns) {
      b.classList.toggle("active", parseInt(b.dataset.min) === staged);
    }
    if (endsAt) {
      if (staged > 0 && o.getEndsAtBase) {
        const base = o.getEndsAtBase();
        const prefix = isAdjust ? "Ends at" : "Re-trigger at";
        endsAt.textContent = base > 0 ? `${prefix} ${fmtClock(base + staged * 60)}` : "";
      } else {
        endsAt.textContent = "";
      }
    }
  }

  function togglePop() {
    if (backdrop.hidden) openPop();
    else closePop();
  }

  function openPop() {
    // Snooze: sticky default. Break: the running total.
    staged = isAdjust ? (o.popoverDefaultMins ? o.popoverDefaultMins() : current) : current;
    closeCustomEdit();
    refreshStage();
    backdrop.hidden = false;
    if (o.onOpen) o.onOpen(staged);
  }

  function closePop() {
    backdrop.hidden = true;
    staged = null;
    closeCustomEdit();
  }

  function applyDefaults(d) {
    if (isAdjust) return; // fixed +N primary, no sticky default
    const v = d?.[o.category];
    if (typeof v === "number" && v >= 1) {
      current = v;
      primaryBtn.textContent = labelFormat(current);
      if (!backdrop.hidden) refreshStage();
    }
  }

  // Outside click / Escape close (the panel lives on body, not in root).
  function onDocMouseDown(e) {
    if (backdrop.hidden) return;
    if (root.contains(e.target) || backdrop.contains(e.target)) return;
    closePop();
  }
  function onDocKey(e) {
    if (e.key === "Escape" && !backdrop.hidden) closePop();
  }
  document.addEventListener("mousedown", onDocMouseDown);
  document.addEventListener("keydown", onDocKey);

  // Initial render
  primaryBtn.textContent = labelFormat(current);
  refreshStage();
  ensureSyncListener();

  const inst = {
    setHidden(hidden) {
      root.hidden = hidden;
      if (hidden) closePop();
    },
    destroy() {
      mounted.delete(inst);
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onDocKey);
      root.remove();
      backdrop.remove();
    },
    applyDefaults,
  };
  mounted.add(inst);

  // Fetch defaults if not preloaded
  if (!o.defaults) {
    loadDefaults().then((d) => applyDefaults(d)).catch(() => {});
  }

  return inst;
}
