# Events & Scheduled Breaks for EnoughWork

## Context
EnoughWork has immediate "Take Break" functionality. This adds **scheduled events** — user sets a future time for either a break or a reminder. Events appear as yellow markers on the progress bar and trigger fullscreen overlays or mini notifications at the scheduled time.

**Principles:**
- Events are time-based (absolute clock time or relative "Xh Xm from now")
- Events do NOT pause or affect the work timer
- Progress bar position is estimated based on current work rate
- Events beyond the work limit still trigger but don't show on the bar
- Daily reset clears all events

---

## Data Model

### `ScheduledEvent` struct (Rust)
```rust
pub struct ScheduledEvent {
    pub id: u32,              // auto-incrementing
    pub event_type: String,   // "break" or "reminder"
    pub title: String,        // reminder title (empty for breaks)
    pub trigger_at: i64,      // unix timestamp
    pub duration_secs: u64,   // break duration (0 for reminders)
    pub overlay_type: String, // "fullscreen" or "mini"
    pub triggered: bool,      // has fired
    pub snoozed_until: Option<i64>,  // snoozed reminder re-trigger time
}
```

Added to `TimerState`:
```rust
pub events: Vec<ScheduledEvent>,
pub next_event_id: u32,
```

---

## Implementation

### 1. Rust: New commands (`src-tauri/src/commands.rs`)

**`create_event(event_type, title, trigger_at, duration_secs, overlay_type)`**
- Assign `next_event_id++`, push to `events` vec
- Return updated state

**`delete_event(id)`**
- Remove event by id from `events`
- Return updated state

**`dismiss_event(id)`**
- Set `triggered = true`, clear `snoozed_until`
- For break type: calls `start_break(duration_secs)` internally
- Return updated state

**`snooze_event(id)`**
- Set `snoozed_until = now + 300` (5 minutes)
- Keep `triggered = false` so it re-fires
- Return updated state

### 2. Rust: Timer loop changes

In the 1-second loop, after existing checks:
- Iterate `events`, find any where `!triggered && trigger_at <= now` (or `snoozed_until <= now` if set)
- Mark as `triggered = true`, emit `"event-triggered"` with event data
- For break-type events: the frontend handles calling `start_break()` (keeps flow consistent)
- On daily reset: clear `events` vec and reset `next_event_id`

### 3. Rust: Persistence

Events saved as part of `TimerState` to store (already auto-saved every 60s).
On reload: events with past `trigger_at` and `!triggered` get triggered immediately.

### 4. Frontend: Events icon + page (`index.html` + `main.js` + `styles.css`)

**Icon button** — calendar/clock SVG at `position: fixed; top: 16px; right: 88px` (before quiet icon at `right: 52px`, settings at `right: 16px`).

**Events page** — full-page overlay (same pattern as break-picker-page and settings-page):
- Close (X) top-right
- Two type cards: **"Scheduled Break"** / **"Reminder"** — click selects type
- **Break form** (when break selected):
  - Duration picker (same quick-pick pills: 5m, 10m, 15m, 20m, 30m, 1h)
  - Time input: clock picker OR "Xh Xm from now" (toggle between modes)
- **Reminder form** (when reminder selected):
  - Title text input
  - Overlay type: fullscreen / mini (two pill buttons)
  - Time input: clock picker OR "Xh Xm from now" (same toggle)
- **"Schedule" button** → calls `create_event()`
- **Pending events list** below the form:
  - Each event shows: icon (break/reminder), title, trigger time, delete button
  - Yellow dot indicator

### 5. Frontend: Progress bar event markers (`main.js`)

**Upcoming events** (not yet triggered) — yellow markers in the unfilled/grey area:
- Position calculation:
  - Work rate = `active_secs / max(elapsed_secs, 1)`
  - Estimated active at trigger time = `active_secs + (trigger_at - now_secs) * rate`
  - `x = (estimated_active / limit_secs) * 100`
  - If `x > 100` → beyond limit, don't render on bar (still triggers)
  - If `x <= current fill width` → already passed that point, render as thin yellow segment instead
- Render as a thin yellow rect (`width: 2` min, like break segment minimum)
- Tooltip on hover: shows event title + trigger time (reuse floating-ui pattern from break-tooltip)

**Triggered events** — yellow segment rectangles (like break segments):
- For break events: `active_at_trigger` captured when triggered, duration = event duration
- For reminder events: thin yellow marker (2px wide) at `active_at_trigger`
- Styling: `fill: #fde047; opacity: 0.8` (yellow)

### 6. Frontend: Event overlay (`src/event-notify.html` + `src/event-notify.js`)

New fullscreen overlay for triggered reminders:
- Shows event title (large text)
- "OK" button → calls `dismiss_event(id)`
- "Snooze 5m" button → calls `snooze_event(id)`
- Same multi-monitor pattern as existing overlay (fullscreen on all monitors)
- If event's `overlay_type == "mini"` → show as small popup instead (like notify.html)

For triggered break events → reuse existing break countdown overlay flow (just call `start_break()`).

### 7. Frontend: Event-triggered listener (`main.js`)

Listen for `"event-triggered"` event:
- If break type: call `start_break(event.duration_secs)` directly
- If reminder type:
  - If `overlay_type == "fullscreen"`: open event-notify overlay on all monitors
  - If `overlay_type == "mini"`: open small notification popup

---

## Files to Modify

| File | Changes |
|---|---|
| `src-tauri/src/commands.rs` | `ScheduledEvent` struct, TimerState fields, 4 commands, timer loop event check, daily reset |
| `src-tauri/src/lib.rs` | Register `create_event`, `delete_event`, `dismiss_event`, `snooze_event` |
| `index.html` | Events icon button, events page overlay, event tooltip div |
| `src/main.js` | Events page logic, progress bar markers, event-triggered listener, overlay opening |
| `src/styles.css` | Events page styles, event markers, event icon button |
| `src/event-notify.html` | New file — reminder overlay HTML |
| `src/event-notify.js` | New file — reminder overlay JS (emit dismiss/snooze) |

## Verification
1. `cargo build` — compiles
2. `npm run dev` — launch app
3. Click events icon → events page opens with type selector
4. Create a reminder 1 min from now → appears as yellow marker on progress bar
5. Wait for trigger → reminder overlay shows with title, OK + Snooze 5m
6. Click OK → overlay closes, event marked as triggered, yellow segment on bar
7. Create scheduled break 1 min from now → marker appears
8. Wait for trigger → break countdown starts
9. Delete event from pending list → marker removed
10. Event beyond work limit → not shown on bar, still triggers correctly
11. Daily reset clears all events
