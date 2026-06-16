use crate::persistence::{get_reset_time, save_daily_history, save_state};
use crate::state::{effective_date, reset_state_for_new_day, AppData, RECUR_WINDOW_SECS};
use std::time::Instant;
use tauri::{Emitter, Manager};
use tauri_plugin_store::StoreExt;

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
                let (old_date, old_active, old_break, old_elapsed) =
                    reset_state_for_new_day(&mut state, &today);
                drop(state);
                if !old_date.is_empty() && old_active > 0 {
                    if let Ok(store) = ah.store("enoughwork-store.json") {
                        save_daily_history(&old_date, old_active, old_break, old_elapsed, &store);
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

            // Scheduled events: fire any due event.
            // - One-time: due when trigger_at passes. After snooze, only snoozed_until re-fires.
            // - Recurring: due only within a 60s window after trigger_at, and only once per day.
            //   If the laptop was off past the window, it's marked done for today (no backfill).
            let now_ts = chrono::Local::now().timestamp();
            let elapsed_now = state.elapsed_secs;
            let mut fired_events: Vec<crate::state::ScheduledEvent> = Vec::new();
            for ev in state.events.iter_mut() {
                let is_recurring = !ev.recurring_days.is_empty();

                if is_recurring {
                    // Already fired today (or dormant for non-scheduled weekday)
                    if ev.recurred_today || ev.triggered {
                        continue;
                    }
                    // Snoozed recurring: fire on snoozed_until
                    if let Some(s) = ev.snoozed_until {
                        if s <= now_ts {
                            ev.recurred_today = true;
                            ev.triggered = true;
                            ev.snoozed_until = None;
                            ev.elapsed_at_trigger = Some(elapsed_now);
                            fired_events.push(ev.clone());
                        }
                        continue;
                    }
                    // Windowed due check — only fire if we're within the window
                    if ev.trigger_at <= now_ts && now_ts < ev.trigger_at + RECUR_WINDOW_SECS {
                        ev.recurred_today = true;
                        ev.triggered = true;
                        ev.elapsed_at_trigger = Some(elapsed_now);
                        fired_events.push(ev.clone());
                        continue;
                    }
                    // Past the fire window for today → mark done for today
                    // (no backfill; re-armed next scheduled day at rollover).
                    if now_ts >= ev.trigger_at + RECUR_WINDOW_SECS {
                        ev.recurred_today = true;
                        ev.triggered = true;
                    }
                    continue;
                }

                // One-time event
                if ev.triggered {
                    continue;
                }
                let original_due = ev.trigger_at <= now_ts;
                let due = if let Some(s) = ev.snoozed_until {
                    s <= now_ts
                } else {
                    original_due
                };
                if due {
                    ev.triggered = true;
                    ev.snoozed_until = None;
                    ev.elapsed_at_trigger = Some(elapsed_now);
                    fired_events.push(ev.clone());
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

            for ev in fired_events {
                let _ = ah.emit("event-triggered", &ev);
            }
        }
    });
}
