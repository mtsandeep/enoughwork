# CSS Deduplication — Follow-up

## Context
The CSS reorg (`code-organization.md`) was a pure move: every rule was relocated verbatim into `src/components/*.css` with no merging or consolidation. This left visible duplication across component files. This doc captures the candidates for a follow-up dedup pass.

Out of scope for the reorg; do as a separate task so behavior changes (shared classes can cascade differently than the originals) can be reviewed and visually verified on their own.

---

## Candidate duplications

### 1. Number inputs (highest value)
Three near-identical input styles that differ only in sizing/color:
- `.limit-input` (`components/controls.css`)
- `.break-duration-input` (`components/break-picker.css`)
- `.event-input` (`components/schedule.css`)

Shared: padding, border, border-radius, font-family/color, outline, box-sizing, transition, `-moz-appearance: textfield`. Also all three repeat the same `::-webkit-inner-spin-button, ::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }` block verbatim.

**Suggested:** a `.number-input` base class in `styles.css` (or a shared `components/form.css`) holding the common rules, with each component file setting only its size/color overrides.

### 2. Toggle-active states
Several `.active` rules with the same shape (`background: var(--accent-light); color: var(--accent); border-color: var(--accent);`):
- `.event-type-btn.active` (schedule)
- `.event-day-btn.active` (schedule)
- `.event-pill-btn.active` (schedule)
- `.break-quick-btn.active` (break-picker — note: uses `#0d9488` teal, not accent)

**Suggested:** a `.toggle-pill.active` shared class (careful: break-quick uses teal, so it stays separate or parameterizes the color).

### 3. Top-bar icon buttons
Near-identical fixed-position icon buttons:
- `.quiet-icon` (overlay)
- `.settings-gear` (settings)
- `.events-list-icon` (overlay)

Shared: `position: fixed; top: 16px; background: none; border: none; cursor: pointer; color: var(--muted); padding: 6px; border-radius: 8px; transition: all 0.15s; z-index: 10;` + the `:hover { color: var(--text); }`. Differ only in `right:` offset and `outline: none` presence.

**Suggested:** a `.topbar-icon` base class; each rule keeps only its `right:` offset.

### 4. Tick buttons
- `.limit-tick-btn` and `.limit-tick-btn-lg` (controls) — the `-lg` variant just overrides `width`/`height`. Already compact; low value to change.

### 5. Spin-button hiding
The `::-webkit-inner-spin-button, ::-webkit-outer-spin-button` block is repeated for `.limit-input` and `.break-duration-input` (`.event-input` doesn't hide them). Folding into the shared `.number-input` base (#1) removes this.

### 6. Click-to-edit row pattern
- `.limit-value.editing` (controls)
- `.break-duration-row.editing` (break-picker)

Both set `cursor: default; background: transparent;` and a matching `:hover`. Small; could share a `.editable-row.editing` class.

---

## Approach when doing this
- Build the shared classes, swap HTML `class=` attributes in `index.html` (and `overlay.html`/`break-countdown.html` where applicable).
- Verify each change visually in `npm run dev` — shared classes can change cascade specificity vs. the original single-class selectors.
- Keep the `src/components/` file boundaries from the reorg; shared base classes go in `styles.css` or a new `components/form.css` / `components/shared.css`.
