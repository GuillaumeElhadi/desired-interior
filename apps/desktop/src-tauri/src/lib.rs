use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_shell::ShellExt;

struct ApiState {
    base_url: Mutex<Option<String>>,
}

struct SidecarState {
    child: Mutex<Option<tauri_plugin_shell::process::CommandChild>>,
}

fn find_free_port() -> u16 {
    use std::net::TcpListener;
    TcpListener::bind("127.0.0.1:0")
        .expect("bind to ephemeral port")
        .local_addr()
        .expect("local_addr")
        .port()
}

#[tauri::command]
fn api_base_url(state: tauri::State<ApiState>) -> Result<String, String> {
    state
        .base_url
        .lock()
        .map_err(|e| format!("lock poisoned: {e}"))?
        .clone()
        .ok_or_else(|| "sidecar not yet started".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(ApiState {
            base_url: Mutex::new(None),
        })
        .manage(SidecarState {
            child: Mutex::new(None),
        })
        .setup(|app| {
            let port = find_free_port();
            let base_url = format!("http://127.0.0.1:{port}");

            let (rx, child) = app
                .shell()
                .sidecar("interior-vision-api")
                .map_err(|e| format!("sidecar not found: {e}"))?
                .args(["--host", "127.0.0.1", "--port", &port.to_string()])
                .spawn()
                .map_err(|e| format!("spawn failed: {e}"))?;

            // Drain sidecar stdout/stderr to prevent pipe backpressure
            tauri::async_runtime::spawn(async move {
                let mut rx = rx;
                while rx.recv().await.is_some() {}
            });

            *app.state::<ApiState>().base_url.lock().unwrap() = Some(base_url);
            *app.state::<SidecarState>().child.lock().unwrap() = Some(child);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![api_base_url])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Ok(mut guard) = app_handle.state::<SidecarState>().child.lock() {
                    if let Some(child) = guard.take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
