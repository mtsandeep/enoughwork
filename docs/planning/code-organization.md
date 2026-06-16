# Code Organization — EnoughWork

## Context
The three largest files were split into smaller, focused modules for maintainability — pure reorganization, no behavior changes. The split was done one layer at a time (Rust → JS → CSS), each verified with a build before moving on. As-built state below.

---

## Rust (`src-tauri/src/`)

Module graph (acyclic): `state` is the leaf; `timer`, `persistence`, `win32`, and `commands` all depend on it; `lib.rs` wires everything.

| File | Contents |
|---|---|
| `state.rs` | All structs (`BreakSegment`, `ScheduledEvent`, `TimerState`+Default, `DayRecord`, `BreakSuggestion`, `AppSettings`+Default, `AppData`, `MonitorRect`); `DailyHistory` type; date helpers (`parse_reset_time`, `effective_date`); `RECUR_WINDOW_SECS`; recurring helpers (`mark_missed_recurring_done`, `rollover_events_for_new_day`); `reset_state_for_new_day` (extracted from the duplicated rollover block that was copy-pasted in `get_state` + the tick loop). |
| `persistence.rs` | Pure store I/O helpers (no `#[tauri::command]`): `load_state`, `save_state`, `load_daily_history`, `save_daily_history`, `load_settings`, `get_reset_time`. Commands that need the store live in `commands.rs`. |
| `timer.rs` | `start_timer()` — the background tick loop. |
| `win32.rs` | `#[cfg(target_os="windows")]` FFI: `is_fullscreen_app`, `get_foreground_monitor_rect`, `get_main_window_work_area`. |
| `commands.rs` | All `#[tauri::command]` wrappers (state mutators, event CRUD, autostart, monitor queries, + the three store commands `get_history`/`get_settings`/`save_settings` that call into persistence). |
| `lib.rs` | Setup, command registration, tray, window-close handler. |

### Note on `lib.rs` invoke_handler
The command registration list is unchanged — all commands physically live in `commands.rs` (the three store commands are thin wrappers there, calling `persistence::` helpers). Tauri's `generate_handler!` resolves generated helper symbols from the module named in the handler path, so re-exporting a command across modules does *not* work — the command must physically reside in the module the handler references.

---

## Frontend JS (`src/`)

`currentState` is reassigned in many handlers across modules, so it lives in a mutable holder object (`state.current` in `state.js`) — ES module `let` bindings can't be reassigned by importers.

| File | Contents |
|---|---|
| `state.js` | Shared hub: `state.current` holder, `$`, Tauri globals (`invoke`/`listen`/`emit`/`WebviewWindow`), `GITHUB_*` consts, shared helpers (`formatTime`, `localDateKey`, `formatClock`). |
| `main.js` | Orchestrator: `render()`, `refreshState()`, limit controls + handlers, action buttons (snooze/stop/resume/quiet), debug-bar handlers, `mainWindow.onCloseRequested`, `listen("close-overlay")`, `setInterval`, startup IIFE. Exports `render`, `refreshState`. |
| `overlays.js` | All overlay windows: break overlay (`openBreakOverlay`/`closeBreakOverlay`), limit-reached overlay (`openOverlay`, `closeAllOverlays`, `openAnimatedNotification`, `openNotifyPopup`, `openFullscreenOverlay`/`Except`), event-notify (`openEventNotifyFullscreen`/`Mini`, `closeEventNotify`), + the `listen("break-action"|"show-overlay"|"event-triggered"|"event-dismiss"|"event-snooze")` registrations. |
| `heatmap.js` | `initHeatmap`, `buildHeatmap`, `updateHeatmapColors`, `formatBreakMin`, tooltip wiring. |
| `progress-bar.js` | Event markers/dots: `renderEventMarkers`, `positionEventDots`, `formatEventTitle`/`Label`, dot popover (`openEventDotPopover`/`closeEventDotPopover`), break/dot tooltips, resize re-spread. |
| `schedule.js` | Scheduled items (named to avoid colliding with DOM/Tauri "event"): quick-add event form + events list page — all `evt*` state and functions (`resetEventForm`, `applyEventFormState`, `enterEditMode`, `renderEventsList`, `eventMetaText`, `formatRecurringDays`, etc.). Exports: `formatRecurringDays`, `eventMetaText`, `enterEditMode`, `renderEventsList`. |
| `break-picker.js` | Break picker page: `openBreakPicker`, duration display/edit, quick picks, start-break handler. |
| `settings.js` | Settings page (`loadSettings`/`applyPendingSettings`), auto-update (`checkForUpdate`, `downloadAndUpdate`, `openUpdateNotifyPopup`, `startAutoUpdate`, dismissed-version flow), debug-bar toggle, + `listen("update-dismiss"|"update-download")`. |
| `window-utils.js` | Unchanged — monitor/work-area helpers. |

### Cyclic imports
main↔overlays, main↔progress-bar, progress-bar↔schedule, main↔settings have import cycles, but every cross-module call happens inside a function body or event handler (never at module-eval time), so ES module live bindings resolve them safely.

---

## CSS (`src/`)

Plain CSS `@import` (Vite inlines them at build time — no preprocessor). `styles.css` keeps the root/shared rules (`*`, `:root`, `body`, `#app-area`, `.btn*`) and `@import`s the components. The three HTML files that load `styles.css` (`index.html`, `overlay.html`, `break-countdown.html`) are unchanged.

| File | Contents |
|---|---|
| `styles.css` | Root: `@import` directives + reset/`:root`/`body`/`#app-area`/shared `.btn` system. |
| `components/timer.css` | Timer display, progress bar, snooze bar, status text. |
| `components/controls.css` | Buttons, limit picker, break stats, break button. |
| `components/heatmap.css` | Heatmap grid + tooltips. |
| `components/break-picker.css` | Break picker page + quick picks. |
| `components/overlay.css` | Overlay window, quiet icon, settings/events-list/add icons. |
| `components/break-countdown.css` | Break countdown ring + buttons + `@keyframes pulse-overlay-btn`. |
| `components/settings.css` | Settings page, form fields, toggles, debug bar, dev/update badges. |
| `components/schedule.css` | Progress-bar wrap/overflow, event dots, dot popover, quick-add event panel, events list page. **Must load after `settings.css`** — `.events-page` shares the `.settings-page` base. |

### CSS import order
`@import`s must precede all other rules (CSS spec). `settings.css` is imported before `schedule.css` so the cascade dependency holds.

---

## Approach (how it was done)
- No behavior changes — pure file reorganization.
- One layer at a time: Rust, then JS, then CSS.
- Each layer verified before moving on: `cargo build` + `cargo clippy` (Rust), `pnpm vite build` (JS and CSS).
- One dedup during reorg: the duplicated day-rollover block in `get_state`/`start_timer` was extracted into `state::reset_state_for_new_day` (extracting identical code, not a behavior change).
- CSS class/selector deduplication is a separate follow-up — see `docs/planning/css-dedup.md`.
