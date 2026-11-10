use crate::app::{AppState, QueuedDownload};
use crate::browser::BrowserDownloadRequest;
use crate::download::{DownloadMetadata, DownloadRecord};
use crate::jobs::{DownloadJobRequest, queue_download_request};
use serde::Serialize;
use std::sync::atomic::Ordering;
use tauri::{Manager, State};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub default_download_dir: String,
    pub max_concurrent_downloads: usize,
    pub connections_per_download: usize,
    pub default_bandwidth_limit_kbps: u64,
    pub ask_browser_download_location: bool,
    pub hidden_sites: Vec<String>,
}

fn hidden_browser_sites(state: &AppState) -> Vec<String> {
    state.storage.get_setting("hidden_browser_sites").ok().flatten()
        .and_then(|value| serde_json::from_str(&value).ok()).unwrap_or_default()
}

#[tauri::command]
pub async fn inspect_url(
    state: State<'_, AppState>,
    url: String,
) -> Result<DownloadMetadata, String> {
    state.download_service.inspect_url(&url).await
}

#[tauri::command]
pub async fn list_downloads(state: State<'_, AppState>) -> Result<Vec<DownloadRecord>, String> {
    let mut list = state.storage.list_downloads()?;
    {
        let live = state.live_metrics.lock().unwrap();
        for item in &mut list {
            if item.status == "in_progress" {
                if let Some(&(speed, eta)) = live.get(&item.id) {
                    item.speed_bytes_per_second = Some(speed);
                    item.eta_seconds = eta;
                }
            }
        }
    }
    // Overlay the on-disk size so a poll cannot show less progress than the
    // last live event (SQLite is only written every 1.5s).
    for item in &mut list {
        if item.status == "in_progress" {
            let actual = state
                .download_service
                .current_downloaded_bytes(std::path::Path::new(&item.save_path))
                .await;
            item.downloaded_bytes = item.downloaded_bytes.max(actual);
        }
    }
    Ok(list)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub index: usize,
    pub status: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub start_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadDetails {
    pub download: DownloadRecord,
    pub connections: Vec<ConnectionInfo>,
    pub resumable: bool,
}

fn connection_status(status: &str, segment_complete: bool) -> String {
    match status {
        "in_progress" => {
            if segment_complete { "Completed" } else { "Receiving data" }
        }
        "paused" => {
            if segment_complete { "Completed" } else { "Paused" }
        }
        "queued" | "scheduled" => "Pending",
        "completed" => "Completed",
        "failed" => "Failed",
        "cancelled" => "Cancelled",
        other => other,
    }
    .to_string()
}

#[tauri::command]
pub fn open_download_window(
    app_handle: tauri::AppHandle,
    id: i64,
    file_name: Option<String>,
) -> Result<(), String> {
    crate::download_window::open_download_window(&app_handle, id, file_name)
}

/// Full detail payload for the dedicated download window: the persisted
/// record (with live speed/ETA) plus per-connection state derived from the
/// segment manifest and its segment files on disk.
#[tauri::command]
pub fn focus_main_window(app_handle: tauri::AppHandle) {
    crate::app::summon_main_window(&app_handle);
}

#[tauri::command]
pub async fn download_details(
    state: State<'_, AppState>,
    id: i64,
) -> Result<DownloadDetails, String> {
    let mut record = state.storage.get_download(id)?;
    let target_path = std::path::PathBuf::from(&record.save_path);
    if record.status == "in_progress" {
        // SQLite progress is throttled to 1.5s; the on-disk size is current,
        // so polling never rewinds a percentage the UI already showed.
        let actual = state
            .download_service
            .current_downloaded_bytes(&target_path)
            .await;
        record.downloaded_bytes = record.downloaded_bytes.max(actual);
        if let Some(&(speed, eta)) = state.live_metrics.lock().unwrap().get(&id) {
            record.speed_bytes_per_second = Some(speed);
            record.eta_seconds = eta;
        }
    }

    let manifest = state.download_service.load_segment_manifest(&target_path).await?;
    let mut connections = Vec::new();

    if let Some(manifest) = manifest {
        connections.reserve(manifest.segments.len());
        for segment in manifest.segments {
            let capacity = segment.end.saturating_sub(segment.start).saturating_add(1);
            let downloaded = std::cmp::min(segment.downloaded_bytes, capacity);
            connections.push(ConnectionInfo {
                index: segment.index,
                status: connection_status(&record.status, capacity > 0 && downloaded >= capacity),
                downloaded_bytes: downloaded,
                total_bytes: capacity,
                start_bytes: segment.start,
            });
        }
    }

    // Single-stream (or yt-dlp/stream) downloads still get one row.
    if connections.is_empty() {
        let downloaded = state
            .download_service
            .current_downloaded_bytes(&target_path)
            .await;
        let total = record.total_bytes.unwrap_or(0).max(downloaded);
        connections.push(ConnectionInfo {
            index: 0,
            status: connection_status(
                &record.status,
                record.total_bytes.is_some_and(|total| downloaded >= total),
            ),
            downloaded_bytes: downloaded,
            total_bytes: total,
            start_bytes: 0,
        });
    }

    Ok(DownloadDetails {
        resumable: record.resumable,
        download: record,
        connections,
    })
}

#[tauri::command]
pub async fn start_download(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    url: String,
    save_dir: Option<String>,
    expected_checksum: Option<String>,
    scheduled_at: Option<String>,
    bandwidth_limit_kbps: Option<u64>,
    custom_file_name: Option<String>,
) -> Result<DownloadRecord, String> {
    queue_download_request(
        &app_handle,
        &state,
        DownloadJobRequest {
            url,
            fallback_urls: Vec::new(),
            audio_url: None,
            source_page_url: None,
            http_headers: Default::default(),
            save_dir,
            expected_checksum,
            scheduled_at,
            bandwidth_limit_kbps,
            format: None,
            source_title: custom_file_name,
            force_ytdlp: false,
            stream_manifest: false,
        },
    )
    .await
}

#[tauri::command]
pub async fn start_browser_download(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    request: BrowserDownloadRequest,
    save_dir: String,
) -> Result<DownloadRecord, String> {
    queue_download_request(
        &app_handle,
        &state,
        DownloadJobRequest {
            url: request.url,
            fallback_urls: request.fallback_urls,
            audio_url: request.audio_url,
            source_page_url: request.source_page_url,
            http_headers: request.http_headers,
            save_dir: Some(save_dir),
            expected_checksum: request.expected_checksum,
            scheduled_at: request.scheduled_at,
            bandwidth_limit_kbps: request.bandwidth_limit_kbps,
            format: request.format,
            source_title: request.source_title,
            force_ytdlp: request.force_ytdlp,
            stream_manifest: request.stream_manifest,
        },
    )
    .await
}

#[tauri::command]
pub async fn pick_save_directory(
    app_handle: tauri::AppHandle,
    initial_dir: Option<String>,
) -> Result<Option<String>, String> {
    let dialog = tauri_plugin_dialog::DialogExt::dialog(&app_handle);
    let mut picker = dialog.file();
    if let Some(path) = initial_dir {
        picker = picker.set_directory(path);
    }
    let result = picker.blocking_pick_folder();
    Ok(result.map(|path| path.to_string()))
}

#[tauri::command]
pub async fn app_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    Ok(AppSettings {
        default_download_dir: state.default_download_dir().display().to_string(),
        max_concurrent_downloads: state.max_concurrent_downloads(),
        connections_per_download: state.connections_per_download(),
        default_bandwidth_limit_kbps: state.default_bandwidth_limit_kbps().unwrap_or(0),
        ask_browser_download_location: state.storage.get_setting("ask_browser_download_location")?.as_deref() != Some("false"),
        hidden_sites: hidden_browser_sites(&state),
    })
}

#[tauri::command]
pub async fn update_app_settings(
    state: State<'_, AppState>,
    default_download_dir: Option<String>,
    max_concurrent_downloads: Option<usize>,
    connections_per_download: Option<usize>,
    default_bandwidth_limit_kbps: Option<u64>,
    ask_browser_download_location: Option<bool>,
    hidden_sites: Option<Vec<String>>,
) -> Result<AppSettings, String> {
    // Validate the folder first so a failure cannot leave the other
    // settings half-applied.
    if let Some(dir) = default_download_dir {
        state.set_default_download_dir(&dir)?;
    }

    if let Some(value) = max_concurrent_downloads {
        if value == 0 || value > 10 {
            return Err("max concurrent downloads must be between 1 and 10".to_string());
        }
        state.set_max_concurrent_downloads(value);
    }

    if let Some(value) = connections_per_download {
        if value == 0 || value > 16 {
            return Err("connections per download must be between 1 and 16".to_string());
        }
        state.set_connections_per_download(value);
    }

    if let Some(value) = default_bandwidth_limit_kbps {
        state.set_default_bandwidth_limit_kbps(if value == 0 { None } else { Some(value) });
    }
    if let Some(value) = ask_browser_download_location {
        state.storage.set_setting("ask_browser_download_location", if value { "true" } else { "false" })?;
    }
    if let Some(sites) = hidden_sites {
        state.storage.set_setting("hidden_browser_sites", &serde_json::to_string(&sites).map_err(|error| error.to_string())?)?;
    }

    Ok(AppSettings {
        default_download_dir: state.default_download_dir().display().to_string(),
        max_concurrent_downloads: state.max_concurrent_downloads(),
        connections_per_download: state.connections_per_download(),
        default_bandwidth_limit_kbps: state.default_bandwidth_limit_kbps().unwrap_or(0),
        ask_browser_download_location: state.storage.get_setting("ask_browser_download_location")?.as_deref() != Some("false"),
        hidden_sites: hidden_browser_sites(&state),
    })
}

/// Actual folder where the browser extension was installed (recorded at
/// install/first-run time). Returns None if it cannot be located.
#[tauri::command]
pub async fn extension_folder(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let marker = state.app_data_dir.join(".extension_installed");
    if let Ok(path) = std::fs::read_to_string(&marker) {
        let path = path.trim();
        if !path.is_empty() {
            return Ok(Some(path.to_string()));
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        let candidate = std::path::PathBuf::from(home)
            .join("Documents")
            .join("Haul DM Extension");
        if candidate.is_dir() {
            return Ok(Some(candidate.display().to_string()));
        }
    }
    Ok(None)
}

/// Force the main window with the browser-download dialog in front of
/// everything.active = true re-applies always-on-top and retries focus;
/// active = false releases the pin (called when the queue drains).
#[tauri::command]
pub async fn set_browser_dialog_focus(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    active: bool,
) -> Result<(), String> {
    if active {
        crate::app::summon_main_window(&app_handle);
    } else {
        // Dialog answered/queue drained: stop the retry loop and unpin.
        state.browser_dialog_pending.store(false, Ordering::Relaxed);
        if let Some(window) = app_handle.get_webview_window("main") {
            let _ = window.set_always_on_top(false);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn pause_download(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    id: i64,
) -> Result<(), String> {
    state.pause_download(id)?;
    let record = state.storage.get_download(id)?;
    let actual_bytes = state
        .download_service
        .current_downloaded_bytes(std::path::Path::new(&record.save_path))
        .await;
    let downloaded = std::cmp::max(record.downloaded_bytes, actual_bytes);
    state.storage.set_status(id, "paused", downloaded, record.total_bytes, None)?;
    state.emit_download_event(&app_handle, id, "paused", downloaded, record.total_bytes, None, None, Some(0), None);
    Ok(())
}

#[tauri::command]
pub async fn resume_download(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    id: i64,
) -> Result<DownloadRecord, String> {
    let record = state.storage.get_download(id)?;
    let metadata = state.download_service.inspect_url(&record.url).await?;
    state.storage.set_resumable(id, metadata.resumable)?;

    let actual_bytes = state
        .download_service
        .current_downloaded_bytes(std::path::Path::new(&record.save_path))
        .await;
    let downloaded_bytes = std::cmp::max(record.downloaded_bytes, actual_bytes);
    let total_bytes = record.total_bytes.or(metadata.content_length);

    state.storage.set_status(
        id,
        "queued",
        downloaded_bytes,
        total_bytes,
        None,
    )?;
    state.emit_download_event(
        &app_handle,
        id,
        "queued",
        downloaded_bytes,
        total_bytes,
        None,
        None,
        Some(0),
        None,
    );
    state.enqueue_download(
        &app_handle,
        QueuedDownload {
            id,
            url: record.url,
            fallback_urls: Vec::new(),
            audio_url: None,
            source_page_url: None,
            http_headers: Default::default(),
            format: None,
            force_ytdlp: false,
            stream_manifest: false,
            target_path: std::path::Path::new(&record.save_path).to_path_buf(),
            resumable_hint: metadata.resumable,
            total_bytes_hint: total_bytes,
            auto_open_window: true,
            expected_checksum: record.expected_checksum,
            scheduled_at: record.scheduled_at,
            bandwidth_limit_kbps: record.bandwidth_limit_kbps,
        },
    )?;

    state.storage.get_download(id)
}

#[tauri::command]
pub async fn cancel_download(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    id: i64,
) -> Result<(), String> {
    state.cancel_download(id)?;
    let record = state.storage.get_download(id)?;
    let _ = state
        .download_service
        .remove_temp_artifacts(std::path::Path::new(&record.save_path))
        .await;
    state.emit_download_event(&app_handle, id, "cancelled", 0, None, None, None, Some(0), None);
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemStatus {
    pub active_downloads: usize,
    pub pending_downloads: usize,
    pub default_download_dir: String,
}

#[tauri::command]
pub async fn clear_completed(state: State<'_, AppState>) -> Result<u64, String> {
    state.storage.delete_completed()
}

#[tauri::command]
pub async fn system_status(state: State<'_, AppState>) -> Result<SystemStatus, String> {
    Ok(SystemStatus {
        active_downloads: state.active_download_count(),
        pending_downloads: state.pending_download_count(),
        default_download_dir: state.default_download_dir().display().to_string(),
    })
}

#[tauri::command]
pub async fn delete_download(
    state: State<'_, AppState>,
    id: i64,
    delete_file: bool,
) -> Result<(), String> {
    let _ = state.cancel_download(id);
    if let Ok(record) = state.storage.get_download(id) {
        let path = std::path::PathBuf::from(&record.save_path);
        let _ = state.download_service.remove_temp_artifacts(&path).await;
        if delete_file && path.exists() {
            let _ = std::fs::remove_file(&path);
        }
    }
    state.storage.delete_download(id)?;
    Ok(())
}

#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("Only http/https URLs can be opened".to_string());
    }
    std::process::Command::new("xdg-open")
        .arg(&url)
        .spawn()
        .map_err(|e| format!("Failed to open URL: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn open_file(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("File does not exist: {path}"));
    }
    std::process::Command::new("xdg-open")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("Failed to open file: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn open_folder(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    let target = if p.is_dir() {
        p.to_path_buf()
    } else {
        p.parent().map(|parent| parent.to_path_buf()).unwrap_or_else(|| p.to_path_buf())
    };
    if !target.exists() {
        return Err(format!("Folder does not exist: {}", target.display()));
    }
    std::process::Command::new("xdg-open")
        .arg(target)
        .spawn()
        .map_err(|e| format!("Failed to open folder: {e}"))?;
    Ok(())
}

