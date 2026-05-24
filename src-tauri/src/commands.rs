use chrono::Timelike;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;
use tauri::{Emitter, Manager};
use tauri_plugin_store::StoreExt;

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
            quiet_overlay: false,
            break_until: None,
            break_started_at: None,
            break_duration_secs: 0,
            total_break_secs: 0,
            break_count: 0,
            last_break_ended_at: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DayRecord {
    pub active_secs: u64,
    pub break_secs: u64,
}

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
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            overlay_title: "Enough Work!".into(),
            overlay_subtitle: "You've done enough for today. Time to step away.".into(),
            reset_time: "00:00".into(),
            force_fullscreen_overlay: false,
            animation_type: "star-drop".into(),
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
        let old_date = state.date.clone();
        let old_active = state.active_secs;
        let old_break = state.total_break_secs;
        state.date = today;
        state.elapsed_secs = 0;
        state.active_secs = 0;
        state.status = "active".into();
        state.snooze_until = None;
        state.snooze_started_at = None;
        state.quiet_overlay = false;
        state.break_until = None;
        state.break_started_at = None;
        state.break_duration_secs = 0;
        state.total_break_secs = 0;
        state.break_count = 0;
        state.last_break_ended_at = None;
        drop(state);
        if !old_date.is_empty() && old_active > 0 {
            if let Ok(store) = app_handle.store("enoughwork-store.json") {
                save_daily_history(&old_date, old_active, old_break, &store);
            }
        }
        state = app_data.state.lock().unwrap();
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

#[tauri::command]
pub fn set_quiet_overlay(enabled: bool, app_handle: tauri::AppHandle) -> TimerState {
    let app_data = app_handle.state::<AppData>();
    let mut state = app_data.state.lock().unwrap();
    state.quiet_overlay = enabled;
    state.clone()
}

#[tauri::command]
pub fn start_break(duration_secs: u64, app_handle: tauri::AppHandle) -> TimerState {
    let app_data = app_handle.state::<AppData>();
    let mut state = app_data.state.lock().unwrap();
    let now_ts = chrono::Local::now().timestamp();
    state.status = "on_break".into();
    state.break_until = Some(now_ts + duration_secs as i64);
    state.break_started_at = Some(now_ts);
    state.break_duration_secs = duration_secs;
    state.clone()
}

#[tauri::command]
pub fn resume_from_break(app_handle: tauri::AppHandle) -> TimerState {
    let t0 = std::time::Instant::now();
    let app_data = app_handle.state::<AppData>();
    let mut state = app_data.state.lock().unwrap();
    let wait_ms = t0.elapsed().as_millis();
    let now_ts = chrono::Local::now().timestamp();

    // Record actual break time taken
    if let Some(started) = state.break_started_at {
        let actual = (now_ts - started) as u64;
        state.total_break_secs += actual;
    }
    state.break_count += 1;
    state.last_break_ended_at = Some(now_ts);
    state.break_until = None;
    state.break_started_at = None;
    state.break_duration_secs = 0;

    // If past limit, go to limit_reached; otherwise active
    if state.elapsed_secs >= state.limit_mins * 60 {
        state.status = "limit_reached".into();
        drop(state);
        eprintln!("[break] resume_from_break: mutex_wait={wait_ms}ms, total={}ms -> limit_reached", t0.elapsed().as_millis());
        let _ = app_handle.emit("show-overlay", ());
        return app_handle.state::<AppData>().state.lock().unwrap().clone();
    }
    state.status = "active".into();
    eprintln!("[break] resume_from_break: mutex_wait={wait_ms}ms, total={}ms -> active", t0.elapsed().as_millis());
    state.clone()
}

#[tauri::command]
pub fn extend_break(add_secs: u64, app_handle: tauri::AppHandle) -> TimerState {
    let t0 = std::time::Instant::now();
    let app_data = app_handle.state::<AppData>();
    let mut state = app_data.state.lock().unwrap();
    let wait_ms = t0.elapsed().as_millis();
    let now_ts = chrono::Local::now().timestamp();
    if state.status == "on_break" {
        let current = state.break_until.unwrap_or(now_ts);
        state.break_until = Some(std::cmp::max(current, now_ts) + add_secs as i64);
        state.break_duration_secs += add_secs;
    }
    eprintln!("[break] extend_break: mutex_wait={wait_ms}ms, total={}ms", t0.elapsed().as_millis());
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

type DailyHistory = HashMap<String, DayRecord>;

fn load_daily_history(store: &std::sync::Arc<tauri_plugin_store::Store<tauri::Wry>>) -> DailyHistory {
    store
        .get("daily_history")
        .and_then(|v| {
            // Try new DayRecord format first
            if let Ok(h) = serde_json::from_value::<DailyHistory>(v.clone()) {
                return Some(h);
            }
            // Fallback: old format was HashMap<String, u64> — migrate
            let old: HashMap<String, u64> = serde_json::from_value(v.clone()).ok()?;
            Some(old.into_iter().map(|(k, secs)| (k, DayRecord { active_secs: secs, break_secs: 0 })).collect())
        })
        .unwrap_or_default()
}

fn save_daily_history(date: &str, active_secs: u64, break_secs: u64, store: &std::sync::Arc<tauri_plugin_store::Store<tauri::Wry>>) {
    let mut history = load_daily_history(store);
    history.insert(date.to_string(), DayRecord { active_secs, break_secs });
    // Prune to last 30 days
    let mut dates: Vec<String> = history.keys().cloned().collect();
    dates.sort();
    while dates.len() > 30 {
        if let Some(old) = dates.first() {
            history.remove(old);
        }
        dates.remove(0);
    }
    let _ = store.set("daily_history", serde_json::to_value(&history).unwrap());
    let _ = store.save();
}

#[tauri::command]
pub fn get_history(app_handle: tauri::AppHandle) -> DailyHistory {
    let Ok(store) = app_handle.store("enoughwork-store.json") else {
        return HashMap::new();
    };
    load_daily_history(&store)
}

/// Background tick: increments elapsed_secs if active, detects sleep via time gaps,
/// saves state periodically, and emits events when limit is reached.
pub fn start_timer(app_handle: tauri::AppHandle) {
    let ah = app_handle.clone();
    std::thread::spawn(move || {
        let mut last_tick = Instant::now();
        let mut break_ended_emitted = false;
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
                let old_date = state.date.clone();
                let old_active = state.active_secs;
                let old_break = state.total_break_secs;
                state.date = today;
                state.elapsed_secs = 0;
                state.active_secs = 0;
                state.status = "active".into();
                state.snooze_until = None;
                state.snooze_started_at = None;
                state.break_until = None;
                state.break_started_at = None;
                state.break_duration_secs = 0;
                state.total_break_secs = 0;
                state.break_count = 0;
                state.last_break_ended_at = None;
                drop(state);
                if !old_date.is_empty() && old_active > 0 {
                    if let Ok(store) = ah.store("enoughwork-store.json") {
                        save_daily_history(&old_date, old_active, old_break, &store);
                    }
                }
                state = app_data.state.lock().unwrap();
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

            // Check break expiry — emit only once
            if state.status == "on_break" {
                if let Some(until) = state.break_until {
                    if chrono::Local::now().timestamp() >= until && !break_ended_emitted {
                        break_ended_emitted = true;
                        let _ = ah.emit("break-ended", ());
                    }
                }
            } else {
                break_ended_emitted = false;
            }

            // Active time always tracks when laptop is awake, regardless of status
            if delta.as_secs() <= 30 {
                state.active_secs += 1;
            }

            // elapsed_secs ticks for both "active" and "on_break" (timer doesn't pause during break)
            if (state.status == "active" || state.status == "on_break") && delta.as_secs() <= 30 {
                state.elapsed_secs += 1;

                let limit_secs = state.limit_mins * 60;
                if state.elapsed_secs >= limit_secs && state.status == "active" {
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
    force_fullscreen_overlay: bool,
    animation_type: String,
    app_handle: tauri::AppHandle,
) -> AppSettings {
    let settings = AppSettings {
        overlay_title,
        overlay_subtitle,
        reset_time,
        force_fullscreen_overlay,
        animation_type,
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

#[tauri::command]
pub fn is_fullscreen_app_running() -> bool {
    #[cfg(target_os = "windows")]
    {
        win32::is_fullscreen_app()
    }

    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonitorRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[tauri::command]
pub fn get_foreground_monitor() -> Option<MonitorRect> {
    #[cfg(target_os = "windows")]
    {
        win32::get_foreground_monitor_rect()
    }

    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

#[tauri::command]
pub fn get_main_work_area(app_handle: tauri::AppHandle) -> Option<MonitorRect> {
    #[cfg(target_os = "windows")]
    {
        win32::get_main_window_work_area(&app_handle)
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = app_handle;
        None
    }
}

#[cfg(target_os = "windows")]
mod win32 {
    use super::MonitorRect;
    use std::ffi::c_void;
    use std::mem;

    type HWND = *mut c_void;
    type HMONITOR = *mut c_void;
    type BOOL = i32;
    type DWORD = u32;
    type LPARAM = isize;
    type WNDENUMPROC = Option<unsafe extern "system" fn(HWND, LPARAM) -> BOOL>;

    #[repr(C)]
    #[derive(Clone)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    #[repr(C)]
    struct MonitorInfo {
        cb_size: DWORD,
        rc_monitor: Rect,
        rc_work: Rect,
        dw_flags: DWORD,
    }

    const GWL_STYLE: i32 = -16;
    const WS_THICKFRAME: u32 = 0x00040000;
    const WS_CAPTION: u32 = 0x00C00000;
    const PROCESS_QUERY_LIMITED_INFORMATION: DWORD = 0x1000;

    // System executables that create fullscreen overlay windows always present on screen
    const SYSTEM_OVERLAYS: &[&str] = &[
        "searchui.exe",
        "searchhost.exe",
        "shellexperiencehost.exe",
        "startmenuexperiencehost.exe",
        "dwm.exe",
        "lockapp.exe",
        "logonui.exe",
        "textinputhost.exe",
        "nvidia overlay.exe",
    ];

    struct WindowInfo {
        pid: DWORD,
        title: String,
        style: u32,
        rect: Rect,
        monitor_rect: Rect,
    }

    extern "system" {
        fn GetWindowRect(hwnd: HWND, lprect: *mut Rect) -> BOOL;
        fn MonitorFromWindow(hwnd: HWND, dwflags: DWORD) -> HMONITOR;
        fn GetMonitorInfoW(hmonitor: HMONITOR, lpmi: *mut MonitorInfo) -> BOOL;
        fn IsWindowVisible(hwnd: HWND) -> BOOL;
        fn EnumWindows(lpenumfunc: WNDENUMPROC, lparam: LPARAM) -> BOOL;
        fn GetWindowTextW(hwnd: HWND, lpstring: *mut u16, nmaxcount: i32) -> i32;
        fn GetWindowLongW(hwnd: HWND, nindex: i32) -> i32;
        fn GetWindowThreadProcessId(hwnd: HWND, lpdwprocessid: *mut DWORD) -> DWORD;
        fn GetCurrentProcessId() -> DWORD;
        fn OpenProcess(access: DWORD, inherit: BOOL, pid: DWORD) -> *mut c_void;
        fn QueryFullProcessImageNameW(
            process: *mut c_void,
            flags: DWORD,
            buf: *mut u16,
            size: *mut DWORD,
        ) -> BOOL;
        fn CloseHandle(handle: *mut c_void) -> BOOL;
    }

    fn get_exe_name(pid: DWORD) -> Option<String> {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return None;
            }
            let mut buf = [0u16; 512];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut len);
            CloseHandle(h);
            if ok == 0 {
                return None;
            }
            let full = String::from_utf16_lossy(&buf[..len as usize]);
            Some(full.rsplit('\\').next().unwrap_or(&full).to_lowercase())
        }
    }

    unsafe extern "system" fn collect_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let windows = &mut *(lparam as *mut Vec<WindowInfo>);

        if IsWindowVisible(hwnd) == 0 {
            return 1;
        }

        let style = GetWindowLongW(hwnd, GWL_STYLE) as u32;

        let mut title_buf = [0u16; 256];
        let title_len = GetWindowTextW(hwnd, title_buf.as_mut_ptr(), 256);
        let title = if title_len > 0 {
            String::from_utf16_lossy(&title_buf[..title_len as usize])
        } else {
            String::new()
        };

        if title == "Program Manager" {
            return 1;
        }

        let mut pid: DWORD = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);

        let mut window_rect = mem::zeroed::<Rect>();
        if GetWindowRect(hwnd, &mut window_rect) == 0 {
            return 1;
        }
        if window_rect.right <= window_rect.left || window_rect.bottom <= window_rect.top {
            return 1;
        }

        let monitor = MonitorFromWindow(hwnd, 0);
        if monitor.is_null() {
            return 1;
        }
        let mut monitor_info = mem::zeroed::<MonitorInfo>();
        monitor_info.cb_size = mem::size_of::<MonitorInfo>() as DWORD;
        if GetMonitorInfoW(monitor, &mut monitor_info) == 0 {
            return 1;
        }

        windows.push(WindowInfo {
            pid,
            title,
            style,
            rect: window_rect,
            monitor_rect: monitor_info.rc_monitor,
        });

        1
    }

    fn find_fullscreen() -> Option<Rect> {
        let own_pid = unsafe { GetCurrentProcessId() };

        let mut windows: Vec<WindowInfo> = Vec::new();
        unsafe {
            EnumWindows(
                Some(collect_callback),
                &mut windows as *mut Vec<WindowInfo> as LPARAM,
            );
        }

        // Find a frameless window covering >=90% of its monitor, not from a system overlay
        for w in &windows {
            if w.pid == own_pid { continue; }
            if w.title.is_empty() { continue; }
            // Must be frameless (no thick frame, no caption)
            if w.style & (WS_THICKFRAME | WS_CAPTION) != 0 { continue; }
            // Must cover >=90% of monitor area
            let mon_w = (w.monitor_rect.right - w.monitor_rect.left) as f64;
            let mon_h = (w.monitor_rect.bottom - w.monitor_rect.top) as f64;
            if mon_w <= 0.0 || mon_h <= 0.0 { continue; }
            let win_w = (w.rect.right - w.rect.left).max(0) as f64;
            let win_h = (w.rect.bottom - w.rect.top).max(0) as f64;
            let coverage = (win_w * win_h) / (mon_w * mon_h);
            if coverage < 0.999 { continue; }
            // Check if it's a system overlay by executable name
            let exe = match get_exe_name(w.pid) {
                Some(e) => e,
                None => continue,
            };
            if SYSTEM_OVERLAYS.contains(&exe.as_str()) {
                continue;
            }

            return Some(w.monitor_rect.clone());
        }

        None
    }

    pub fn is_fullscreen_app() -> bool {
        find_fullscreen().is_some()
    }

    pub fn get_foreground_monitor_rect() -> Option<MonitorRect> {
        let mr = find_fullscreen()?;
        Some(MonitorRect {
            x: mr.left,
            y: mr.top,
            width: (mr.right - mr.left) as u32,
            height: (mr.bottom - mr.top) as u32,
        })
    }

    pub fn get_main_window_work_area(app_handle: &tauri::AppHandle) -> Option<MonitorRect> {
        use tauri::Manager;
        let window = app_handle.get_webview_window("main")?;
        let hwnd = window.hwnd().ok()?;
        let hmonitor = unsafe { MonitorFromWindow(hwnd.0 as HWND, 0) };
        if hmonitor.is_null() {
            return None;
        }
        let mut mi = MonitorInfo {
            cb_size: mem::size_of::<MonitorInfo>() as DWORD,
            rc_monitor: Rect { left: 0, top: 0, right: 0, bottom: 0 },
            rc_work: Rect { left: 0, top: 0, right: 0, bottom: 0 },
            dw_flags: 0,
        };
        if unsafe { GetMonitorInfoW(hmonitor, &mut mi) } == 0 {
            return None;
        }
        Some(MonitorRect {
            x: mi.rc_work.left,
            y: mi.rc_work.top,
            width: (mi.rc_work.right - mi.rc_work.left) as u32,
            height: (mi.rc_work.bottom - mi.rc_work.top) as u32,
        })
    }
}
