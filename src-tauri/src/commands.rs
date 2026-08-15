// Thin `#[tauri::command]` wrappers. State structs live in `state.rs`,
// store I/O in `persistence.rs`, the tick loop in `timer.rs`, and the Win32
// FFI in `win32.rs`. lib.rs registers `commands::*` paths, so the commands
// that moved to persistence.rs/win32.rs are re-exported below to keep the
// invoke_handler list unchanged.

use crate::persistence::{get_reset_time, load_settings};
use crate::state::{
    effective_date, finalize_break, mark_event_missed, mark_missed_recurring_done,
    reset_state_for_new_day, ActiveInterrupt, BreakSuggestion, ScheduledEvent, TimerState,
    AppData,
};
use tauri::{Emitter, Manager};
use tauri_plugin_store::StoreExt;

#[tauri::command]
pub fn get_state(app_handle: tauri::AppHandle) -> TimerState {
    let reset_time = get_reset_time(&app_handle);
    let today = effective_date(&reset_time);

    let app_data = app_handle.state::<AppData>();
    let mut state = app_data.state.lock().unwrap();

    if state.date != today {
        reset_state_for_new_day(&mut state, &today);
        let welcome = state.pending_welcome.clone();
        drop(state);
        let _ = app_handle.emit("day-rolled", &welcome);
        return app_handle.state::<AppData>().state.lock().unwrap().clone();
    }

    if state.status == "snoozed" {
        if let Some(until) = state.snooze_until {
            let now_ts = chrono::Local::now().timestamp();
            if now_ts >= until {
                // Don't force the limit overlay from a poll — timer loop handles
                // showing it only while time is running.
                state.status = "limit_reached".into();
                state.snooze_until = None;
                state.snooze_started_at = None;
                state.active_interrupt = Some(ActiveInterrupt {
                    kind: "limit".into(),
                    label: "Enough Work".into(),
                    event_id: None,
                });
            }
        }
    }

    // Mark any recurring event whose fire window passed today (e.g. app was
    // closed at trigger time). Done on every poll so it stays correct even
    // when the timer is idle and the tick loop isn't running.
    {
        let now_ts = chrono::Local::now().timestamp();
        let elapsed = state.elapsed_secs;
        mark_missed_recurring_done(&mut state.events, now_ts, elapsed);
    }

    state.clone()
}

#[tauri::command]
pub fn set_limit(minutes: u64, app_handle: tauri::AppHandle) -> TimerState {
    let app_data = app_handle.state::<AppData>();
    let mut state = app_data.state.lock().unwrap();
    state.limit_mins = minutes;
    state.clone()
}

#[tauri::command]
pub fn snooze(minutes: u64, remember: Option<bool>, app_handle: tauri::AppHandle) -> TimerState {
    let app_data = app_handle.state::<AppData>();
    {
        let mut state = app_data.state.lock().unwrap();
        let now_ts = chrono::Local::now().timestamp();
        let extra_secs = minutes as i64 * 60;

        // If already snoozed, extend; otherwise start fresh
        let current_until = state.snooze_until.unwrap_or(now_ts);
        state.snooze_until = Some(std::cmp::max(current_until, now_ts) + extra_secs);
        state.total_snooze_secs += minutes * 60;

        if state.snooze_started_at.is_none() {
            state.snooze_started_at = Some(now_ts);
        }
        state.status = "snoozed".into();
    }
    // Sticky default + label sync — outside the state lock (store I/O).
    if remember.unwrap_or(true) {
        let settings = crate::persistence::write_settings(&app_handle, |s| {
            s.snooze_limit_mins = minutes.clamp(1, 240);
        });
        let _ = app_handle.emit("snooze-defaults-changed", &settings);
    }
    let result = app_data.state.lock().unwrap().clone();
    result
}

#[tauri::command]
pub fn stop_for_today(app_handle: tauri::AppHandle) -> TimerState {
    let app_data = app_handle.state::<AppData>();
    let mut state = app_data.state.lock().unwrap();
    state.status = "stopped".into();
    state.snooze_until = None;
    state.snooze_started_at = None;
    state.clone()
}

#[tauri::command]
pub fn resume_tracking(app_handle: tauri::AppHandle) -> TimerState {
    let app_data = app_handle.state::<AppData>();
    let mut state = app_data.state.lock().unwrap();

    state.pending_welcome = None;

    // If already past limit, go to limit_reached not active
    if state.elapsed_secs >= state.limit_mins * 60 {
        state.status = "limit_reached".into();
        state.active_interrupt = Some(ActiveInterrupt {
            kind: "limit".into(),
            label: "Enough Work".into(),
            event_id: None,
        });
        let _ = app_handle.emit("show-overlay", ());
    } else {
        state.status = "active".into();
    }
    state.snooze_until = None;
    state.snooze_started_at = None;
    state.clone()
}

#[tauri::command]
pub fn debug_set_elapsed(secs: u64, app_handle: tauri::AppHandle) -> TimerState {
    let app_data = app_handle.state::<AppData>();
    let mut state = app_data.state.lock().unwrap();
    state.elapsed_secs = secs;
    state.clone()
}

#[tauri::command]
pub fn debug_clear_state(app_handle: tauri::AppHandle) -> TimerState {
    let app_data = app_handle.state::<AppData>();
    let mut state = app_data.state.lock().unwrap();
    *state = TimerState::default();
    state.clone()
}

#[tauri::command]
pub fn set_quiet_overlay(enabled: bool, app_handle: tauri::AppHandle) -> TimerState {
    let app_data = app_handle.state::<AppData>();
    let mut state = app_data.state.lock().unwrap();
    state.quiet_overlay = enabled;
    state.clone()
}

#[tauri::command]
pub fn start_break(
    duration_secs: u64,
    label: Option<String>,
    event_id: Option<u32>,
    app_handle: tauri::AppHandle,
) -> TimerState {
    let app_data = app_handle.state::<AppData>();
    let mut state = app_data.state.lock().unwrap();
    let now_ts = chrono::Local::now().timestamp();
    state.status = "on_break".into();
    state.break_until = Some(now_ts + duration_secs as i64);
    state.break_started_at = Some(now_ts);
    state.break_duration_secs = duration_secs;
    let label = label
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "a break".into());
    state.active_interrupt = Some(ActiveInterrupt {
        kind: "break".into(),
        label,
        event_id,
    });
    state.clone()
}

#[tauri::command]
pub fn resume_from_break(app_handle: tauri::AppHandle) -> TimerState {
    let app_data = app_handle.state::<AppData>();
    let mut state = app_data.state.lock().unwrap();
    let now_ts = chrono::Local::now().timestamp();
    finalize_break(&mut state, now_ts);

    // If past limit, go to limit_reached; otherwise active
    if state.elapsed_secs >= state.limit_mins * 60 {
        state.status = "limit_reached".into();
        state.active_interrupt = Some(ActiveInterrupt {
            kind: "limit".into(),
            label: "Enough Work".into(),
            event_id: None,
        });
        drop(state);
        let _ = app_handle.emit("show-overlay", ());
        return app_handle.state::<AppData>().state.lock().unwrap().clone();
    }
    state.status = "active".into();
    state.clone()
}

/// Extend or shorten the running break by `delta_secs`. `break_until` and
/// `break_duration_secs` move by the same signed delta so counted time stays
/// continuous. Shortening clamps to one minute remaining and is a no-op once
/// the break has ended.
#[tauri::command]
pub fn adjust_break(delta_secs: i64, app_handle: tauri::AppHandle) -> TimerState {
    let app_data = app_handle.state::<AppData>();
    let mut state = app_data.state.lock().unwrap();
    let now_ts = chrono::Local::now().timestamp();
    if state.status == "on_break" {
        let current = state.break_until.unwrap_or(now_ts);
        let new_until = if delta_secs >= 0 {
            std::cmp::max(current, now_ts) + delta_secs
        } else if current <= now_ts {
            current // already ended — nothing to shorten
        } else {
            std::cmp::max(current + delta_secs, now_ts + 60)
        };
        let applied = new_until - current;
        state.break_until = Some(new_until);
        state.break_duration_secs = (state.break_duration_secs as i64 + applied).max(1) as u64;
    }
    state.clone()
}

/// Set the running break's total duration. The new end is
/// `started_at + total`, so a total below the already-elapsed time leaves
/// `break_until` in the past by the overshoot — the overlay then shows the
/// total as taken plus recharging overtime.
#[tauri::command]
pub fn set_break_duration(total_secs: u64, app_handle: tauri::AppHandle) -> TimerState {
    let app_data = app_handle.state::<AppData>();
    let mut state = app_data.state.lock().unwrap();
    let now_ts = chrono::Local::now().timestamp();
    if state.status == "on_break" {
        let total_secs = total_secs.max(60); // at least a minute
        // Re-derive elapsed from the anchors so lock/sleep freezes don't skew it.
        let current_until = state.break_until.unwrap_or(now_ts);
        let remaining = (current_until - now_ts).max(0) as u64;
        let elapsed = state.break_duration_secs.saturating_sub(remaining);
        let started = state
            .break_started_at
            .unwrap_or(now_ts - elapsed as i64)
            .min(now_ts - elapsed as i64);
        state.break_duration_secs = total_secs;
        state.break_until = Some(started + total_secs as i64);
    }
    state.clone()
}

#[tauri::command]
pub fn suggest_break(app_handle: tauri::AppHandle) -> BreakSuggestion {
    let app_data = app_handle.state::<AppData>();
    let state = app_data.state.lock().unwrap();
    let now_ts = chrono::Local::now().timestamp();

    // Work time since last break ended (or since day start)
    let work_start = state.last_break_ended_at.unwrap_or_else(|| {
        // Approximate day start from elapsed_secs
        now_ts - state.elapsed_secs as i64
    });
    let work_secs = (now_ts - work_start).max(0) as u64;
    let work_min = (work_secs / 60) as u32;

    let suggested_min = if work_min < 30 {
        5
    } else if work_min < 60 {
        10
    } else if work_min < 120 {
        15
    } else if work_min < 180 {
        20
    } else {
        30
    };

    BreakSuggestion { suggested_min, work_min }
}

#[tauri::command]
pub fn create_event(
    event_type: String,
    title: String,
    trigger_at: i64,
    duration_secs: u64,
    overlay_type: String,
    recurring_days: Vec<u8>,
    app_handle: tauri::AppHandle,
) -> TimerState {
    use chrono::{Datelike, Timelike};
    let app_data = app_handle.state::<AppData>();
    let mut state = app_data.state.lock().unwrap();
    let id = state.next_event_id;
    state.next_event_id += 1;
    // For recurring events, capture the minute-of-day for daily recomputation
    let trigger_minute = if !recurring_days.is_empty() {
        let dt = chrono::DateTime::from_timestamp(trigger_at, 0)
            .map(|t| t.with_timezone(&chrono::Local))
            .map(|t| t.hour() as u32 * 60 + t.minute() as u32);
        dt
    } else {
        None
    };
    // For recurring events: if today isn't a scheduled day, arm for the next
    // scheduled fire and stay dormant today (don't fire or count down to a
    // today-time that won't actually trigger).
    let (effective_trigger_at, effective_triggered) = if !recurring_days.is_empty() {
        let now = chrono::Local::now();
        let today_weekday = now.weekday().num_days_from_sunday() as u8;
        if recurring_days.contains(&today_weekday) {
            // Today is scheduled: keep the (possibly today-adjusted) trigger_at
            (trigger_at, false)
        } else if let Some(next_ts) = crate::state::next_recurring_trigger(&recurring_days, trigger_minute, now) {
            // Advance to the next scheduled weekday; dormant until then.
            (next_ts, true)
        } else {
            (trigger_at, false)
        }
    } else {
        (trigger_at, false)
    };
    state.events.push(ScheduledEvent {
        id,
        event_type,
        title,
        trigger_at: effective_trigger_at,
        duration_secs,
        overlay_type,
        triggered: effective_triggered,
        snoozed_until: None,
        elapsed_at_trigger: None,
        recurring_days,
        recurred_today: false,
        trigger_minute,
        miss_reason: None,
    });
    state.clone()
}

#[tauri::command]
pub fn update_event(
    id: u32,
    event_type: String,
    title: String,
    trigger_at: i64,
    duration_secs: u64,
    overlay_type: String,
    recurring_days: Vec<u8>,
    app_handle: tauri::AppHandle,
) -> TimerState {
    use chrono::{Datelike, Timelike};
    let app_data = app_handle.state::<AppData>();
    let mut state = app_data.state.lock().unwrap();
    if let Some(ev) = state.events.iter_mut().find(|e| e.id == id) {
        ev.event_type = event_type;
        ev.title = title;
        ev.duration_secs = duration_secs;
        ev.overlay_type = overlay_type;
        ev.recurring_days = recurring_days.clone();
        ev.trigger_minute = if !recurring_days.is_empty() {
            chrono::DateTime::from_timestamp(trigger_at, 0)
                .map(|t| t.with_timezone(&chrono::Local))
                .map(|t| t.hour() as u32 * 60 + t.minute() as u32)
        } else {
            None
        };
        // Editing resets daily trigger state. For recurring events not
        // scheduled today, arm for the next scheduled fire and stay dormant.
        let now = chrono::Local::now();
        let today_weekday = now.weekday().num_days_from_sunday() as u8;
        let (effective_trigger_at, effective_triggered) = if !recurring_days.is_empty() && !recurring_days.contains(&today_weekday) {
            if let Some(next_ts) = crate::state::next_recurring_trigger(&recurring_days, ev.trigger_minute, now) {
                (next_ts, true)
            } else {
                (trigger_at, false)
            }
        } else {
            (trigger_at, false)
        };
        ev.trigger_at = effective_trigger_at;
        ev.snoozed_until = None;
        ev.recurred_today = false;
        ev.triggered = effective_triggered;
    }
    state.clone()
}

#[tauri::command]
pub fn delete_event(id: u32, app_handle: tauri::AppHandle) -> TimerState {
    let app_data = app_handle.state::<AppData>();
    let mut state = app_data.state.lock().unwrap();
    state.events.retain(|e| e.id != id);
    state.clone()
}

#[tauri::command]
pub fn dismiss_event(id: u32, app_handle: tauri::AppHandle) -> TimerState {
    let app_data = app_handle.state::<AppData>();
    let mut state = app_data.state.lock().unwrap();
    if let Some(ev) = state.events.iter_mut().find(|e| e.id == id) {
        ev.triggered = true;
        ev.snoozed_until = None;
        ev.miss_reason = None;
    }
    if state
        .active_interrupt
        .as_ref()
        .and_then(|a| a.event_id)
        == Some(id)
    {
        state.active_interrupt = None;
    }
    state.clone()
}

#[tauri::command]
pub fn snooze_event(
    id: u32,
    minutes: Option<u64>,
    remember: Option<bool>,
    app_handle: tauri::AppHandle,
) -> TimerState {
    let mins = minutes
        .unwrap_or_else(|| match app_handle.store("enoughwork-store.json") {
            Ok(store) => load_settings(&store).snooze_event_mins,
            Err(_) => crate::state::default_sticky_mins(),
        })
        .clamp(1, 240);

    let app_data = app_handle.state::<AppData>();
    {
        let mut state = app_data.state.lock().unwrap();
        let now_ts = chrono::Local::now().timestamp();
        if let Some(ev) = state.events.iter_mut().find(|e| e.id == id) {
            ev.triggered = false;
            ev.recurred_today = false; // allow the snoozed re-fire
            ev.snoozed_until = Some(now_ts + mins as i64 * 60);
            ev.miss_reason = None;
        }
        if state
            .active_interrupt
            .as_ref()
            .and_then(|a| a.event_id)
            == Some(id)
        {
            state.active_interrupt = None;
        }
    }
    // Sticky default + label sync — outside the state lock (store I/O).
    if remember.unwrap_or(true) {
        let settings = crate::persistence::write_settings(&app_handle, |s| {
            s.snooze_event_mins = mins;
        });
        let _ = app_handle.emit("snooze-defaults-changed", &settings);
    }
    let result = app_data.state.lock().unwrap().clone();
    result
}

/// Mark an event silently missed (replaced by another interrupt, etc.).
#[tauri::command(rename = "mark_event_missed")]
pub fn mark_event_missed_cmd(id: u32, reason: String, app_handle: tauri::AppHandle) -> TimerState {
    let app_data = app_handle.state::<AppData>();
    let mut state = app_data.state.lock().unwrap();
    if let Some(ev) = state.events.iter_mut().find(|e| e.id == id) {
        mark_event_missed(ev, &reason);
    }
    if state
        .active_interrupt
        .as_ref()
        .and_then(|a| a.event_id)
        == Some(id)
    {
        state.active_interrupt = None;
    }
    state.clone()
}

/// Clear the next-day welcome card and start tracking for today.
#[tauri::command]
pub fn dismiss_day_welcome(app_handle: tauri::AppHandle) -> TimerState {
    let app_data = app_handle.state::<AppData>();
    let mut state = app_data.state.lock().unwrap();
    state.pending_welcome = None;
    if state.status == "stopped" {
        state.status = "active".into();
    }
    state.clone()
}

/// Skip today's occurrence of a recurring event without affecting future days.
/// Marks the event as fully done for today (triggered + recurred_today), which
/// the tick loop treats as "don't fire". The next daily rollover resets
/// recurred_today and re-arms it for the next scheduled weekday.
/// Only meaningful for recurring events armed to fire today (triggered=false).
#[tauri::command]
pub fn skip_event(id: u32, app_handle: tauri::AppHandle) -> TimerState {
    let app_data = app_handle.state::<AppData>();
    let mut state = app_data.state.lock().unwrap();
    if let Some(ev) = state.events.iter_mut().find(|e| e.id == id) {
        ev.triggered = true;
        ev.recurred_today = true;
        ev.snoozed_until = None;
    }
    state.clone()
}

#[tauri::command]
pub fn get_settings(app_handle: tauri::AppHandle) -> crate::state::AppSettings {
    let Ok(store) = app_handle.store("enoughwork-store.json") else {
        return crate::state::AppSettings::default();
    };
    load_settings(&store)
}

/// Read-modify-write: overwrites only the settings page's fields so the
/// sticky snooze defaults survive every save from the UI.
#[tauri::command]
pub fn save_settings(
    overlay_title: String,
    overlay_subtitle: String,
    reset_time: String,
    force_fullscreen_overlay: bool,
    animation_type: String,
    auto_update: bool,
    app_handle: tauri::AppHandle,
) -> crate::state::AppSettings {
    crate::persistence::write_settings(&app_handle, |s| {
        s.overlay_title = overlay_title;
        s.overlay_subtitle = overlay_subtitle;
        s.reset_time = reset_time;
        s.force_fullscreen_overlay = force_fullscreen_overlay;
        s.animation_type = animation_type;
        s.auto_update = auto_update;
    })
}

/// Set a sticky snooze/adjust default directly (popover "Reset to default").
#[tauri::command]
pub fn set_snooze_default(
    category: String,
    minutes: u64,
    app_handle: tauri::AppHandle,
) -> crate::state::AppSettings {
    let minutes = minutes.clamp(1, 240);
    let settings = crate::persistence::write_settings(&app_handle, |s| match category.as_str() {
        "limit" => s.snooze_limit_mins = minutes,
        "event" => s.snooze_event_mins = minutes,
        _ => {}
    });
    let _ = app_handle.emit("snooze-defaults-changed", &settings);
    settings
}

#[tauri::command]
pub fn toggle_autostart(enable: bool, app_handle: tauri::AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app_handle.autolaunch();
    if enable {
        let _ = manager.enable();
    } else {
        let _ = manager.disable();
    }
    manager.is_enabled().unwrap_or(false)
}

#[tauri::command]
pub fn get_autostart(app_handle: tauri::AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app_handle.autolaunch();
    manager.is_enabled().unwrap_or(false)
}

#[tauri::command]
pub fn is_dev() -> bool {
    cfg!(debug_assertions)
}

#[tauri::command]
pub fn get_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
pub fn is_fullscreen_app_running() -> bool {
    #[cfg(target_os = "windows")]
    {
        crate::win32::is_fullscreen_app()
    }

    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

#[tauri::command]
pub fn get_foreground_monitor() -> Option<crate::state::MonitorRect> {
    #[cfg(target_os = "windows")]
    {
        crate::win32::get_foreground_monitor_rect()
    }

    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

#[tauri::command]
pub fn get_main_work_area(app_handle: tauri::AppHandle) -> Option<crate::state::MonitorRect> {
    #[cfg(target_os = "windows")]
    {
        crate::win32::get_main_window_work_area(&app_handle)
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = app_handle;
        None
    }
}
