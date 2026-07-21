#[derive(Clone, Default)]
struct WindowsClientOverrides {
    max_fps: Option<u32>,
    master_volume: Option<f32>,
    graphics_level: Option<u32>,
    window_size: Option<(u32, u32)>,
    fast_flags: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum LaunchClientProfile {
    Normal,
    BottingPlayer,
    BottingBot,
}

pub(crate) fn profile_key(
    profile: LaunchClientProfile,
    normal: &'static str,
    player: &'static str,
    bot: &'static str,
) -> &'static str {
    match profile {
        LaunchClientProfile::Normal => normal,
        LaunchClientProfile::BottingPlayer => player,
        LaunchClientProfile::BottingBot => bot,
    }
}

pub(crate) fn effective_launch_profile(
    settings: &SettingsStore,
    profile: LaunchClientProfile,
) -> LaunchClientProfile {
    if matches!(profile, LaunchClientProfile::Normal) || !botting_uses_shared_client_profile(settings)
    {
        profile
    } else {
        LaunchClientProfile::Normal
    }
}

fn custom_client_settings_path(settings: &SettingsStore, profile: LaunchClientProfile) -> String {
    let key = profile_key(
        profile,
        "CustomClientSettings",
        "BottingPlayerCustomClientSettings",
        "BottingBotCustomClientSettings",
    );
    settings.get_string("General", key)
}

pub(crate) fn start_minimized_for_profile(
    settings: &SettingsStore,
    profile: LaunchClientProfile,
) -> bool {
    let key = profile_key(
        profile,
        "StartRobloxMinimized",
        "BottingPlayerStartRobloxMinimized",
        "BottingBotStartRobloxMinimized",
    );
    settings.get_bool("General", key)
}

pub(crate) fn botting_uses_shared_client_profile(settings: &SettingsStore) -> bool {
    settings
        .get("General", "BottingUseSharedClientProfile")
        .ok()
        .flatten()
        .map(|v| v == "true")
        .unwrap_or(true)
}

#[cfg(target_os = "windows")]
fn windows_client_overrides(
    settings: &SettingsStore,
    allow_fps_override: bool,
    profile: LaunchClientProfile,
) -> WindowsClientOverrides {
    let unlock_fps_key = profile_key(
        profile,
        "UnlockFPS",
        "BottingPlayerUnlockFPS",
        "BottingBotUnlockFPS",
    );
    let max_fps_key = profile_key(
        profile,
        "MaxFPSValue",
        "BottingPlayerMaxFPSValue",
        "BottingBotMaxFPSValue",
    );

    let max_fps = if allow_fps_override && settings.get_bool("General", unlock_fps_key) {
        let fps = settings.get_int("General", max_fps_key).unwrap_or(120);
        if fps > 0 {
            Some(fps as u32)
        } else {
            None
        }
    } else {
        None
    };

    let override_volume_key = profile_key(
        profile,
        "OverrideClientVolume",
        "BottingPlayerOverrideClientVolume",
        "BottingBotOverrideClientVolume",
    );
    let client_volume_key = profile_key(
        profile,
        "ClientVolume",
        "BottingPlayerClientVolume",
        "BottingBotClientVolume",
    );

    let master_volume = if settings.get_bool("General", override_volume_key) {
        Some(
            settings
                .get_float("General", client_volume_key)
                .unwrap_or(0.5)
                .clamp(0.0, 1.0) as f32,
        )
    } else {
        None
    };

    let override_graphics_key = profile_key(
        profile,
        "OverrideClientGraphics",
        "BottingPlayerOverrideClientGraphics",
        "BottingBotOverrideClientGraphics",
    );
    let graphics_level_key = profile_key(
        profile,
        "ClientGraphicsLevel",
        "BottingPlayerClientGraphicsLevel",
        "BottingBotClientGraphicsLevel",
    );

    let graphics_level = if settings.get_bool("General", override_graphics_key) {
        let lvl = settings
            .get_int("General", graphics_level_key)
            .unwrap_or(10);
        if lvl > 0 {
            Some(lvl.clamp(1, 10) as u32)
        } else {
            None
        }
    } else {
        None
    };

    let override_window_key = profile_key(
        profile,
        "OverrideClientWindowSize",
        "BottingPlayerOverrideClientWindowSize",
        "BottingBotOverrideClientWindowSize",
    );
    let window_width_key = profile_key(
        profile,
        "ClientWindowWidth",
        "BottingPlayerClientWindowWidth",
        "BottingBotClientWindowWidth",
    );
    let window_height_key = profile_key(
        profile,
        "ClientWindowHeight",
        "BottingPlayerClientWindowHeight",
        "BottingBotClientWindowHeight",
    );

    let window_size = if settings.get_bool("General", override_window_key) {
        let w = settings
            .get_int("General", window_width_key)
            .unwrap_or(1280);
        let h = settings
            .get_int("General", window_height_key)
            .unwrap_or(720);
        if w > 0 && h > 0 {
            Some((w as u32, h as u32))
        } else {
            None
        }
    } else {
        None
    };

    let optimization_profile = platform::windows::load_optimization_profile(settings, profile);
    let fast_flags = if optimization_profile.experimental.enable_fast_flags {
        match platform::windows::parse_allowlisted_fast_flags_json(
            &optimization_profile.experimental.fast_flags_json,
        ) {
            Ok(flags) => Some(flags),
            Err(err) => {
                eprintln!("Skipped allowlisted fast flags for {:?}: {}", profile, err);
                None
            }
        }
    } else {
        None
    };

    WindowsClientOverrides {
        max_fps,
        master_volume,
        graphics_level,
        window_size,
        fast_flags,
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn patch_client_settings_for_launch(
    settings: &SettingsStore,
    profile: LaunchClientProfile,
    base_path: Option<&str>,
) {
    use platform::windows;

    let effective_profile = effective_launch_profile(settings, profile);
    let custom_settings = custom_client_settings_path(settings, effective_profile);
    let custom_settings = custom_settings.trim();
    let mut custom_applied = false;

    // Legacy behavior: custom settings file overrides FPS unlock when valid.
    if !custom_settings.is_empty()
        && std::path::Path::new(custom_settings).exists()
        && windows::copy_custom_client_settings(base_path, custom_settings).is_ok()
    {
        custom_applied = true;
    }

    let mut overrides = windows_client_overrides(settings, !custom_applied, effective_profile);
    if custom_applied {
        overrides.fast_flags = None;
    }
    let _ = windows::apply_runtime_client_settings(
        base_path,
        overrides.max_fps,
        overrides.master_volume,
        overrides.graphics_level,
        overrides.window_size,
        overrides.fast_flags.as_ref(),
    );
}

#[cfg(target_os = "macos")]
fn fps_unlock_target(settings: &SettingsStore, profile: LaunchClientProfile) -> Option<u32> {
    let unlock_fps_key = profile_key(
        profile,
        "UnlockFPS",
        "BottingPlayerUnlockFPS",
        "BottingBotUnlockFPS",
    );
    let max_fps_key = profile_key(
        profile,
        "MaxFPSValue",
        "BottingPlayerMaxFPSValue",
        "BottingBotMaxFPSValue",
    );

    if !settings.get_bool("General", unlock_fps_key) {
        return None;
    }
    settings
        .get_int("General", max_fps_key)
        .filter(|fps| *fps > 0)
        .map(|fps| fps as u32)
}

#[cfg(target_os = "macos")]
pub(crate) fn patch_client_settings_for_launch(
    settings: &SettingsStore,
    profile: LaunchClientProfile,
    base_path: Option<&str>,
) {
    use platform::macos;

    let _ = base_path;
    let custom_settings = custom_client_settings_path(settings, profile);
    let custom_settings = custom_settings.trim();

    // Keep the same override precedence as Windows.
    if !custom_settings.is_empty()
        && std::path::Path::new(custom_settings).exists()
        && macos::copy_custom_client_settings(custom_settings).is_ok()
    {
        return;
    }

    if let Some(fps) = fps_unlock_target(settings, profile) {
        let _ = macos::apply_fps_unlock(fps);
    }
}

fn save_browser_tracker_id(
    state: &AccountStore,
    user_id: i64,
    browser_tracker_id: &str,
) -> Result<(), String> {
    let accounts = state.get_all()?;
    if let Some(mut account) = accounts.into_iter().find(|a| a.user_id == user_id) {
        account.browser_tracker_id = browser_tracker_id.to_string();
        state.update(account)?;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
pub(crate) fn get_or_create_browser_tracker_id(
    state: &AccountStore,
    user_id: i64,
) -> Result<String, String> {
    let accounts = state.get_all()?;
    if let Some(existing) = accounts
        .iter()
        .find(|a| a.user_id == user_id)
        .map(|a| a.browser_tracker_id.trim().to_string())
        .filter(|id| !id.is_empty())
    {
        return Ok(existing);
    }

    let generated = platform::windows::generate_browser_tracker_id();
    save_browser_tracker_id(state, user_id, &generated)?;
    Ok(generated)
}

#[cfg(target_os = "macos")]
fn get_or_create_browser_tracker_id(state: &AccountStore, user_id: i64) -> Result<String, String> {
    let accounts = state.get_all()?;
    if let Some(existing) = accounts
        .iter()
        .find(|a| a.user_id == user_id)
        .map(|a| a.browser_tracker_id.trim().to_string())
        .filter(|id| !id.is_empty())
    {
        return Ok(existing);
    }

    let generated = platform::macos::generate_browser_tracker_id();
    save_browser_tracker_id(state, user_id, &generated)?;
    Ok(generated)
}

#[cfg(target_os = "windows")]
pub(crate) async fn wait_for_new_roblox_pid(
    pids_before: &[u32],
    timeout: std::time::Duration,
) -> Option<u32> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let pids_after = platform::windows::get_roblox_pids();
        if let Some(pid) = pids_after
            .iter()
            .find(|p| !pids_before.contains(p))
            .copied()
        {
            return Some(pid);
        }
        if std::time::Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    }
}

#[cfg(target_os = "macos")]
async fn wait_for_new_roblox_pid(pids_before: &[u32], timeout: std::time::Duration) -> Option<u32> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let pids_after = platform::macos::get_roblox_pids();
        if let Some(pid) = pids_after
            .iter()
            .find(|p| !pids_before.contains(p))
            .copied()
        {
            return Some(pid);
        }
        if std::time::Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    }
}

#[derive(Debug, Clone, serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct BottingAccountStatusPayload {
    user_id: i64,
    is_player: bool,
    disconnected: bool,
    phase: String,
    retry_count: u32,
    next_restart_at_ms: Option<i64>,
    player_grace_until_ms: Option<i64>,
    last_error: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct BottingStatusPayload {
    active: bool,
    started_at_ms: Option<i64>,
    place_id: i64,
    job_id: String,
    launch_data: String,
    interval_minutes: i64,
    launch_delay_seconds: i64,
    player_grace_minutes: i64,
    player_user_ids: Vec<i64>,
    user_ids: Vec<i64>,
    accounts: Vec<BottingAccountStatusPayload>,
}

#[cfg(target_os = "windows")]
async fn minimize_new_roblox_windows(pids_before: Vec<u32>, timeout: std::time::Duration) {
    let deadline = std::time::Instant::now() + timeout;
    let mut minimized: HashSet<u32> = HashSet::new();
    loop {
        for pid in platform::windows::get_roblox_pids() {
            if pids_before.contains(&pid) || minimized.contains(&pid) {
                continue;
            }
            if let Some(hwnd) = platform::windows::find_main_window(pid) {
                let _ = platform::windows::minimize_window(hwnd);
                minimized.insert(pid);
            }
        }

        if std::time::Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    }
}

#[cfg(target_os = "windows")]
pub(crate) async fn apply_windows_post_launch_profile(
    app: Option<&tauri::AppHandle>,
    settings: &SettingsStore,
    profile: LaunchClientProfile,
    pid: u32,
) {
    let effective_profile = effective_launch_profile(settings, profile);
    let optimization_profile = platform::windows::load_optimization_profile(settings, effective_profile);
    let has_process_policy = optimization_profile.process.enabled;
    let has_job_limits = optimization_profile.experimental.enable_job_cpu_limit
        || optimization_profile.experimental.enable_job_memory_limit;
    if !has_process_policy && !has_job_limits {
        return;
    }
    if has_process_policy && optimization_profile.process.delay_ms > 0 {
        tokio::time::sleep(std::time::Duration::from_millis(
            optimization_profile.process.delay_ms,
        ))
        .await;
    }

    if let Err(err) = platform::windows::apply_optimization_to_pid(pid, &optimization_profile) {
        eprintln!("Failed to apply Windows optimization to pid {}: {}", pid, err);
        if let Some(app) = app {
            let _ = app.emit(
                "roblox-optimization-warning",
                serde_json::json!({
                    "pid": pid,
                    "message": err,
                }),
            );
        }
    }
}

#[cfg(target_os = "windows")]
async fn ensure_multi_roblox_enabled(auto_close_conflicts: bool) -> Result<(), String> {
    let enabled = platform::windows::enable_multi_roblox()?;
    if enabled {
        return Ok(());
    }

    let roblox_pids = platform::windows::get_roblox_pids();
    let legacy_pids = platform::windows::find_legacy_ram_pids();
    eprintln!(
        "[multi-roblox] mutex not acquired: {} roblox pid(s), {} legacy ram pid(s)",
        roblox_pids.len(),
        legacy_pids.len()
    );

    if !roblox_pids.is_empty() {
        if auto_close_conflicts {
            let killed = platform::windows::kill_all_roblox();
            eprintln!("[multi-roblox] auto-close killed {} roblox process(es)", killed);
            if killed > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(700)).await;
            }
            let _ = platform::windows::tracker().cleanup_dead_processes();
            let enabled_after = platform::windows::enable_multi_roblox()?;
            if enabled_after {
                return Ok(());
            }
        }
        return Err(
            "A Roblox client is already running. Close it or enable Auto-close Roblox for Multi-Roblox in settings.".into(),
        );
    }

    if !legacy_pids.is_empty() {
        return Err(
            "The legacy Roblox Account Manager is running and holds the Roblox singleton mutex. Close it before launching from this app.".into(),
        );
    }

    platform::windows::release_multi_roblox_handle();
    for attempt in 0..3u32 {
        tokio::time::sleep(std::time::Duration::from_millis(if attempt == 0 { 150 } else { 500 })).await;
        let enabled_retry = platform::windows::enable_multi_roblox()?;
        if enabled_retry {
            return Ok(());
        }
    }

    Err(
        "Another program is holding the Roblox singleton mutex. Start Roblox Account Manager before other Roblox tools, or close them and try again.".into(),
    )
}

#[cfg(target_os = "windows")]
#[derive(Debug, Clone)]
struct BottingConfig {
    user_ids: Vec<i64>,
    place_id: i64,
    job_id: String,
    launch_data: String,
    player_user_ids: HashSet<i64>,
    interval_minutes: u64,
    launch_delay_seconds: u64,
    retry_max: u32,
    retry_base_seconds: u64,
    player_grace_minutes: u64,
}

#[cfg(target_os = "windows")]
#[derive(Debug, Clone)]
struct BottingAccountRuntime {
    user_id: i64,
    is_player: bool,
    disconnected: bool,
    manual_restart_pending: bool,
    manual_restart_keep_schedule: bool,
    manual_restart_saved_next_restart_at_ms: Option<i64>,
    phase: &'static str,
    retry_count: u32,
    next_restart_at_ms: Option<i64>,
    player_grace_until_ms: Option<i64>,
    last_error: Option<String>,
}

#[cfg(target_os = "windows")]
#[derive(Clone)]
struct BottingSession {
    id: u64,
    stop_flag: Arc<AtomicBool>,
    stopped_notify: Arc<tokio::sync::Notify>,
    started_at_ms: i64,
    config: Arc<Mutex<BottingConfig>>,
    accounts: Arc<Mutex<HashMap<i64, BottingAccountRuntime>>>,
}

#[cfg(target_os = "windows")]
struct BottingManager {
    session: Mutex<Option<BottingSession>>,
    next_id: AtomicU64,
}

#[cfg(target_os = "windows")]
impl BottingManager {
    fn new() -> Self {
        Self {
            session: Mutex::new(None),
            next_id: AtomicU64::new(1),
        }
    }

    fn next_session_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    fn get_session(&self) -> Option<BottingSession> {
        self.session.lock().ok().and_then(|s| s.as_ref().cloned())
    }

    fn replace_session(&self, session: Option<BottingSession>) {
        if let Ok(mut guard) = self.session.lock() {
            *guard = session;
        }
    }
}

#[cfg(target_os = "windows")]
static BOTTING_MANAGER: LazyLock<BottingManager> = LazyLock::new(BottingManager::new);

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[derive(Debug, Clone, Default)]
struct ResolvedLaunchJob {
    job_id: String,
    join_vip: bool,
    link_code: String,
}

fn decode_url_component(value: &str) -> String {
    urlencoding::decode(value)
        .map(|v| v.into_owned())
        .unwrap_or_else(|_| value.to_string())
}

fn extract_query_param_value(input: &str, key: &str) -> Option<String> {
    for part in input.split(['?', '&']) {
        let pair = part.split('#').next().unwrap_or(part);
        let Some((k, v)) = pair.split_once('=') else {
            continue;
        };
        if !k.eq_ignore_ascii_case(key) {
            continue;
        }

        let decoded = decode_url_component(v.trim());
        let value = decoded.trim();
        if value.is_empty()
            || value.eq_ignore_ascii_case("null")
            || value.eq_ignore_ascii_case("undefined")
        {
            continue;
        }

        return Some(value.to_string());
    }
    None
}

fn extract_query_param_value_recursive(input: &str, key: &str) -> Option<String> {
    if let Some(value) = extract_query_param_value(input, key) {
        return Some(value);
    }

    let decoded = decode_url_component(input);
    if decoded != input {
        return extract_query_param_value(&decoded, key);
    }

    None
}

fn strip_ascii_prefix<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    let head = value.get(..prefix.len())?;
    if !head.eq_ignore_ascii_case(prefix) {
        return None;
    }
    value.get(prefix.len()..)
}

fn looks_like_share_link(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains("/share?")
        || lower.contains("/share-links")
        || lower.contains("navigation/share_links")
        || lower.contains("type=server")
        || lower.contains("pid=server")
}

fn extract_private_server_link_code(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Some(rest) = strip_ascii_prefix(trimmed, "vip:") {
        let decoded = decode_url_component(rest.trim());
        let code = decoded.trim();
        if !code.is_empty() {
            return Some(code.to_string());
        }
    }

    if let Some(code) = extract_query_param_value_recursive(trimmed, "privateServerLinkCode") {
        return Some(code);
    }
    if let Some(code) = extract_query_param_value_recursive(trimmed, "linkCode") {
        return Some(code);
    }

    let starts_with_code = trimmed
        .get(..5)
        .map(|head| head.eq_ignore_ascii_case("code="))
        .unwrap_or(false);
    if looks_like_share_link(trimmed) || starts_with_code {
        if let Some(code) = extract_query_param_value_recursive(trimmed, "code") {
            return Some(code);
        }
    }

    None
}

fn resolve_launch_job(
    raw_job_id: &str,
    explicit_join_vip: bool,
    explicit_link_code: &str,
) -> ResolvedLaunchJob {
    let trimmed_job = raw_job_id.trim();
    let mut job_id = trimmed_job.to_string();

    let mut link_code = extract_private_server_link_code(explicit_link_code).unwrap_or_else(|| {
        decode_url_component(explicit_link_code.trim())
            .trim()
            .to_string()
    });

    let mut join_vip = explicit_join_vip;
    if let Some(rest) = strip_ascii_prefix(trimmed_job, "vip:") {
        join_vip = true;
        job_id = rest.trim().to_string();
    }

    if link_code.is_empty() {
        if let Some(code) = extract_private_server_link_code(trimmed_job) {
            link_code = code;
        }
    }

    if join_vip && link_code.is_empty() {
        if job_id.trim().is_empty() {
            join_vip = false;
        } else {
            link_code = decode_url_component(job_id.trim()).trim().to_string();
        }
    }

    ResolvedLaunchJob {
        job_id,
        join_vip,
        link_code,
    }
}

fn looks_like_access_code(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return false;
    }

    let parts: Vec<&str> = trimmed.split('-').collect();
    if parts.len() != 5 {
        return false;
    }

    parts
        .iter()
        .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
}

fn looks_like_share_link_code(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.len() == 32
        && trimmed.chars().any(|c| c.is_ascii_alphabetic())
        && trimmed.chars().all(|c| c.is_ascii_hexdigit())
}

fn extract_place_id_from_url(value: &str) -> Option<i64> {
    let lower = value.to_ascii_lowercase();
    let marker = "/games/";
    let start = lower.find(marker)? + marker.len();
    let rest = value.get(start..)?;
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse::<i64>().ok().filter(|id| *id > 0)
}

#[derive(Debug, Clone)]
struct ResolvedPrivateJoin {
    place_id: i64,
    link_code: String,
    access_code: String,
    use_private_join: bool,
}

async fn resolve_private_join(
    cookie: &str,
    place_id: i64,
    launch: &ResolvedLaunchJob,
) -> Result<ResolvedPrivateJoin, String> {
    let mut resolved_place_id = place_id;
    let mut resolved_link_code = launch.link_code.trim().to_string();

    if !resolved_link_code.is_empty() {
        if let Some(url_place_id) = extract_place_id_from_url(&launch.job_id) {
            resolved_place_id = url_place_id;
        }
    }

    if !resolved_link_code.is_empty()
        && (looks_like_share_link(&launch.job_id)
            || looks_like_share_link_code(&resolved_link_code))
    {
        let (maybe_place_id, resolved_code) =
            api::roblox::resolve_share_server_link(cookie, &resolved_link_code).await?;
        if let Some(pid) = maybe_place_id {
            resolved_place_id = pid;
        }
        if !resolved_code.trim().is_empty() {
            resolved_link_code = resolved_code.trim().to_string();
        }
    }

    let mut access_code = String::new();
    if looks_like_access_code(&resolved_link_code) {
        access_code = resolved_link_code.clone();
        resolved_link_code.clear();
    }

    let use_private_join =
        launch.join_vip || !resolved_link_code.is_empty() || !access_code.is_empty();

    Ok(ResolvedPrivateJoin {
        place_id: resolved_place_id,
        link_code: resolved_link_code,
        access_code,
        use_private_join,
    })
}

#[cfg(target_os = "windows")]
fn backoff_delay_seconds(base: u64, retry_count: u32, retry_max: u32) -> u64 {
    let exp = retry_count.saturating_sub(1).min(retry_max.max(1));
    let scaled = base.saturating_mul(1_u64 << exp.min(12));
    scaled.clamp(5, 300)
}

#[cfg(target_os = "windows")]
async fn wait_for_launch_slot(
    last_launch_at: &mut Option<std::time::Instant>,
    launch_delay_seconds: u64,
) {
    if let Some(last) = *last_launch_at {
        let required_gap = std::time::Duration::from_secs(launch_delay_seconds);
        let elapsed = last.elapsed();
        if elapsed < required_gap {
            tokio::time::sleep(required_gap - elapsed).await;
        }
    }
    *last_launch_at = Some(std::time::Instant::now());
}

#[cfg(target_os = "windows")]
fn is_429_related_error(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("429")
        || lower.contains("too many requests")
        || lower.contains("authentifizierung fehlgeschlagen")
        || lower.contains("authentication failed")
}

#[cfg(target_os = "windows")]
fn title_looks_auth_failure(title: &str) -> bool {
    let t = title.to_lowercase();
    t.contains("authentifizierung fehlgeschlagen")
        || t.contains("authentication failed")
        || t.contains("fehlercode: 429")
        || t.contains("error code: 429")
}

#[cfg(target_os = "windows")]
async fn detect_auth_failure_window(pid: u32) -> bool {
    for _ in 0..20 {
        if let Some(hwnd) = platform::windows::find_main_window(pid) {
            let title = platform::windows::get_window_title(hwnd);
            if !title.is_empty() && title_looks_auth_failure(&title) {
                return true;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    }
    false
}

#[cfg(target_os = "windows")]
fn botting_status_from_session(session: &BottingSession) -> BottingStatusPayload {
    let config = match session.config.lock() {
        Ok(c) => c.clone(),
        Err(_) => {
            return BottingStatusPayload {
                active: false,
                ..BottingStatusPayload::default()
            }
        }
    };
    let mut accounts: Vec<BottingAccountStatusPayload> = match session.accounts.lock() {
        Ok(map) => map
            .values()
            .map(|a| BottingAccountStatusPayload {
                user_id: a.user_id,
                is_player: a.is_player,
                disconnected: a.disconnected,
                phase: a.phase.to_string(),
                retry_count: a.retry_count,
                next_restart_at_ms: a.next_restart_at_ms,
                player_grace_until_ms: a.player_grace_until_ms,
                last_error: a.last_error.clone(),
            })
            .collect(),
        Err(_) => Vec::new(),
    };
    accounts.sort_by_key(|a| a.user_id);
    let mut player_user_ids: Vec<i64> = config.player_user_ids.iter().copied().collect();
    player_user_ids.sort();
    BottingStatusPayload {
        active: !session.stop_flag.load(Ordering::Relaxed),
        started_at_ms: Some(session.started_at_ms),
        place_id: config.place_id,
        job_id: config.job_id,
        launch_data: config.launch_data,
        interval_minutes: config.interval_minutes as i64,
        launch_delay_seconds: config.launch_delay_seconds as i64,
        player_grace_minutes: config.player_grace_minutes as i64,
        player_user_ids,
        user_ids: config.user_ids,
        accounts,
    }
}

#[cfg(target_os = "windows")]
fn current_botting_status() -> BottingStatusPayload {
    if let Some(session) = BOTTING_MANAGER.get_session() {
        botting_status_from_session(&session)
    } else {
        BottingStatusPayload::default()
    }
}

#[cfg(target_os = "windows")]
fn emit_botting_status(app: &tauri::AppHandle) {
    let _ = app.emit("botting-status", current_botting_status());
}
