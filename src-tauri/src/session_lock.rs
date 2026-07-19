//! Detect whether the OS session/screen is locked so the work timer can pause.
//!
//! - Windows: WTS session info (`WTSSessionInfoEx`)
//! - macOS: `CGSessionCopyCurrentDictionary` / `CGSSessionScreenIsLocked`
//! - Linux: D-Bus `org.freedesktop.ScreenSaver.GetActive` (with login1 LockedHint fallback)

/// Returns true when the workstation/session screen is locked.
/// On failure or unsupported environments, returns false (timer keeps running).
pub fn is_session_locked() -> bool {
    #[cfg(target_os = "windows")]
    {
        windows::is_locked()
    }
    #[cfg(target_os = "macos")]
    {
        macos::is_locked()
    }
    #[cfg(target_os = "linux")]
    {
        linux::is_locked()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        false
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use std::ffi::c_void;

    const WTS_CURRENT_SERVER_HANDLE: *mut c_void = std::ptr::null_mut();
    const WTS_CURRENT_SESSION: u32 = 0xFFFF_FFFF;
    const WTS_SESSION_INFO_EX: u32 = 25;
    // Win8.1+: 0 = locked, 1 = unlocked. (Values were swapped on older Windows.)
    const WTS_SESSIONSTATE_LOCK: i32 = 0;

    #[repr(C)]
    struct WtsInfoExHeader {
        level: u32,
        _session_id: u32,
        _session_state: u32,
        session_flags: i32,
    }

    #[link(name = "wtsapi32")]
    extern "system" {
        fn WTSQuerySessionInformationW(
            h_server: *mut c_void,
            session_id: u32,
            wts_info_class: u32,
            pp_buffer: *mut *mut c_void,
            p_bytes_returned: *mut u32,
        ) -> i32;
        fn WTSFreeMemory(p_memory: *mut c_void);
    }

    pub fn is_locked() -> bool {
        unsafe {
            let mut buffer: *mut c_void = std::ptr::null_mut();
            let mut bytes: u32 = 0;
            let ok = WTSQuerySessionInformationW(
                WTS_CURRENT_SERVER_HANDLE,
                WTS_CURRENT_SESSION,
                WTS_SESSION_INFO_EX,
                &mut buffer,
                &mut bytes,
            );
            if ok == 0 || buffer.is_null() {
                return false;
            }
            let locked = {
                let info = &*(buffer as *const WtsInfoExHeader);
                info.level == 1 && info.session_flags == WTS_SESSIONSTATE_LOCK
            };
            WTSFreeMemory(buffer);
            locked
        }
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::c_void;

    type CfDictionaryRef = *const c_void;
    type CfStringRef = *const c_void;
    type CfTypeRef = *const c_void;

    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGSessionCopyCurrentDictionary() -> CfDictionaryRef;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: CfTypeRef);
        fn CFDictionaryGetValue(dict: CfDictionaryRef, key: *const c_void) -> *const c_void;
        fn CFStringCreateWithCString(
            alloc: *const c_void,
            c_str: *const i8,
            encoding: u32,
        ) -> CfStringRef;
        fn CFBooleanGetValue(boolean: *const c_void) -> u8;
    }

    pub fn is_locked() -> bool {
        unsafe {
            let dict = CGSessionCopyCurrentDictionary();
            if dict.is_null() {
                return false;
            }

            let key = CFStringCreateWithCString(
                std::ptr::null(),
                b"CGSSessionScreenIsLocked\0".as_ptr() as *const i8,
                K_CF_STRING_ENCODING_UTF8,
            );
            let locked = if key.is_null() {
                false
            } else {
                let val = CFDictionaryGetValue(dict, key as *const c_void);
                CFRelease(key as CfTypeRef);
                // Key is absent when unlocked; present + true when locked.
                !val.is_null() && CFBooleanGetValue(val) != 0
            };

            CFRelease(dict as CfTypeRef);
            locked
        }
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use std::process::Command;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    /// Cache D-Bus polls briefly so a stuck/slow bus doesn't hammer every tick.
    static CACHE: Mutex<Option<(Instant, bool)>> = Mutex::new(None);
    const CACHE_TTL: Duration = Duration::from_secs(1);

    pub fn is_locked() -> bool {
        if let Ok(guard) = CACHE.lock() {
            if let Some((at, locked)) = *guard {
                if at.elapsed() < CACHE_TTL {
                    return locked;
                }
            }
        }

        let locked = screensaver_active() || login_locked_hint();

        if let Ok(mut guard) = CACHE.lock() {
            *guard = Some((Instant::now(), locked));
        }
        locked
    }

    fn screensaver_active() -> bool {
        // Session-bus screensaver API — true while lock/screensaver is active
        let output = Command::new("busctl")
            .args([
                "--user",
                "call",
                "org.freedesktop.ScreenSaver",
                "/org/freedesktop/ScreenSaver",
                "org.freedesktop.ScreenSaver",
                "GetActive",
            ])
            .output();

        match output {
            Ok(out) if out.status.success() => {
                let s = String::from_utf8_lossy(&out.stdout);
                // Typical: "b true\n" or "b false\n"
                s.contains("true")
            }
            _ => false,
        }
    }

    fn login_locked_hint() -> bool {
        // systemd-logind LockedHint for the current session
        let session = std::env::var("XDG_SESSION_ID").unwrap_or_else(|_| "self".into());
        let output = Command::new("loginctl")
            .args(["show-session", &session, "-p", "LockedHint", "--value"])
            .output();

        match output {
            Ok(out) if out.status.success() => {
                String::from_utf8_lossy(&out.stdout).trim().eq_ignore_ascii_case("yes")
                    || String::from_utf8_lossy(&out.stdout).trim().eq_ignore_ascii_case("true")
            }
            _ => false,
        }
    }
}
