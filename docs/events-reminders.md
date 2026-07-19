# Events & Scheduled Breaks — Implementation

EnoughWork supports **scheduled events**: reminders and timed breaks that fire at a future time you choose. Events appear as amber markers on the progress bar and trigger a fullscreen overlay or mini popup (for reminders) or a break countdown (for breaks) when their time arrives. Events can also **recur** on selected weekdays.

---

## Data Model

### `ScheduledEvent` (Rust, in `commands.rs`)

```rust
pub struct ScheduledEvent {
    pub id: u32,                       // auto-incrementing
    pub event_type: String,            // "break" | "reminder"
    pub title: String,                 // reminder title (empty for breaks)
    pub trigger_at: i64,               // unix timestamp of next fire
    pub duration_secs: u64,            // break duration (0 for reminders)
    pub overlay_type: String,          // "fullscreen" | "mini" (reminders only)
    pub triggered: bool,               // one-time: has fired. recurring: dormant (non-scheduled day)
    pub snoozed_until: Option<i64>,    // snoozed re-trigger time
    pub elapsed_at_trigger: Option<u64>,// elapsed_secs captured when fired (for bar segment)
    pub recurring_days: Vec<u8>,       // weekdays 0=Sun..6=Sat (empty = one-time)
    pub recurred_today: bool,          // recurring: already fired this calendar day
    pub trigger_minute: Option<u32>,   // recurring: minute-of-day (HH*60+MM) for daily recomputation
}
```

Stored on `TimerState` as `events: Vec<ScheduledEvent>` and `next_event_id: u32`. Persisted to `enoughwork-store.json` (auto-saved every 60s).

---

## Commands (`src-tauri/src/commands.rs`, registered in `lib.rs`)

| Command | Purpose |
|---|---|
| `create_event(event_type, title, trigger_at, duration_secs, overlay_type, recurring_days)` | Assign `next_event_id++`, push to `events` |
| `update_event(id, ...)` | Edit an existing event; resets daily trigger state |
| `delete_event(id)` | Remove by id |
| `dismiss_event(id)` | Mark fired (`triggered=true` for one-time, `recurred_today=true` for recurring), clear snooze |
| `snooze_event(id)` | Set `snoozed_until = now + 300s`; clears `triggered`/`recurred_today` so it re-fires |

---

## Trigger Logic (timer loop, `start_timer`)

Every second, the loop checks each event. Two paths:

Events fire **only while time is counting** (active or on break, and system not locked/asleep). Otherwise they are silent-missed with `miss_reason`: `before_work` (amber left `+N`) or `inactive` / `replaced` (gray `+N`).

### One-time events
- **Windowed**: due only if `trigger_at <= now < trigger_at + 60s` (same as recurring). Past the window → silent miss.
- On fire: `triggered = true`, capture `elapsed_at_trigger`, emit `"event-triggered"`.
- After snooze, only `snoozed_until` can re-fire.

### Recurring events
- **Windowed firing**: due only if `trigger_at <= now < trigger_at + 60s`, and only if `!recurred_today`.
- On fire: set `recurred_today` + `triggered`, capture `elapsed_at_trigger`, emit `"event-triggered"`.
- **No backfill**: if the laptop was off/locked past the 60s window, silent miss for that day.
- Snooze: clears `recurred_today` and sets `snoozed_until`; the snoozed re-fire uses the normal snooze path.

The emitted `"event-triggered"` payload is the full `ScheduledEvent`. The frontend **replaces** any current interrupt, then branches on `event_type`:
- `break` → `invoke("start_break", …)` (reuses the break countdown overlay)
- `reminder` → opens `event-notify.html` fullscreen or mini, based on `overlay_type`

---

## Daily Reset

`rollover_events_for_new_day()` runs at the effective daily reset (both in `get_state` and the timer loop):

1. **Drop one-time events** (`recurring_days` empty).
2. **Keep recurring events** and reset their daily state: `snoozed_until = None`, `elapsed_at_trigger = None`, `recurred_today = false`, `triggered = true` (dormant by default).
3. If today's weekday is **in** `recurring_days`: recompute `trigger_at` to today's HH:MM (from `trigger_minute`) and set `triggered = false` (armed).
4. If today's weekday is **not** in `recurring_days`: leave `triggered = true` (stays dormant all day).

---

## Progress Bar Markers (`src/main.js`, `renderEventMarkers`)

Markers are rendered as `<rect>` elements in the same SVG as the fill and break segments, positioned on the **elapsed axis** (consistent with the blue fill):

- **Triggered** event → placed at `elapsed_at_trigger / limit`. Break-type gets a segment sized by `duration_secs`; reminders are thin (2px min). Amber fill.
- **Upcoming** event → estimated position using `elapsed_secs + secsUntil` (1:1 with wall-clock), clamped to `[0, 100]`.
- **Out of range** → counted into the `+N` overflow badges flanking the bar. Left badge = events before the bar's start; right badge = events beyond the limit. Hover shows titles.
- Hover tooltip shows event title and trigger time (floating-ui, reusing the break-tooltip pattern).

---

## Frontend UI

### Quick-add icon (`+` next to "Take Break")
Opens a full-page form with:
- **Type toggle**: Reminder / Scheduled Break
- **Reminder fields**: title, fullscreen/mini notification pills
- **Break fields**: duration quick-picks (5/10/15/20/30/60m)
- **When**: clock (`at HH:MM`) ⇄ relative (`in Xh Ym`) toggle. Relative uses a `- 0h 30m +` stepper matching the home-screen limit control, with click-to-edit and 30-min snap.
- **Repeat** (clock mode only): toggle + weekday badges (Mon–Sun). Defaults to Mon–Fri when first enabled.

### Events list page (calendar icon, top bar)
- Lists today's events sorted by time, with live countdown ("in 3m", "in 25s" under 1 min).
- Each row shows: dot, title, meta line (time · status) with **type badge** (Fullscreen/Mini/Break) and **recurring badge** (Daily / Mon-Fri / Mon, Wed, Fri).
- Edit (loads into quick-add form) and Remove per row.
- Two add buttons at top: **+ Add Reminder** and **+ Add Scheduled Break** (each opens the form with the corresponding type pre-selected).
- Empty state with calendar icon and two-line message.

### Reminder overlay (`src/event-notify.html` + `event-notify.js`)
- Themed: dark fullscreen / light mini popup (toggled by `?mode=` query param).
- Shows the reminder title (large), scheduled time in 12h AM/PM, **OK** (dismiss) and **Snooze 5m** buttons.
- Fullscreen opens on all monitors (mirrors the limit overlay pattern); mini is a draggable bottom-right popup (mirrors the quiet-mode notification).
- Emits `event-dismiss` / `event-snooze` events (distinct from `break-action`).

---

## Capabilities

The `event-notify*` window labels are added to the Tauri capability allowlist (`src-tauri/capabilities/default.json`) so the overlay can emit events and be dragged.

---

## Verification

1. Click the `+` icon → form opens. Create a reminder 1 min out → marker appears on the bar.
2. Wait for trigger → reminder overlay (fullscreen or mini) with title, OK + Snooze 5m.
3. Click OK → overlay closes, amber segment remains on bar.
4. Create a scheduled break 1 min out → marker appears; on trigger, break countdown starts.
5. Create an event beyond the work limit → right `+N` badge shows the count.
6. Enable Repeat with selected weekdays → event survives daily reset and re-fires on scheduled days.
7. Close the laptop before a recurring event's time, reopen after → event does **not** fire (no backfill).
8. Edit/remove events from the events list page.
