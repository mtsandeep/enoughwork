mod commands;
mod session_lock;
#[cfg(target_os = "windows")]
mod win32;
mod persistence;
mod state;
mod timer;

use persistence::{load_state, save_state};
use state::{AppData, UiHealth};
use std::io::Write;
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::time::Instant;
use timer::start_timer;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};
use tauri_plugin_store::StoreExt;

fn show_native_error(title: &str, message: &str) {
    #[cfg(target_os = "windows")]
    win32::show_error_dialog(title, message);
    #[cfg(not(target_os = "windows"))]
    eprintln!("[ERROR] {}: {}", title, message);
}

fn append_error_log(app: &tauri::AppHandle, line: &str) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    let log_path = dir.join("enoughwork.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&log_path) {
        let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
        let _ = writeln!(f, "[{}] {}", ts, line);
    }
    Some(log_path)
}

fn report_ui_failure(app: &tauri::AppHandle, reason: &str, show_dialog: bool) {
    if let Some(health) = app.try_state::<UiHealth>() {
        health.failed.store(true, Ordering::Relaxed);
    }
    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_tooltip(Some("EnoughWork — UI failed to load (click for details)"));
    }
    let wv2_ver = tauri::webview_version()
        .map(|v| v)
        .unwrap_or_else(|e| format!("unavailable ({})", e));
    let log_line = format!("{} | webview_version={}", reason, wv2_ver);
    let log_path = append_error_log(app, &log_line);

    if show_dialog {
        let log_hint = log_path
            .map(|p| format!("\n\nLog: {}", p.display()))
            .unwrap_or_default();
        let msg = format!(
            "EnoughWork's window failed to load ({}).\n\n\
             WebView2 Runtime: {}\n\n\
             This usually means Microsoft Edge WebView2 Runtime is missing or damaged.\n\
             Download and run the Evergreen Bootstrapper (or Evergreen Standalone Installer) from:\n\
             https://developer.microsoft.com/en-us/microsoft-edge/webview2/\n\
             then restart your PC and relaunch EnoughWork.{}",
            reason, wv2_ver, log_hint
        );
        std::thread::spawn(move || {
            show_native_error("EnoughWork — UI Failed to Load", &msg);
        });
    }
}

fn show_main_window(app: &tauri::AppHandle) {
    let already_failed = app
        .try_state::<UiHealth>()
        .map(|h| h.failed.load(Ordering::Relaxed))
        .unwrap_or(false);
    if already_failed {
        report_ui_failure(app, "WebView UI did not initialize", true);
        return;
    }

    match app.get_webview_window("main") {
        Some(w) => {
            let _ = w.unminimize();
            if let Err(e) = w.show() {
                report_ui_failure(app, &format!("window.show() failed: {}", e), true);
                return;
            }
            let _ = w.set_focus();
        }
        None => {
            report_ui_failure(app, "main webview window missing", true);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Focus existing window when second instance launched
            show_main_window(app);
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
            app.manage(UiHealth::default());

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

            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("EnoughWork")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
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
                        show_main_window(tray.app_handle());
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

            // Watchdog: if the webview frontend never reports ready, flag the tray
            // and (for manual launches) surface a native dialog without WebView2.
            let watchdog_handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(10));
                let ready = watchdog_handle
                    .try_state::<UiHealth>()
                    .map(|h| h.ready.load(Ordering::Relaxed))
                    .unwrap_or(false);
                if !ready {
                    report_ui_failure(
                        &watchdog_handle,
                        "WebView UI did not initialize within 10s",
                        !launched_at_boot,
                    );
                }
            });

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
            commands::adjust_break,
            commands::set_break_duration,
            commands::suggest_break,
            commands::create_event,
            commands::update_event,
            commands::delete_event,
            commands::dismiss_event,
            commands::snooze_event,
            commands::mark_event_missed_cmd,
            commands::dismiss_day_welcome,
            commands::skip_event,
            commands::start_task,
            commands::pause_task,
            commands::resume_task,
            commands::restart_task,
            commands::stop_task,
            commands::dismiss_task,
            commands::get_foreground_monitor,
            commands::get_main_work_area,
            commands::set_snooze_default,
            commands::ui_ready,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
