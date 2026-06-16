//! Store I/O helpers — pure functions over the tauri-plugin-store. No
//! `#[tauri::command]` attributes here: the thin command wrappers live in
//! `commands.rs` and call into these, which keeps all command registration
//! paths rooted at `commands::*` (Tauri's `generate_handler!` resolves the
//! command's generated helper symbols from the module in the handler path).

use crate::state::{AppSettings, DailyHistory, DayRecord, TimerState};
use tauri_plugin_store::StoreExt;

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

pub fn load_daily_history(store: &std::sync::Arc<tauri_plugin_store::Store<tauri::Wry>>) -> DailyHistory {
    store
        .get("daily_history")
        .and_then(|v| {
            // Try new DayRecord format first
            if let Ok(h) = serde_json::from_value::<DailyHistory>(v.clone()) {
                return Some(h);
            }
            // Fallback: old format was HashMap<String, u64> — migrate
            let old: std::collections::HashMap<String, u64> = serde_json::from_value(v.clone()).ok()?;
            Some(old.into_iter().map(|(k, secs)| (k, DayRecord { active_secs: secs, break_secs: 0, elapsed_secs: 0 })).collect())
        })
        .unwrap_or_default()
}

pub fn save_daily_history(date: &str, active_secs: u64, break_secs: u64, elapsed_secs: u64, store: &std::sync::Arc<tauri_plugin_store::Store<tauri::Wry>>) {
    let mut history = load_daily_history(store);
    history.insert(date.to_string(), DayRecord { active_secs, break_secs, elapsed_secs });
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

pub fn load_settings(store: &std::sync::Arc<tauri_plugin_store::Store<tauri::Wry>>) -> AppSettings {
    store
        .get("settings")
        .and_then(|v| serde_json::from_value::<AppSettings>(v.clone()).ok())
        .unwrap_or_default()
}

pub fn get_reset_time(app_handle: &tauri::AppHandle) -> String {
    if let Ok(store) = app_handle.store("enoughwork-store.json") {
        load_settings(&store).reset_time
    } else {
        "00:00".into()
    }
}
