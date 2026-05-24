#[cfg(target_os = "windows")]
#[tauri::command]
async fn launch_roblox(
    app: tauri::AppHandle,
    state: tauri::State<'_, AccountStore>,
    settings: tauri::State<'_, SettingsStore>,
    versions: tauri::State<'_, data::versions::VersionsCatalogStore>,
    user_id: i64,
    place_id: i64,
    job_id: String,
    launch_data: String,
    follow_user: bool,
    join_vip: bool,
    link_code: String,
    shuffle_job: bool,
) -> Result<(), String> {
    use platform::windows;

    let is_teleport = settings.get_bool("Developer", "IsTeleport");
    let configured_old_join = settings.get_bool("Developer", "UseOldJoin");
    let auto_close_last_process = settings.get_bool("General", "AutoCloseLastProcess");
    let auto_close_multi_conflicts = settings.get_bool("General", "AutoCloseRobloxForMultiRbx");
    let start_minimized = settings.get_bool("General", "StartRobloxMinimized");

    let account_snapshot_for_version = state.get_all()?;
    let account_version_override = account_snapshot_for_version
        .iter()
        .find(|a| a.user_id == user_id)
        .and_then(|a| a.fields.get("RobloxVersion").cloned())
        .filter(|v| !v.trim().is_empty());

    let (resolved_base_path, resolved_version_id) =
        windows::resolve_roblox_install_path(account_version_override.as_deref(), &settings, &versions)?;
    let isolation_will_wipe_install = settings
        .get_string("Isolation", "Mode")
        .eq_ignore_ascii_case("Full")
        && resolved_version_id.is_none();
    let use_old_join = if isolation_will_wipe_install {
        false
    } else {
        configured_old_join || resolved_version_id.is_some()
    };

    let tracker_check = windows::tracker();
    let _ = tracker_check.cleanup_dead_processes();
    let running_keys = tracker_check.running_version_keys();
    if running_keys.iter().any(|k| k != &resolved_version_id) {
        return Err(
            "A Roblox client is already running on a different version. Close it before launching this account on a different Roblox version. Concurrent multi-version support is planned for a future update.".into(),
        );
    }

    if let Some(report) = run_pre_launch_isolation(&app, &settings)? {
        let _ = app.emit("isolation-report", &report);
        if windows::has_pending_fast_flags() {
            tokio::spawn(apply_pending_fast_flags_when_ready(
                std::time::Duration::from_secs(240),
            ));
        }
    }

    let multi_rbx = settings.get_bool("General", "EnableMultiRbx");
    if multi_rbx {
        ensure_multi_roblox_enabled(auto_close_multi_conflicts)?;
    } else {
        let _ = windows::disable_multi_roblox();
    }

    patch_client_settings_for_launch(&settings, LaunchClientProfile::Normal);

    let tracker = windows::tracker();
    if auto_close_last_process && tracker.get_pid(user_id).is_some() {
        let closed = tracker.kill_for_user_graceful(user_id, 4500);
        if !closed {
            return Err("Previous Roblox instance did not close before relaunch".into());
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }

    let mut resolved_launch = resolve_launch_job(&job_id, join_vip, &link_code);
    if follow_user {
        resolved_launch.join_vip = false;
        resolved_launch.link_code.clear();
    }

    let mut actual_job = resolved_launch.job_id.clone();
    if shuffle_job && !follow_user && actual_job.trim().is_empty() {
        if let Ok(response) = run_with_session_retry(state.inner(), user_id, |cookie| async move {
            api::roblox::get_servers(place_id, "Public", None, Some(&cookie)).await
        })
        .await
        {
            if !response.data.is_empty() {
                let idx = (std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos() as usize)
                    % response.data.len();
                actual_job = response.data[idx].id.clone();
            }
        }
    }

    let browser_tracker_id = get_or_create_browser_tracker_id(&state, user_id)?;
    let ticket = run_with_session_retry(state.inner(), user_id, |cookie| async move {
        api::auth::get_auth_ticket(&cookie).await
    })
    .await?;
    let private_join = run_with_session_retry(state.inner(), user_id, |cookie| {
        let resolved_launch = resolved_launch.clone();
        async move { resolve_private_join(&cookie, place_id, &resolved_launch).await }
    })
    .await?;

    let pids_before = windows::get_roblox_pids();

    if use_old_join {
        windows::launch_old_join_from(
            &resolved_base_path,
            &ticket,
            private_join.place_id,
            &actual_job,
            &launch_data,
            follow_user,
            private_join.use_private_join,
            &private_join.access_code,
            &private_join.link_code,
            is_teleport,
        )?;
    } else {
        let url = windows::build_launch_url(
            &ticket,
            private_join.place_id,
            &actual_job,
            &browser_tracker_id,
            &launch_data,
            follow_user,
            private_join.use_private_join,
            &private_join.access_code,
            &private_join.link_code,
            is_teleport,
        );
        windows::launch_url(&url)?;
    }

    if let Some(pid) = wait_for_new_roblox_pid(&pids_before, std::time::Duration::from_secs(12)).await
    {
        tracker.track_with_version(
            user_id,
            pid,
            browser_tracker_id.clone(),
            resolved_version_id.clone(),
        );
        if let Some(version_id) = resolved_version_id.as_deref() {
            if let Some((channel, hash)) = version_id.split_once(':') {
                versions.touch_launched(channel, hash);
            }
        }
        apply_windows_post_launch_profile(Some(&app), &settings, LaunchClientProfile::Normal, pid)
            .await;

        let accounts = state.get_all()?;
        if let Some(account) = accounts.iter().find(|a| a.user_id == user_id) {
            let x = account
                .fields
                .get("Window_Position_X")
                .and_then(|v| v.parse::<i32>().ok());
            let y = account
                .fields
                .get("Window_Position_Y")
                .and_then(|v| v.parse::<i32>().ok());
            let w = account
                .fields
                .get("Window_Width")
                .and_then(|v| v.parse::<i32>().ok());
            let h = account
                .fields
                .get("Window_Height")
                .and_then(|v| v.parse::<i32>().ok());

            if let (Some(x), Some(y), Some(w), Some(h)) = (x, y, w, h) {
                let target_pid = pid;
                tokio::spawn(async move {
                    for _ in 0..45 {
                        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                        if let Some(hwnd) = windows::find_main_window(target_pid) {
                            windows::set_window_position(hwnd, x, y, w, h);
                            break;
                        }
                    }
                });
            }
        }

        if start_minimized {
            let baseline = pids_before.clone();
            tokio::spawn(async move {
                minimize_new_roblox_windows(baseline, std::time::Duration::from_secs(14)).await;
            });
        }
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
async fn launch_roblox(
    _app: tauri::AppHandle,
    state: tauri::State<'_, AccountStore>,
    settings: tauri::State<'_, SettingsStore>,
    user_id: i64,
    place_id: i64,
    job_id: String,
    launch_data: String,
    follow_user: bool,
    join_vip: bool,
    link_code: String,
    shuffle_job: bool,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use platform::macos;

        let is_teleport = settings.get_bool("Developer", "IsTeleport");
        let use_old_join = settings.get_bool("Developer", "UseOldJoin");
        let auto_close_last_process = settings.get_bool("General", "AutoCloseLastProcess");

        let multi_rbx = settings.get_bool("General", "EnableMultiRbx");
        if multi_rbx {
            let enabled = macos::enable_multi_roblox()?;
            if !enabled {
                return Err(
                    "Failed to enable Multi Roblox. Close all Roblox processes and try again."
                        .into(),
                );
            }
        } else {
            let _ = macos::disable_multi_roblox();
        }

        patch_client_settings_for_launch(&settings, LaunchClientProfile::Normal);

        let tracker = macos::tracker();
        if auto_close_last_process && tracker.get_pid(user_id).is_some() {
            tracker.kill_for_user(user_id);
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }

        let mut resolved_launch = resolve_launch_job(&job_id, join_vip, &link_code);
        if follow_user {
            resolved_launch.join_vip = false;
            resolved_launch.link_code.clear();
        }

        let mut actual_job = resolved_launch.job_id.clone();
        if shuffle_job && !follow_user && actual_job.trim().is_empty() {
            if let Ok(response) =
                run_with_session_retry(state.inner(), user_id, |cookie| async move {
                    api::roblox::get_servers(place_id, "Public", None, Some(&cookie)).await
                })
                .await
            {
                if !response.data.is_empty() {
                    let idx = (std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_nanos() as usize)
                        % response.data.len();
                    actual_job = response.data[idx].id.clone();
                }
            }
        }

        let browser_tracker_id = get_or_create_browser_tracker_id(&state, user_id)?;
        let ticket = run_with_session_retry(state.inner(), user_id, |cookie| async move {
            api::auth::get_auth_ticket(&cookie).await
        })
        .await?;
        let private_join = run_with_session_retry(state.inner(), user_id, |cookie| {
            let resolved_launch = resolved_launch.clone();
            async move { resolve_private_join(&cookie, place_id, &resolved_launch).await }
        })
        .await?;

        let pids_before = macos::get_roblox_pids();

        if use_old_join {
            macos::launch_old_join(
                &ticket,
                private_join.place_id,
                &actual_job,
                &launch_data,
                follow_user,
                private_join.use_private_join,
                &private_join.access_code,
                &private_join.link_code,
                is_teleport,
            )?;
        } else {
            let url = macos::build_launch_url(
                &ticket,
                private_join.place_id,
                &actual_job,
                &browser_tracker_id,
                &launch_data,
                follow_user,
                private_join.use_private_join,
                &private_join.access_code,
                &private_join.link_code,
                is_teleport,
            );
            macos::launch_url(&url)?;
        }

        if let Some(pid) =
            wait_for_new_roblox_pid(&pids_before, std::time::Duration::from_secs(12)).await
        {
            tracker.track(user_id, pid, browser_tracker_id);
        }

        return Ok(());
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        let _ = (
            state,
            settings,
            user_id,
            place_id,
            job_id,
            launch_data,
            follow_user,
            join_vip,
            link_code,
            shuffle_job,
        );
        Err("Launching is only supported on Windows and macOS".into())
    }
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn launch_multiple(
    app: tauri::AppHandle,
    state: tauri::State<'_, AccountStore>,
    settings: tauri::State<'_, SettingsStore>,
    versions: tauri::State<'_, data::versions::VersionsCatalogStore>,
    user_ids: Vec<i64>,
    place_id: i64,
    job_id: String,
    launch_data: String,
) -> Result<(), String> {
    use platform::windows;

    let delay = settings.get_int("General", "AccountJoinDelay").unwrap_or(8) as u64;
    let multi_rbx = settings.get_bool("General", "EnableMultiRbx");
    let delay = if multi_rbx { delay.max(12) } else { delay };
    let async_join = settings.get_bool("General", "AsyncJoin");
    let is_teleport = settings.get_bool("Developer", "IsTeleport");
    let configured_old_join = settings.get_bool("Developer", "UseOldJoin");
    let auto_close_last_process = settings.get_bool("General", "AutoCloseLastProcess");
    let auto_close_multi_conflicts = settings.get_bool("General", "AutoCloseRobloxForMultiRbx");
    let start_minimized = settings.get_bool("General", "StartRobloxMinimized");
    let tracker = windows::tracker();
    tracker.reset_launch_cancelled();

    if let Some(report) = run_pre_launch_isolation(&app, &settings)? {
        let _ = app.emit("isolation-report", &report);
        if windows::has_pending_fast_flags() {
            tokio::spawn(apply_pending_fast_flags_when_ready(
                std::time::Duration::from_secs(240),
            ));
        }
    }

    let accounts = state.get_all()?;

    for (i, &uid) in user_ids.iter().enumerate() {
        if tracker.is_launch_cancelled() {
            break;
        }

        let account = accounts.iter().find(|a| a.user_id == uid);
        let acct_place = account
            .and_then(|a| a.fields.get("SavedPlaceId"))
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(place_id);
        let acct_job = account
            .and_then(|a| a.fields.get("SavedJobId"))
            .map(|v| v.clone())
            .unwrap_or_else(|| job_id.clone());
        let acct_version_override = account
            .and_then(|a| a.fields.get("RobloxVersion").cloned())
            .filter(|v| !v.trim().is_empty());

        let (acct_base_path, acct_version_id) = match windows::resolve_roblox_install_path(
            acct_version_override.as_deref(),
            &settings,
            &versions,
        ) {
            Ok(value) => value,
            Err(_) => {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                continue;
            }
        };
        let acct_isolation_wipes_install = settings
            .get_string("Isolation", "Mode")
            .eq_ignore_ascii_case("Full")
            && acct_version_id.is_none();
        let acct_use_old_join = if acct_isolation_wipes_install {
            false
        } else {
            configured_old_join || acct_version_id.is_some()
        };

        let _ = tracker.cleanup_dead_processes();
        let running_keys = tracker.running_version_keys();
        if running_keys.iter().any(|k| k != &acct_version_id) {
            let _ = app.emit(
                "launch-progress",
                serde_json::json!({
                    "userId": uid,
                    "index": i,
                    "total": user_ids.len(),
                    "error": "version-conflict",
                }),
            );
            continue;
        }

        let _ = app.emit(
            "launch-progress",
            serde_json::json!({
                "userId": uid,
                "index": i,
                "total": user_ids.len(),
            }),
        );

        let resolved_launch = resolve_launch_job(&acct_job, false, "");

        if multi_rbx {
            ensure_multi_roblox_enabled(auto_close_multi_conflicts)?;
        } else {
            let _ = windows::disable_multi_roblox();
        }

        patch_client_settings_for_launch(&settings, LaunchClientProfile::Normal);

        if auto_close_last_process && tracker.get_pid(uid).is_some() {
            let closed = tracker.kill_for_user_graceful(uid, 4500);
            if !closed {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                continue;
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }

        let browser_tracker_id = get_or_create_browser_tracker_id(&state, uid)?;
        let ticket = match run_with_session_retry(state.inner(), uid, |cookie| async move {
            api::auth::get_auth_ticket(&cookie).await
        })
        .await
        {
            Ok(t) => t,
            Err(_) => {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                continue;
            }
        };
        let private_join = match run_with_session_retry(state.inner(), uid, |cookie| {
            let resolved_launch = resolved_launch.clone();
            async move { resolve_private_join(&cookie, acct_place, &resolved_launch).await }
        })
        .await
        {
            Ok(value) => value,
            Err(_) => {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                continue;
            }
        };

        let pids_before = windows::get_roblox_pids();

        let launch_result = if acct_use_old_join {
            windows::launch_old_join_from(
                &acct_base_path,
                &ticket,
                private_join.place_id,
                &resolved_launch.job_id,
                &launch_data,
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
                &launch_data,
                false,
                private_join.use_private_join,
                &private_join.access_code,
                &private_join.link_code,
                is_teleport,
            );
            windows::launch_url(&url)
        };

        if launch_result.is_err() {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            continue;
        }

        if let Some(pid) = wait_for_new_roblox_pid(&pids_before, std::time::Duration::from_secs(12)).await
        {
            tracker.track_with_version(uid, pid, browser_tracker_id, acct_version_id.clone());
            if let Some(version_id) = acct_version_id.as_deref() {
                if let Some((channel, hash)) = version_id.split_once(':') {
                    versions.touch_launched(channel, hash);
                }
            }
            apply_windows_post_launch_profile(
                Some(&app),
                &settings,
                LaunchClientProfile::Normal,
                pid,
            )
            .await;
            if start_minimized {
                let baseline = pids_before.clone();
                tokio::spawn(async move {
                    minimize_new_roblox_windows(baseline, std::time::Duration::from_secs(14)).await;
                });
            }
        }

        if i < user_ids.len() - 1 {
            if async_join {
                tracker.reset_next_account();
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
                while !tracker.is_next_account() && !tracker.is_launch_cancelled() {
                    if std::time::Instant::now() > deadline {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                }
            } else {
                tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
            }
        }
    }

    let _ = app.emit("launch-complete", serde_json::json!({}));
    Ok(())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
async fn launch_multiple(
    app: tauri::AppHandle,
    state: tauri::State<'_, AccountStore>,
    settings: tauri::State<'_, SettingsStore>,
    user_ids: Vec<i64>,
    place_id: i64,
    job_id: String,
    launch_data: String,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use platform::macos;

        let delay = settings.get_int("General", "AccountJoinDelay").unwrap_or(8) as u64;
        let multi_rbx = settings.get_bool("General", "EnableMultiRbx");
        let delay = if multi_rbx { delay.max(12) } else { delay };
        let async_join = settings.get_bool("General", "AsyncJoin");
        let is_teleport = settings.get_bool("Developer", "IsTeleport");
        let use_old_join = settings.get_bool("Developer", "UseOldJoin");
        let auto_close_last_process = settings.get_bool("General", "AutoCloseLastProcess");
        let tracker = macos::tracker();
        tracker.reset_launch_cancelled();

        let accounts = state.get_all()?;

        for (i, &uid) in user_ids.iter().enumerate() {
            if tracker.is_launch_cancelled() {
                break;
            }

            let account = accounts.iter().find(|a| a.user_id == uid);
            let acct_place = account
                .and_then(|a| a.fields.get("SavedPlaceId"))
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(place_id);
            let acct_job = account
                .and_then(|a| a.fields.get("SavedJobId"))
                .map(|v| v.clone())
                .unwrap_or_else(|| job_id.clone());

            let _ = app.emit(
                "launch-progress",
                serde_json::json!({
                    "userId": uid,
                    "index": i,
                    "total": user_ids.len(),
                }),
            );

            let resolved_launch = resolve_launch_job(&acct_job, false, "");

            if multi_rbx {
                let enabled = macos::enable_multi_roblox()?;
                if !enabled {
                    return Err(
                        "Failed to enable Multi Roblox. Close all Roblox processes and try again."
                            .into(),
                    );
                }
            } else {
                let _ = macos::disable_multi_roblox();
            }

            patch_client_settings_for_launch(&settings, LaunchClientProfile::Normal);

            if auto_close_last_process && tracker.get_pid(uid).is_some() {
                tracker.kill_for_user(uid);
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }

            let browser_tracker_id = get_or_create_browser_tracker_id(&state, uid)?;
            let ticket = match run_with_session_retry(state.inner(), uid, |cookie| async move {
                api::auth::get_auth_ticket(&cookie).await
            })
            .await
            {
                Ok(t) => t,
                Err(_) => {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    continue;
                }
            };
            let private_join =
                match run_with_session_retry(state.inner(), uid, |cookie| {
                    let resolved_launch = resolved_launch.clone();
                    async move { resolve_private_join(&cookie, acct_place, &resolved_launch).await }
                })
                .await
                {
                Ok(value) => value,
                Err(_) => {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    continue;
                }
            };

            let pids_before = macos::get_roblox_pids();

            let launch_result = if use_old_join {
                macos::launch_old_join(
                    &ticket,
                    private_join.place_id,
                    &resolved_launch.job_id,
                    &launch_data,
                    false,
                    private_join.use_private_join,
                    &private_join.access_code,
                    &private_join.link_code,
                    is_teleport,
                )
            } else {
                let url = macos::build_launch_url(
                    &ticket,
                    private_join.place_id,
                    &resolved_launch.job_id,
                    &browser_tracker_id,
                    &launch_data,
                    false,
                    private_join.use_private_join,
                    &private_join.access_code,
                    &private_join.link_code,
                    is_teleport,
                );
                macos::launch_url(&url)
            };

            if launch_result.is_err() {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                continue;
            }

            if let Some(pid) =
                wait_for_new_roblox_pid(&pids_before, std::time::Duration::from_secs(12)).await
            {
                tracker.track(uid, pid, browser_tracker_id);
            }

            if i < user_ids.len() - 1 {
                if async_join {
                    tracker.reset_next_account();
                    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
                    while !tracker.is_next_account() && !tracker.is_launch_cancelled() {
                        if std::time::Instant::now() > deadline {
                            break;
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                    }
                } else {
                    tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
                }
            }
        }

        let _ = app.emit("launch-complete", serde_json::json!({}));
        return Ok(());
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        let _ = (app, state, settings, user_ids, place_id, job_id, launch_data);
        Err("Launching is only supported on Windows and macOS".into())
    }
}

#[tauri::command]
fn cancel_launch() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        platform::windows::tracker().cancel_launch();
    }
    #[cfg(target_os = "macos")]
    {
        platform::macos::tracker().cancel_launch();
    }
    Ok(())
}

#[tauri::command]
fn next_account() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        platform::windows::tracker().signal_next_account();
    }
    #[cfg(target_os = "macos")]
    {
        platform::macos::tracker().signal_next_account();
    }
    Ok(())
}

#[tauri::command]
fn cmd_kill_roblox(user_id: i64) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        return Ok(platform::windows::tracker().kill_for_user(user_id));
    }
    #[cfg(target_os = "macos")]
    {
        return Ok(platform::macos::tracker().kill_for_user(user_id));
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        let _ = user_id;
        Err("Not supported on this platform".into())
    }
}

#[tauri::command]
fn focus_roblox_window(user_id: i64) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        let tracker = platform::windows::tracker();
        let Some(pid) = tracker.get_pid(user_id) else {
            return Ok(false);
        };
        let Some(hwnd) = platform::windows::find_main_window(pid) else {
            return Ok(false);
        };
        return Ok(platform::windows::focus_window(hwnd));
    }
    #[cfg(target_os = "macos")]
    {
        let _ = user_id;
        return Ok(false);
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        let _ = user_id;
        Ok(false)
    }
}

#[tauri::command]
fn cmd_kill_all_roblox() -> Result<u32, String> {
    #[cfg(target_os = "windows")]
    {
        let killed = platform::windows::kill_all_roblox();
        let tracker = platform::windows::tracker();
        let all = tracker.get_all();
        for p in all {
            tracker.untrack(p.user_id);
        }
        return Ok(killed);
    }
    #[cfg(target_os = "macos")]
    {
        let killed = platform::macos::kill_all_roblox();
        let tracker = platform::macos::tracker();
        let all = tracker.get_all();
        for p in all {
            tracker.untrack(p.user_id);
        }
        return Ok(killed);
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        Err("Not supported on this platform".into())
    }
}

#[derive(serde::Serialize)]
struct RunningInstance {
    pid: u32,
    user_id: i64,
    browser_tracker_id: String,
}

#[tauri::command]
fn get_running_instances() -> Result<Vec<RunningInstance>, String> {
    #[cfg(target_os = "windows")]
    {
        return Ok(platform::windows::tracker()
            .get_all()
            .into_iter()
            .map(|p| RunningInstance {
                pid: p.pid,
                user_id: p.user_id,
                browser_tracker_id: p.browser_tracker_id,
            })
            .collect());
    }
    #[cfg(target_os = "macos")]
    {
        return Ok(platform::macos::tracker()
            .get_all()
            .into_iter()
            .map(|p| RunningInstance {
                pid: p.pid,
                user_id: p.user_id,
                browser_tracker_id: p.browser_tracker_id,
            })
            .collect());
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        Ok(Vec::new())
    }
}

#[tauri::command]
fn cmd_enable_multi_roblox() -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        return platform::windows::enable_multi_roblox();
    }
    #[cfg(target_os = "macos")]
    {
        return platform::macos::enable_multi_roblox();
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        Err("Not supported on this platform".into())
    }
}

#[tauri::command]
fn cmd_disable_multi_roblox() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        return platform::windows::disable_multi_roblox();
    }
    #[cfg(target_os = "macos")]
    {
        return platform::macos::disable_multi_roblox();
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        Ok(())
    }
}

#[tauri::command]
fn cmd_get_roblox_path() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        return platform::windows::get_roblox_path();
    }
    #[cfg(target_os = "macos")]
    {
        return platform::macos::get_roblox_path();
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        Err("Not supported on this platform".into())
    }
}

#[tauri::command]
fn cmd_apply_fps_unlock(max_fps: u32) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        return platform::windows::apply_fps_unlock(max_fps);
    }
    #[cfg(target_os = "macos")]
    {
        return platform::macos::apply_fps_unlock(max_fps);
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        let _ = max_fps;
        Err("Not supported on this platform".into())
    }
}
