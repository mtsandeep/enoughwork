// Theme manager: light / dark for the content only — the window title bar
// always follows the OS. Until the user picks one, the theme resolves from
// the system preference (and follows it live). The choice lives in
// localStorage so the inline bootstrap in index.html applies it before first
// paint. applyTheme sets <html data-theme> and emits "themechange" (the
// snooze control follows it).

const KEY = "theme";
const MODES = ["light", "dark"];

function systemPrefersDark() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function getStoredTheme() {
  const v = localStorage.getItem(KEY);
  return MODES.includes(v) ? v : null;
}

export function resolvedTheme() {
  return getStoredTheme() ?? (systemPrefersDark() ? "dark" : "light");
}

export function applyTheme() {
  const resolved = resolvedTheme();
  document.documentElement.dataset.theme = resolved;
  document.dispatchEvent(new CustomEvent("themechange", { detail: resolved }));
  return resolved;
}

export function setTheme(mode) {
  localStorage.setItem(KEY, mode);
  applyTheme();
}

// Apply on load; follow the OS while no explicit choice is stored.
export function initTheme(onChange) {
  applyTheme();
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => {
      if (!getStoredTheme()) {
        applyTheme();
        onChange?.();
      }
    });
}

// Header toggle: light / dark icons; the shown one reflects the effective
// theme. Click switches to the other.
export function initThemeToggle(button) {
  if (!button) return;
  const icons = {
    light: button.querySelector(".theme-icon-light"),
    dark: button.querySelector(".theme-icon-dark"),
  };

  function refresh() {
    const mode = resolvedTheme();
    // SVG elements ignore the hidden IDL property — toggle style.display.
    for (const [m, el] of Object.entries(icons)) el.style.display = m === mode ? "" : "none";
    button.title = `${mode[0].toUpperCase() + mode.slice(1)} theme`;
  }

  button.addEventListener("click", () => {
    setTheme(resolvedTheme() === "dark" ? "light" : "dark");
    refresh();
  });

  initTheme(refresh);
  refresh();
}

initThemeToggle(document.getElementById("btn-theme"));
