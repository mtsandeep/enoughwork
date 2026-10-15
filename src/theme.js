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
  const root = document.documentElement;
  // Snap colors into place; transitions would flash through the flip.
  root.classList.add("theme-switching");
  const resolved = resolvedTheme();
  root.dataset.theme = resolved;
  document.dispatchEvent(new CustomEvent("themechange", { detail: resolved }));
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-switching")));
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
// Wobbly closed blob path around (cx, cy) — a jittered circle with a couple
// of harmonics so the edge reads as paint, not geometry. Same point count
// and phases on every call, so two sizes interpolate cleanly.
function blobPath(cx, cy, R, points = 40) {
  let d = "";
  for (let i = 0; i < points; i++) {
    const a = (i / points) * Math.PI * 2;
    const w = 1 + 0.14 * Math.sin(3 * a + 1.7) + 0.08 * Math.sin(5 * a + 0.4);
    const x = cx + Math.cos(a) * R * w;
    const y = cy + Math.sin(a) * R * w;
    d += `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  return `${d} Z`;
}

export function initThemeToggle(button) {
  if (!button) return;
  const icons = {
    light: button.querySelector(".theme-icon-light"),
    dark: button.querySelector(".theme-icon-dark"),
  };

  function refresh() {
    const mode = resolvedTheme();
    for (const [m, el] of Object.entries(icons)) {
      const on = m === mode;
      el.style.opacity = on ? "1" : "0";
      el.style.transform = on ? "" : "rotate(-90deg) scale(0.6)";
    }
    button.title = `${mode[0].toUpperCase() + mode.slice(1)} theme`;
  }

  button.addEventListener("click", (e) => {
    const next = resolvedTheme() === "dark" ? "light" : "dark";
    const rect = button.getBoundingClientRect();
    const x = e.clientX || rect.left + rect.width / 2;
    const y = e.clientY || rect.top + rect.height / 2;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (!document.startViewTransition || reduce) {
      setTheme(next);
      refresh();
    } else {
      // Paint drop from the click; overshoot clears the farthest corner
      // even at the wobble's thinnest (~0.78× r).
      const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)) * 1.35;
      const transition = document.startViewTransition(() => setTheme(next));
      transition.ready.then(() => {
        refresh();
        document.documentElement.animate(
          { clipPath: [`path("${blobPath(x, y, 0)}")`, `path("${blobPath(x, y, r)}")`] },
          { duration: 850, easing: "cubic-bezier(0.65, 0, 0.25, 1)", pseudoElement: "::view-transition-new(root)" },
        );
      }).catch(() => {});
    }
  });

  initTheme(refresh);
  refresh();
}

initThemeToggle(document.getElementById("btn-theme"));
