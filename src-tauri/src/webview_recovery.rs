use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_SHIFT};

use crate::data::settings::get_settings_path;

static FRONTEND_READY: AtomicBool = AtomicBool::new(false);
static SAFE_MODE: AtomicBool = AtomicBool::new(false);

const MARKER_FILE: &str = "webview.safemode";
const READY_TIMEOUT_SECS: u64 = 25;
const DISABLED_FEATURES: [&str; 4] = [
    "msWebOOUI",
    "msPdfOOUI",
    "msSmartScreenProtection",
    "CalculateNativeWinOcclusion",
];
const SAFE_MODE_FLAGS: [&str; 2] = ["--disable-gpu", "--disable-gpu-compositing"];

fn marker_path() -> PathBuf {
    get_settings_path().with_file_name(MARKER_FILE)
}

fn runtime_version() -> String {
    tauri::webview_version()
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

fn safe_mode_requested() -> bool {
    let command_line = std::env::args_os()
        .skip(1)
        .any(|arg| arg.to_string_lossy().eq_ignore_ascii_case("--safe-mode"));
    let environment = std::env::var("RAM_WEBVIEW_SAFE_MODE")
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false);
    let shift_held = unsafe { GetAsyncKeyState(VK_SHIFT as i32) < 0 };

    command_line || environment || shift_held
}

pub fn prepare_environment() {
    let marker = marker_path();
    let mut safe_mode = safe_mode_requested();

    if let Ok(recorded) = std::fs::read_to_string(&marker) {
        let recorded = recorded.trim();
        if !recorded.is_empty() && recorded == runtime_version() {
            safe_mode = true;
        } else {
            let _ = std::fs::remove_file(&marker);
        }
    }
    SAFE_MODE.store(safe_mode, Ordering::SeqCst);

    let existing = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
    let mut features: Vec<String> = Vec::new();
    let mut args: Vec<String> = Vec::new();
    for part in existing.split_whitespace() {
        if let Some(list) = part.strip_prefix("--disable-features=") {
            features.extend(list.split(',').filter(|f| !f.is_empty()).map(str::to_string));
        } else {
            args.push(part.to_string());
        }
    }
    for feature in DISABLED_FEATURES {
        if !features.iter().any(|f| f == feature) {
            features.push(feature.to_string());
        }
    }
    args.push(format!("--disable-features={}", features.join(",")));
    if safe_mode {
        for flag in SAFE_MODE_FLAGS {
            if !args.iter().any(|a| a == flag) {
                args.push(flag.to_string());
            }
        }
    }
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", args.join(" "));
}

pub fn mark_ready() {
    FRONTEND_READY.store(true, Ordering::SeqCst);
    if !SAFE_MODE.load(Ordering::SeqCst) {
        let _ = std::fs::remove_file(marker_path());
    }
}

fn show_repair_dialog(app: &AppHandle<Wry>) {
    app.dialog()
        .message(
            "Roblox Account Manager could not display its interface, even in graphics safe mode.\n\nRepair Microsoft Edge WebView2 Runtime in Windows Settings > Apps > Installed apps, restart Windows, then open RAM again. You can force graphics safe mode at any time by holding Shift while RAM starts.\n\nRAM konnte die Oberfläche auch im Grafik-Sicherheitsmodus nicht anzeigen.\n\nRepariere Microsoft Edge WebView2 Runtime unter Windows-Einstellungen > Apps > Installierte Apps, starte Windows neu und öffne RAM erneut. Halte beim Starten von RAM die Umschalttaste gedrückt, um den Grafik-Sicherheitsmodus zu erzwingen.",
        )
        .title("Roblox Account Manager")
        .kind(MessageDialogKind::Error)
        .blocking_show();
}

pub fn start_watchdog(app: AppHandle<Wry>) {
    if cfg!(debug_assertions) {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(READY_TIMEOUT_SECS));
        if FRONTEND_READY.load(Ordering::SeqCst) {
            return;
        }
        if SAFE_MODE.load(Ordering::SeqCst) {
            show_repair_dialog(&app);
            return;
        }
        if std::fs::write(marker_path(), runtime_version()).is_err() {
            show_repair_dialog(&app);
            return;
        }
        app.restart();
    });
}
