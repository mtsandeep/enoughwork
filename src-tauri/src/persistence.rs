//! Store I/O helpers — pure functions over the tauri-plugin-store. No
//! `#[tauri::command]` attributes here: the thin command wrappers live in
//! `commands.rs` and call into these, which keeps all command registration
//! paths rooted at `commands::*` (Tauri's `generate_handler!` resolves the
//! command's generated helper symbols from the module in the handler path).

use crate::state::{AppSettings, TimerState};
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

pub fn load_settings(store: &std::sync::Arc<tauri_plugin_store::Store<tauri::Wry>>) -> AppSettings {
    store
        .get("settings")
        .and_then(|v| serde_json::from_value::<AppSettings>(v.clone()).ok())
        .unwrap_or_default()
}

/// Read-modify-write the settings and persist immediately, so a writer that
/// owns a subset of fields never clobbers the rest.
pub fn write_settings(
    app_handle: &tauri::AppHandle,
    mutate: impl FnOnce(&mut AppSettings),
) -> AppSettings {
    let mut settings = match app_handle.store("enoughwork-store.json") {
        Ok(store) => load_settings(&store),
        Err(_) => AppSettings::default(),
    };
    mutate(&mut settings);
    if let Ok(store) = app_handle.store("enoughwork-store.json") {
        let _ = store.set("settings", serde_json::to_value(&settings).unwrap());
        let _ = store.save();
    }
    settings
}

pub fn get_reset_time(app_handle: &tauri::AppHandle) -> String {
    if let Ok(store) = app_handle.store("enoughwork-store.json") {
        load_settings(&store).reset_time
    } else {
        "00:00".into()
    }
}
