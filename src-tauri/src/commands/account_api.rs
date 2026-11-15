use std::future::Future;

fn session_relogin_error() -> String {
    "Roblox invalidated this session. Re-login required.".to_string()
}

fn is_auth_session_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("status 401")
        || lower.contains("[401")
        || lower.contains("unauthorized")
        || lower.contains("not authenticated")
        || lower.contains("user is not authenticated")
        || lower.contains("invalid cookie")
        || lower.contains("token validation failed")
        || lower.contains("authorization has been denied")
        || lower.contains("\"code\":9002")
        || lower.contains("code 9002")
}

fn get_account(state: &AccountStore, user_id: i64) -> Result<crate::data::accounts::Account, String> {
    state
        .get_all()?
        .into_iter()
        .find(|a| a.user_id == user_id)
        .ok_or_else(|| format!("Account {} not found", user_id))
}

fn mark_refresh_attempt(
    state: &AccountStore,
    user_id: i64,
) -> Result<crate::data::accounts::Account, String> {
    let mut account = get_account(state, user_id)?;
    account.last_attempted_refresh = chrono::Utc::now();
    state.update(account.clone())?;
    Ok(account)
}

fn persist_cookie_update(state: &AccountStore, user_id: i64, new_cookie: &str) -> Result<(), String> {
    let mut account = get_account(state, user_id)?;
    account.security_token = new_cookie.to_string();
    account.valid = true;
    state.update(account)?;
    Ok(())
}

async fn refresh_account_session(state: &AccountStore, user_id: i64) -> Result<String, String> {
    let account = mark_refresh_attempt(state, user_id)?;
    let result = api::auth::log_out_other_sessions(&account.security_token).await?;
    if !result.success {
        return Err(session_relogin_error());
    }
    let new_cookie = result
        .new_cookie
        .filter(|cookie| !cookie.trim().is_empty())
        .ok_or_else(session_relogin_error)?;
    persist_cookie_update(state, user_id, &new_cookie)?;
    Ok(new_cookie)
}

async fn run_with_session_retry<T, F, Fut>(
    state: &AccountStore,
    user_id: i64,
    mut operation: F,
) -> Result<T, String>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = Result<T, String>>,
{
    let cookie = get_cookie(state, user_id)?;
    match operation(cookie).await {
        Ok(value) => Ok(value),
        Err(error) => {
            if !is_auth_session_error(&error) {
                return Err(error);
            }
            eprintln!(
                "[session-retry] user {}: auth session error, attempting refresh: {}",
                user_id, error
            );

            let refreshed_cookie = refresh_account_session(state, user_id)
                .await
                .map_err(|refresh_error| {
                    if is_auth_session_error(&refresh_error) {
                        session_relogin_error()
                    } else {
                        refresh_error
                    }
                })?;

            match operation(refreshed_cookie).await {
                Ok(value) => Ok(value),
                Err(retry_error) => {
                    if is_auth_session_error(&retry_error) {
                        Err(session_relogin_error())
                    } else {
                        Err(retry_error)
                    }
                }
            }
        }
    }
}

#[tauri::command]
async fn validate_cookie(cookie: String) -> Result<api::auth::AccountInfo, String> {
    api::auth::validate_cookie(&cookie).await
}

#[tauri::command]
async fn get_csrf_token(
    state: tauri::State<'_, AccountStore>,
    user_id: i64,
) -> Result<String, String> {
    run_with_session_retry(state.inner(), user_id, |cookie| async move {
        api::auth::get_csrf_token(&cookie).await
    })
    .await
}

#[tauri::command]
async fn get_auth_ticket(
    state: tauri::State<'_, AccountStore>,
    user_id: i64,
) -> Result<String, String> {
    run_with_session_retry(state.inner(), user_id, |cookie| async move {
        api::auth::get_auth_ticket(&cookie).await
    })
    .await
}

#[tauri::command]
async fn check_pin(state: tauri::State<'_, AccountStore>, user_id: i64) -> Result<bool, String> {
    run_with_session_retry(state.inner(), user_id, |cookie| async move {
        api::auth::check_pin(&cookie).await
    })
    .await
}

#[tauri::command]
async fn unlock_pin(
    state: tauri::State<'_, AccountStore>,
    user_id: i64,
    pin: String,
) -> Result<bool, String> {
    run_with_session_retry(state.inner(), user_id, |cookie| {
        let pin = pin.clone();
        async move { api::auth::unlock_pin(&cookie, &pin).await }
    })
    .await
}

#[tauri::command]
async fn refresh_cookie(
    state: tauri::State<'_, AccountStore>,
    user_id: i64,
) -> Result<bool, String> {
    refresh_account_session(state.inner(), user_id).await?;
    Ok(true)
}

#[tauri::command]
async fn get_robux(state: tauri::State<'_, AccountStore>, user_id: i64) -> Result<i64, String> {
    run_with_session_retry(state.inner(), user_id, |cookie| async move {
        api::roblox::get_robux(&cookie).await
    })
    .await
}

#[tauri::command]
async fn get_user_info(user_id: i64) -> Result<api::roblox::UserInfo, String> {
    api::roblox::get_user_info(None, user_id).await
}

#[tauri::command]
async fn lookup_user(username: String) -> Result<api::roblox::UserLookupResult, String> {
    api::roblox::get_user_id(None, &username).await
}

#[tauri::command]
async fn test_auth(cookie: String) -> Result<String, String> {
    let mut results = Vec::new();

    results.push(format!("Cookie length: {}", cookie.len()));

    match api::auth::validate_cookie(&cookie).await {
        Ok(info) => results.push(format!(
            "Validate: OK - {} (ID: {})",
            info.name, info.user_id
        )),
        Err(e) => results.push(format!("Validate: FAILED - {}", e)),
    }

    match api::auth::get_csrf_token(&cookie).await {
        Ok(token) => results.push(format!("CSRF: OK - {}...", &token[..token.len().min(16)])),
        Err(e) => results.push(format!("CSRF: FAILED - {}", e)),
    }

    match api::auth::get_auth_ticket(&cookie).await {
        Ok(ticket) => results.push(format!(
            "Ticket: OK - {}...",
            &ticket[..ticket.len().min(20)]
        )),
        Err(e) => results.push(format!("Ticket: FAILED - {}", e)),
    }

    Ok(results.join("\n"))
}

#[tauri::command]
async fn send_friend_request(
    state: tauri::State<'_, AccountStore>,
    user_id: i64,
    target_user_id: i64,
) -> Result<(), String> {
    run_with_session_retry(state.inner(), user_id, |cookie| async move {
        api::roblox::send_friend_request(&cookie, target_user_id).await
    })
    .await
}

#[tauri::command]
async fn block_user(
    state: tauri::State<'_, AccountStore>,
    user_id: i64,
    target_user_id: i64,
) -> Result<(), String> {
    run_with_session_retry(state.inner(), user_id, |cookie| async move {
        api::roblox::block_user(&cookie, target_user_id).await
    })
    .await
}

#[tauri::command]
async fn unblock_user(
    state: tauri::State<'_, AccountStore>,
    user_id: i64,
    target_user_id: i64,
) -> Result<(), String> {
    run_with_session_retry(state.inner(), user_id, |cookie| async move {
        api::roblox::unblock_user(&cookie, target_user_id).await
    })
    .await
}

#[tauri::command]
async fn get_blocked_users(
    state: tauri::State<'_, AccountStore>,
    user_id: i64,
) -> Result<Vec<api::roblox::BlockedUser>, String> {
    run_with_session_retry(state.inner(), user_id, |cookie| async move {
        api::roblox::get_blocked_users(&cookie).await
    })
    .await
}

#[tauri::command]
async fn unblock_all_users(
    state: tauri::State<'_, AccountStore>,
    user_id: i64,
) -> Result<i32, String> {
    run_with_session_retry(state.inner(), user_id, |cookie| async move {
        api::roblox::unblock_all_users(&cookie).await
    })
    .await
}

#[tauri::command]
async fn set_follow_privacy(
    state: tauri::State<'_, AccountStore>,
    user_id: i64,
    privacy: String,
) -> Result<(), String> {
    run_with_session_retry(state.inner(), user_id, |cookie| {
        let privacy = privacy.clone();
        async move { api::roblox::set_follow_privacy(&cookie, &privacy).await }
    })
    .await
}

#[tauri::command]
async fn get_private_server_invite_privacy(
    state: tauri::State<'_, AccountStore>,
    user_id: i64,
) -> Result<String, String> {
    run_with_session_retry(state.inner(), user_id, |cookie| async move {
        api::roblox::get_private_server_invite_privacy(&cookie).await
    })
    .await
}

#[tauri::command]
async fn set_private_server_invite_privacy(
    state: tauri::State<'_, AccountStore>,
    user_id: i64,
    privacy: String,
) -> Result<(), String> {
    run_with_session_retry(state.inner(), user_id, |cookie| {
        let privacy = privacy.clone();
        async move { api::roblox::set_private_server_invite_privacy(&cookie, &privacy).await }
    })
    .await
}

#[tauri::command]
async fn set_avatar(
    state: tauri::State<'_, AccountStore>,
    user_id: i64,
    avatar_json: serde_json::Value,
) -> Result<Vec<i64>, String> {
    run_with_session_retry(state.inner(), user_id, |cookie| {
        let avatar_json = avatar_json.clone();
        async move { api::roblox::set_avatar(&cookie, avatar_json).await }
    })
    .await
}

#[tauri::command]
async fn get_outfits(target_user_id: i64) -> Result<Vec<api::roblox::OutfitInfo>, String> {
    api::roblox::get_outfits(target_user_id).await
}

#[tauri::command]
async fn get_outfit_details(outfit_id: i64) -> Result<serde_json::Value, String> {
    api::roblox::get_outfit_details(outfit_id).await
}

#[tauri::command]
async fn get_place_details(
    state: tauri::State<'_, AccountStore>,
    place_ids: Vec<i64>,
    user_id: Option<i64>,
) -> Result<Vec<api::roblox::PlaceDetails>, String> {
    let cookie = user_id.and_then(|id| get_cookie(&state, id).ok());
    api::roblox::get_place_details(&place_ids, cookie.as_deref()).await
}

#[tauri::command]
async fn get_servers(
    state: tauri::State<'_, AccountStore>,
    place_id: i64,
    server_type: String,
    cursor: Option<String>,
    user_id: Option<i64>,
) -> Result<api::roblox::ServersResponse, String> {
    let cookie = user_id.and_then(|id| get_cookie(&state, id).ok());
    api::roblox::get_servers(place_id, &server_type, cursor.as_deref(), cookie.as_deref()).await
}

#[tauri::command]
async fn join_game_instance(
    state: tauri::State<'_, AccountStore>,
    user_id: i64,
    place_id: i64,
    game_id: String,
    is_teleport: bool,
) -> Result<serde_json::Value, String> {
    run_with_session_retry(state.inner(), user_id, |cookie| {
        let game_id = game_id.clone();
        async move { api::roblox::join_game_instance(&cookie, place_id, &game_id, is_teleport).await }
    })
    .await
}

#[tauri::command]
async fn join_game(
    state: tauri::State<'_, AccountStore>,
    user_id: i64,
    place_id: i64,
) -> Result<serde_json::Value, String> {
    run_with_session_retry(state.inner(), user_id, |cookie| async move {
        api::roblox::join_game(&cookie, place_id).await
    })
    .await
}

#[tauri::command]
async fn search_games(
    security_token: Option<String>,
    keyword: String,
    start: i32,
) -> Result<serde_json::Value, String> {
    api::roblox::search_games(security_token.as_deref(), &keyword, start).await
}

#[tauri::command]
async fn get_universe_places(
    state: tauri::State<'_, AccountStore>,
    universe_id: i64,
    user_id: Option<i64>,
) -> Result<Vec<api::roblox::UniversePlace>, String> {
    let cookie = user_id.and_then(|id| get_cookie(&state, id).ok());
    api::roblox::get_universe_places(universe_id, cookie.as_deref()).await
}

#[tauri::command]
async fn parse_private_server_link_code(
    state: tauri::State<'_, AccountStore>,
    user_id: i64,
    place_id: i64,
    link_code: String,
) -> Result<String, String> {
    run_with_session_retry(state.inner(), user_id, |cookie| {
        let link_code = link_code.clone();
        async move { api::roblox::parse_private_server_link_code(&cookie, place_id, &link_code).await }
    })
    .await
}

#[tauri::command]
async fn join_group(
    state: tauri::State<'_, AccountStore>,
    user_id: i64,
    group_id: i64,
) -> Result<(), String> {
    run_with_session_retry(state.inner(), user_id, |cookie| async move {
        api::roblox::join_group(&cookie, group_id).await
    })
    .await
}

#[tauri::command]
async fn get_presence(
    state: tauri::State<'_, AccountStore>,
    user_ids: Vec<i64>,
    viewer_user_id: Option<i64>,
) -> Result<Vec<api::roblox::UserPresence>, String> {
    let cookie = viewer_user_id
        .and_then(|id| get_cookie(state.inner(), id).ok())
        .filter(|cookie| !cookie.trim().is_empty())
        .or_else(|| {
            state.get_all().ok().and_then(|accounts| {
                accounts
                    .iter()
                    .find(|account| account.valid && !account.security_token.trim().is_empty())
                    .or_else(|| {
                        accounts
                            .iter()
                            .find(|account| !account.security_token.trim().is_empty())
                    })
                    .map(|account| account.security_token.clone())
            })
        });

    match cookie {
        Some(cookie) => match api::roblox::get_presence(&user_ids, Some(&cookie)).await {
            Ok(presences) => Ok(presences),
            Err(_) => api::roblox::get_presence(&user_ids, None).await,
        },
        None => api::roblox::get_presence(&user_ids, None).await,
    }
}

#[tauri::command]
async fn batch_thumbnails(
    requests: Vec<api::roblox::ThumbnailRequest>,
) -> Result<Vec<api::roblox::ThumbnailResponse>, String> {
    api::roblox::batch_thumbnails(requests).await
}

#[tauri::command]
async fn get_avatar_headshots(
    user_ids: Vec<i64>,
    size: String,
) -> Result<Vec<api::roblox::ThumbnailResponse>, String> {
    api::roblox::get_avatar_headshots(&user_ids, &size).await
}

#[tauri::command]
async fn get_asset_thumbnails(
    state: tauri::State<'_, AccountStore>,
    asset_ids: Vec<i64>,
    size: String,
    user_id: Option<i64>,
) -> Result<Vec<api::roblox::ThumbnailResponse>, String> {
    let cookie = user_id.and_then(|id| get_cookie(&state, id).ok());
    api::roblox::get_asset_thumbnails(&asset_ids, &size, cookie.as_deref()).await
}

#[tauri::command]
async fn get_asset_details(
    state: tauri::State<'_, AccountStore>,
    asset_id: i64,
    user_id: Option<i64>,
) -> Result<api::roblox::AssetDetails, String> {
    let cookie = user_id.and_then(|id| get_cookie(&state, id).ok());
    api::roblox::get_asset_details(asset_id, cookie.as_deref()).await
}

#[tauri::command]
async fn purchase_product(
    state: tauri::State<'_, AccountStore>,
    user_id: i64,
    product_id: i64,
    expected_price: i64,
    expected_seller_id: i64,
) -> Result<api::roblox::PurchaseResult, String> {
    run_with_session_retry(state.inner(), user_id, |cookie| async move {
        api::roblox::purchase_product(&cookie, product_id, expected_price, expected_seller_id)
            .await
    })
    .await
}

#[tauri::command]
async fn change_password(
    state: tauri::State<'_, AccountStore>,
    user_id: i64,
    current_password: String,
    new_password: String,
) -> Result<(), String> {
    let new_cookie = run_with_session_retry(state.inner(), user_id, |cookie| {
        let current_password = current_password.clone();
        let new_password = new_password.clone();
        async move { api::auth::change_password(&cookie, &current_password, &new_password).await }
    })
    .await?;

    if let Some(new_cookie) = new_cookie {
        persist_cookie_update(state.inner(), user_id, &new_cookie)?;
    }

    Ok(())
}

#[tauri::command]
async fn change_email(
    state: tauri::State<'_, AccountStore>,
    user_id: i64,
    password: String,
    new_email: String,
) -> Result<(), String> {
    run_with_session_retry(state.inner(), user_id, |cookie| {
        let password = password.clone();
        let new_email = new_email.clone();
        async move { api::auth::change_email(&cookie, &password, &new_email).await }
    })
    .await
}

#[tauri::command]
async fn set_display_name(
    state: tauri::State<'_, AccountStore>,
    user_id: i64,
    display_name: String,
) -> Result<(), String> {
    run_with_session_retry(state.inner(), user_id, |cookie| {
        let display_name = display_name.clone();
        async move { api::auth::set_display_name(&cookie, user_id, &display_name).await }
    })
    .await
}

#[tauri::command]
async fn quick_login_enter_code(
    state: tauri::State<'_, AccountStore>,
    user_id: i64,
    code: String,
) -> Result<serde_json::Value, String> {
    run_with_session_retry(state.inner(), user_id, |cookie| {
        let code = code.clone();
        async move { api::auth::quick_login_enter_code(&cookie, &code).await }
    })
    .await
}

#[tauri::command]
async fn quick_login_validate_code(
    state: tauri::State<'_, AccountStore>,
    user_id: i64,
    code: String,
) -> Result<(), String> {
    run_with_session_retry(state.inner(), user_id, |cookie| {
        let code = code.clone();
        async move { api::auth::quick_login_validate_code(&cookie, &code).await }
    })
    .await
}
