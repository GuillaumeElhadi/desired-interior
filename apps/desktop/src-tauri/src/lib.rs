use std::io::Read;
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_shell::ShellExt;

struct ApiState {
    base_url: Mutex<Option<String>>,
    ipc_token: Mutex<Option<String>>,
}

struct SidecarState {
    child: Mutex<Option<tauri_plugin_shell::process::CommandChild>>,
}

fn gen_ipc_token() -> String {
    let mut bytes = [0u8; 16];
    std::fs::File::open("/dev/urandom")
        .expect("/dev/urandom not available")
        .read_exact(&mut bytes)
        .expect("read /dev/urandom");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
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

#[tauri::command]
fn ipc_token(state: tauri::State<ApiState>) -> Result<String, String> {
    state
        .ipc_token
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
            ipc_token: Mutex::new(None),
        })
        .manage(SidecarState {
            child: Mutex::new(None),
        })
        .setup(|app| {
            let port = find_free_port();
            let base_url = format!("http://127.0.0.1:{port}");
            let token = gen_ipc_token();

            let (rx, child) = app
                .shell()
                .sidecar("interior-vision-api")
                .map_err(|e| format!("sidecar not found: {e}"))?
                .args(["--host", "127.0.0.1", "--port", &port.to_string()])
                .env("IPC_TOKEN", &token)
                .spawn()
                .map_err(|e| format!("spawn failed: {e}"))?;

            // Forward sidecar stderr to this process's stderr; drain stdout.
            tauri::async_runtime::spawn(async move {
                let mut rx = rx;
                while let Some(event) = rx.recv().await {
                    if let tauri_plugin_shell::process::CommandEvent::Stderr(line) = event {
                        eprint!("[sidecar] {line}");
                    }
                }
            });

            *app.state::<ApiState>().base_url.lock().unwrap() = Some(base_url);
            *app.state::<ApiState>().ipc_token.lock().unwrap() = Some(token);
            *app.state::<SidecarState>().child.lock().unwrap() = Some(child);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![api_base_url, ipc_token])
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
