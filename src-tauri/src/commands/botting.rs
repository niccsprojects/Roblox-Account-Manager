async fn launch_account_for_cycle(
    app: &tauri::AppHandle,
    user_id: i64,
    place_id: i64,
    job_id: &str,
    launch_data: &str,
    is_player: bool,
) -> Result<(), String> {
    use platform::windows;

    let launch_profile = {
        let settings = app.state::<SettingsStore>();
        if botting_uses_shared_client_profile(&settings) {
            LaunchClientProfile::Normal
        } else if is_player {
            LaunchClientProfile::BottingPlayer
        } else {
            LaunchClientProfile::BottingBot
        }
    };

    let (
        is_teleport,
        use_old_join,
        auto_close_last_process,
        multi_rbx,
        auto_close_multi_conflicts,
        start_minimized,
    ) = {
        let settings = app.state::<SettingsStore>();
        (
            settings.get_bool("Developer", "IsTeleport"),
            settings.get_bool("Developer", "UseOldJoin"),
            settings.get_bool("General", "AutoCloseLastProcess"),
            settings.get_bool("General", "EnableMultiRbx"),
            settings.get_bool("General", "AutoCloseRobloxForMultiRbx"),
            start_minimized_for_profile(&settings, launch_profile),
        )
    };

    let resolved_launch = resolve_launch_job(job_id, false, "");

    if multi_rbx {
        ensure_multi_roblox_enabled(auto_close_multi_conflicts)?;
    } else {
        let _ = windows::disable_multi_roblox();
    }

    {
        let settings = app.state::<SettingsStore>();
        patch_client_settings_for_launch(&settings, launch_profile);
    }

    let tracker = windows::tracker();
    if auto_close_last_process && tracker.get_pid(user_id).is_some() {
        let closed = tracker.kill_for_user_graceful(user_id, 4500);
        if !closed {
            return Err("Previous Roblox instance did not close before relaunch".into());
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }

    let browser_tracker_id = {
        let state = app.state::<AccountStore>();
        get_or_create_browser_tracker_id(&state, user_id)?
    };
    let mut ticket: Option<String> = None;
    let mut last_ticket_err = String::new();
    for attempt in 0..5_u64 {
        let state = app.state::<AccountStore>();
        match run_with_session_retry(state.inner(), user_id, |cookie| async move {
            api::auth::get_auth_ticket(&cookie).await
        })
        .await
        {
            Ok(value) => {
                ticket = Some(value);
                break;
            }
            Err(err) => {
                last_ticket_err = err.clone();
                if !is_429_related_error(&err) || attempt >= 4 {
                    break;
                }
                let delay = 4_u64.saturating_mul(attempt + 1);
                tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
            }
        }
    }
    let ticket = ticket
        .ok_or_else(|| format!("Failed to get auth ticket for launch: {}", last_ticket_err))?;
    let private_join = {
        let state = app.state::<AccountStore>();
        run_with_session_retry(state.inner(), user_id, |cookie| {
            let resolved_launch = resolved_launch.clone();
            async move { resolve_private_join(&cookie, place_id, &resolved_launch).await }
        })
        .await?
    };

    let pids_before = windows::get_roblox_pids();

    let launch_result = if use_old_join {
        windows::launch_old_join(
            &ticket,
            private_join.place_id,
            &resolved_launch.job_id,
            launch_data,
            false,
            private_join.use_private_join,
            &private_join.access_code,
            &private_join.link_code,
            is_teleport,
        )
    } else {
        let url = windows::build_launch_url(
            &ticket,
            private_join.place_id,
            &resolved_launch.job_id,
            &browser_tracker_id,
            launch_data,
            false,
            private_join.use_private_join,
            &private_join.access_code,
            &private_join.link_code,
            is_teleport,
        );
        windows::launch_url(&url)
    };

    if let Err(e) = launch_result {
        return Err(format!("Launch failed: {}", e));
    }

    let Some(pid) = wait_for_new_roblox_pid(&pids_before, std::time::Duration::from_secs(12)).await
    else {
        return Err("Timed out waiting for Roblox process after launch".into());
    };

    tracker.track(user_id, pid, browser_tracker_id);
    {
        let settings_state = app.state::<SettingsStore>();
        apply_windows_post_launch_profile(Some(app), settings_state.inner(), launch_profile, pid)
            .await;
    }
    if detect_auth_failure_window(pid).await {
        let _ = tracker.kill_for_user(user_id);
        return Err("Roblox authentication failed (429) while joining".into());
    }

    if start_minimized {
        let baseline = pids_before.clone();
        tokio::spawn(async move {
            minimize_new_roblox_windows(baseline, std::time::Duration::from_secs(14)).await;
        });
    }

    Ok(())
}

#[cfg(target_os = "windows")]
async fn run_botting_session(
    app: tauri::AppHandle,
    session_id: u64,
    stop_flag: Arc<AtomicBool>,
    stopped_notify: Arc<tokio::sync::Notify>,
    config: Arc<Mutex<BottingConfig>>,
    accounts: Arc<Mutex<HashMap<i64, BottingAccountRuntime>>>,
) {
    let initial_user_ids = config
        .lock()
        .map(|c| c.user_ids.clone())
        .unwrap_or_else(|_| Vec::new());
    let mut last_launch_at: Option<std::time::Instant> = None;
    let mut auth429_cooldowns: HashMap<i64, std::time::Instant> = HashMap::new();

    for uid in &initial_user_ids {
        if stop_flag.load(Ordering::Relaxed) {
            break;
        }

        let mut skip_launch = false;
        if let Ok(mut map) = accounts.lock() {
            if let Some(entry) = map.get_mut(uid) {
                if entry.disconnected {
                    entry.phase = if platform::windows::tracker().get_pid(*uid).is_some() {
                        "disconnected-running"
                    } else {
                        "disconnected"
                    };
                    entry.next_restart_at_ms = None;
                    entry.player_grace_until_ms = None;
                    skip_launch = true;
                } else {
                    entry.phase = "launching";
                    entry.last_error = None;
                }
            }
        }
        emit_botting_status(&app);
        if skip_launch {
            continue;
        }

        let cfg = match config.lock() {
            Ok(c) => c.clone(),
            Err(_) => break,
        };
        if let Some(until) = auth429_cooldowns.get(uid).copied() {
            let now_instant = std::time::Instant::now();
            if until > now_instant {
                let remaining_ms = (until - now_instant).as_millis().min(i64::MAX as u128) as i64;
                if let Ok(mut map) = accounts.lock() {
                    if let Some(entry) = map.get_mut(uid) {
                        entry.phase = "retry-backoff";
                        entry.next_restart_at_ms = Some(now_ms().saturating_add(remaining_ms));
                    }
                }
                emit_botting_status(&app);
                continue;
            }
            auth429_cooldowns.remove(uid);
        }
        wait_for_launch_slot(&mut last_launch_at, cfg.launch_delay_seconds).await;
        if stop_flag.load(Ordering::Relaxed) {
            break;
        }

        let is_player = cfg.player_user_ids.contains(uid);
        let launch_result = launch_account_for_cycle(
            &app,
            *uid,
            cfg.place_id,
            &cfg.job_id,
            &cfg.launch_data,
            is_player,
        )
        .await;
        let now = now_ms();
        let launch_ok = launch_result.is_ok();
        let launch_error = launch_result.err();

        if let Ok(mut map) = accounts.lock() {
            if let Some(entry) = map.get_mut(uid) {
                if launch_ok {
                    auth429_cooldowns.remove(uid);
                    entry.retry_count = 0;
                    entry.last_error = None;
                    if entry.is_player {
                        entry.phase = "running-player";
                        entry.next_restart_at_ms = None;
                        entry.player_grace_until_ms = None;
                    } else {
                        entry.phase = "running";
                        entry.next_restart_at_ms =
                            Some(now + (cfg.interval_minutes as i64 * 60_000));
                    }
                } else {
                    entry.retry_count = entry.retry_count.saturating_add(1);
                    let mut delay = backoff_delay_seconds(
                        cfg.retry_base_seconds,
                        entry.retry_count,
                        cfg.retry_max,
                    ) as i64;
                    let is_429 = launch_error
                        .as_ref()
                        .map(|e| is_429_related_error(e))
                        .unwrap_or(false);
                    if is_429 {
                        delay = delay
                            .max(45)
                            .max((cfg.launch_delay_seconds as i64).saturating_mul(2));
                        auth429_cooldowns.insert(
                            *uid,
                            std::time::Instant::now()
                                + std::time::Duration::from_secs(delay as u64),
                        );
                    } else {
                        auth429_cooldowns.remove(uid);
                    }
                    entry.phase = "retry-backoff";
                    entry.last_error = launch_error.clone();
                    entry.next_restart_at_ms = Some(now + delay * 1000);
                }
            }
        }
        let _ = app.emit(
            "botting-account-cycle",
            serde_json::json!({
                "userId": uid,
                "ok": launch_ok,
                "error": launch_error,
            }),
        );
        emit_botting_status(&app);
    }

    loop {
        if stop_flag.load(Ordering::Relaxed) {
            break;
        }

        let cfg = match config.lock() {
            Ok(c) => c.clone(),
            Err(_) => break,
        };
        let now = now_ms();
        let tracker = platform::windows::tracker();
        let user_ids = cfg.user_ids.clone();

        for uid in user_ids {
            if stop_flag.load(Ordering::Relaxed) {
                break;
            }

            let mut should_launch = false;
            let mut skip_for_player = false;
            if let Ok(mut map) = accounts.lock() {
                if let Some(entry) = map.get_mut(&uid) {
                    if entry.disconnected {
                        entry.phase = if tracker.get_pid(uid).is_some() {
                            "disconnected-running"
                        } else {
                            "disconnected"
                        };
                        entry.manual_restart_pending = false;
                        entry.manual_restart_keep_schedule = false;
                        entry.manual_restart_saved_next_restart_at_ms = None;
                        entry.next_restart_at_ms = None;
                        entry.player_grace_until_ms = None;
                        skip_for_player = true;
                    } else if entry.manual_restart_pending {
                        let due = entry.next_restart_at_ms.unwrap_or(now);
                        if now >= due {
                            entry.phase = "restarting";
                            entry.last_error = None;
                            should_launch = true;
                        }
                    } else if entry.is_player {
                        if tracker.get_pid(uid).is_some() {
                            entry.phase = "running-player";
                        } else if entry.phase != "queued-player" && entry.phase != "launching" {
                            entry.phase = "queued-player";
                        }
                        entry.next_restart_at_ms = None;
                        skip_for_player = true;
                    } else if let Some(next_ms) = entry.next_restart_at_ms {
                        if now >= next_ms {
                            entry.phase = "restarting";
                            entry.last_error = None;
                            should_launch = true;
                        }
                    } else {
                        entry.next_restart_at_ms =
                            Some(now + (cfg.interval_minutes as i64 * 60_000));
                    }
                }
            }
            if skip_for_player || !should_launch {
                continue;
            }
            emit_botting_status(&app);

            if let Some(until) = auth429_cooldowns.get(&uid).copied() {
                let now_instant = std::time::Instant::now();
                if until > now_instant {
                    let remaining_ms =
                        (until - now_instant).as_millis().min(i64::MAX as u128) as i64;
                    if let Ok(mut map) = accounts.lock() {
                        if let Some(entry) = map.get_mut(&uid) {
                            entry.phase = "retry-backoff";
                            entry.next_restart_at_ms = Some(now_ms().saturating_add(remaining_ms));
                        }
                    }
                    emit_botting_status(&app);
                    continue;
                }
                auth429_cooldowns.remove(&uid);
            }
            wait_for_launch_slot(&mut last_launch_at, cfg.launch_delay_seconds).await;
            if stop_flag.load(Ordering::Relaxed) {
                break;
            }
            let closed = tracker.kill_for_user_graceful(uid, 4500);
            if !closed {
                let pid_hint = tracker
                    .get_pid(uid)
                    .map(|pid| format!(" (pid {})", pid))
                    .unwrap_or_default();
                if let Ok(mut map) = accounts.lock() {
                    if let Some(entry) = map.get_mut(&uid) {
                        entry.retry_count = entry.retry_count.saturating_add(1);
                        let retry_delay_seconds = backoff_delay_seconds(
                            cfg.retry_base_seconds,
                            entry.retry_count,
                            cfg.retry_max,
                        )
                        .max(cfg.launch_delay_seconds.saturating_mul(2))
                        .clamp(6, 300);
                        entry.phase = "retry-backoff";
                        entry.last_error = Some(format!(
                            "Previous Roblox instance did not close before relaunch{}",
                            pid_hint
                        ));
                        entry.next_restart_at_ms = Some(
                            now_ms()
                                .saturating_add((retry_delay_seconds as i64).saturating_mul(1000)),
                        );
                    }
                }
                emit_botting_status(&app);
                continue;
            }
            tokio::time::sleep(std::time::Duration::from_millis(450)).await;

            let is_player = cfg.player_user_ids.contains(&uid);
            let launch_result = launch_account_for_cycle(
                &app,
                uid,
                cfg.place_id,
                &cfg.job_id,
                &cfg.launch_data,
                is_player,
            )
            .await;
            let now_after = now_ms();
            let launch_ok = launch_result.is_ok();
            let launch_error = launch_result.err();

            if let Ok(mut map) = accounts.lock() {
                if let Some(entry) = map.get_mut(&uid) {
                    let restart_keep_schedule = entry.manual_restart_keep_schedule;
                    let saved_restart_due = entry.manual_restart_saved_next_restart_at_ms;
                    if launch_ok {
                        auth429_cooldowns.remove(&uid);
                        entry.retry_count = 0;
                        entry.last_error = None;
                        entry.player_grace_until_ms = None;
                        if is_player {
                            entry.is_player = true;
                            entry.disconnected = false;
                            entry.phase = "running-player";
                            entry.next_restart_at_ms = None;
                        } else {
                            entry.is_player = false;
                            entry.disconnected = false;
                            entry.phase = "running";
                            let default_due = now_after + (cfg.interval_minutes as i64 * 60_000);
                            entry.next_restart_at_ms = Some(if restart_keep_schedule {
                                saved_restart_due.unwrap_or(default_due)
                            } else {
                                default_due
                            });
                        }
                        entry.manual_restart_pending = false;
                        entry.manual_restart_keep_schedule = false;
                        entry.manual_restart_saved_next_restart_at_ms = None;
                    } else {
                        entry.retry_count = entry.retry_count.saturating_add(1);
                        let mut delay = backoff_delay_seconds(
                            cfg.retry_base_seconds,
                            entry.retry_count,
                            cfg.retry_max,
                        ) as i64;
                        let is_429 = launch_error
                            .as_ref()
                            .map(|e| is_429_related_error(e))
                            .unwrap_or(false);
                        if is_429 {
                            delay = delay
                                .max(45)
                                .max((cfg.launch_delay_seconds as i64).saturating_mul(2));
                            auth429_cooldowns.insert(
                                uid,
                                std::time::Instant::now()
                                    + std::time::Duration::from_secs(delay as u64),
                            );
                        } else {
                            auth429_cooldowns.remove(&uid);
                        }
                        entry.phase = "retry-backoff";
                        entry.last_error = launch_error.clone();
                        entry.next_restart_at_ms = Some(now_after + delay * 1000);
                        entry.is_player = is_player;
                    }
                }
            }

            let _ = app.emit(
                "botting-account-cycle",
                serde_json::json!({
                    "userId": uid,
                    "ok": launch_ok,
                    "error": launch_error,
                }),
            );
            emit_botting_status(&app);
        }

        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }

    let should_clear = BOTTING_MANAGER
        .get_session()
        .map(|s| s.id == session_id)
        .unwrap_or(false);
    if should_clear {
        BOTTING_MANAGER.replace_session(None);
    }
    stopped_notify.notify_waiters();
    let _ = app.emit("botting-stopped", serde_json::json!({}));
    emit_botting_status(&app);
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn start_botting_mode(
    app: tauri::AppHandle,
    _state: tauri::State<'_, AccountStore>,
    settings: tauri::State<'_, SettingsStore>,
    user_ids: Vec<i64>,
    place_id: i64,
    job_id: String,
    launch_data: String,
    player_user_ids: Vec<i64>,
    interval_minutes: i64,
    launch_delay_seconds: i64,
    player_grace_minutes: i64,
) -> Result<BottingStatusPayload, String> {
    if user_ids.len() < 2 {
        return Err("Select at least two accounts for Botting Mode".into());
    }
    if place_id <= 0 {
        return Err("Place ID must be greater than 0".into());
    }
    if !settings.get_bool("General", "EnableMultiRbx") {
        return Err("Botting Mode currently requires Multi Roblox to be enabled".into());
    }

    let mut dedup = Vec::new();
    let mut seen = HashSet::new();
    for id in user_ids {
        if seen.insert(id) {
            dedup.push(id);
        }
    }
    if dedup.len() < 2 {
        return Err("Select at least two unique accounts for Botting Mode".into());
    }

    let mut player_set = HashSet::new();
    for uid in player_user_ids {
        if !dedup.contains(&uid) {
            return Err("Player Account must be one of the selected accounts".into());
        }
        player_set.insert(uid);
    }

    if let Some(existing) = BOTTING_MANAGER.get_session() {
        existing.stop_flag.store(true, Ordering::Relaxed);
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            existing.stopped_notify.notified(),
        )
        .await;
        let should_clear = BOTTING_MANAGER
            .get_session()
            .map(|s| s.id == existing.id)
            .unwrap_or(false);
        if should_clear {
            BOTTING_MANAGER.replace_session(None);
        }
    }

    let retry_max = settings
        .get_int("General", "BottingRetryMax")
        .unwrap_or(6)
        .clamp(1, 20) as u32;
    let retry_base_seconds = settings
        .get_int("General", "BottingRetryBaseSeconds")
        .unwrap_or(8)
        .clamp(5, 120) as u64;
    let default_player_grace_minutes = settings
        .get_int("General", "BottingPlayerGraceMinutes")
        .unwrap_or(15)
        .clamp(1, 90);

    let interval_minutes = interval_minutes.clamp(10, 120) as u64;
    let launch_delay_seconds = launch_delay_seconds.clamp(5, 120) as u64;
    let player_grace_minutes = if player_grace_minutes <= 0 {
        default_player_grace_minutes as u64
    } else {
        player_grace_minutes.clamp(1, 90) as u64
    };

    let cfg = BottingConfig {
        user_ids: dedup.clone(),
        place_id,
        job_id,
        launch_data,
        player_user_ids: player_set,
        interval_minutes,
        launch_delay_seconds,
        retry_max,
        retry_base_seconds,
        player_grace_minutes,
    };

    let mut runtime_map = HashMap::new();
    for uid in &dedup {
        let is_player = cfg.player_user_ids.contains(uid);
        runtime_map.insert(
            *uid,
            BottingAccountRuntime {
                user_id: *uid,
                is_player,
                disconnected: false,
                manual_restart_pending: false,
                manual_restart_keep_schedule: false,
                manual_restart_saved_next_restart_at_ms: None,
                phase: if is_player { "queued-player" } else { "queued" },
                retry_count: 0,
                next_restart_at_ms: None,
                player_grace_until_ms: None,
                last_error: None,
            },
        );
    }

    let session_id = BOTTING_MANAGER.next_session_id();
    let stop_flag = Arc::new(AtomicBool::new(false));
    let stopped_notify = Arc::new(tokio::sync::Notify::new());
    let session = BottingSession {
        id: session_id,
        stop_flag: stop_flag.clone(),
        stopped_notify: stopped_notify.clone(),
        started_at_ms: now_ms(),
        config: Arc::new(Mutex::new(cfg)),
        accounts: Arc::new(Mutex::new(runtime_map)),
    };

    BOTTING_MANAGER.replace_session(Some(session.clone()));
    emit_botting_status(&app);

    tokio::spawn(run_botting_session(
        app.clone(),
        session_id,
        stop_flag,
        stopped_notify,
        session.config.clone(),
        session.accounts.clone(),
    ));

    Ok(current_botting_status())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
async fn start_botting_mode(
    _app: tauri::AppHandle,
    _state: tauri::State<'_, AccountStore>,
    _settings: tauri::State<'_, SettingsStore>,
    _user_ids: Vec<i64>,
    _place_id: i64,
    _job_id: String,
    _launch_data: String,
    _player_user_ids: Vec<i64>,
    _interval_minutes: i64,
    _launch_delay_seconds: i64,
    _player_grace_minutes: i64,
) -> Result<BottingStatusPayload, String> {
    Err("Botting Mode is only supported on Windows".into())
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn stop_botting_mode(app: tauri::AppHandle, close_bot_accounts: bool) -> Result<(), String> {
    let session = BOTTING_MANAGER.get_session();
    if let Some(session) = session {
        session.stop_flag.store(true, Ordering::Relaxed);
        if close_bot_accounts {
            let cfg = session.config.lock().map_err(|e| e.to_string())?.clone();
            let tracker = platform::windows::tracker();
            let keep_player_pids: Vec<u32> = cfg
                .player_user_ids
                .iter()
                .filter_map(|uid| tracker.get_pid(*uid))
                .collect();

            let _ = platform::windows::kill_all_roblox_except(&keep_player_pids);
            let _ = tracker.cleanup_dead_processes();
        }
        BOTTING_MANAGER.replace_session(None);
    }
    let _ = app.emit("botting-stopped", serde_json::json!({}));
    emit_botting_status(&app);
    Ok(())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn stop_botting_mode(_app: tauri::AppHandle, _close_bot_accounts: bool) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn get_botting_mode_status() -> Result<BottingStatusPayload, String> {
    Ok(current_botting_status())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn get_botting_mode_status() -> Result<BottingStatusPayload, String> {
    Ok(BottingStatusPayload::default())
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn add_botting_accounts(
    app: tauri::AppHandle,
    state: tauri::State<'_, AccountStore>,
    user_ids: Vec<i64>,
) -> Result<BottingStatusPayload, String> {
    let Some(session) = BOTTING_MANAGER.get_session() else {
        return Err("Botting Mode is not running".into());
    };
    if user_ids.is_empty() {
        return Err("Select at least one account to add".into());
    }

    let all_accounts = state.get_all()?;
    let known_ids: HashSet<i64> = all_accounts.iter().map(|a| a.user_id).collect();

    let mut requested = Vec::new();
    let mut seen = HashSet::new();
    for uid in user_ids {
        if seen.insert(uid) {
            requested.push(uid);
        }
    }

    for uid in &requested {
        if !known_ids.contains(uid) {
            return Err(format!("Account {} not found", uid));
        }
    }

    let tracker = platform::windows::tracker();
    let now = now_ms();

    let mut cfg = session.config.lock().map_err(|e| e.to_string())?;
    let launch_delay_ms = (cfg.launch_delay_seconds as i64).saturating_mul(1000);
    let interval_ms = (cfg.interval_minutes as i64).saturating_mul(60_000);
    let mut runtime_map = session.accounts.lock().map_err(|e| e.to_string())?;

    let mut to_add = Vec::new();
    for uid in requested {
        if cfg.user_ids.contains(&uid) || runtime_map.contains_key(&uid) {
            continue;
        }
        to_add.push(uid);
    }

    if to_add.is_empty() {
        return Err("Selected accounts are already in Botting Mode".into());
    }

    for uid in to_add {
        cfg.user_ids.push(uid);

        let has_running_client = tracker.get_pid(uid).is_some();
        let next_restart_at_ms = if has_running_client {
            Some(now.saturating_add(interval_ms))
        } else {
            Some(now.saturating_add(launch_delay_ms))
        };
        let phase = if has_running_client {
            "running"
        } else {
            "queued"
        };

        runtime_map.insert(
            uid,
            BottingAccountRuntime {
                user_id: uid,
                is_player: false,
                disconnected: false,
                manual_restart_pending: false,
                manual_restart_keep_schedule: false,
                manual_restart_saved_next_restart_at_ms: None,
                phase,
                retry_count: 0,
                next_restart_at_ms,
                player_grace_until_ms: None,
                last_error: None,
            },
        );
    }
    drop(runtime_map);
    drop(cfg);

    emit_botting_status(&app);
    Ok(current_botting_status())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn add_botting_accounts(
    _app: tauri::AppHandle,
    _state: tauri::State<'_, AccountStore>,
    _user_ids: Vec<i64>,
) -> Result<BottingStatusPayload, String> {
    Err("Botting Mode is only supported on Windows".into())
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn set_botting_player_accounts(
    app: tauri::AppHandle,
    player_user_ids: Vec<i64>,
) -> Result<BottingStatusPayload, String> {
    let Some(session) = BOTTING_MANAGER.get_session() else {
        return Err("Botting Mode is not running".into());
    };

    let mut cfg = session.config.lock().map_err(|e| e.to_string())?;
    let mut next_set = HashSet::new();
    for uid in player_user_ids {
        if !cfg.user_ids.contains(&uid) {
            return Err("Player Account must be one of the botting accounts".into());
        }
        next_set.insert(uid);
    }

    let old_set = cfg.player_user_ids.clone();
    cfg.player_user_ids = next_set.clone();
    let grace_ms = cfg.player_grace_minutes as i64 * 60_000;
    drop(cfg);

    let tracker = platform::windows::tracker();
    let mut accounts = session.accounts.lock().map_err(|e| e.to_string())?;
    for entry in accounts.values_mut() {
        let was_player = old_set.contains(&entry.user_id);
        let is_player = next_set.contains(&entry.user_id);

        if is_player {
            entry.is_player = true;
            entry.disconnected = false;
            entry.manual_restart_pending = false;
            entry.manual_restart_keep_schedule = false;
            entry.manual_restart_saved_next_restart_at_ms = None;
            entry.retry_count = 0;
            entry.last_error = None;
            entry.player_grace_until_ms = None;
            entry.next_restart_at_ms = None;
            entry.phase = if tracker.get_pid(entry.user_id).is_some() {
                "running-player"
            } else {
                "queued-player"
            };
            continue;
        }

        if was_player && !is_player {
            entry.is_player = false;
            entry.manual_restart_pending = false;
            entry.manual_restart_keep_schedule = false;
            entry.manual_restart_saved_next_restart_at_ms = None;
            entry.retry_count = 0;
            entry.last_error = None;
            if tracker.get_pid(entry.user_id).is_some() {
                let due = now_ms() + grace_ms;
                entry.phase = "player-grace";
                entry.player_grace_until_ms = Some(due);
                entry.next_restart_at_ms = Some(due);
            } else {
                entry.phase = "queued";
                entry.player_grace_until_ms = None;
                entry.next_restart_at_ms = Some(now_ms());
            }
        }
    }
    drop(accounts);

    emit_botting_status(&app);
    Ok(current_botting_status())
}

#[cfg(target_os = "windows")]
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
enum BottingAccountAction {
    Disconnect,
    Close,
    CloseDisconnect,
    RestartClient,
    RestartLoop,
}

#[cfg(not(target_os = "windows"))]
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
enum BottingAccountAction {
    Disconnect,
    Close,
    CloseDisconnect,
    RestartClient,
    RestartLoop,
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn botting_account_action(
    app: tauri::AppHandle,
    user_id: i64,
    action: BottingAccountAction,
) -> Result<BottingStatusPayload, String> {
    let Some(session) = BOTTING_MANAGER.get_session() else {
        return Err("Botting Mode is not running".into());
    };

    let should_disconnect = matches!(
        action,
        BottingAccountAction::Disconnect | BottingAccountAction::CloseDisconnect
    );
    let should_close = matches!(
        action,
        BottingAccountAction::Close
            | BottingAccountAction::CloseDisconnect
            | BottingAccountAction::RestartClient
            | BottingAccountAction::RestartLoop
    );
    let should_restart_client = matches!(action, BottingAccountAction::RestartClient);
    let should_restart_loop = matches!(action, BottingAccountAction::RestartLoop);

    let tracker = platform::windows::tracker();

    let (is_player_from_config, interval_ms) = {
        let cfg = session.config.lock().map_err(|e| e.to_string())?;
        if !cfg.user_ids.contains(&user_id) {
            return Err("Account is not part of the current botting session".into());
        }
        (
            cfg.player_user_ids.contains(&user_id),
            (cfg.interval_minutes as i64).saturating_mul(60_000),
        )
    };

    if should_disconnect && is_player_from_config {
        return Err(
            "Player accounts cannot be disconnected; remove them from Player Accounts first".into(),
        );
    }

    if should_disconnect {
        let accounts = session.accounts.lock().map_err(|e| e.to_string())?;
        let Some(entry) = accounts.get(&user_id) else {
            return Err("Account runtime is missing for the current botting session".into());
        };
        if entry.is_player {
            return Err(
                "Player accounts cannot be disconnected; remove them from Player Accounts first"
                    .into(),
            );
        }
    }

    if should_close {
        let _ = tracker.kill_for_user(user_id);
    }

    let now = now_ms();
    {
        let mut accounts = session.accounts.lock().map_err(|e| e.to_string())?;
        let Some(entry) = accounts.get_mut(&user_id) else {
            return Err("Account runtime is missing for the current botting session".into());
        };
        let was_disconnected = entry.disconnected;
        let is_player = is_player_from_config || entry.is_player;

        if should_disconnect && is_player {
            return Err(
                "Player accounts cannot be disconnected; remove them from Player Accounts first"
                    .into(),
            );
        }

        entry.retry_count = 0;
        entry.last_error = None;
        entry.player_grace_until_ms = None;
        entry.is_player = is_player;
        entry.disconnected = should_disconnect;
        entry.manual_restart_pending = should_restart_loop || should_restart_client;
        entry.manual_restart_keep_schedule = should_restart_client && !is_player;
        entry.manual_restart_saved_next_restart_at_ms = if entry.manual_restart_keep_schedule {
            entry.next_restart_at_ms
        } else {
            None
        };

        if entry.disconnected {
            entry.next_restart_at_ms = None;
            entry.phase = if !should_close && tracker.get_pid(user_id).is_some() {
                "disconnected-running"
            } else {
                "disconnected"
            };
        } else if should_restart_loop || should_restart_client {
            entry.next_restart_at_ms = Some(now);
            entry.phase = "restarting";
        } else if is_player {
            entry.next_restart_at_ms = None;
            entry.phase = if !should_close && tracker.get_pid(user_id).is_some() {
                "running-player"
            } else {
                "queued-player"
            };
        } else if matches!(action, BottingAccountAction::Close) && was_disconnected {
            entry.next_restart_at_ms = Some(now);
            entry.phase = "restarting";
        } else {
            entry.manual_restart_keep_schedule = false;
            entry.manual_restart_saved_next_restart_at_ms = None;
            let next_due = entry
                .next_restart_at_ms
                .unwrap_or_else(|| now.saturating_add(interval_ms));
            entry.next_restart_at_ms = Some(next_due);
            entry.phase = if next_due <= now {
                "queued"
            } else {
                "waiting-rejoin"
            };
        }
    }

    emit_botting_status(&app);
    Ok(current_botting_status())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn botting_account_action(
    _app: tauri::AppHandle,
    _user_id: i64,
    _action: BottingAccountAction,
) -> Result<BottingStatusPayload, String> {
    Ok(BottingStatusPayload::default())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn set_botting_player_accounts(
    _app: tauri::AppHandle,
    _player_user_ids: Vec<i64>,
) -> Result<BottingStatusPayload, String> {
    Ok(BottingStatusPayload::default())
}
