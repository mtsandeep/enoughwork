# EnoughWork — Features & Behavior

## Overview

EnoughWork tracks your daily screen time and nudges you to step away when you've worked enough. It runs in the background, auto-starts on boot, and uses fullscreen overlays to get your attention.

---

## Daily Work Timer

Tracks active screen time from the moment the app starts. The timer ticks every second while the computer is awake.

- **Sleep detection** — the timer pauses automatically when the computer sleeps or hibernates (any gap > 30 seconds is skipped)
- **Daily reset** — all stats reset at a configurable time (default: midnight). You can set this to any time (e.g., 6:00 AM for night shift workers — work done before 6 AM counts as the previous day)
- **Persistent** — state is saved to disk every 60 seconds and survives app restarts

### Limitations

- The timer counts wall-clock active time, not per-app or per-window usage. It's a general "screen is on" metric.

---

## Work Limit

Set a daily limit (default: 8 hours, range: 1 minute to 24 hours). When the limit is reached, a fullscreen overlay appears on all monitors.

- **Plus/minus buttons** snap to 30-minute boundaries
- **Direct edit** — click the limit display to type exact hours and minutes
- **Progress bar** fills from left to right as you approach the limit. Turns red when over the limit

---

## Breaks

Take breaks during the work day. Breaks have a fullscreen countdown overlay with a circular ring timer.

### How it works

1. Click **"Take Break"** to open the break picker
2. The app suggests a break duration based on how long you've been working:
   - Under 30 min worked → 5 min break
   - 30 min – 1h → 10 min
   - 1h – 2h → 15 min
   - 2h – 3h → 20 min
   - 3h+ → 30 min
3. Pick a duration (quick buttons: 5m, 10m, 15m, 20m, 30m, 1h) or type a custom value
4. Start the break — a countdown overlay appears on all monitors
5. **Extend** — press "+5 min" to add time during the break
6. **Resume Work** — end the break early and return to work

### Supercharging

If you stay past the break end, the overlay switches to "You're Recharged!" mode and counts up with a "Super Charging" message showing how much extra rest you've taken. The ring cycles in amber.

### Break time on the progress bar

Completed breaks appear as teal segments on the progress bar at the correct position (when they happened). Hover a segment to see the break duration.

### Break stats

After taking breaks, the main screen shows "Breaks today: N (Xm total)".

### Important: Break time and your work limit

**Break time counts toward your daily limit.** The work timer keeps ticking during breaks. This is intentional — the limit represents total screen proximity time, not just "active typing" time.

If you want breaks to be excluded from the limit, you can increase your limit to compensate. For example, if you plan to take 45 minutes of breaks in an 8-hour day, set your limit to 8h 45m.

---

## Snooze

When the limit is reached, you can **snooze for 30 minutes** to extend your working time.

- **Cumulative** — each snooze adds 30 minutes on top of the current snooze end time. Snoozing twice gives you 60 extra minutes total
- A yellow progress bar shows snooze time elapsed
- When snooze expires, the overlay reappears

---

## Stop for Today

Ends all tracking immediately. The timer stops and status shows "Stopped — resumes tomorrow". A **Resume** button is available if you change your mind. Resuming when over the limit will re-trigger the overlay.

---

## Overlays

### Fullscreen Overlay

When the limit is reached, a dark fullscreen overlay appears on **all monitors** with the title, subtitle, and two buttons (Snooze / Stop). Customizable title and subtitle in Settings.

### Quiet Mode (Mini Notification)

Toggle via the bell icon in the top bar. Instead of a fullscreen overlay, a small draggable popup appears in the bottom-right corner with the same Snooze / Stop buttons. Useful during meetings or presentations.

- **Today only** — quiet mode resets on daily reset

### Fullscreen App Detection (Windows only)

When a fullscreen app (game, presentation, video player) is detected, EnoughWork adapts:
- On the fullscreen app's monitor: plays a subtle animation (Star Drop) or shows a mini notification
- On all other monitors: shows the fullscreen overlay

You can override this in Settings → "Force fullscreen overlay" to always show the overlay on all monitors.

**Limitation:** Fullscreen app detection is Windows-only. On macOS and Linux, the fullscreen overlay always appears.

### Star Drop Animation

A 4.3-second spinning star with a laser trail following a parabolic arch, shown on the fullscreen app's monitor. After the animation completes, a mini notification popup appears.

---

## Activity Heatmap

A row of 30 colored squares showing daily work totals for the last 30 days. Hover a square to see the date, work time, and break time.

Color coding:
- Gray — no data
- Green — 0 to 8.5 hours
- Orange — 8.5 to 11 hours
- Red — over 11 hours

**Limitation:** History is limited to 30 days. Older data is automatically pruned.

---

## Settings

| Setting | Default | Description |
|---|---|---|
| Auto-start on boot | On | Launches on system startup |
| Show debug bar | Off (On in dev) | Developer testing toolbar |
| Daily reset time | 00:00 | When daily stats reset |
| Overlay title | "Enough Work!" | Title text on the limit overlay |
| Overlay subtitle | "You've done enough for today..." | Subtitle on the limit overlay |
| Force fullscreen overlay | Off | Always show overlay, even with fullscreen apps |
| Animation | Star Drop | Animation type when fullscreen app detected |

---

## System Tray

The app minimizes to the system tray on close instead of quitting. Left-click the tray icon to show the window. Right-click for Show / Quit options. Closing the window via the X button hides it to tray.

**Single instance** — if you try to launch a second copy, it focuses the existing window instead.

---

## Keyboard Shortcuts

| Key | Context | Action |
|---|---|---|
| Enter | Limit edit input | Save limit |
| Escape | Limit edit input | Cancel edit |
| Enter | Break duration input | Confirm duration |
| Escape | Break duration input | Cancel edit |
| Escape | Break picker overlay | Close picker |

---

## Data Storage

All data is stored locally in `enoughwork-store.json` (via Tauri's store plugin). No data is sent anywhere. The file contains:

- **Timer state** — current day's tracking data
- **Settings** — your preferences
- **Daily history** — last 30 days of work and break totals
