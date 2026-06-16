# EnoughWork

**Set a daily screen time limit. Get a fullscreen overlay when you've had enough.**

EnoughWork is a daily limit enforcer — when you've been at the screen for 8 hours (or whatever you set), it covers all your monitors and tells you to stop. Simple.

Built with [Tauri](https://tauri.app/) (Rust + webview). Not Electron.

## Why this exists

Most screen time apps remind you to take breaks every X minutes. That's not the problem. The problem is looking up at 6 PM and realizing you've been at it for 10 hours straight.

EnoughWork answers one question: **"Have I worked enough today?"** When the answer is yes, it makes you stop — fullscreen overlay on every monitor, hard to ignore. You can snooze or dismiss it, but you have to make that choice consciously.

## Philosophy

EnoughWork isn't meant to lock you down. It's a nudge to help you notice how long you've been at the screen, step away, and spend time on things that matter — rest, movement, family, hobbies. The overlay is easy to dismiss because the goal is awareness, not restriction. Better screen habits lead to better wellbeing.

## Features

- **A daily limit you'll actually notice** — set your hours (default: 8h); when you hit it, a fullscreen overlay covers every monitor and stays on top until you deal with it
- **Take real breaks** — start a break with a countdown ring, a sensible duration suggested from how long you've been working, and extend/resume controls
- **Schedule the things you keep forgetting** — set a reminder or a timed break for "12:30 lunch" or "in 2h", optionally repeating on weekdays
- **Your call to keep going or stop** — snooze in 30-minute steps, or stop for today and resume tomorrow
- **Quiet mode for meetings** — swap the fullscreen overlay for a small popup when a wall of windows would be rude
- **Resets when your day does** — daily reset at a time you choose (default midnight), so night-shift hours count the right way

It also stays out of your way: runs from the system tray, starts on boot, keeps one instance, survives restarts, auto-updates, and drops to a gentle animation when you're in a game or fullscreen app.

See [docs/features.md](docs/features.md) for detailed feature documentation and behavior.

## Screenshots

<p align="center">
  <img src="screenshots/enoughwork-app.jpg" width="300" alt="Main window" />
  &nbsp;&nbsp;
  <img src="screenshots/enoughwork-settings.jpg" width="300" alt="Settings" />
  &nbsp;&nbsp;
  <img src="screenshots/enoughwork-take-break.jpg" width="300" alt="Take break picker" />
</p>
<p align="center">
  <img src="screenshots/enoughwork-break-overlay.jpg" width="300" alt="Break countdown overlay" />
  &nbsp;&nbsp;
  <img src="screenshots/enoughwork-break-recharged-overlay.jpg" width="300" alt="Break recharged overlay" />
</p>
<p align="center">
  <img src="screenshots/enoughwork-overlay.jpg" width="400" alt="Limit reached overlay" />
  &nbsp;&nbsp;
  <img src="screenshots/enoughwork-mini-notifications.jpg" width="400" alt="Quiet mode notifications" />
</p>

## Tech stack

- [Tauri](https://tauri.app/) (Rust backend + webview frontend)
- Vanilla HTML, CSS, JavaScript (no framework)
- Plugins: autostart, single-instance, store, tray-icon, updater

## Getting started

```bash
pnpm install
pnpm dev
```

## Build for production

Requires signing keys for auto-update. Copy `.env.example` to `.env` and set the password:

```
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=your_password
```

The key file should be at `keys/enoughwork.key` (generate with `pnpm signer`).

```bash
pnpm build
```

Output binaries will be in `src-tauri/target/release/bundle/`.

## Releasing

Uses [cargo-release](https://github.com/crate-ci/cargo-release) to bump versions in one step.

```bash
pnpm release:patch   # 0.1.0 → 0.2.0
pnpm release:minor   # 0.1.0 → 1.0.0
pnpm release:major   # 1.0.0 → 2.0.0
```

This will:
- Bump version in `Cargo.toml`, `package.json`, and `tauri.conf.json`
- Replace `[Unreleased]` in `CHANGELOG.md` with the version and date, and add a fresh `[Unreleased]` section
- Commit, tag (`v0.2.0`), and create a GitHub release via the publish workflow

## Project structure

```
src/
  main.js              # Main window: render loop, limit controls, action buttons
  state.js             # Shared state holder, Tauri globals, helpers
  overlays.js          # Overlay windows (limit, break, event-notify, notify)
  progress-bar.js      # Progress bar markers, event dots, dot popover
  schedule.js          # Quick-add event form + events list page
  break-picker.js      # Break picker page
  settings.js          # Settings page + auto-update
  window-utils.js      # Multi-monitor DPI-aware positioning
  styles.css           # Root styles + @imports components/
  components/          # Component CSS (timer, controls, schedule, etc.)
  windows/             # Secondary window pages (overlay, break-countdown, etc.)
src-tauri/src/
  lib.rs               # App setup, tray, plugins, window management
  commands.rs          # Tauri commands (thin wrappers)
  state.rs             # State structs + date/recurring helpers
  persistence.rs       # Store I/O (state, settings)
  timer.rs             # Background tick loop
  win32.rs             # Windows FFI (fullscreen detection, monitors)
  main.rs              # Binary entry point
docs/
  features.md          # Detailed feature documentation
  events-reminders.md  # Events & scheduled breaks implementation
  planning/            # Feature planning docs
```
