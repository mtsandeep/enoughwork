import { $, state, invoke } from "./state.js";
import { render } from "./main.js";
import { closeBreakOverlay } from "./overlays.js";

// ===== Break Picker =====
let breakDurationMin = 15;
let breakDurationEditing = false;

async function openBreakPicker() {
  const suggestion = await invoke("suggest_break");
  breakDurationMin = suggestion.suggested_min;

  // Work info
  const wh = Math.floor(suggestion.work_min / 60);
  const wm = suggestion.work_min % 60;
  const workStr = wh > 0 ? `${wh}h ${String(wm).padStart(2, "0")}m` : `${wm}m`;
  $("#break-work-info").innerHTML = `You've been working for <strong>${workStr}</strong>`;

  updateBreakDurationDisplay();
  highlightQuickPick();
  closeBreakDurationEdit();
  $("#break-picker-page").hidden = false;
}

function updateBreakDurationDisplay() {
  const display = $("#break-duration-display");
  if (breakDurationMin >= 60 && breakDurationMin % 60 === 0) {
    display.textContent = `${breakDurationMin / 60}h`;
  } else {
    display.textContent = `${breakDurationMin}m`;
  }
  highlightQuickPick();
}

function highlightQuickPick() {
  document.querySelectorAll(".break-quick-btn").forEach(btn => {
    btn.classList.toggle("active", parseInt(btn.dataset.min) === breakDurationMin);
  });
}

function openBreakDurationEdit() {
  breakDurationEditing = true;
  const input = $("#break-input-m");
  input.value = breakDurationMin;
  $("#break-duration-display").hidden = true;
  $("#break-duration-edit").hidden = false;
  $("#break-duration-row").classList.add("editing");
  input.focus();
  input.select();
}

function closeBreakDurationEdit() {
  breakDurationEditing = false;
  $("#break-duration-display").hidden = false;
  $("#break-duration-edit").hidden = true;
  $("#break-duration-row").classList.remove("editing");
}

// Take Break button
$("#btn-take-break").addEventListener("click", openBreakPicker);

// Resume Work from main screen during break
$("#btn-resume-break").addEventListener("click", async () => {
  state.current = await invoke("resume_from_break");
  await closeBreakOverlay();
  render();
});

// Close picker
$("#break-picker-close").addEventListener("click", () => {
  $("#break-picker-page").hidden = true;
  closeBreakDurationEdit();
});

// Click anywhere on the row to edit duration
$("#break-duration-row").addEventListener("click", () => {
  if (!breakDurationEditing) openBreakDurationEdit();
});

// Quick pick buttons
document.querySelectorAll(".break-quick-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    breakDurationMin = parseInt(btn.dataset.min);
    updateBreakDurationDisplay();
    closeBreakDurationEdit();
  });
});

// Duration edit: enter/escape
$("#break-input-m").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const val = parseInt(e.target.value);
    if (val > 0 && val <= 120) {
      breakDurationMin = val;
      updateBreakDurationDisplay();
      closeBreakDurationEdit();
    }
  }
  if (e.key === "Escape") {
    closeBreakDurationEdit();
  }
});

// Start Break
$("#btn-start-break").addEventListener("click", async () => {
  if (breakDurationEditing) {
    const val = parseInt($("#break-input-m").value);
    if (val > 0 && val <= 120) breakDurationMin = val;
    closeBreakDurationEdit();
  }
  $("#break-picker-page").hidden = true;
  state.current = await invoke("start_break", {
    durationSecs: breakDurationMin * 60,
    label: null,
    eventId: null,
  });
  render();
});
