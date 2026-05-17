# Changelog

All notable changes to EnoughWork will be documented in this file.

## [Unreleased]

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
