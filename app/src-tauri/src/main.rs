// Prevents an extra console window on Windows in release; harmless on macOS.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;

use std::sync::Arc;

use backend::{Backend, BackendInfo};
use tauri::{AppHandle, Manager, RunEvent, State};
use tauri_plugin_log::{Target, TargetKind};

/// Resolves once the sidecar has printed its ready line; rejects with a human readable message if it
/// failed to start or exited early. Runs on a worker thread (sync commands would block the main thread).
#[tauri::command(async)]
fn backend_info(state: State<'_, Arc<Backend>>) -> Result<BackendInfo, String> {
    state.info()
}

/// Kills the current sidecar (if any), starts a fresh one and resolves with its connection info.
#[tauri::command(async)]
fn restart_backend(app: AppHandle, state: State<'_, Arc<Backend>>) -> Result<BackendInfo, String> {
    state.restart(&app);
    state.info()
}

fn main() {
    let backend = Backend::new();

    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir { file_name: Some("jarvis".into()) }),
                ])
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::clone(&backend))
        .setup(|app| {
            let backend = app.state::<Arc<Backend>>().inner().clone();
            backend.start(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![backend_info, restart_backend])
        .build(tauri::generate_context!())
        .expect("error while building the Jarvis application");

    app.run(move |handle, event| match event {
        // Hide the window right away so quitting feels instant while the sidecar shuts down.
        RunEvent::ExitRequested { .. } => {
            for (_, window) in handle.webview_windows() {
                let _ = window.hide();
            }
        }
        // Last chance: graceful POST /api/shutdown, then SIGTERM, then SIGKILL on the process group.
        RunEvent::Exit => backend.shutdown(),
        _ => {}
    });
}
