async fn handle_get_alias(
    Extension(state): Extension<AppState>,
    Query(params): Query<AccountQuery>,
    v2: bool,
) -> Response {
    if !state.settings.get_bool("WebServer", "AllowGetAccounts") {
        return reply(401, "AllowGetAccounts is disabled", v2);
    }

    if !check_password(&state, &params.password) {
        return reply(401, "Invalid password", v2);
    }

    let identifier = match params.account {
        Some(ref a) if !a.is_empty() => a,
        _ => return reply(400, "Missing Account parameter", v2),
    };

    let accounts = match state.accounts.get_all() {
        Ok(a) => a,
        Err(e) => return reply(500, &e, v2),
    };

    match find_account(&accounts, identifier) {
        Some(account) => reply(200, &account.alias, v2),
        None => reply(404, "Account not found", v2),
    }
}

async fn handle_get_description(
    Extension(state): Extension<AppState>,
    Query(params): Query<AccountQuery>,
    v2: bool,
) -> Response {
    if !state.settings.get_bool("WebServer", "AllowGetAccounts") {
        return reply(401, "AllowGetAccounts is disabled", v2);
    }

    if !check_password(&state, &params.password) {
        return reply(401, "Invalid password", v2);
    }

    let identifier = match params.account {
        Some(ref a) if !a.is_empty() => a,
        _ => return reply(400, "Missing Account parameter", v2),
    };

    let accounts = match state.accounts.get_all() {
        Ok(a) => a,
        Err(e) => return reply(500, &e, v2),
    };

    match find_account(&accounts, identifier) {
        Some(account) => reply(200, &account.description, v2),
        None => reply(404, "Account not found", v2),
    }
}

async fn handle_get_field(
    Extension(state): Extension<AppState>,
    Query(params): Query<AccountQuery>,
    v2: bool,
) -> Response {
    if !state.settings.get_bool("WebServer", "AllowGetAccounts") {
        return reply(401, "AllowGetAccounts is disabled", v2);
    }

    if !check_password(&state, &params.password) {
        return reply(401, "Invalid password", v2);
    }

    let identifier = match params.account {
        Some(ref a) if !a.is_empty() => a,
        _ => return reply(400, "Missing Account parameter", v2),
    };

    let field_name = match params.field {
        Some(ref f) if !f.is_empty() => f,
        _ => return reply(400, "Missing Field parameter", v2),
    };

    let accounts = match state.accounts.get_all() {
        Ok(a) => a,
        Err(e) => return reply(500, &e, v2),
    };

    match find_account(&accounts, identifier) {
        Some(account) => {
            let value = account.fields.get(field_name.as_str()).map(|v| v.as_str()).unwrap_or("");
            reply(200, value, v2)
        }
        None => reply(404, "Account not found", v2),
    }
}

async fn handle_set_field(
    Extension(state): Extension<AppState>,
    Query(params): Query<AccountQuery>,
    v2: bool,
) -> Response {
    if !state.settings.get_bool("WebServer", "AllowAccountEditing") {
        return reply(401, "AllowAccountEditing is disabled", v2);
    }

    let identifier = match params.account {
        Some(ref a) if !a.is_empty() => a,
        _ => return reply(400, "Missing Account parameter", v2),
    };

    let field_name = match params.field {
        Some(ref f) if !f.is_empty() => f.clone(),
        _ => return reply(400, "Missing Field parameter", v2),
    };

    let field_value = match params.value {
        Some(ref v) => v.clone(),
        None => return reply(400, "Missing Value parameter", v2),
    };

    let accounts = match state.accounts.get_all() {
        Ok(a) => a,
        Err(e) => return reply(500, &e, v2),
    };

    let mut account = match find_account(&accounts, identifier) {
        Some(a) => a,
        None => return reply(404, "Account not found", v2),
    };

    account.set_field(field_name, field_value);
    match state.accounts.update(account) {
        Ok(_) => reply(200, "Field set successfully", v2),
        Err(e) => reply(500, &e, v2),
    }
}

async fn handle_remove_field(
    Extension(state): Extension<AppState>,
    Query(params): Query<AccountQuery>,
    v2: bool,
) -> Response {
    if !state.settings.get_bool("WebServer", "AllowAccountEditing") {
        return reply(401, "AllowAccountEditing is disabled", v2);
    }

    let identifier = match params.account {
        Some(ref a) if !a.is_empty() => a,
        _ => return reply(400, "Missing Account parameter", v2),
    };

    let field_name = match params.field {
        Some(ref f) if !f.is_empty() => f,
        _ => return reply(400, "Missing Field parameter", v2),
    };

    let accounts = match state.accounts.get_all() {
        Ok(a) => a,
        Err(e) => return reply(500, &e, v2),
    };

    let mut account = match find_account(&accounts, identifier) {
        Some(a) => a,
        None => return reply(404, "Account not found", v2),
    };

    account.remove_field(field_name);
    match state.accounts.update(account) {
        Ok(_) => reply(200, "Field removed successfully", v2),
        Err(e) => reply(500, &e, v2),
    }
}

async fn handle_set_alias(
    Extension(state): Extension<AppState>,
    Query(params): Query<AccountQuery>,
    body: String,
    v2: bool,
) -> Response {
    if !state.settings.get_bool("WebServer", "AllowAccountEditing") {
        return reply(401, "AllowAccountEditing is disabled", v2);
    }

    let identifier = match params.account {
        Some(ref a) if !a.is_empty() => a,
        _ => return reply(400, "Missing Account parameter", v2),
    };

    if body.is_empty() {
        return reply(400, "Missing body", v2);
    }

    let accounts = match state.accounts.get_all() {
        Ok(a) => a,
        Err(e) => return reply(500, &e, v2),
    };

    let mut account = match find_account(&accounts, identifier) {
        Some(a) => a,
        None => return reply(404, "Account not found", v2),
    };

    account.alias = body;
    match state.accounts.update(account) {
        Ok(_) => reply(200, "Alias set successfully", v2),
        Err(e) => reply(500, &e, v2),
    }
}

async fn handle_set_description(
    Extension(state): Extension<AppState>,
    Query(params): Query<AccountQuery>,
    body: String,
    v2: bool,
) -> Response {
    if !state.settings.get_bool("WebServer", "AllowAccountEditing") {
        return reply(401, "AllowAccountEditing is disabled", v2);
    }

    let identifier = match params.account {
        Some(ref a) if !a.is_empty() => a,
        _ => return reply(400, "Missing Account parameter", v2),
    };

    if body.is_empty() {
        return reply(400, "Missing body", v2);
    }

    let accounts = match state.accounts.get_all() {
        Ok(a) => a,
        Err(e) => return reply(500, &e, v2),
    };

    let mut account = match find_account(&accounts, identifier) {
        Some(a) => a,
        None => return reply(404, "Account not found", v2),
    };

    account.description = body;
    match state.accounts.update(account) {
        Ok(_) => reply(200, "Description set successfully", v2),
        Err(e) => reply(500, &e, v2),
    }
}

async fn handle_append_description(
    Extension(state): Extension<AppState>,
    Query(params): Query<AccountQuery>,
    body: String,
    v2: bool,
) -> Response {
    if !state.settings.get_bool("WebServer", "AllowAccountEditing") {
        return reply(401, "AllowAccountEditing is disabled", v2);
    }

    let identifier = match params.account {
        Some(ref a) if !a.is_empty() => a,
        _ => return reply(400, "Missing Account parameter", v2),
    };

    if body.is_empty() {
        return reply(400, "Missing body", v2);
    }

    let accounts = match state.accounts.get_all() {
        Ok(a) => a,
        Err(e) => return reply(500, &e, v2),
    };

    let mut account = match find_account(&accounts, identifier) {
        Some(a) => a,
        None => return reply(404, "Account not found", v2),
    };

    account.description.push_str(&body);
    match state.accounts.update(account) {
        Ok(_) => reply(200, "Description appended successfully", v2),
        Err(e) => reply(500, &e, v2),
    }
}

async fn handle_set_avatar(
    Extension(state): Extension<AppState>,
    Query(params): Query<AccountQuery>,
    body: String,
    v2: bool,
) -> Response {
    let identifier = match params.account {
        Some(ref a) if !a.is_empty() => a,
        _ => return reply(400, "Missing Account parameter", v2),
    };

    let avatar_json: serde_json::Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(_) => return reply(400, "Invalid JSON body", v2),
    };

    let accounts = match state.accounts.get_all() {
        Ok(a) => a,
        Err(e) => return reply(500, &e, v2),
    };

    let account = match find_account(&accounts, identifier) {
        Some(a) => a,
        None => return reply(404, "Account not found", v2),
    };

    match roblox::set_avatar(&account.security_token, avatar_json).await {
        Ok(_) => reply(200, "Avatar set successfully", v2),
        Err(e) => reply(400, &e, v2),
    }
}

async fn handle_block_user(
    Extension(state): Extension<AppState>,
    Query(params): Query<AccountQuery>,
    v2: bool,
) -> Response {
    let identifier = match params.account {
        Some(ref a) if !a.is_empty() => a,
        _ => return reply(400, "Missing Account parameter", v2),
    };

    let target_user_id: i64 = match params.user_id.as_deref().and_then(|v| v.parse().ok()) {
        Some(id) => id,
        None => return reply(400, "Missing or invalid UserId parameter", v2),
    };

    let accounts = match state.accounts.get_all() {
        Ok(a) => a,
        Err(e) => return reply(500, &e, v2),
    };

    let account = match find_account(&accounts, identifier) {
        Some(a) => a,
        None => return reply(404, "Account not found", v2),
    };

    match roblox::block_user(&account.security_token, target_user_id).await {
        Ok(_) => reply(200, "User blocked successfully", v2),
        Err(e) => reply(500, &e, v2),
    }
}

async fn handle_unblock_user(
    Extension(state): Extension<AppState>,
    Query(params): Query<AccountQuery>,
    v2: bool,
) -> Response {
    let identifier = match params.account {
        Some(ref a) if !a.is_empty() => a,
        _ => return reply(400, "Missing Account parameter", v2),
    };

    let target_user_id: i64 = match params.user_id.as_deref().and_then(|v| v.parse().ok()) {
        Some(id) => id,
        None => return reply(400, "Missing or invalid UserId parameter", v2),
    };

    let accounts = match state.accounts.get_all() {
        Ok(a) => a,
        Err(e) => return reply(500, &e, v2),
    };

    let account = match find_account(&accounts, identifier) {
        Some(a) => a,
        None => return reply(404, "Account not found", v2),
    };

    match roblox::unblock_user(&account.security_token, target_user_id).await {
        Ok(_) => reply(200, "User unblocked successfully", v2),
        Err(e) => reply(500, &e, v2),
    }
}

async fn handle_get_blocked_list(
    Extension(state): Extension<AppState>,
    Query(params): Query<AccountQuery>,
    v2: bool,
) -> Response {
    let identifier = match params.account {
        Some(ref a) if !a.is_empty() => a,
        _ => return reply(400, "Missing Account parameter", v2),
    };

    let accounts = match state.accounts.get_all() {
        Ok(a) => a,
        Err(e) => return reply(500, &e, v2),
    };

    let account = match find_account(&accounts, identifier) {
        Some(a) => a,
        None => return reply(404, "Account not found", v2),
    };

    match roblox::get_blocked_users(&account.security_token).await {
        Ok(blocked) => {
            let body = serde_json::to_string(&blocked).unwrap_or_else(|_| "[]".to_string());
            if v2 {
                let wrapper = serde_json::json!({
                    "Success": true,
                    "Message": blocked,
                });
                Response::builder()
                    .status(200)
                    .header("content-type", "application/json; charset=utf-8")
                    .body(Body::from(wrapper.to_string()))
                    .unwrap()
            } else {
                Response::builder()
                    .status(200)
                    .header("content-type", "application/json; charset=utf-8")
                    .body(Body::from(body))
                    .unwrap()
            }
        }
        Err(e) => reply(500, &e, v2),
    }
}

async fn handle_unblock_everyone(
    Extension(state): Extension<AppState>,
    Query(params): Query<AccountQuery>,
    v2: bool,
) -> Response {
    let identifier = match params.account {
        Some(ref a) if !a.is_empty() => a,
        _ => return reply(400, "Missing Account parameter", v2),
    };

    let accounts = match state.accounts.get_all() {
        Ok(a) => a,
        Err(e) => return reply(500, &e, v2),
    };

    let account = match find_account(&accounts, identifier) {
        Some(a) => a,
        None => return reply(404, "Account not found", v2),
    };

    match roblox::unblock_all_users(&account.security_token).await {
        Ok(count) => reply(200, &format!("Unblocked {} users", count), v2),
        Err(e) => reply(500, &e, v2),
    }
}

fn check_password(state: &AppState, password: &Option<String>) -> bool {
    let ws_password = state.settings.get_string("WebServer", "Password");
    let every_request_requires_password = state
        .settings
        .get_bool("WebServer", "EveryRequestRequiresPassword");

    if ws_password.len() < 6 {
        return false;
    }

    if every_request_requires_password {
        return matches!(password, Some(p) if *p == ws_password);
    }

    match password {
        Some(p) => *p == ws_password,
        None => true,
    }
}

