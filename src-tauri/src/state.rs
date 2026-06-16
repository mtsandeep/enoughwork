use chrono::{Datelike, Timelike};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DayRecord {
    pub active_secs: u64,
    pub break_secs: u64,
    #[serde(default)]
    pub elapsed_secs: u64,
}

pub type DailyHistory = HashMap<String, DayRecord>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BreakSuggestion {
    pub suggested_min: u32,
    pub work_min: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub overlay_title: String,
    pub overlay_subtitle: String,
    pub reset_time: String,
    pub force_fullscreen_overlay: bool,
    pub animation_type: String,
    pub auto_update: bool,
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
pub fn mark_missed_recurring_done(events: &mut Vec<ScheduledEvent>, now_ts: i64) {
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
            ev.recurred_today = true;
            ev.triggered = true;
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

        if !ev.recurring_days.contains(&today_weekday) {
            continue; // not scheduled today → stays dormant
        }
        // Recompute trigger_at to today's HH:MM
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
    mark_missed_recurring_done(events, now_ts);
}

/// Reset all per-day fields when the effective date rolls over. Returns the
/// previous day's totals so the caller can persist them to history.
///
/// Extracted because `get_state` and the timer tick loop had this block
/// duplicated verbatim.
pub fn reset_state_for_new_day(state: &mut TimerState, today: &str) -> (String, u64, u64, u64) {
    let old_date = state.date.clone();
    let old_active = state.active_secs;
    let old_break = state.total_break_secs;
    let old_elapsed = state.elapsed_secs;

    state.date = today.to_string();
    state.elapsed_secs = 0;
    state.active_secs = 0;
    state.status = "active".into();
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
    rollover_events_for_new_day(&mut state.events);

    (old_date, old_active, old_break, old_elapsed)
}
