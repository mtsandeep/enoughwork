# Changelog

All notable changes to EnoughWork will be documented in this file.

## [Unreleased]

### Added
- Skip today's occurrence of a recurring event (re-arms next scheduled day)

### Changed
- Internal code reorganization (no behavior changes): split the large source files into focused modules, moved styles into `src/components/`, and grouped the window pages under `src/windows/`
- CSS cleanup: consolidated duplicated input, icon-button, and toggle styles into shared classes (`src/components/shared.css`), and unified form border weights with the Settings page

### Removed
- Activity heatmap and 30-day history tracking — the daily work/break history grid and its storage have been removed

## [0.1.8] - 2026-06-14

### Added
- Events & Scheduled Breaks — schedule future reminders and timed breaks; they appear as markers on the progress bar and trigger a reminder overlay or break countdown at the scheduled time
- Recurring events & breaks — repeat on selected weekdays (clock-time only); triggers fire only while the timer is running, so missed times while the laptop was off are not backfilled
- `tauri-plugin-positioner` for cross-platform notification window placement (fixes macOS positioning)
- Update-available popup notification when a new version is found (dismissed versions remembered per-version)

### Changed
- Mini notification popup now positions itself at bottom-right via positioner plugin on macOS/Linux (Windows keeps taskbar-aware positioning)
- Debug "Show Overlay" button now respects the megaphone/quiet mode setting

## [0.1.7] - 2026-05-28

### Changed
- Heatmap tooltip now shows awake time, work time (matches progress bar), and breaks separately

## [0.1.6] - 2026-05-27

### Fixed
- Heatmap now respects the configured daily reset time instead of always rolling over at midnight
- Heatmap days and history update live when the effective day changes (no app restart needed)

## [0.1.5] - 2026-05-25

### Fixed
- Updater signing key mismatch — updated public key in config to match signing key

## [0.1.4] - 2026-05-25

### Fixed
- Update badge click no longer crashes when settings status element is not present
- Updater release tag mismatch fix — `latest.json` now uses correct tag URL (`v` instead of `app-v`)

## [0.1.3] - 2026-05-25

### Added
- "Take Break" — adaptive break timer with smart suggestion, fullscreen countdown overlay, extend/resume controls, and break time tracking in heatmap
- Break overlay shows "You're Recharged!" with supercharging counter after break ends
- Break time segemnts added to main work progress bar
- Cumulative snooze — multiple snoozes add up instead of replacing each other
- Quiet mode — mini notification popup instead of fullscreen overlay (useful during meetings)
- "Star Drop" animation — spinning star with laser trail following a parabolic arch
- Activity heatmap showing daily work totals for the last 30 days with hover tooltips
- Settings: "When fullscreen app detected" — toggle fullscreen overlay or choose animation
- Auto-check update — checks for new versions on startup and every 4 hours, shows badge when available
- "Check for Updates" button in settings with download and restart
- "Auto check for updates" toggle in settings to disable background checks

### Changed
- Break overlay is event-driven for reliable sync across multiple monitors
- Settings page UI refined for a lighter, more minimal feel
- Migrated frontend build to Vite for more flexibility with npm packages

## [0.1.2] - 2026-05-17

### Added
- Version number displayed in settings page
- `.gitattributes` for consistent line endings across platforms

### Changed
- Auto-start on boot now applies on settings close instead of on every toggle
- Settings only write to disk when values actually changed
- Auto-start state re-checks OS on every settings open (detects external changes)

## [0.1.1] - 2026-05-17

### Fixed
- Disk I/O no longer blocks IPC commands during state saves
- Store operations handle errors gracefully instead of panicking
- Initial app load no longer has a race condition with DOMContentLoaded

## [0.1.0] - 2025-05-17

### Added
- Daily work time tracking with configurable hour limit
- Fullscreen overlay on all monitors when time limit is reached
- Snooze to extend working time by 30 minutes
- Stop for today to end tracking until daily reset
- Configurable daily reset time (default: midnight)
- Auto-start on system boot
- Settings page with overlay title, subtitle, and reset time
- Multi-monitor overlay support (prod + dev)
- Sleep detection — timer pauses when computer sleeps
- Debug bar for development builds
- Windows, macOS, and Linux builds via GitHub Actions

### Fixed
- Multi-monitor overlay now works correctly in production builds
