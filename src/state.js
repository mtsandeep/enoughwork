// Shared hub: app state holder, Tauri/globals, and helpers used across modules.
// `currentState` is reassigned in many handlers across modules, so it lives in
// a mutable holder object (`state.current`) — ES module `let` bindings can't be
// reassigned by importers.

export const $ = (sel) => document.querySelector(sel);

export const state = { current: null };

export const { invoke } = window.__TAURI__.core;
export const { listen, emit } = window.__TAURI__.event;
export const { WebviewWindow } = window.__TAURI__.webviewWindow;

// App constants — change these to update repo url
export const GITHUB_REPO = "mtsandeep/enoughwork";
export const GITHUB_RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases`;

export function formatTime(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
}

export function formatClock(unixSecs) {
  const d = new Date(unixSecs * 1000);
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return `${h}:${m}${ampm}`;
}
