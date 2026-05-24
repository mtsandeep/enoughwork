/**
 * Window positioning utilities for multi-monitor + mixed-DPI setups.
 *
 * All Tauri monitor positions/sizes are in PHYSICAL pixels.
 * WebviewWindow constructor x/y are in LOGICAL pixels.
 * The Rust `get_main_work_area` returns the work area (excludes taskbar) in physical pixels.
 */

const { invoke } = window.__TAURI__.core;

/**
 * Get the work area (physical pixels) for the monitor the main window is on.
 * Returns { x, y, width, height } or null.
 */
export async function getMainWorkArea() {
  return invoke("get_main_work_area");
}

/**
 * Get the scale factor for a monitor at a given physical-pixel position.
 * Falls back to 1 if no monitor matches.
 */
export async function getScaleFactorAt(physX, physY) {
  const monitors = await window.__TAURI__.window.availableMonitors();
  for (const m of monitors) {
    if (physX >= m.position.x && physX < m.position.x + m.size.width &&
        physY >= m.position.y && physY < m.position.y + m.size.height) {
      return m.scaleFactor;
    }
  }
  return 1;
}

/**
 * Calculate bottom-right position (logical pixels) within a work area for a window
 * of the given size with margin from the edges.
 *
 * @param {{ x, y, width, height }} workArea - physical pixels from get_main_work_area
 * @param {number} winW - window width in logical pixels
 * @param {number} winH - window height in logical pixels
 * @param {number} margin - margin from screen edges in logical pixels
 * @returns {{ x: number, y: number }} logical pixel position
 */
export async function bottomRightPosition(workArea, winW, winH, margin = 16) {
  if (!workArea) return { x: 100, y: 100 };

  const sf = await getScaleFactorAt(workArea.x, workArea.y);
  return {
    x: Math.round((workArea.x + workArea.width) / sf - winW - margin),
    y: Math.round((workArea.y + workArea.height) / sf - winH - margin),
  };
}

/**
 * Get all available monitors (physical pixel positions/sizes + scaleFactor).
 */
export async function getMonitors() {
  return window.__TAURI__.window.availableMonitors();
}
