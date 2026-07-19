use crate::persistence::{get_reset_time, save_state};
use crate::state::{
    effective_date, event_display_label, mark_event_missed, miss_reason_for_elapsed,
    reset_state_for_new_day, ActiveInterrupt, AppData, RECUR_WINDOW_SECS,
};
use std::time::Instant;
use tauri::{Emitter, Manager};
use tauri_plugin_store::StoreExt;

/// Background tick: increments elapsed while counting, freezes breaks during
/// lock/sleep, fires events only while time is running, and handles day rollover.
pub fn start_timer(app_handle: tauri::AppHandle) {
    let ah = app_handle.clone();
    std::thread::spawn(move || {
        let mut last_tick = Instant::now();
        let mut last_wall_ts = chrono::Local::now().timestamp();
        let mut break_ended_emitted = false;
        loop {
            std::thread::sleep(std::time::Duration::from_secs(1));
            let now = Instant::now();
            let delta = now.duration_since(last_tick);
            last_tick = now;

            let now_ts = chrono::Local::now().timestamp();
            let wall_delta = (now_ts - last_wall_ts).max(0);
            last_wall_ts = now_ts;

            let mut should_show_overlay = false;
            let mut day_rolled = false;

            let reset_time = get_reset_time(&ah);
            let today = effective_date(&reset_time);

            let app_data = ah.state::<AppData>();
            let mut state = app_data.state.lock().unwrap();

            if state.date != today {
                reset_state_for_new_day(&mut state, &today);
                day_rolled = true;
                break_ended_emitted = false;
            }

            let session_locked = crate::session_lock::is_session_locked();
            let sleep_gap = delta.as_secs() > 30;
            let system_active = !session_locked && !sleep_gap;
            // Time only counts while actively tracking (or on break) and system is usable.
            let time_running = system_active
                && (state.status == "active" || state.status == "on_break");

            // Freeze break countdown across lock/sleep by pushing break_until forward.
            if state.status == "on_break" && !system_active && wall_delta > 0 {
                if let Some(until) = state.break_until.as_mut() {
                    *until += wall_delta;
                }
            }

            if state.status == "snoozed" && time_running {
                if let Some(until) = state.snooze_until {
                    if now_ts >= until {
                        state.status = "limit_reached".into();
                        state.snooze_until = None;
                        state.snooze_started_at = None;
                        state.active_interrupt = Some(ActiveInterrupt {
                            kind: "limit".into(),
                            label: "Enough Work".into(),
                            event_id: None,
                        });
                        should_show_overlay = true;
                    }
                }
            } else if state.status == "snoozed" && !time_running {
                // Snooze may expire while inactive — flip status, but never show overlay.
                if let Some(until) = state.snooze_until {
                    if now_ts >= until {
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

            // Break expiry — only while system active (frozen otherwise)
            if state.status == "on_break" && system_active {
                if let Some(until) = state.break_until {
                    if now_ts >= until && !break_ended_emitted {
                        break_ended_emitted = true;
                        let _ = ah.emit("break-ended", ());
                    }
                }
            } else if state.status != "on_break" {
                break_ended_emitted = false;
            }

            if time_running {
                state.active_secs += 1;
            }

            if (state.status == "active" || state.status == "on_break") && time_running {
                state.elapsed_secs += 1;

                let limit_secs = state.limit_mins * 60;
                if state.elapsed_secs >= limit_secs && state.status == "active" {
                    state.status = "limit_reached".into();
                    state.active_interrupt = Some(ActiveInterrupt {
                        kind: "limit".into(),
                        label: "Enough Work".into(),
                        event_id: None,
                    });
                    should_show_overlay = true;
                }
            }

            // Events fire only while time is running. Otherwise silent-miss.
            let elapsed_now = state.elapsed_secs;
            let miss_reason = miss_reason_for_elapsed(elapsed_now);
            let mut fired_events: Vec<crate::state::ScheduledEvent> = Vec::new();
            for ev in state.events.iter_mut() {
                let is_recurring = !ev.recurring_days.is_empty();

                if is_recurring {
                    if ev.recurred_today || ev.triggered {
                        continue;
                    }
                    if let Some(s) = ev.snoozed_until {
                        if s <= now_ts {
                            if time_running {
                                ev.recurred_today = true;
                                ev.triggered = true;
                                ev.snoozed_until = None;
                                ev.miss_reason = None;
                                ev.elapsed_at_trigger = Some(elapsed_now);
                                fired_events.push(ev.clone());
                            } else {
                                mark_event_missed(ev, &miss_reason);
                            }
                        }
                        continue;
                    }
                    if ev.trigger_at <= now_ts && now_ts < ev.trigger_at + RECUR_WINDOW_SECS {
                        if time_running {
                            ev.recurred_today = true;
                            ev.triggered = true;
                            ev.miss_reason = None;
                            ev.elapsed_at_trigger = Some(elapsed_now);
                            fired_events.push(ev.clone());
                        }
                        // If not running, wait — may still fire if user returns inside the window.
                        continue;
                    }
                    if now_ts >= ev.trigger_at + RECUR_WINDOW_SECS {
                        mark_event_missed(ev, &miss_reason);
                    }
                    continue;
                }

                // One-time: same 60s fire window as recurring (no late backfill).
                if ev.triggered {
                    continue;
                }
                if let Some(s) = ev.snoozed_until {
                    if s <= now_ts {
                        if time_running {
                            ev.triggered = true;
                            ev.snoozed_until = None;
                            ev.miss_reason = None;
                            ev.elapsed_at_trigger = Some(elapsed_now);
                            fired_events.push(ev.clone());
                        } else {
                            mark_event_missed(ev, &miss_reason);
                        }
                    }
                    continue;
                }
                if ev.trigger_at <= now_ts && now_ts < ev.trigger_at + RECUR_WINDOW_SECS {
                    if time_running {
                        ev.triggered = true;
                        ev.miss_reason = None;
                        ev.elapsed_at_trigger = Some(elapsed_now);
                        fired_events.push(ev.clone());
                    }
                    continue;
                }
                if now_ts >= ev.trigger_at + RECUR_WINDOW_SECS {
                    mark_event_missed(ev, &miss_reason);
                }
            }

            // Record interrupt labels for fired events (welcome / replace bookkeeping)
            for ev in &fired_events {
                state.active_interrupt = Some(ActiveInterrupt {
                    kind: ev.event_type.clone(),
                    label: event_display_label(ev),
                    event_id: Some(ev.id),
                });
            }

            let welcome_snapshot = state.pending_welcome.clone();
            let state_snapshot = state.clone();

            {
                let mut last_save = app_data.last_save.lock().unwrap();
                if now.duration_since(*last_save) > std::time::Duration::from_secs(60) {
                    *last_save = now;
                    drop(last_save);
                    if let Ok(store) = ah.store("enoughwork-store.json") {
                        save_state(&state_snapshot, &store);
                    }
                }
            }

            drop(state);

            if day_rolled {
                let _ = ah.emit("day-rolled", &welcome_snapshot);
            }

            if should_show_overlay {
                let _ = ah.emit("show-overlay", ());
            }

            for ev in fired_events {
                let _ = ah.emit("event-triggered", &ev);
            }
        }
    });
}
