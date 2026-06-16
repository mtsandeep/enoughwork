use crate::state::MonitorRect;
use std::ffi::c_void;
use std::mem;
use tauri::Manager;

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
