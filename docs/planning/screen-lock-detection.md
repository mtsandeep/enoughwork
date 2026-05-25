# Screen Lock Detection — EnoughWork

## Context
When a user walks away and the screen auto-locks (Win+L, screensaver timeout, etc.), the timer keeps running if the laptop stays awake (plugged in, no sleep). The timer should pause during screen lock, same as it pauses during sleep.

---

## Platform APIs

### Windows
- `WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION)` registers a window for session change notifications
- Window receives `WM_WTSSESSION_CHANGE` with `WTS_SESSION_LOCK` (0x7) and `WTS_SESSION_UNLOCK` (0x8)
- Requires a hidden window + message loop (can use Tauri's main window or create a dedicated one)
- Via `windows` crate, feature `Win32_System_RemoteDesktop`

### macOS
- NSDistributedNotificationCenter: listen for `"com.apple.screenIsLocked"` and `"com.apple.screenIsUnlocked"`
- No special permissions needed

### Linux
- D-Bus: listen for `Lock`/`Unlock` signals on `org.freedesktop.login1.Session`
- Works on systemd-based distros

---

## Implementation Sketch

### Rust: state flag
Add to `TimerState`:
```rust
pub screen_locked: bool,
```

### Rust: platform-specific listener
Spawn a background thread per platform that receives lock/unlock events and updates `state.screen_locked`.

### Rust: timer loop change
In `start_timer`, when `screen_locked == true`, skip incrementing `elapsed_secs` and `active_secs` (same as the sleep detection `delta > 30s` check).

### Fallback
If detection isn't available (old Linux, etc.), the existing sleep detection via delta gap still works as a safety net.

---

## Files to Modify
- `src-tauri/src/commands.rs` — `screen_locked` flag, timer loop check
- `src-tauri/src/lib.rs` — spawn platform listener thread
- New: `src-tauri/src/screen_lock.rs` (or platform modules) — per-platform lock detection
- `src-tauri/Cargo.toml` — add `windows` crate feature (Windows only)

## Open Questions
- Should lock events be emitted to the frontend (e.g., show "Paused — screen locked" status)?
- Should we track total locked time separately (like break time)?
