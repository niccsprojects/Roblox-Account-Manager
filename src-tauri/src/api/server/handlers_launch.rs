async fn handle_launch_account(
    Extension(state): Extension<AppState>,
    Query(params): Query<AccountQuery>,
    v2: bool,
) -> Response {
    if !state.settings.get_bool("WebServer", "AllowLaunchAccount") {
        return reply(401, "AllowLaunchAccount is disabled", v2);
    }

    if !check_password(&state, &params.password) {
        return reply(401, "Invalid password", v2);
    }

    let identifier = match params.account {
        Some(ref a) if !a.is_empty() => a,
        _ => return reply(400, "Missing Account parameter", v2),
    };

    let place_id: i64 = match params.place_id.as_deref().and_then(|v| v.parse().ok()) {
        Some(id) => id,
        None => return reply(400, "Missing or invalid PlaceId parameter", v2),
    };

    let job_id = params.job_id.as_deref().unwrap_or("");
    let follow_user = params.follow_user.as_deref().map(|v| v.eq_ignore_ascii_case("true")).unwrap_or(false);
    let join_vip = params.join_vip.as_deref().map(|v| v.eq_ignore_ascii_case("true")).unwrap_or(false);

    let accounts = match state.accounts.get_all() {
        Ok(a) => a,
        Err(e) => return reply(500, &e, v2),
    };

    let account = match find_account(&accounts, identifier) {
        Some(a) => a,
        None => return reply(404, "Account not found", v2),
    };

    #[cfg(target_os = "windows")]
    {
        use crate::platform::windows;

        patch_client_settings_for_launch(state.settings);
        let is_teleport = state.settings.get_bool("Developer", "IsTeleport");
        let use_old_join = state.settings.get_bool("Developer", "UseOldJoin");
        let auto_close_last_process = state.settings.get_bool("General", "AutoCloseLastProcess");
        let multi_rbx = state.settings.get_bool("General", "EnableMultiRbx");

        if multi_rbx {
            match windows::enable_multi_roblox() {
                Ok(true) => {}
                Ok(false) => {
                    return reply(500, "Failed to enable Multi Roblox. Close all Roblox processes and try again.", v2);
                }
                Err(e) => return reply(500, &e, v2),
            }
        } else {
            let _ = windows::disable_multi_roblox();
        }

        let tracker = windows::tracker();
        if auto_close_last_process && tracker.get_pid(account.user_id).is_some() {
            tracker.kill_for_user(account.user_id);
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }

        let browser_tracker_id =
            match crate::get_or_create_browser_tracker_id(state.accounts, account.user_id) {
                Ok(id) => id,
                Err(e) => return reply(500, &e, v2),
            };
        let ticket = match auth::get_auth_ticket(&account.security_token).await {
            Ok(t) => t,
            Err(e) => return reply(400, &format!("Failed to get auth ticket: {}", e), v2),
        };

        let pids_before = windows::get_roblox_pids();

        let mut access_code = if join_vip {
            job_id.to_string()
        } else {
            String::new()
        };
        let mut link_code = String::new();

        if join_vip && !job_id.is_empty() {
            let mut extracted = String::new();

            if let Some(code) = job_id.split("privateServerLinkCode=").nth(1) {
                extracted = code.split('&').next().unwrap_or(code).to_string();
            } else if let Some(code) = job_id.split("linkCode=").nth(1) {
                extracted = code.split('&').next().unwrap_or(code).to_string();
            } else if let Some(code) = job_id.split("code=").nth(1) {
                extracted = code.split('&').next().unwrap_or(code).to_string();
            }

            if !extracted.is_empty() {
                link_code = extracted;
                if let Ok(code) = roblox::parse_private_server_link_code(
                    &account.security_token,
                    place_id,
                    &link_code,
                )
                .await
                {
                    access_code = code;
                }
            }
        }

        let launch_result = if use_old_join {
            windows::launch_old_join(
                &ticket,
                place_id,
                job_id,
                "",
                follow_user,
                join_vip,
                &access_code,
                &link_code,
                is_teleport,
            )
        } else {
            let url = windows::build_launch_url(
                &ticket,
                place_id,
                job_id,
                &browser_tracker_id,
                "",
                follow_user,
                join_vip,
                &access_code,
                &link_code,
                is_teleport,
            );
            windows::launch_url(&url)
        };

        if let Err(e) = launch_result {
            return reply(500, &format!("Failed to launch: {}", e), v2);
        }

        if let Some(pid) =
            crate::wait_for_new_roblox_pid(&pids_before, std::time::Duration::from_secs(12)).await
        {
            tracker.track(account.user_id, pid, browser_tracker_id);
            crate::apply_windows_post_launch_profile(
                None,
                state.settings,
                crate::LaunchClientProfile::Normal,
                pid,
            )
            .await;
        }

        reply(200, &format!("Launched {} to {}", account.username, place_id), v2)
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (place_id, job_id, follow_user, join_vip, account);
        reply(500, "Launching is only supported on Windows", v2)
    }
}

async fn handle_follow_user(
    Extension(state): Extension<AppState>,
    Query(params): Query<AccountQuery>,
    v2: bool,
) -> Response {
    if !state.settings.get_bool("WebServer", "AllowLaunchAccount") {
        return reply(401, "AllowLaunchAccount is disabled", v2);
    }

    if !check_password(&state, &params.password) {
        return reply(401, "Invalid password", v2);
    }

    let identifier = match params.account {
        Some(ref a) if !a.is_empty() => a,
        _ => return reply(400, "Missing Account parameter", v2),
    };

    let target_username = match params.username {
        Some(ref u) if !u.is_empty() => u.clone(),
        _ => return reply(400, "Missing Username parameter", v2),
    };

    let accounts = match state.accounts.get_all() {
        Ok(a) => a,
        Err(e) => return reply(500, &e, v2),
    };

    let account = match find_account(&accounts, identifier) {
        Some(a) => a,
        None => return reply(404, "Account not found", v2),
    };

    let target = match roblox::get_user_id(None, &target_username).await {
        Ok(u) => u,
        Err(e) => return reply(400, &e, v2),
    };

    #[cfg(target_os = "windows")]
    {
        use crate::platform::windows;

        patch_client_settings_for_launch(state.settings);
        let is_teleport = state.settings.get_bool("Developer", "IsTeleport");
        let use_old_join = state.settings.get_bool("Developer", "UseOldJoin");
        let auto_close_last_process = state.settings.get_bool("General", "AutoCloseLastProcess");
        let multi_rbx = state.settings.get_bool("General", "EnableMultiRbx");

        if multi_rbx {
            match windows::enable_multi_roblox() {
                Ok(true) => {}
                Ok(false) => {
                    return reply(500, "Failed to enable Multi Roblox. Close all Roblox processes and try again.", v2);
                }
                Err(e) => return reply(500, &e, v2),
            }
        } else {
            let _ = windows::disable_multi_roblox();
        }

        let tracker = windows::tracker();
        if auto_close_last_process && tracker.get_pid(account.user_id).is_some() {
            tracker.kill_for_user(account.user_id);
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }

        let browser_tracker_id =
            match crate::get_or_create_browser_tracker_id(state.accounts, account.user_id) {
                Ok(id) => id,
                Err(e) => return reply(500, &e, v2),
            };
        let ticket = match auth::get_auth_ticket(&account.security_token).await {
            Ok(t) => t,
            Err(e) => return reply(400, &format!("Failed to get auth ticket: {}", e), v2),
        };

        let pids_before = windows::get_roblox_pids();

        let launch_result = if use_old_join {
            windows::launch_old_join(
                &ticket,
                target.id,
                "",
                "",
                true,
                false,
                "",
                "",
                is_teleport,
            )
        } else {
            let url = windows::build_launch_url(
                &ticket,
                target.id,
                "",
                &browser_tracker_id,
                "",
                true,
                false,
                "",
                "",
                is_teleport,
            );
            windows::launch_url(&url)
        };

        if let Err(e) = launch_result {
            return reply(500, &format!("Failed to launch: {}", e), v2);
        }

        if let Some(pid) =
            crate::wait_for_new_roblox_pid(&pids_before, std::time::Duration::from_secs(12)).await
        {
            tracker.track(account.user_id, pid, browser_tracker_id);
            crate::apply_windows_post_launch_profile(
                None,
                state.settings,
                crate::LaunchClientProfile::Normal,
                pid,
            )
            .await;
        }

        reply(200, &format!("Following {} to {}", account.username, target_username), v2)
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (account, target);
        reply(500, "Launching is only supported on Windows", v2)
    }
}

async fn handle_set_server(
    Extension(state): Extension<AppState>,
    Query(params): Query<AccountQuery>,
    v2: bool,
) -> Response {
    let identifier = match params.account {
        Some(ref a) if !a.is_empty() => a,
        _ => return reply(400, "Missing Account parameter", v2),
    };

    let place_id: i64 = match params.place_id.as_deref().and_then(|v| v.parse().ok()) {
        Some(id) => id,
        None => return reply(400, "Missing or invalid PlaceId parameter", v2),
    };

    let job_id = match params.job_id {
        Some(ref j) if !j.is_empty() => j.clone(),
        _ => return reply(400, "Missing JobId parameter", v2),
    };

    let accounts = match state.accounts.get_all() {
        Ok(a) => a,
        Err(e) => return reply(500, &e, v2),
    };

    let account = match find_account(&accounts, identifier) {
        Some(a) => a,
        None => return reply(404, "Account not found", v2),
    };

    match roblox::join_game_instance(&account.security_token, place_id, &job_id, false).await {
        Ok(_) => reply(200, "Server set successfully", v2),
        Err(e) => reply(400, &e, v2),
    }
}

async fn handle_set_recommended_server(
    Extension(state): Extension<AppState>,
    Query(params): Query<AccountQuery>,
    v2: bool,
) -> Response {
    let identifier = match params.account {
        Some(ref a) if !a.is_empty() => a,
        _ => return reply(400, "Missing Account parameter", v2),
    };

    let place_id: i64 = match params.place_id.as_deref().and_then(|v| v.parse().ok()) {
        Some(id) => id,
        None => return reply(400, "Missing or invalid PlaceId parameter", v2),
    };

    let accounts = match state.accounts.get_all() {
        Ok(a) => a,
        Err(e) => return reply(500, &e, v2),
    };

    let account = match find_account(&accounts, identifier) {
        Some(a) => a,
        None => return reply(404, "Account not found", v2),
    };

    let servers_response = match roblox::get_servers(place_id, "Public", None, Some(&account.security_token)).await {
        Ok(r) => r,
        Err(e) => return reply(400, &format!("Failed to get servers: {}", e), v2),
    };

    if servers_response.data.is_empty() {
        return reply(400, "No servers available", v2);
    }

    let mut attempted: Vec<String> = Vec::new();

    for _ in 0..10 {
        for server in servers_response.data.iter().rev() {
            if attempted.contains(&server.id) {
                continue;
            }

            attempted.push(server.id.clone());

            match roblox::join_game_instance(&account.security_token, place_id, &server.id, false).await {
                Ok(_) => return reply(200, "Recommended server set successfully", v2),
                Err(_) => continue,
            }
        }

        if attempted.len() >= 100 {
            attempted.clear();
        }
    }

    reply(400, "Too many failed attempts", v2)
}

