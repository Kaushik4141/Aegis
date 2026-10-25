// Aegis Control Plane desktop app.
//
// One window, one app: on launch it starts the Aegis services that are not
// already running (policy gateway :8787, sandbox service :8788, dashboard
// :3000), shows a splash with live status, and the splash navigates to the
// dashboard once everything is healthy. On exit every spawned service process
// group is torn down.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::File;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tauri::{Manager, RunEvent};

struct Services(Mutex<Vec<Child>>);

/// PIDs of spawned service process groups, reachable from the async-signal-
/// safe SIGTERM/SIGINT handler so services die even when the window cannot
/// close normally (logout, kill, crashed display).
static SERVICE_PIDS: OnceLock<Mutex<Vec<i32>>> = OnceLock::new();

fn service_pids() -> &'static Mutex<Vec<i32>> {
    SERVICE_PIDS.get_or_init(|| Mutex::new(Vec::new()))
}

extern "C" fn on_terminate_signal(signal: i32) {
    // Async-signal-safe: only kill(2) and direct memory access. After the
    // service groups are down, restore the default disposition and re-raise
    // so the app itself terminates.
    if let Some(pids) = SERVICE_PIDS.get() {
        if let Ok(list) = pids.lock() {
            for pid in list.iter() {
                unsafe {
                    libc::kill(-*pid, libc::SIGTERM);
                }
            }
        }
    }
    unsafe {
        libc::signal(signal, libc::SIG_DFL);
        libc::kill(libc::getpid(), signal);
    }
}

fn port_open(port: u16) -> bool {
    TcpStream::connect(("127.0.0.1", port)).is_ok()
}

fn http_contains(port: u16, path: &str, needle: &str) -> bool {
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let request = format!("GET {path} HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut body = String::new();
    let _ = stream.read_to_string(&mut body);
    body.contains(needle)
}

#[tauri::command]
fn service_status() -> serde_json::Value {
    let sandbox_up = http_contains(8788, "/health", "\"ok\":true");
    serde_json::json!({
        "gateway": port_open(8787),
        "sandbox": sandbox_up,
        // Docker is required to run sandboxes; surfaced separately so the
        // splash can name the problem when the service is up but Docker is not.
        "docker": sandbox_up && http_contains(8788, "/health", "\"docker\":true"),
        "web": port_open(3000),
    })
}

/// Walk up from the current directory to the monorepo root (the package.json
/// that declares the apps/ workspaces). AEGIS_REPO_ROOT overrides discovery.
fn repo_root() -> PathBuf {
    if let Ok(root) = std::env::var("AEGIS_REPO_ROOT") {
        let path = PathBuf::from(root);
        if path.join("package.json").exists() {
            return path;
        }
    }
    let mut dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    loop {
        if is_repo_root(&dir) {
            return dir;
        }
        if !dir.pop() {
            break;
        }
    }
    // Fall back to two levels above src-tauri (apps/desktop/src-tauri).
    let fallback = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("..");
    fallback.canonicalize().unwrap_or(fallback)
}

fn is_repo_root(dir: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(dir.join("package.json")) else {
        return false;
    };
    text.contains("\"apps/") && dir.join("apps").is_dir()
}

fn spawn_service(root: &Path, script: &str, log_name: &str) -> Option<Child> {
    let log_dir = root.join("data").join("desktop-logs");
    let _ = std::fs::create_dir_all(&log_dir);
    let log = File::create(log_dir.join(log_name)).ok()?;
    let err = log.try_clone().ok()?;
    let child = Command::new("npm")
        .arg("run")
        .arg(script)
        .current_dir(root)
        .stdout(log)
        .stderr(err)
        .process_group(0)
        .spawn()
        .ok()?;
    service_pids().lock().unwrap().push(child.id() as i32);
    Some(child)
}

fn start_missing_services(app: &tauri::AppHandle) {
    let root = repo_root();
    let services = app.state::<Services>();
    let mut guard = services.0.lock().unwrap();
    for (script, port, log) in [
        ("dev:api", 8787u16, "api.log"),
        ("dev:sandbox", 8788, "sandbox.log"),
        ("dev:web", 3000, "web.log"),
    ] {
        if port_open(port) {
            println!("[aegis-desktop] {script} already running on :{port}");
            continue;
        }
        match spawn_service(&root, script, log) {
            Some(child) => {
                println!("[aegis-desktop] started {script} (pid {})", child.id());
                guard.push(child);
            }
            None => eprintln!("[aegis-desktop] failed to start {script} (see data/desktop-logs/{log})"),
        }
    }
}

fn stop_services(app: &tauri::AppHandle) {
    let services = app.state::<Services>();
    let children: Vec<Child> = services.0.lock().unwrap().drain(..).collect();
    for mut child in children {
        let pid = child.id();
        // npm spawns tsx grandchildren; kill the whole process group.
        let killed = Command::new("kill")
            .arg("-TERM")
            .arg(format!("-{pid}"))
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if !killed {
            let _ = child.kill();
        }
        let _ = child.wait();
        println!("[aegis-desktop] stopped service pid {pid}");
    }
}

fn main() {
    let handler = on_terminate_signal as extern "C" fn(i32) as libc::sighandler_t;
    unsafe {
        libc::signal(libc::SIGTERM, handler);
        libc::signal(libc::SIGINT, handler);
        libc::signal(libc::SIGHUP, handler);
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Services(Mutex::new(Vec::new())))
        .invoke_handler(tauri::generate_handler![service_status])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            RunEvent::Ready => start_missing_services(&app),
            RunEvent::ExitRequested { .. } => stop_services(&app),
            RunEvent::Exit => stop_services(&app),
            _ => {}
        });
}
