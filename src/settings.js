import { load } from "@tauri-apps/plugin-store";
import {
  $, state, invoke, listen, WebviewWindow, GITHUB_RELEASES_URL,
} from "./state.js";
import { getMainWorkArea, bottomRightPosition } from "./window-utils.js";

const settingsPage = $("#settings-page");
const gearBtn = $("#settings-gear");
const backBtn = $("#settings-back");
const autostartToggle = $("#setting-autostart");
const autoUpdateToggle = $("#setting-auto-update");
const debugBarToggle = $("#setting-debug-bar");
const resetTimeInput = $("#setting-reset-time");
const overlayTitleInput = $("#setting-overlay-title");
const overlaySubtitleInput = $("#setting-overlay-subtitle");
const animationTypeSelect = $("#setting-animation-type");
const forceFullscreenToggle = $("#setting-force-fullscreen");
const animationLabel = $("#animation-label");
const debugBar = $(".debug-bar");

let settingsLoaded = false;
let autostartChanged = false;
let settingsSnapshot = null;

async function loadSettings() {
  const settings = await invoke("get_settings");
  resetTimeInput.value = settings.reset_time || "00:00";
  overlayTitleInput.value = settings.overlay_title;
  overlaySubtitleInput.value = settings.overlay_subtitle;
  animationTypeSelect.value = settings.animation_type || "star-drop";
  const forceFS = settings.force_fullscreen_overlay === true;
  forceFullscreenToggle.checked = forceFS;
  const animField = $("#animation-field");
  animField.style.opacity = forceFS ? "0.35" : "";
  animationTypeSelect.disabled = forceFS;
  const autostart = await invoke("get_autostart");
  autostartToggle.checked = autostart;
  autostartChanged = false;
  debugBarToggle.checked = !debugBar.hasAttribute("hidden");
  autoUpdateToggle.checked = settings.auto_update !== false;
  settingsLoaded = true;
  // Snapshot for dirty check
  settingsSnapshot = {
    overlayTitle: overlayTitleInput.value,
    overlaySubtitle: overlaySubtitleInput.value,
    resetTime: resetTimeInput.value,
    forceFullscreenOverlay: forceFullscreenToggle.checked,
    animationType: animationTypeSelect.value,
    autoUpdate: autoUpdateToggle.checked,
  };
  // Version
  const version = await invoke("get_version");
  $("#settings-version-text").textContent = `v${version}`;
}

export async function loadSettingsIfOpen() {
  settingsPage.hidden = false;
  if (!settingsLoaded) {
    await loadSettings();
  } else {
    // Always re-fetch autostart from OS since it can change externally
    const autostart = await invoke("get_autostart");
    autostartToggle.checked = autostart;
    autostartChanged = false;
  }
}

function applyPendingSettings() {
  if (!settingsLoaded) return;
  // Only save if text settings actually changed
  const current = {
    overlayTitle: overlayTitleInput.value || "Enough Work!",
    overlaySubtitle: overlaySubtitleInput.value || "You've done enough for today. Time to step away.",
    resetTime: resetTimeInput.value || "00:00",
    forceFullscreenOverlay: forceFullscreenToggle.checked,
    animationType: animationTypeSelect.value || "star-drop",
    autoUpdate: autoUpdateToggle.checked,
  };
  if (settingsSnapshot && (
    current.overlayTitle !== settingsSnapshot.overlayTitle ||
    current.overlaySubtitle !== settingsSnapshot.overlaySubtitle ||
    current.resetTime !== settingsSnapshot.resetTime ||
    current.forceFullscreenOverlay !== settingsSnapshot.forceFullscreenOverlay ||
    current.animationType !== settingsSnapshot.animationType ||
    current.autoUpdate !== settingsSnapshot.autoUpdate
  )) {
    invoke("save_settings", current);
    settingsSnapshot = { ...current };
  }
  // Apply autostart if changed
  if (autostartChanged) {
    invoke("toggle_autostart", { enable: autostartToggle.checked });
    autostartChanged = false;
  }
}

export { applyPendingSettings, debugBar, debugBarToggle };

// Settings gear → open settings page
gearBtn.addEventListener("click", loadSettingsIfOpen);

forceFullscreenToggle.addEventListener("change", () => {
  const fs = forceFullscreenToggle.checked;
  const animField = $("#animation-field");
  animField.style.opacity = fs ? "0.35" : "";
  animationTypeSelect.disabled = fs;
});

backBtn.addEventListener("click", () => {
  settingsPage.hidden = true;
  applyPendingSettings();
  // Clear update status when leaving settings
  const statusEl = $("#update-status");
  statusEl.hidden = true;
  statusEl.innerHTML = "";
});

autostartToggle.addEventListener("change", () => {
  autostartChanged = true;
});

debugBarToggle.addEventListener("change", () => {
  debugBar.hidden = !debugBarToggle.checked;
});

// ===== Auto Update =====
let pendingUpdate = null;
let updateNotifyWindow = null;
let updateInterval = null;

// Remember which version the user dismissed with "Later" so it won't pop up again.
async function getDismissedUpdateVersion() {
  try {
    const store = await load("enoughwork-store.json");
    return (await store.get("dismissed_update_version")) || "";
  } catch {
    return "";
  }
}

async function setDismissedUpdateVersion(version) {
  try {
    const store = await load("enoughwork-store.json");
    await store.set("dismissed_update_version", version);
    await store.save();
  } catch {}
}

// Open the small "Update Available" popup (mirrors openNotifyPopup's positioning).
async function openUpdateNotifyPopup(version) {
  if (updateNotifyWindow) return; // already open

  const popupW = 300;
  const popupH = 160;
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

  updateNotifyWindow = new WebviewWindow("update-notify-0", {
    url: hasWorkArea
      ? `src/windows/update-notify.html?v=${encodeURIComponent(version)}`
      : `src/windows/update-notify.html?v=${encodeURIComponent(version)}&selfpos=1`,
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

  updateNotifyWindow.once("tauri://destroyed", () => {
    updateNotifyWindow = null;
  });
}

export async function checkForUpdate(showStatus = false) {
  const statusEl = $("#update-status");
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();

    if (update) {
      pendingUpdate = update;
      const badge = $("#update-badge");
      badge.textContent = `Update available → v${update.version}`;
      badge.hidden = false;
      badge.classList.remove("updating");

      // Shift badge next to DEV badge if present
      const devBadge = document.querySelector(".dev-badge");
      if (devBadge) badge.parentElement.classList.add("has-dev-badge");

      if (showStatus && statusEl) {
        renderUpdateStatus(statusEl, "available", update.version);
      }

      // Proactive popup (unless this version was already dismissed)
      const dismissed = await getDismissedUpdateVersion();
      if (update.version !== dismissed) {
        openUpdateNotifyPopup(update.version);
      }
    } else {
      pendingUpdate = null;
      if (showStatus && statusEl) {
        statusEl.textContent = "You're on the latest version";
        statusEl.className = "settings-update-status success";
        statusEl.hidden = false;
        setTimeout(() => { statusEl.hidden = true; }, 3000);
      }
    }
  } catch (e) {
    pendingUpdate = null;
    if (showStatus && statusEl) {
      statusEl.innerHTML = `Check failed! <a href="${GITHUB_RELEASES_URL}" target="_blank">Download from GitHub</a>`;
      statusEl.className = "settings-update-status error";
      statusEl.hidden = false;
    }
  }
}

const downloadIcon = `<svg class="update-icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a1 1 0 0 1 1 1v12.586l3.293-3.293a1 1 0 0 1 1.414 1.414l-5 5a1 1 0 0 1-1.414 0l-5-5a1 1 0 1 1 1.414-1.414L11 15.586V3a1 1 0 0 1 1-1zM4 17a1 1 0 0 1 1 1v2h14v-2a1 1 0 1 1 2 0v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a1 1 0 0 1 1-1z"/></svg>`;

function renderUpdateStatus(el, status, version) {
  el.classList.remove("success", "error");
  switch (status) {
    case "available":
      el.innerHTML = `v${version} ${downloadIcon}`;
      el.className = "settings-update-status success clickable";
      el.hidden = false;
      break;
    case "downloading":
      el.textContent = "Downloading...";
      el.className = "settings-update-status";
      el.hidden = false;
      break;
    case "restarting":
      el.textContent = "Restarting...";
      el.className = "settings-update-status";
      el.hidden = false;
      break;
    case "error":
      el.innerHTML = `Error! Try again. <a href="${GITHUB_RELEASES_URL}" target="_blank">Download from GitHub</a>`;
      el.className = "settings-update-status error";
      el.hidden = false;
      break;
  }
}

async function downloadAndUpdate(statusEl) {
  if (!pendingUpdate) return;
  const version = pendingUpdate.version;

  // Update badge
  const badge = $("#update-badge");
  badge.textContent = "Downloading...";
  badge.classList.add("updating");
  // Hide GitHub link if visible
  const ghLink = document.getElementById("badge-gh-link");
  if (ghLink) ghLink.hidden = true;

  // Update settings status
  if (statusEl) renderUpdateStatus(statusEl, "downloading", version);

  try {
    await pendingUpdate.downloadAndInstall();
    badge.textContent = "Restarting...";
    if (statusEl) renderUpdateStatus(statusEl, "restarting", version);
    await new Promise(r => setTimeout(r, 2000));
    await window.__TAURI__.process.relaunch();
  } catch (e) {
    badge.textContent = "Error! Try again";
    badge.classList.remove("updating");
    badge.classList.add("error");
    // Show GitHub link outside badge
    let ghLink = document.getElementById("badge-gh-link");
    if (!ghLink) {
      ghLink = document.createElement("a");
      ghLink.id = "badge-gh-link";
      ghLink.className = "badge-gh-link";
      ghLink.target = "_blank";
      badge.parentElement.appendChild(ghLink);
    }
    ghLink.href = GITHUB_RELEASES_URL;
    ghLink.textContent = "or Download from GitHub";
    ghLink.hidden = false;
    if (statusEl) renderUpdateStatus(statusEl, "error", version);
  }
}

export function startAutoUpdate() {
  if (updateInterval) return;
  updateInterval = setInterval(() => checkForUpdate(false), 4 * 60 * 60 * 1000);
}

// Update badge click → download + install + restart
$("#update-badge").addEventListener("click", () => downloadAndUpdate(null));

// Settings status click → download + install + restart
$("#update-status").addEventListener("click", () => downloadAndUpdate($("#update-status")));

// Settings "Check for Updates" button
$("#btn-check-updates").addEventListener("click", () => checkForUpdate(true));

// Update popup actions (from update-notify.html). Lives here because it owns
// pendingUpdate and updateNotifyWindow.
listen("update-dismiss", async () => {
  if (pendingUpdate) await setDismissedUpdateVersion(pendingUpdate.version);
  if (updateNotifyWindow) {
    try { await updateNotifyWindow.close(); } catch {}
    updateNotifyWindow = null;
  }
});

listen("update-download", async () => {
  // pendingUpdate already set by checkForUpdate(); popup shows its own "Downloading..."
  downloadAndUpdate(null);
});
