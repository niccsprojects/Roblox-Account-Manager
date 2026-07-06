use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use crate::data::settings::get_settings_path;

static FRONTEND_READY: AtomicBool = AtomicBool::new(false);
static SAFE_MODE: AtomicBool = AtomicBool::new(false);

const MARKER_FILE: &str = "webview.safemode";
const READY_TIMEOUT_SECS: u64 = 25;

fn marker_path() -> PathBuf {
    get_settings_path().with_file_name(MARKER_FILE)
}

fn runtime_version() -> String {
    tauri::webview_version().unwrap_or_default()
}

pub fn prepare_environment() {
    let marker = marker_path();
    let mut safe_mode = false;

    if let Ok(recorded) = std::fs::read_to_string(&marker) {
        let recorded = recorded.trim();
        if !recorded.is_empty() && recorded == runtime_version() {
            safe_mode = true;
        } else {
            let _ = std::fs::remove_file(&marker);
        }
    }
    SAFE_MODE.store(safe_mode, Ordering::SeqCst);

    let mut args = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
    if !args.is_empty() {
        args.push(' ');
    }
    args.push_str(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion",
    );
    if safe_mode {
        args.push_str(" --disable-gpu --disable-gpu-compositing");
    }
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", args);
}

pub fn mark_ready() {
    FRONTEND_READY.store(true, Ordering::SeqCst);
    if !SAFE_MODE.load(Ordering::SeqCst) {
        let _ = std::fs::remove_file(marker_path());
    }
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
            app.dialog()
                .message(
                    "Roblox Account Manager could not display its interface, even in graphics safe mode.\n\nThis is usually caused by a broken Microsoft Edge WebView2 runtime update.\n\nTo fix it: open Windows Settings > Apps > Installed apps > Microsoft Edge WebView2 Runtime > Modify > Repair, or install the latest Microsoft Edge update, then restart your PC and open RAM again.",
                )
                .title("Roblox Account Manager")
                .kind(MessageDialogKind::Error)
                .blocking_show();
            return;
        }
        if std::fs::write(marker_path(), runtime_version()).is_ok() {
            app.restart();
        }
    });
}
