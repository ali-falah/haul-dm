# Haul DM — agent notes

Haul DM (display name; formerly "Linux Download Manager") — IDM-inspired download manager.
Tauri 2 + Rust (`src-tauri/`, workspace with single member), vanilla JS frontend (`ui/`, no bundler/npm),
Chromium extension (`browser/chromium/`). Git status is intentionally uncommitted WIP work.

## Commands

- `./dev.sh` — dev launcher: builds `browser_native_host`, writes **debug** native-messaging manifests into
  every found Chromium browser (overwrites the release manifests from `install.sh` — re-run `./install.sh`
  to restore), copies extension files to `~/Documents/Haul DM Extension`, then `cargo run`.
- `./install.sh` — full install: release build, `~/.local/bin/haul-dm`, desktop entry + icon,
  yt-dlp/ffmpeg/Node, native-messaging manifests. `sudo` only if system deps are missing.
- `./uninstall.sh` — removes everything, including legacy pre-rename `linux-download-manager` artifacts.

Focused verification (no full production builds — `cargo check` only):

- Rust: `cargo check --manifest-path src-tauri/Cargo.toml`
- UI: `node --check ui/main.js` · CSS brace balance · HTML parse (148/147 divs balanced)
- Extension: `node --check browser/chromium/*.js` and standalone suites `node browser/tests/<name>.cjs`
  (`content-runtime`, `media-capture`, `player-observer`, `site-buttons`, `twitter-button`)
- Scripts: `bash -n install.sh dev.sh uninstall.sh`
- UI runtime smoke: `python3 -m http.server PORT` in repo root, open `/ui/index.html` in a browser.
  Tauri `invoke` is absent, backend calls fail gracefully — useful for layout/CSS/focus/DOM checks only.

## Naming map (rebrand done 2026-11-08 — keep stable)

- Display name **"Haul DM"**, technical name **`haul-dm`** (binary, data dir `~/.local/share/haul-dm`,
  socket `haul-dm.sock`, desktop entry `haul-dm.desktop`).
- Never renamed (wire identity — renaming requires extension reload + full reinstall + breaks existing users):
  - Tauri `identifier` / native-messaging host `com.eko.linuxdownloadmanager`
    (service-worker `HOST_NAME`, manifests in `platform.rs` + `install.sh`/`dev.sh`,
    `desktop file StartupWMClass`).
  - Extension `key`/ID `dhbkcopeagecbkoncdjefnjlcienhlpg` in `manifest.json`.
  - `ldm-*` DOM/CSS/message namespace shared by `content-script.js`, `content-style.css`,
    `player-manifest-observer.js`, and `browser/tests/*.cjs`. The page badge renders "HDM".
- `browser_native_host` locates the desktop binary by exact name `haul-dm` (or `Haul_DM*.AppImage`) —
  keep those checks in sync if the binary name ever changes. Cargo lib crate name is `haul_dm`
  (derived from the package name; imports use `haul_dm::`).

## Frontend conventions (Iris design system, `ui/styles.css`)

- Tokens live in `:root` / `[data-theme="light"]`: harbor-teal accent `#0F766E` / `#2DD4BF`; radius
  `--radius-xs 6px / sm 8px / md 12px / lg 16px` (+ `999px` pills). Spacing scale 2/4/8/12/16px;
  type scale only `10/11/12/13/14px`. Use tokens, never new raw values.
- Fonts are **bundled** in `ui/fonts/` (`@font-face` for Inter 400/500/600 and JetBrains Mono
  400/500/600). Never add a remote font `@import` — the app must render identically offline.
- Icons are one 24-viewBox Lucide set at `stroke-width: 1.75`; minimum rendered size is `--icon-sm: 14px`
  (smaller sizes render sub-pixel strokes). Control heights are `--control-h-sm: 28px` / `--control-h: 32px`.
- Filled buttons use `--accent-solid` / `--danger-solid` (white text passes AA); `--accent` is for
  active text/progress, not filled buttons. Toasts anchor bottom-right.
- App icon source: `src-tauri/icons/icon.svg` (teal H + download arrow). Rasterized PNGs are committed;
  regenerate with `magick -background none icon.svg -resize NxN PNG32:NxN.png`. The tray icon stays a
  simple monochrome download glyph for legibility at 16px.
- Main window layout is **command bar → filter bar → dense downloads table → status bar** (no sidebar).
  Status filters are `.status-filters [data-filter]`; category filtering is a custom dropdown backed by
  the hidden `#category-select`; sorting stays a custom dropdown backed by `#sort-select`.
- Rows use `.download-row` (grid columns Name/Status/Size/Progress/Speed/Actions) and keep
  `data-download-id` + `status-<state>`; progress fill colour follows status. Row filenames are
  keyboard-activatable (`role="button"`, Enter/Space) since the row itself is mouse-only.
- Responsive table: below 1100px the Size column and Pause-All label drop, below 900px the speed
  column drops, below 720px the status column drops. The filter bar wraps before the table does.
- Sticky failure toasts are `role="alert"` and carry an explicit dismiss button; all toasts are
  announced (`status`/`alert`, `aria-atomic`).
- `[hidden] { display: none !important; }` guard exists — toggle via `element.hidden`, never inline styles.
- Dynamic markup is JS-rendered (`renderDownloadCard` now returns a table row) — `data-action`,
  `data-download-id`, `.row-percent`, `.row-size`, `.row-speed` and `.empty-state-new-btn` are
  behavioral hooks; keep them in sync with `ui/main.js`.
- Focus/UX infrastructure in `ui/main.js`: `showModal`/`hideModal` capture+restore focus, `trapModalTab`
  traps Tab in the topmost dialog, Esc closes topmost via `MODAL_STACK` (browser-download confirm is
  deliberately excluded — explicit Cancel only). Completed/failed downloads summon the window at full
  force (see `nudge_result_window`) — do not soften this behavior.

## Per-download windows (`src-tauri/src/download_window.rs` + `ui/download.html`)

- One OS window per download, label `download-<id>`; open/focus/unminimize are idempotent.
  Clicking a row in the main list calls the `open_download_window` command; closing a download
  window must never cancel/pause the download (no close hooks exist — keep it that way).
- Auto-open happens in `start_download_task` only when `QueuedDownload.auto_open_window` is true.
  Restart restore sets it false by design — windows must not reopen on launch.
- The window reads live data via `download_details` (record + per-connection rows computed from
  the segment manifest files, polled ~1s) and reacts instantly to `download://state` events.
  `ui/download.js` is standalone (helpers mirror `ui/main.js`).
- Window layout order: title + percent header → progress bar → overview panel (summary tiles +
  URL/save path) → error banner → controls → connection table. Keep IDs when editing the markup;
  `download.js` writes values by ID.
- Controls are status-aware: completed shows **Open file / Open folder**, failed shows **Retry / Open
  folder**, active/paused shows **Pause|Resume / Cancel / Open folder**; terminal states hide
  "Close when completed" and the live rate/ETA tiles. Progress and connection fills follow status
  (green completed, amber paused, red failed).
- Capability `windows` includes `download-*`; permissions include `core:window:allow-close`,
  `core:window:allow-minimize` and `core:window:allow-start-dragging` for the in-page window chrome.
- Download windows are **undecorated** (`decorations(false)`): the header is dragged via
  `getCurrentWindow().startDragging()` in `download.js` (mousedown on the header, button clicks
  excluded) and carries its own minimize/close buttons. Do not re-enable native decorations
  without removing those buttons.
- Connections per download is a real user setting: `connections_per_download` (1–16, default 4) in
  Settings → persisted via `AppState`/`app_settings`, capped by file size in `determine_segment_count`.
- Resume support is persisted per download (`downloads.resumable` column, additive migration in
  `Storage::open`; written at creation and refreshed on resume).
- Result summon is conditional: completed/failed only force the main window when that download's
  window is missing, hidden or minimized (`is_download_window_visible`). When the window is visible
  the result is already on screen, so the main window is not stolen. With
  "Close when completed" checked the page calls the `focus_main_window` command before closing,
  so the completion still raises the main window.
- No inline `onclick=` handlers anywhere.

## Conventions — `CODE-INSTRUCTIONS.txt` is binding

- Surgical changes only; don't refactor or reformat adjacent code.
- **Report unrelated bugs instead of fixing them**: `file:line` + root cause + one-line proposed fix, then
  stop. Sweeping/fixing a whole bug class is its own task, only on explicit request ("fix all").
- Minimum code; no speculative abstractions; use existing UI components.

## Known gotchas

- `youtube.com` downloads need a JS runtime (deno preferred, node fallback) for yt-dlp signatures;
  `~/.config/yt-dlp/config` gets `--js-runtimes` written by both install and dev scripts.
- After editing extension files, reload the extension in `chrome://extensions` (copied, not symlinked).
- Root `Cargo.toml` is a virtual workspace and slightly warns about `resolver = "1"` vs edition-2024's
  implied `3` — pre-existing, cosmetic.
