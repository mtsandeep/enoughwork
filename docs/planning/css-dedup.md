# CSS Deduplication

## Status: completed

The duplication left by the CSS split has been addressed. Shared base classes live in `src/components/shared.css` (imported first in `styles.css`, so single-class component rules override them on source-order ties).

## What was done

### 1. Top-bar icon buttons — resolved via `.topbar-icon`
`.settings-gear`, `.quiet-icon`, `.events-list-icon` previously each repeated the full fixed-position icon-button declaration. Now they share `.topbar-icon` (in `shared.css`) and each keeps only its `right:` offset (plus `.quiet-icon`'s `overflow: visible` and `.active` variant). The three buttons in `index.html` carry `class="topbar-icon <name>"`.

### 2. Number inputs — resolved via `.num-input`
`.limit-input` and `.break-duration-input` previously each repeated the input shell + the `::-webkit-inner/outer-spin-button` hiding block. Now they share `.num-input` (in `shared.css`) and each keeps only width, height, font-size/weight, color, and focus color. The inputs in `index.html` carry `class="num-input <name>"`.

### 3. Accent `.active` toggle states — resolved via CSS selector grouping
`.event-type-btn.active`, `.event-day-btn.active`, `.event-pill-btn.active` had identical declarations. These are now a single grouped selector in `schedule.css`:
```css
.event-type-btn.active,
.event-day-btn.active,
.event-pill-btn.active { ... }
```
`.break-quick-btn.active` (teal) deliberately keeps its own rule.

## Why not a `.pill-active` class
The original plan proposed a `.pill-active` utility class. Rejected because `.active` is toggled dynamically by `applyEventFormState()` in `schedule.js` — adopting `.pill-active` would have required JS changes to toggle a second class, adding risk for no benefit. CSS selector grouping achieves the same dedup with zero JS impact.

## Not done (low value, left as-is)
- `.limit-tick-btn` / `.limit-tick-btn-lg` — the `-lg` variant just overrides width/height; already compact.
- `.limit-value.editing` / `.break-duration-row.editing` — small, two-rule duplication; not worth a shared class.
