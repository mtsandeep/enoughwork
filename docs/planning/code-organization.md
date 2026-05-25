# Code Organization — EnoughWork

## Context
Three files have grown too large and need splitting into smaller, focused modules for maintainability:
- `src-tauri/src/commands.rs` — 862 lines
- `src/main.js` — 1091 lines
- `src/styles.css` — 1097 lines

---

## Rust (`src-tauri/src/`)

**Current:** Everything in `commands.rs` (state structs, commands, timer loop, win32 FFI, persistence)

**Proposed split:**
| File | Contents |
|---|---|
| `state.rs` | `TimerState`, `BreakSegment`, `DayRecord`, `AppSettings`, `AppData`, `Default` impls |
| `timer.rs` | `start_timer()`, timer loop, day rollover logic |
| `commands.rs` | Only `#[tauri::command]` functions — thin wrappers |
| `persistence.rs` | `save_state`, `save_daily_history`, `load_state`, store helpers |
| `win32.rs` | Fullscreen detection, monitor rects, all FFI bindings (already a module) |
| `lib.rs` | Setup, command registration (unchanged) |

---

## Frontend JS (`src/`)

**Current:** Everything in `main.js` (render loop, overlays, heatmap, settings, break picker, progress bar, tooltips)

**Proposed split:**
| File | Contents |
|---|---|
| `main.js` | Init, render loop, state management, event wiring |
| `overlays.js` | Overlay open/close, multi-monitor positioning, break overlay, notify popup |
| `heatmap.js` | Heatmap rendering, tooltip |
| `settings.js` | Settings page load/save, autostart |
| `break-picker.js` | Break picker page, duration selection, suggest_break flow |
| `progress-bar.js` | Progress bar rendering, break segments, tooltips |
| `window-utils.js` | Already separate — no change |

---

## CSS (`src/`)

**Current:** Single `styles.css` with all component styles

**Proposed split:**
| File | Contents |
|---|--- |
| `styles.css` | CSS variables, base/reset, shared utilities — `@import` all below |
| `components/timer.css` | Timer display, progress bar, snooze bar, status text |
| `components/controls.css` | Buttons, limit picker, break stats |
| `components/heatmap.css` | Heatmap grid, tooltips |
| `components/settings.css` | Settings page, form fields, toggles |
| `components/break-picker.css` | Break picker page, quick picks |
| `components/overlay.css` | Overlay pages, quiet icon, top bar icons |
| `components/break-countdown.css` | Break countdown ring, buttons |

---

## Approach

- No behavior changes — pure file reorganization
- Do one layer at a time: Rust first, then JS, then CSS
- Each layer verified with `cargo build` + `npm run dev` before moving on
- Detailed line-by-line split plan created when picking this up
