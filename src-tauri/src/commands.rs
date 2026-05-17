use chrono::Timelike;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::Instant;
use tauri::{Emitter, Manager};
use tauri_plugin_store::StoreExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimerState {
    pub date: String,
    pub elapsed_secs: u64,
    pub limit_mins: u64,
    pub status: String,
    pub snooze_until: Option<i64>,
    pub snooze_started_at: Option<i64>, // when snooze first began
}

impl Default for TimerState {
    fn default() -> Self {
        Self {
            date: effective_date("00:00"),
            elapsed_secs: 0,
            limit_mins: 480,
            status: "active".into(),
            snooze_until: None,
            snooze_started_at: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub overlay_title: String,
    pub overlay_subtitle: String,
    pub reset_time: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            overlay_title: "Enough Work!".into(),
            overlay_subtitle: "You've done enough for today. Time to step away.".into(),
            reset_time: "00:00".into(),
        }
    }
}

fn parse_reset_time(s: &str) -> (u32, u32) {
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() == 2 {
        let h = parts[0].parse::<u32>().unwrap_or(0);
        let m = parts[1].parse::<u32>().unwrap_or(0);
        (h.min(23), m.min(59))
    } else {
        (0, 0)
    }
}

fn effective_date(reset_time: &str) -> String {
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

pub struct AppData {
    pub state: Mutex<TimerState>,
    pub last_save: Mutex<Instant>,
}

#[tauri::command]
pub fn get_state(app_handle: tauri::AppHandle) -> TimerState {
    let reset_time = get_reset_time(&app_handle);
    let today = effective_date(&reset_time);

    let app_data = app_handle.state::<AppData>();
    let mut state = app_data.state.lock().unwrap();

    if state.date != today {
        state.date = today;
        state.elapsed_secs = 0;
        state.status = "active".into();
        state.snooze_until = None;
        state.snooze_started_at = None;
    }

    if state.status == "snoozed" {
        if let Some(until) = state.snooze_until {
            let now_ts = chrono::Local::now().timestamp();
            if now_ts >= until {
                state.status = "limit_reached".into();
                state.snooze_until = None;
                state.snooze_started_at = None;
                drop(state);
                let _ = app_handle.emit("show-overlay", ());
                return app_handle.state::<AppData>().state.lock().unwrap().clone();
            }
        }
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
pub fn snooze(minutes: u64, app_handle: tauri::AppHandle) -> TimerState {
    let app_data = app_handle.state::<AppData>();
    let mut state = app_data.state.lock().unwrap();
    let now_ts = chrono::Local::now().timestamp();
    let extra_secs = minutes as i64 * 60;

    // If already snoozed, extend; otherwise start fresh
    let current_until = state.snooze_until.unwrap_or(now_ts);
    state.snooze_until = Some(std::cmp::max(current_until, now_ts) + extra_secs);

    if state.snooze_started_at.is_none() {
        state.snooze_started_at = Some(now_ts);
    }
    state.status = "snoozed".into();
    state.clone()
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

    // If already past limit, go to limit_reached not active
    if state.elapsed_secs >= state.limit_mins * 60 {
        state.status = "limit_reached".into();
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

pub fn load_state(store: &std::sync::Arc<tauri_plugin_store::Store<tauri::Wry>>) -> TimerState {
    store
        .get("timer_state")
        .and_then(|v| serde_json::from_value::<TimerState>(v.clone()).ok())
        .unwrap_or_default()
}

pub fn save_state(state: &TimerState, store: &std::sync::Arc<tauri_plugin_store::Store<tauri::Wry>>) {
    let _ = store.set("timer_state", serde_json::to_value(state).unwrap());
    let _ = store.save();
}

/// Background tick: increments elapsed_secs if active, detects sleep via time gaps,
/// saves state periodically, and emits events when limit is reached.
pub fn start_timer(app_handle: tauri::AppHandle) {
    let ah = app_handle.clone();
    std::thread::spawn(move || {
        let mut last_tick = Instant::now();
        loop {
            std::thread::sleep(std::time::Duration::from_secs(1));
            let now = Instant::now();
            let delta = now.duration_since(last_tick);
            last_tick = now;

            let mut should_show_overlay = false;

            let reset_time = get_reset_time(&ah);
            let today = effective_date(&reset_time);

            let app_data = ah.state::<AppData>();
            let mut state = app_data.state.lock().unwrap();

            if state.date != today {
                state.date = today;
                state.elapsed_secs = 0;
                state.status = "active".into();
                state.snooze_until = None;
                state.snooze_started_at = None;
            }

            if state.status == "snoozed" {
                if let Some(until) = state.snooze_until {
                    if chrono::Local::now().timestamp() >= until {
                        state.status = "limit_reached".into();
                        state.snooze_until = None;
                        state.snooze_started_at = None;
                        should_show_overlay = true;
                    }
                }
            }

            if state.status == "active" && delta.as_secs() <= 30 {
                state.elapsed_secs += 1;

                let limit_secs = state.limit_mins * 60;
                if state.elapsed_secs >= limit_secs {
                    state.status = "limit_reached".into();
                    should_show_overlay = true;
                }
            }

            let state_snapshot = state.clone();

            {
                let mut last_save = app_data.last_save.lock().unwrap();
                if now.duration_since(*last_save) > std::time::Duration::from_secs(60) {
                    *last_save = now;
                    drop(last_save);
                    // Disk I/O outside the state lock
                    if let Ok(store) = ah.store("enoughwork-store.json") {
                        save_state(&state_snapshot, &store);
                    }
                }
            }

            drop(state);

            if should_show_overlay {
                let _ = ah.emit("show-overlay", ());
            }
        }
    });
}

#[tauri::command]
pub fn get_settings(app_handle: tauri::AppHandle) -> AppSettings {
    let Ok(store) = app_handle.store("enoughwork-store.json") else {
        return AppSettings::default();
    };
    store
        .get("settings")
        .and_then(|v| serde_json::from_value::<AppSettings>(v.clone()).ok())
        .unwrap_or_default()
}

fn get_reset_time(app_handle: &tauri::AppHandle) -> String {
    if let Ok(store) = app_handle.store("enoughwork-store.json") {
        store
            .get("settings")
            .and_then(|v| serde_json::from_value::<AppSettings>(v.clone()).ok())
            .map(|s| s.reset_time)
            .unwrap_or_else(|| "00:00".into())
    } else {
        "00:00".into()
    }
}

#[tauri::command]
pub fn save_settings(
    overlay_title: String,
    overlay_subtitle: String,
    reset_time: String,
    app_handle: tauri::AppHandle,
) -> AppSettings {
    let settings = AppSettings {
        overlay_title,
        overlay_subtitle,
        reset_time,
    };
    let store = app_handle.store("enoughwork-store.json");
    if let Ok(store) = store {
        let _ = store.set("settings", serde_json::to_value(&settings).unwrap());
        let _ = store.save();
    }
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
