use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Window labels are stable per download so open/focus/reopen is idempotent.
pub fn window_label(download_id: i64) -> String {
    format!("download-{download_id}")
}

/// Whether the download's own window exists, is visible and not minimized.
/// Used by the completion/failure nudge: if the result is already on screen
/// in the dedicated window, the main window is not summoned as well.
pub fn is_download_window_visible(app_handle: &AppHandle, download_id: i64) -> bool {
    let Some(window) = app_handle.get_webview_window(&window_label(download_id)) else {
        return false;
    };
    let visible = window.is_visible().unwrap_or(false);
    let minimized = window.is_minimized().unwrap_or(false);
    visible && !minimized
}

///
/// - missing → create, focus
/// - minimized → unminimize, show, focus
/// - visible → focus only
///
/// Closing the window never touches the download task; the task keeps
/// running in the background and reopening simply shows it again.
pub fn open_download_window(
    app_handle: &AppHandle,
    download_id: i64,
    file_name: Option<String>,
) -> Result<(), String> {
    let app = app_handle.clone();
    let title = format!(
        "Haul DM — {}",
        file_name
            .unwrap_or_else(|| "Download".to_string())
            .chars()
            .take(120)
            .collect::<String>()
    );

    app_handle
        .run_on_main_thread(move || {
            let label = window_label(download_id);

            if let Some(window) = app.get_webview_window(&label) {
                if window.is_minimized().unwrap_or(false) {
                    let _ = window.unminimize();
                }
                let _ = window.show();
                let _ = window.set_focus();
                return;
            }

            let url = WebviewUrl::App(format!("download.html?id={download_id}").into());
            match WebviewWindowBuilder::new(&app, &label, url)
                .title(title)
                .inner_size(1024.0, 640.0)
                .min_inner_size(760.0, 440.0)
                .decorations(false)
                .center()
                .focused(true)
                .build()
            {
                Ok(window) => {
                    let _ = window.set_focus();
                }
                Err(error) => {
                    eprintln!("failed to open download window {label}: {error}");
                }
            }
        })
        .map_err(|error| format!("failed to schedule download window: {error}"))
}
