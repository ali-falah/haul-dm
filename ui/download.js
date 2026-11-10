// Haul DM — dedicated per-download window controller.
// Formatting helpers mirror ui/main.js so this window stays standalone
// (main.js boots the whole app shell and cannot be reused here).

const downloadId = (() => {
    const fromQuery = Number(new URLSearchParams(window.location.search).get("id"));
    if (Number.isFinite(fromQuery) && fromQuery > 0) return fromQuery;
    // Fallback: the Rust side labels the window "download-<id>".
    try {
        const label = window.__TAURI__?.window?.getCurrentWindow?.().label || "";
        const fromLabel = Number(String(label).replace("download-", ""));
        return Number.isFinite(fromLabel) ? fromLabel : 0;
    } catch (_) {
        return 0;
    }
})();
const POLL_INTERVAL_MS = 1000;
const AUTO_FIT_MIN_HEIGHT = 440;
const AUTO_FIT_MAX_HEIGHT = 900;

const el = {
    icon: document.getElementById("dlw-icon"),
    percent: document.getElementById("dlw-percent"),
    title: document.getElementById("dlw-title"),
    url: document.getElementById("dlw-url"),
    statusPill: document.getElementById("dlw-status-pill"),
    status: document.getElementById("dlw-status"),
    size: document.getElementById("dlw-size"),
    downloaded: document.getElementById("dlw-downloaded"),
    rate: document.getElementById("dlw-rate"),
    eta: document.getElementById("dlw-eta"),
    resumable: document.getElementById("dlw-resumable"),
    path: document.getElementById("dlw-path"),
    error: document.getElementById("dlw-error"),
    progressTrack: document.getElementById("dlw-progress-track"),
    progress: document.getElementById("dlw-progress"),
    toggleDetails: document.getElementById("dlw-toggle-details"),
    closeWhenDone: document.getElementById("dlw-close-when-done"),
    closeWhenDoneLabel: document.getElementById("dlw-close-when-done-label"),
    pause: document.getElementById("dlw-pause"),
    cancel: document.getElementById("dlw-cancel"),
    openFile: document.getElementById("dlw-open-file"),
    openFolder: document.getElementById("dlw-open-folder"),
    connections: document.getElementById("dlw-connections"),
    segbar: document.getElementById("dlw-segbar"),
    connBody: document.getElementById("dlw-conn-body"),
    close: document.getElementById("dlw-close"),
    minimize: document.getElementById("dlw-minimize"),
    windowClose: document.getElementById("dlw-win-close"),
};

let details = null;
let lastStatus = "";
let refreshAt = 0;
let fittedKey = "";
let fitScheduled = false;
// Percentage only ever moves forward while a download is running, even if a
// slower poll response lands after a newer live event.
let lastProgressBytes = 0;

// ── Tauri access (same pattern as ui/main.js) ───────────────────────────────

function getTauri() {
    return typeof window !== "undefined" ? window.__TAURI__ : null;
}

async function invoke(cmd, args = {}) {
    const tauri = getTauri();
    if (!tauri?.core?.invoke) throw new Error("Tauri API unavailable");
    return tauri.core.invoke(cmd, args);
}

async function listen(event, callback) {
    const tauri = getTauri();
    if (!tauri?.event?.listen) return null;
    return tauri.event.listen(event, callback);
}

// ── Formatting helpers (mirror ui/main.js) ──────────────────────────────────

function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function formatSpeed(bytesPerSecond) {
    if (!bytesPerSecond || bytesPerSecond <= 0) return "—";
    return `${formatBytes(bytesPerSecond)}/s`;
}

function formatEta(seconds) {
    if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return "—";
    const total = Math.round(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
    if (minutes > 0) return `${minutes}m ${String(secs).padStart(2, "0")}s`;
    return `${secs}s`;
}

const STATUS_LABELS = {
    in_progress: "Downloading",
    queued: "Queued",
    scheduled: "Scheduled",
    paused: "Paused",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
};

function statusLabel(status) {
    return STATUS_LABELS[status] || status;
}

function percentOf(downloaded, total) {
    if (!total) return 0;
    return Math.min(100, Number(((downloaded / total) * 100).toFixed(1)));
}

function categorizeFile(fileName) {
    const parts = String(fileName || "").toLowerCase().split(".");
    const ext = parts.length > 1 ? parts.pop() : "";
    const sets = {
        video: ["mp4", "mkv", "webm", "avi", "mov", "flv", "wmv", "m4v", "ts"],
        audio: ["mp3", "m4a", "wav", "flac", "aac", "ogg", "opus", "wma"],
        archive: ["zip", "tar", "gz", "bz2", "xz", "7z", "rar", "deb", "rpm", "appimage", "iso", "exe", "msi", "dmg", "apk"],
        document: ["pdf", "doc", "docx", "txt", "rtf", "odt", "epub", "xls", "xlsx", "ppt", "pptx", "csv", "md"],
        image: ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico", "tiff"],
    };
    for (const [category, extensions] of Object.entries(sets)) {
        if (extensions.includes(ext)) return category;
    }
    return "other";
}

const CATEGORY_ICONS = {
    video: '<svg class="cat-video" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"></path><rect x="2" y="6" width="14" height="12" rx="2" ry="2"></rect></svg>',
    audio: '<svg class="cat-audio" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 10v3"></path><path d="M6 6v11"></path><path d="M10 3v18"></path><path d="M14 8v7"></path><path d="M18 5v13"></path><path d="M22 10v3"></path></svg>',
    archive: '<svg class="cat-archive" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="11"></line></svg>',
    document: '<svg class="cat-document" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"></path><path d="M14 2v4a2 2 0 0 0 2 2h4"></path><path d="M10 9H8"></path><path d="M16 13H8"></path><path d="M16 17H8"></path></svg>',
    image: '<svg class="cat-image" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"></rect><circle cx="9" cy="9" r="2"></circle><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"></path></svg>',
    other: '<svg class="cat-other" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"></path><path d="M14 2v4a2 2 0 0 0 2 2h4"></path></svg>',
};

// ── Rendering ───────────────────────────────────────────────────────────────

function setStatus(status) {
    el.status.textContent = statusLabel(status);
    el.statusPill.className = `status-pill status-${status}`;
    document.body.dataset.status = status;
}

function setProgress(downloaded, total) {
    const percent = percentOf(downloaded, total);
    el.percent.textContent = `${Math.round(percent)}%`;
    el.progress.style.width = `${percent}%`;
    el.progressTrack.setAttribute("aria-valuenow", String(Math.round(percent)));
}

function scheduleFitWindow() {
    if (fitScheduled) return;
    fitScheduled = true;
    requestAnimationFrame(() => {
        fitScheduled = false;
        fitWindowToContent();
    });
}

async function fitWindowToContent() {
    if (!downloadId) return;
    const tauri = getTauri();
    const win = tauri?.window?.getCurrentWindow?.();
    const LogicalSize = tauri?.dpi?.LogicalSize;
    if (!win?.setSize || !LogicalSize) return;

    const status = details?.download?.status || "";
    const key = `${status}:${el.connections.hidden ? "collapsed" : "open"}:${el.error.hidden ? "ok" : "error"}`;
    if (key === fittedKey) return;

    document.body.classList.add("dlw-measure");
    const natural = Math.ceil(document.querySelector(".dlw")?.getBoundingClientRect().height || 0);
    document.body.classList.remove("dlw-measure");
    if (!natural) return;

    const screenCap = window.screen?.availHeight ? window.screen.availHeight - 40 : AUTO_FIT_MAX_HEIGHT;
    const maxHeight = Math.max(AUTO_FIT_MIN_HEIGHT, Math.min(AUTO_FIT_MAX_HEIGHT, screenCap));
    const height = Math.max(AUTO_FIT_MIN_HEIGHT, Math.min(maxHeight, natural + 2));

    fittedKey = key;
    try {
        await win.setSize(new LogicalSize(window.innerWidth, height));
    } catch (error) {
        console.error("Could not fit download window:", error);
    }
}

function renderDetails(payload) {
    const d = payload.download;
    details = payload;

    if (d.status === "in_progress") {
        d.downloadedBytes = Math.max(d.downloadedBytes, lastProgressBytes);
    }
    lastProgressBytes = d.downloadedBytes;

    el.title.textContent = d.fileName;
    el.title.title = d.fileName;
    el.url.textContent = d.url;
    el.url.title = d.url;
    el.path.textContent = d.savePath;
    el.path.title = d.savePath;
    el.size.textContent = d.totalBytes ? formatBytes(d.totalBytes) : "—";

    const percent = percentOf(d.downloadedBytes, d.totalBytes);
    el.downloaded.textContent = d.totalBytes
        ? `${formatBytes(d.downloadedBytes)} (${percent}%)`
        : formatBytes(d.downloadedBytes);

    el.rate.textContent = formatSpeed(d.speedBytesPerSecond);
    el.eta.textContent = d.status === "in_progress" ? formatEta(d.etaSeconds) : "—";
    el.resumable.textContent = payload.resumable ? "Yes" : "No";
    if (d.errorMessage) {
        el.error.textContent = d.errorMessage;
        el.error.hidden = false;
    } else {
        el.error.hidden = true;
    }

    const category = categorizeFile(d.fileName);
    if (!el.icon.dataset.category || el.icon.dataset.category !== category) {
        el.icon.dataset.category = category;
        el.icon.innerHTML = CATEGORY_ICONS[category] || CATEGORY_ICONS.other;
    }

    setStatus(d.status);
    setProgress(d.downloadedBytes, d.totalBytes);
    renderConnections(payload.connections, d.totalBytes);
    updateControls(d.status);
    scheduleFitWindow();
}

function renderConnections(connections, totalBytes) {
    el.connBody.replaceChildren();
    el.segbar.replaceChildren();

    const total =
        totalBytes ||
        connections.reduce((sum, connection) => sum + (connection.totalBytes || 0), 0) ||
        0;

    for (const connection of connections) {
        const row = document.createElement("tr");
        const cells = [
            String(connection.index + 1),
            connection.status,
            formatBytes(connection.downloadedBytes),
            formatBytes(connection.totalBytes),
            formatBytes(connection.startBytes),
        ];
        cells.forEach((value, index) => {
            const cell = document.createElement("td");
            cell.textContent = value;
            if (index === 1) {
                cell.className = "dlw-conn-status";
                if (connection.status === "Completed") cell.classList.add("is-complete");
                else if (connection.status === "Receiving data") cell.classList.add("is-active");
                else if (connection.status === "Failed") cell.classList.add("is-failed");
                else if (connection.status === "Paused") cell.classList.add("is-paused");
            }
            row.appendChild(cell);
        });
        el.connBody.appendChild(row);

        if (total > 0 && connection.totalBytes > 0) {
            const segment = document.createElement("div");
            segment.className = "dlw-seg";
            const left = (connection.startBytes / total) * 100;
            const width = (connection.totalBytes / total) * 100;
            segment.style.left = `${left}%`;
            segment.style.width = `${Math.max(width - 0.2, 0.2)}%`;
            const fill = document.createElement("div");
            fill.className = "dlw-seg-fill";
            fill.style.width = `${percentOf(connection.downloadedBytes, connection.totalBytes)}%`;
            segment.appendChild(fill);
            el.segbar.appendChild(segment);
        }
    }
}

function updateControls(status) {
    const live = ["in_progress", "queued", "scheduled", "paused"].includes(status);
    const failed = status === "failed";
    const completed = status === "completed";
    const cancelled = status === "cancelled";
    const terminal = completed || failed || cancelled;
    const resume = status === "paused" || failed;

    el.pause.hidden = !(live || failed);
    el.cancel.hidden = terminal;
    el.openFile.hidden = !completed;
    el.openFolder.hidden = cancelled;
    el.closeWhenDoneLabel.hidden = terminal;

    el.pause.textContent = failed ? "Retry" : status === "paused" ? "Resume" : "Pause";
    el.pause.dataset.action = resume ? "resume" : "pause";
    el.pause.classList.toggle("btn-primary", resume);
    el.pause.classList.toggle("btn-secondary", !resume);

    // Terminal downloads do not need live rate/ETA; completed files do not
    // need a resume-support row either.
    document.querySelectorAll('.dlw-stat[data-tile="rate"], .dlw-stat[data-tile="eta"]').forEach((tile) => {
        tile.hidden = terminal;
    });
    const resumableTile = document.querySelector('.dlw-stat[data-tile="resumable"]');
    if (resumableTile) resumableTile.hidden = completed || cancelled;
}

// ── Live updates ────────────────────────────────────────────────────────────

async function refresh() {
    if (!downloadId) return;
    try {
        const payload = await invoke("download_details", { id: downloadId });
        renderDetails(payload);
    } catch (error) {
        console.error("Could not load download details:", error);
    }
}

function applyStateEvent(payload) {
    if (!payload || payload.id !== downloadId) return;

    const downloaded = payload.status === "in_progress"
        ? Math.max(payload.downloadedBytes, lastProgressBytes)
        : payload.downloadedBytes;
    lastProgressBytes = downloaded;

    // Instant feedback without another IPC round-trip; the poll below
    // refreshes the connection table (throttled to ~1s by design).
    setStatus(payload.status);
    if (payload.totalBytes) {
        el.downloaded.textContent = `${formatBytes(downloaded)} (${percentOf(downloaded, payload.totalBytes)}%)`;
    }
    setProgress(downloaded, payload.totalBytes);
    if (payload.speedBytesPerSecond != null) {
        el.rate.textContent = formatSpeed(payload.speedBytesPerSecond);
    }
    if (payload.status === "in_progress") {
        el.eta.textContent = formatEta(payload.etaSeconds);
    }
    if (payload.errorMessage) {
        el.error.textContent = payload.errorMessage;
        el.error.hidden = false;
    } else if (payload.status !== "failed") {
        el.error.hidden = true;
    }
    updateControls(payload.status);
    scheduleFitWindow();

    if (payload.status === "completed" && lastStatus !== "completed" && el.closeWhenDone.checked) {
        // This window closes itself; raise the main window first so the
        // completion is never silent (the backend may have skipped its
        // summon because this window was still visible).
        invoke("focus_main_window").catch(() => {}).finally(closeWindow);
        return;
    }
    lastStatus = payload.status;

    if (Date.now() - refreshAt > POLL_INTERVAL_MS) {
        refreshAt = Date.now();
        refresh();
    }
}

function closeWindow() {
    const tauri = getTauri();
    if (tauri?.window?.getCurrentWindow) {
        tauri.window.getCurrentWindow().close();
    } else {
        window.close();
    }
}

function initTheme() {
    let theme = "system";
    try {
        theme = localStorage.getItem("ldm_theme") || "system";
    } catch (_) {}
    const effective =
        theme === "system"
            ? window.matchMedia("(prefers-color-scheme: dark)").matches
                ? "dark"
                : "light"
            : theme;
    document.documentElement.setAttribute("data-theme", effective);
}

// ── Wire-up ─────────────────────────────────────────────────────────────────

function init() {
    initTheme();

    el.toggleDetails.addEventListener("click", () => {
        const hidden = !el.connections.hidden;
        el.connections.hidden = hidden;
        el.toggleDetails.textContent = hidden ? "Show details" : "Hide details";
        el.toggleDetails.setAttribute("aria-expanded", hidden ? "false" : "true");
        scheduleFitWindow();
    });

    el.pause.addEventListener("click", async () => {
        const action = el.pause.dataset.action === "resume" ? "resume_download" : "pause_download";
        try {
            await invoke(action, { id: downloadId });
        } catch (error) {
            console.error("Could not toggle download:", error);
        }
        refresh();
    });

    async function openPath(command) {
        const path = details?.download?.savePath;
        if (!path) return;
        try {
            await invoke(command, { path });
        } catch (error) {
            console.error(`Could not run ${command}:`, error);
        }
    }

    el.openFile.addEventListener("click", () => openPath("open_file"));
    el.openFolder.addEventListener("click", () => openPath("open_folder"));

    el.cancel.addEventListener("click", async () => {
        try {
            await invoke("cancel_download", { id: downloadId });
        } catch (error) {
            console.error("Could not cancel download:", error);
        }
        refresh();
    });

    el.close.addEventListener("click", closeWindow);
    el.windowClose.addEventListener("click", closeWindow);
    el.minimize.addEventListener("click", async () => {
        const tauri = getTauri();
        try {
            await tauri?.window?.getCurrentWindow?.().minimize();
        } catch (error) {
            console.error("Could not minimize window:", error);
        }
    });

    // Drag the undecorated window by its header (buttons keep their clicks).
    const dragArea = document.querySelector(".dlw-header");
    dragArea?.addEventListener("mousedown", async (event) => {
        if (event.button !== 0 || event.target.closest("button")) return;
        try {
            await getTauri()?.window?.getCurrentWindow?.().startDragging();
        } catch (error) {
            console.error("Could not drag window:", error);
        }
    });

    if (!downloadId) {
        el.title.textContent = "Download not found";
        return;
    }

    listen("download://state", (event) => applyStateEvent(event.payload));
    refresh();
    setInterval(refresh, POLL_INTERVAL_MS);

    // Follow theme changes made in the main window (same origin storage).
    window.addEventListener("storage", (event) => {
        if (event.key === "ldm_theme") initTheme();
    });
}

init();
