#[derive(Debug, Clone)]
struct AfkConfig {
    interval_seconds: u64,
    key: String,
    inter_window_delay_ms: u64,
}

#[derive(Debug, Clone, Default)]
struct AfkRuntime {
    last_cycle_at_ms: Option<i64>,
    next_cycle_at_ms: Option<i64>,
    last_window_count: u32,
    total_cycles: u64,
    last_error: Option<String>,
}

#[cfg(target_os = "windows")]
#[derive(Clone)]
struct AfkSession {
    id: u64,
    stop_flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
    stopped_notify: std::sync::Arc<tokio::sync::Notify>,
    started_at_ms: i64,
    config: std::sync::Arc<std::sync::Mutex<AfkConfig>>,
    runtime: std::sync::Arc<std::sync::Mutex<AfkRuntime>>,
}

#[cfg(target_os = "windows")]
struct AfkManager {
    session: std::sync::Mutex<Option<AfkSession>>,
    next_id: std::sync::atomic::AtomicU64,
}

#[cfg(target_os = "windows")]
impl AfkManager {
    fn new() -> Self {
        Self {
            session: std::sync::Mutex::new(None),
            next_id: std::sync::atomic::AtomicU64::new(1),
        }
    }

    fn next_session_id(&self) -> u64 {
        self.next_id
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    }

    fn get_session(&self) -> Option<AfkSession> {
        self.session.lock().ok().and_then(|s| s.as_ref().cloned())
    }

    fn replace_session(&self, session: Option<AfkSession>) {
        if let Ok(mut guard) = self.session.lock() {
            *guard = session;
        }
    }
}

#[cfg(target_os = "windows")]
static AFK_MANAGER: std::sync::LazyLock<AfkManager> = std::sync::LazyLock::new(AfkManager::new);

#[derive(Debug, Clone, serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct AfkStatusPayload {
    active: bool,
    started_at_ms: Option<i64>,
    interval_seconds: u64,
    key: String,
    inter_window_delay_ms: u64,
    last_cycle_at_ms: Option<i64>,
    next_cycle_at_ms: Option<i64>,
    last_window_count: u32,
    total_cycles: u64,
    last_error: Option<String>,
}

#[cfg(target_os = "windows")]
fn current_afk_status() -> AfkStatusPayload {
    match AFK_MANAGER.get_session() {
        Some(session) => {
            let config = session
                .config
                .lock()
                .map(|c| c.clone())
                .unwrap_or_else(|_| AfkConfig {
                    interval_seconds: 600,
                    key: "Space".into(),
                    inter_window_delay_ms: 250,
                });
            let runtime = session
                .runtime
                .lock()
                .map(|r| r.clone())
                .unwrap_or_default();
            AfkStatusPayload {
                active: true,
                started_at_ms: Some(session.started_at_ms),
                interval_seconds: config.interval_seconds,
                key: config.key,
                inter_window_delay_ms: config.inter_window_delay_ms,
                last_cycle_at_ms: runtime.last_cycle_at_ms,
                next_cycle_at_ms: runtime.next_cycle_at_ms,
                last_window_count: runtime.last_window_count,
                total_cycles: runtime.total_cycles,
                last_error: runtime.last_error,
            }
        }
        None => AfkStatusPayload::default(),
    }
}

#[cfg(target_os = "windows")]
fn emit_afk_status(app: &tauri::AppHandle) {
    let _ = app.emit("afk-status", current_afk_status());
}

#[cfg(target_os = "windows")]
fn run_afk_cycle_blocking(config: &AfkConfig) -> Result<u32, String> {
    use platform::windows;

    let (vk, scan) =
        windows::vk_and_scan(&config.key).ok_or_else(|| format!("Unsupported key: {}", config.key))?;
    let previous_foreground = windows::get_foreground_hwnd();
    let mut pids = windows::get_roblox_pids();
    pids.sort_unstable();

    let mut hit = 0u32;
    for pid in pids {
        let hwnd = match windows::find_main_window(pid) {
            Some(hwnd) => hwnd,
            None => continue,
        };
        if !windows::window_exists(hwnd) || !windows::window_is_arrangeable(hwnd) {
            continue;
        }

        windows::focus_window(hwnd);
        std::thread::sleep(std::time::Duration::from_millis(150));
        windows::send_key(vk, scan, false);
        std::thread::sleep(std::time::Duration::from_millis(40));
        windows::send_key(vk, scan, true);
        hit += 1;

        std::thread::sleep(std::time::Duration::from_millis(
            config.inter_window_delay_ms.min(5000),
        ));
    }

    if !previous_foreground.is_null() && windows::window_exists(previous_foreground) {
        windows::focus_window(previous_foreground);
    }

    Ok(hit)
}

#[cfg(target_os = "windows")]
async fn run_afk_session(app: tauri::AppHandle, session: AfkSession) {
    loop {
        if session
            .stop_flag
            .load(std::sync::atomic::Ordering::Relaxed)
        {
            break;
        }

        let config = match session.config.lock() {
            Ok(c) => c.clone(),
            Err(_) => break,
        };

        if let Ok(mut runtime) = session.runtime.lock() {
            runtime.next_cycle_at_ms = Some(now_ms() + (config.interval_seconds as i64) * 1000);
        }
        emit_afk_status(&app);

        sleep_interruptible(&session.stop_flag, (config.interval_seconds as i64) * 1000).await;
        if session
            .stop_flag
            .load(std::sync::atomic::Ordering::Relaxed)
        {
            break;
        }

        let cycle_config = config.clone();
        let result = tokio::task::spawn_blocking(move || run_afk_cycle_blocking(&cycle_config))
            .await
            .unwrap_or_else(|e| Err(format!("AFK cycle failed: {}", e)));

        if let Ok(mut runtime) = session.runtime.lock() {
            runtime.last_cycle_at_ms = Some(now_ms());
            runtime.total_cycles += 1;
            match result {
                Ok(count) => {
                    runtime.last_window_count = count;
                    runtime.last_error = None;
                }
                Err(error) => {
                    runtime.last_error = Some(error);
                }
            }
        }
        emit_afk_status(&app);
    }

    let owns_session = AFK_MANAGER
        .get_session()
        .map(|s| s.id == session.id)
        .unwrap_or(false);
    if owns_session {
        AFK_MANAGER.replace_session(None);
    }
    session.stopped_notify.notify_waiters();
    let _ = app.emit("afk-stopped", ());
    emit_afk_status(&app);
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn start_afk_mode(
    app: tauri::AppHandle,
    interval_seconds: u64,
    key: String,
    inter_window_delay_ms: u64,
) -> Result<AfkStatusPayload, String> {
    use platform::windows;

    if interval_seconds < 10 {
        return Err("Interval must be at least 10 seconds".into());
    }
    if windows::vk_and_scan(&key).is_none() {
        return Err(format!("Unsupported key: {}", key));
    }

    if let Some(existing) = AFK_MANAGER.get_session() {
        existing
            .stop_flag
            .store(true, std::sync::atomic::Ordering::Relaxed);
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            existing.stopped_notify.notified(),
        )
        .await;
        AFK_MANAGER.replace_session(None);
    }

    let session = AfkSession {
        id: AFK_MANAGER.next_session_id(),
        stop_flag: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        stopped_notify: std::sync::Arc::new(tokio::sync::Notify::new()),
        started_at_ms: now_ms(),
        config: std::sync::Arc::new(std::sync::Mutex::new(AfkConfig {
            interval_seconds,
            key,
            inter_window_delay_ms: inter_window_delay_ms.clamp(50, 5000),
        })),
        runtime: std::sync::Arc::new(std::sync::Mutex::new(AfkRuntime::default())),
    };

    AFK_MANAGER.replace_session(Some(session.clone()));
    tokio::spawn(run_afk_session(app.clone(), session));

    let status = current_afk_status();
    emit_afk_status(&app);
    Ok(status)
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn stop_afk_mode(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(session) = AFK_MANAGER.get_session() {
        session
            .stop_flag
            .store(true, std::sync::atomic::Ordering::Relaxed);
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            session.stopped_notify.notified(),
        )
        .await;
    }
    emit_afk_status(&app);
    Ok(())
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn get_afk_mode_status() -> Result<AfkStatusPayload, String> {
    Ok(current_afk_status())
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn afk_trigger_now(key: String, inter_window_delay_ms: u64) -> Result<u32, String> {
    let config = AfkConfig {
        interval_seconds: 0,
        key,
        inter_window_delay_ms: inter_window_delay_ms.clamp(50, 5000),
    };
    tokio::task::spawn_blocking(move || run_afk_cycle_blocking(&config))
        .await
        .unwrap_or_else(|e| Err(format!("AFK cycle failed: {}", e)))
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
async fn start_afk_mode(
    _interval_seconds: u64,
    _key: String,
    _inter_window_delay_ms: u64,
) -> Result<AfkStatusPayload, String> {
    Err("Not supported on this platform".into())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
async fn stop_afk_mode() -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn get_afk_mode_status() -> Result<AfkStatusPayload, String> {
    Ok(AfkStatusPayload::default())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
async fn afk_trigger_now(_key: String, _inter_window_delay_ms: u64) -> Result<u32, String> {
    Err("Not supported on this platform".into())
}
