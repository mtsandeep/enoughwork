mod commands;
#[cfg(target_os = "windows")]
mod win32;
mod persistence;
mod state;
mod timer;

use persistence::{load_state, save_state};
use state::AppData;
use timer::start_timer;
use std::sync::Mutex;
use std::time::Instant;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};
use tauri_plugin_store::StoreExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Focus existing window when second instance launched
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::Builder::new().args(["--autostart"]).build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_positioner::init())
        .setup(|app| {
            // Load saved state from store
            let store = app.store("enoughwork-store.json")?;
            let saved = load_state(&store);
            drop(store);

            app.manage(AppData {
                state: Mutex::new(saved),
                last_save: Mutex::new(Instant::now()),
            });

            // Migrate any pre-existing autostart registration so it carries the --autostart arg.
            {
                use tauri_plugin_autostart::ManagerExt;
                let mgr = app.autolaunch();
                if let Ok(true) = mgr.is_enabled() {
                    let _ = mgr.disable();
                    let _ = mgr.enable();
                }
            }

            // System tray
            let show_i = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("EnoughWork")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => {
                        if let Some(app_data) = app.try_state::<AppData>() {
                            let state = app_data.state.lock().unwrap();
                            if let Ok(store) = app.store("enoughwork-store.json") {
                                save_state(&state, &store);
                            }
                        }
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

            // Hide to tray on close instead of quitting
            let handle = app.handle().clone();
            let main_window = app.get_webview_window("main").unwrap();
            // When launched by the OS at boot (autostart entry carries --autostart), keep hidden.
            // Manual launches (no --autostart arg) show normally.
            let launched_at_boot = std::env::args().any(|a| a == "--autostart");
            if launched_at_boot {
                let _ = main_window.hide();
            }
            main_window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    if let Some(w) = handle.get_webview_window("main") {
                        let _ = w.hide();
                    }
                }
            });

            // Start background timer
            start_timer(app.handle().clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_state,
            commands::set_limit,
            commands::snooze,
            commands::stop_for_today,
            commands::resume_tracking,
            commands::debug_set_elapsed,
            commands::debug_clear_state,
            commands::get_settings,
            commands::save_settings,
            commands::toggle_autostart,
            commands::get_autostart,
            commands::is_dev,
            commands::get_version,
            commands::is_fullscreen_app_running,
            commands::set_quiet_overlay,
            commands::start_break,
            commands::resume_from_break,
            commands::extend_break,
            commands::suggest_break,
            commands::create_event,
            commands::update_event,
            commands::delete_event,
            commands::dismiss_event,
            commands::snooze_event,
            commands::skip_event,
            commands::get_foreground_monitor,
            commands::get_main_work_area,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
