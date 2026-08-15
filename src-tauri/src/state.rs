use chrono::{Datelike, Timelike};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::Instant;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BreakSegment {
    pub active_at_start: u64, // active_secs when break started
    pub duration: u64,        // break duration in seconds
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduledEvent {
    pub id: u32,
    pub event_type: String,            // "break" or "reminder"
    pub title: String,                 // reminder title (empty for breaks)
    pub trigger_at: i64,               // unix timestamp
    pub duration_secs: u64,            // break duration (0 for reminders)
    pub overlay_type: String,          // "fullscreen" or "mini" (reminders only)
    pub triggered: bool,
    #[serde(default)]
    pub snoozed_until: Option<i64>,    // snoozed reminder re-trigger time
    #[serde(default)]
    pub elapsed_at_trigger: Option<u64>, // elapsed_secs captured when fired (for bar segment)
    #[serde(default)]
    pub recurring_days: Vec<u8>,       // weekdays 0=Sun..6=Sat that this recurs on (empty = one-time)
    #[serde(default)]
    pub recurred_today: bool,          // recurring: already fired this calendar day
    #[serde(default)]
    pub trigger_minute: Option<u32>,   // recurring: minute-of-day (HH*60+MM) to recompute trigger_at daily
    /// Why a silent miss happened: "before_work" | "inactive" | "replaced"
    #[serde(default)]
    pub miss_reason: Option<String>,
}

/// What interrupt UI was last active (break / reminder / limit), for next-day welcome.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActiveInterrupt {
    pub kind: String,          // "break" | "reminder" | "limit"
    pub label: String,         // human-readable, e.g. reminder title
    pub event_id: Option<u32>,
}

/// Shown once after a day rollover that interrupted an in-progress session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DayWelcome {
    pub last_label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimerState {
    pub date: String,
    pub elapsed_secs: u64,
    pub active_secs: u64,
    pub limit_mins: u64,
    pub status: String,
    pub snooze_until: Option<i64>,
    pub snooze_started_at: Option<i64>, // when snooze first began
    #[serde(default)]
    pub total_snooze_secs: u64,
    #[serde(default)]
    pub quiet_overlay: bool,
    // Break fields
    #[serde(default)]
    pub break_until: Option<i64>,
    #[serde(default)]
    pub break_started_at: Option<i64>,
    #[serde(default)]
    pub break_duration_secs: u64,
    #[serde(default)]
    pub total_break_secs: u64,
    #[serde(default)]
    pub break_count: u32,
    #[serde(default)]
    pub last_break_ended_at: Option<i64>,
    #[serde(default)]
    pub break_segments: Vec<BreakSegment>,
    // Scheduled events
    #[serde(default)]
    pub events: Vec<ScheduledEvent>,
    #[serde(default)]
    pub next_event_id: u32,
    #[serde(default)]
    pub active_interrupt: Option<ActiveInterrupt>,
    #[serde(default)]
    pub pending_welcome: Option<DayWelcome>,
}

impl Default for TimerState {
    fn default() -> Self {
        Self {
            date: effective_date("00:00"),
            elapsed_secs: 0,
            active_secs: 0,
            limit_mins: 480,
            status: "active".into(),
            snooze_until: None,
            snooze_started_at: None,
            total_snooze_secs: 0,
            quiet_overlay: false,
            break_until: None,
            break_started_at: None,
            break_duration_secs: 0,
            total_break_secs: 0,
            break_count: 0,
            last_break_ended_at: None,
            break_segments: Vec::new(),
            events: Vec::new(),
            next_event_id: 1,
            active_interrupt: None,
            pending_welcome: None,
        }
    }
}

/// Miss reason when an event could not fire: no counted time yet vs system not active.
pub fn miss_reason_for_elapsed(elapsed_secs: u64) -> String {
    if elapsed_secs == 0 {
        "before_work".into()
    } else {
        "inactive".into()
    }
}

pub fn event_display_label(ev: &ScheduledEvent) -> String {
    if !ev.title.trim().is_empty() {
        return ev.title.clone();
    }
    if ev.event_type == "break" {
        "a break".into()
    } else {
        "a reminder".into()
    }
}

/// Mark an armed event as silently missed (no overlay, no elapsed_at_trigger).
pub fn mark_event_missed(ev: &mut ScheduledEvent, reason: &str) {
    ev.triggered = true;
    ev.recurred_today = true;
    ev.snoozed_until = None;
    ev.elapsed_at_trigger = None;
    ev.miss_reason = Some(reason.to_string());
}

/// End an in-progress break, recording only the time that actually counted down
/// (works with freeze-by-extending `break_until` during lock/sleep).
pub fn finalize_break(state: &mut TimerState, now_ts: i64) {
    if state.status != "on_break" {
        return;
    }
    let actual = break_counted_secs(state, now_ts);
    if actual > 0 || state.break_started_at.is_some() {
        state.total_break_secs += actual;
        let elapsed_at_start = state.elapsed_secs.saturating_sub(actual);
        state.break_segments.push(BreakSegment {
            active_at_start: elapsed_at_start,
            duration: actual,
        });
        state.break_count += 1;
    }
    state.last_break_ended_at = Some(now_ts);
    state.break_until = None;
    state.break_started_at = None;
    state.break_duration_secs = 0;
    if state
        .active_interrupt
        .as_ref()
        .map(|a| a.kind == "break")
        .unwrap_or(false)
    {
        state.active_interrupt = None;
    }
}

fn break_counted_secs(state: &TimerState, now_ts: i64) -> u64 {
    match (state.break_until, state.break_duration_secs) {
        // Until in the past (set_break_duration below elapsed): the full
        // shrunken total counts as taken.
        (Some(until), dur) if dur > 0 && until <= now_ts => dur,
        (Some(until), dur) if dur > 0 => {
            let remaining = (until - now_ts).max(0) as u64;
            dur.saturating_sub(remaining).min(dur)
        }
        (_, _) => state
            .break_started_at
            .map(|started| (now_ts - started).max(0) as u64)
            .unwrap_or(0),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BreakSuggestion {
    pub suggested_min: u32,
    pub work_min: u32,
}

/// Factory default for the sticky snooze durations (minutes).
pub fn default_sticky_mins() -> u64 {
    10
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub overlay_title: String,
    pub overlay_subtitle: String,
    pub reset_time: String,
    pub force_fullscreen_overlay: bool,
    pub animation_type: String,
    pub auto_update: bool,
    /// Sticky "last used" snooze durations (minutes), written through by the
    /// snooze commands. `#[serde(default)]` keeps old settings files loading.
    #[serde(default = "default_sticky_mins")]
    pub snooze_limit_mins: u64,
    #[serde(default = "default_sticky_mins")]
    pub snooze_event_mins: u64,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            overlay_title: "Enough Work!".into(),
            overlay_subtitle: "You've done enough for today. Time to step away.".into(),
            reset_time: "00:00".into(),
            force_fullscreen_overlay: false,
            animation_type: "star-drop".into(),
            auto_update: true,
            snooze_limit_mins: default_sticky_mins(),
            snooze_event_mins: default_sticky_mins(),
        }
    }
}

pub struct AppData {
    pub state: Mutex<TimerState>,
    pub last_save: Mutex<Instant>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonitorRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

pub fn parse_reset_time(s: &str) -> (u32, u32) {
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() == 2 {
        let h = parts[0].parse::<u32>().unwrap_or(0);
        let m = parts[1].parse::<u32>().unwrap_or(0);
        (h.min(23), m.min(59))
    } else {
        (0, 0)
    }
}

pub fn effective_date(reset_time: &str) -> String {
    let now = chrono::Local::now();
    let (rh, rm) = parse_reset_time(reset_time);
    if let Some(reset) = now.with_hour(rh).and_then(|t| t.with_minute(rm)).and_then(|t| t.with_second(0)) {
        if now < reset {
            (now - chrono::Duration::days(1)).format("%Y-%m-%d").to_string()
        } else {
            now.format("%Y-%m-%d").to_string()
        }
    } else {
        now.format("%Y-%m-%d").to_string()
    }
}

/// Fire window for recurring events (seconds after trigger_at during which
/// the event is still considered "live" and can fire). Defined here so both
/// the tick loop and rollover share one value.
pub const RECUR_WINDOW_SECS: i64 = 60;

/// For each recurring event armed for today whose fire window has already
/// passed (e.g. the laptop was off past trigger_at + window), mark it done
/// for the day so the UI shows "triggered" instead of "due now".
///
/// Idempotent. Two cases per event, both gated on the fire window having
/// passed (trigger_at + window <= now):
///  - armed for today (triggered=false): mark done. This also rescues events
///    stuck in the half-marked state from older builds (recurred_today=true
///    but triggered=false), which kept showing "due now" in the UI.
///  - dormant (triggered=true, recurred_today=false): leave alone — that's a
///    non-scheduled weekday or a not-yet-rearmed rollover state, not "missed".
pub fn mark_missed_recurring_done(events: &mut Vec<ScheduledEvent>, now_ts: i64, elapsed_secs: u64) {
    let reason = miss_reason_for_elapsed(elapsed_secs);
    for ev in events.iter_mut() {
        if ev.recurring_days.is_empty() {
            continue; // one-time events are handled elsewhere
        }
        // Dormant (not scheduled today, or pre-arm): skip so we don't mistake
        // it for "missed".
        if ev.triggered && !ev.recurred_today {
            continue;
        }
        // Already fully done for today: nothing to do.
        if ev.triggered && ev.recurred_today {
            continue;
        }
        if now_ts >= ev.trigger_at + RECUR_WINDOW_SECS {
            mark_event_missed(ev, &reason);
        }
    }
}

/// On a new effective day: drop one-time events, keep recurring ones and
/// re-arm them for today. Recurring events whose weekday isn't scheduled today
/// are left dormant (triggered=true) so they never fire; scheduled ones get
/// trigger_at recomputed to today's HH:MM and triggered=false.
pub fn rollover_events_for_new_day(events: &mut Vec<ScheduledEvent>) {
    let now = chrono::Local::now();
    let now_ts = now.timestamp();
    let today_weekday = now.weekday().num_days_from_sunday() as u8;
    events.retain(|e| !e.recurring_days.is_empty());
    for ev in events.iter_mut() {
        // Reset daily state
        ev.triggered = true; // dormant until re-armed below
        ev.recurred_today = false;
        ev.snoozed_until = None;
        ev.elapsed_at_trigger = None;
        ev.miss_reason = None;

        if !ev.recurring_days.contains(&today_weekday) {
            // Not scheduled today → stays dormant, but advance trigger_at to the
            // next scheduled fire so the UI counts down to the real next time
            // (not a stale today-time).
            if let Some(next_ts) = next_recurring_trigger(&ev.recurring_days, ev.trigger_minute, now) {
                ev.trigger_at = next_ts;
            }
            continue;
        }
        // Scheduled today: recompute trigger_at to today's HH:MM and arm it.
        if let Some(min_of_day) = ev.trigger_minute {
            let h = min_of_day / 60;
            let m = min_of_day % 60;
            if let Some(t) = now.with_hour(h).and_then(|t| t.with_minute(m)).and_then(|t| t.with_second(0)) {
                ev.trigger_at = t.timestamp();
                ev.triggered = false;
            }
        }
    }
    // Any event armed for today whose time has already passed (e.g. app
    // opened late in the day with the timer stopped) is marked done now so
    // the UI doesn't show "due now" for the rest of the day.
    // elapsed is 0 on a fresh day → before_work.
    mark_missed_recurring_done(events, now_ts, 0);
}

/// Compute the next datetime at which a recurring event should fire, given its
/// selected weekdays and minute-of-day. Walks forward day-by-day from today
/// (up to 7 days) and returns the first scheduled weekday whose HH:MM time is
/// still in the future relative to `now`. Returns None if trigger_minute is
/// unset (shouldn't happen for recurring events) or no day matches.
///
/// Used at creation time (to arm for the correct first fire when today isn't
/// scheduled) and could be used to advance dormant events so the UI counts
/// down to the real next fire instead of a stale today-time.
pub fn next_recurring_trigger(recurring_days: &[u8], trigger_minute: Option<u32>, now: chrono::DateTime<chrono::Local>) -> Option<i64> {
    let min_of_day = trigger_minute?;
    if recurring_days.is_empty() {
        return None;
    }
    let h = min_of_day / 60;
    let m = min_of_day % 60;
    // Search the next 7 days starting from today.
    for offset in 0..7 {
        let day = now + chrono::Duration::days(offset);
        let weekday = day.weekday().num_days_from_sunday() as u8;
        if !recurring_days.contains(&weekday) {
            continue;
        }
        if let Some(t) = day.with_hour(h).and_then(|t| t.with_minute(m)).and_then(|t| t.with_second(0)) {
            let ts = t.timestamp();
            // Today: only use it if the time hasn't passed yet.
            // Future days: always valid.
            if offset == 0 && ts <= now.timestamp() {
                continue;
            }
            return Some(ts);
        }
    }
    None
}

/// Reset all per-day fields when the effective date rolls over.
///
/// If a break/reminder/limit interrupt was still active, sets `pending_welcome`
/// and leaves status as `stopped` so the UI can greet the user before starting.
///
/// Extracted because `get_state` and the timer tick loop had this block
/// duplicated verbatim.
pub fn reset_state_for_new_day(state: &mut TimerState, today: &str) {
    let welcome = state.active_interrupt.as_ref().map(|ai| DayWelcome {
        last_label: ai.label.clone(),
    }).or_else(|| {
        if state.status == "on_break" {
            Some(DayWelcome {
                last_label: "a break".into(),
            })
        } else if state.status == "limit_reached" || state.status == "snoozed" {
            Some(DayWelcome {
                last_label: "Enough Work".into(),
            })
        } else {
            None
        }
    });

    state.date = today.to_string();
    state.elapsed_secs = 0;
    state.active_secs = 0;
    state.snooze_until = None;
    state.snooze_started_at = None;
    state.total_snooze_secs = 0;
    state.quiet_overlay = false;
    state.break_until = None;
    state.break_started_at = None;
    state.break_duration_secs = 0;
    state.total_break_secs = 0;
    state.break_count = 0;
    state.last_break_ended_at = None;
    state.break_segments.clear();
    state.active_interrupt = None;
    rollover_events_for_new_day(&mut state.events);

    if let Some(w) = welcome {
        state.pending_welcome = Some(w);
        state.status = "stopped".into();
    } else {
        state.pending_welcome = None;
        state.status = "active".into();
    }
}
