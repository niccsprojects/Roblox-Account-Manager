use reqwest::header::{COOKIE, REFERER};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::time::sleep;

const REFERER_URL: &str = "https://www.roblox.com/games/2753915549/Blox-Fruits";

fn build_client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36")
        .build()
        .unwrap()
}

fn cookie_header(security_token: &str) -> String {
    format!(".ROBLOSECURITY={}", security_token)
}

fn normalize_quick_login_code(code: &str) -> String {
    code.chars().filter(|c| c.is_ascii_digit()).collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountInfo {
    #[serde(alias = "UserId")]
    pub user_id: i64,
    #[serde(alias = "Name")]
    pub name: String,
    #[serde(alias = "DisplayName")]
    pub display_name: String,
    #[serde(alias = "UserEmail", default)]
    pub user_email: Option<String>,
    #[serde(alias = "IsEmailVerified", default)]
    pub is_email_verified: bool,
    #[serde(alias = "AgeBracket", default)]
    pub age_bracket: i32,
    #[serde(alias = "UserAbove13", default)]
    pub user_above_13: bool,
}

pub async fn validate_cookie(security_token: &str) -> Result<AccountInfo, String> {
    let client = build_client();
    let mut last_error = String::new();
    let mut cookie_rejected = false;

    for attempt in 0..3u32 {
        let retry_delay = Duration::from_millis(400 * 2_u64.pow(attempt));
        match client
            .get("https://www.roblox.com/my/account/json")
            .header(COOKIE, cookie_header(security_token))
            .send()
            .await
        {
            Ok(response) => {
                let status = response.status();
                if status.is_server_error() || status.as_u16() == 429 {
                    last_error = format!("Request failed (status {})", status.as_u16());
                    if attempt < 2 {
                        sleep(retry_delay).await;
                    }
                    continue;
                }
                if !status.is_success() {
                    if status.as_u16() == 401 {
                        last_error = "Invalid cookie (status 401)".to_string();
                        cookie_rejected = true;
                    } else {
                        last_error = format!("Request rejected (status {})", status.as_u16());
                    }
                    break;
                }

                match response.text().await {
                    Ok(body) => match serde_json::from_str::<AccountInfo>(&body) {
                        Ok(info) => return Ok(info),
                        Err(e) => {
                            let preview: String = body.chars().take(200).collect();
                            last_error =
                                format!("Failed to parse account info: {} (body: {})", e, preview);
                            break;
                        }
                    },
                    Err(e) => {
                        last_error = format!("Failed to read response: {}", e);
                        if attempt < 2 {
                            sleep(retry_delay).await;
                        }
                    }
                }
            }
            Err(e) => {
                last_error = format!("Request failed: {}", e);
                if attempt < 2 {
                    sleep(retry_delay).await;
                }
            }
        }
    }

    if cookie_rejected {
        return Err(last_error);
    }

    match validate_cookie_fallback(&client, security_token).await {
        Ok(info) => Ok(info),
        Err(fallback_error) => {
            if fallback_error.starts_with("Invalid cookie") {
                Err(fallback_error)
            } else {
                Err(last_error)
            }
        }
    }
}

async fn validate_cookie_fallback(
    client: &reqwest::Client,
    security_token: &str,
) -> Result<AccountInfo, String> {
    #[derive(Deserialize)]
    struct AuthenticatedUser {
        id: i64,
        name: String,
        #[serde(rename = "displayName")]
        display_name: String,
    }

    let mut last_error = String::new();

    for attempt in 0..3u32 {
        let retry_delay = Duration::from_millis(400 * 2_u64.pow(attempt));
        match client
            .get("https://users.roblox.com/v1/users/authenticated")
            .header(COOKIE, cookie_header(security_token))
            .send()
            .await
        {
            Ok(response) => {
                let status = response.status();
                if status.is_server_error() || status.as_u16() == 429 {
                    last_error = format!("Request failed (status {})", status.as_u16());
                    if attempt < 2 {
                        sleep(retry_delay).await;
                    }
                    continue;
                }
                if status.as_u16() == 401 {
                    return Err("Invalid cookie (status 401)".to_string());
                }
                if !status.is_success() {
                    return Err(format!("Request rejected (status {})", status.as_u16()));
                }

                match response.text().await {
                    Ok(body) => {
                        let user: AuthenticatedUser = serde_json::from_str(&body)
                            .map_err(|e| format!("Failed to parse account info: {}", e))?;

                        return Ok(AccountInfo {
                            user_id: user.id,
                            name: user.name,
                            display_name: user.display_name,
                            user_email: None,
                            is_email_verified: false,
                            age_bracket: 0,
                            user_above_13: true,
                        });
                    }
                    Err(e) => {
                        last_error = format!("Failed to read response: {}", e);
                        if attempt < 2 {
                            sleep(retry_delay).await;
                        }
                    }
                }
            }
            Err(e) => {
                last_error = format!("Request failed: {}", e);
                if attempt < 2 {
                    sleep(retry_delay).await;
                }
            }
        }
    }

    Err(last_error)
}

pub async fn get_csrf_token(security_token: &str) -> Result<String, String> {
    let client = build_client();

    let response = client
        .post("https://auth.roblox.com/v1/authentication-ticket/")
        .header(COOKIE, cookie_header(security_token))
        .header(REFERER, REFERER_URL)
        .header("RBXAuthenticationNegotiation", "1")
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if let Some(token) = response
        .headers()
        .get("x-csrf-token")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
    {
        return Ok(token);
    }

    // Historically Roblox returns 403 and includes the x-csrf-token header.
    // If the status code or behavior changes, surface the response to help debug.
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    Err(format!(
        "[{} {}] {}",
        status.as_u16(),
        status.canonical_reason().unwrap_or(""),
        body
    ))
}

fn next_csrf_from_403(
    status: reqwest::StatusCode,
    headers: &reqwest::header::HeaderMap,
    current: &str,
) -> Option<String> {
    if status.as_u16() != 403 {
        return None;
    }

    headers
        .get("x-csrf-token")
        .and_then(|value| value.to_str().ok())
        .filter(|token| !token.is_empty() && *token != current)
        .map(|token| token.to_string())
}

pub(crate) async fn send_authenticated<F>(
    security_token: &str,
    make_request: F,
) -> Result<reqwest::Response, String>
where
    F: FnMut(&str) -> reqwest::RequestBuilder,
{
    let mut csrf = get_csrf_token(security_token).await?;
    send_with_csrf(&mut csrf, make_request).await
}

pub(crate) async fn send_with_csrf<F>(
    csrf: &mut String,
    mut make_request: F,
) -> Result<reqwest::Response, String>
where
    F: FnMut(&str) -> reqwest::RequestBuilder,
{
    let mut refreshed_csrf = false;
    let mut last_error = String::new();

    for attempt in 0..3 {
        match make_request(csrf.as_str()).send().await {
            Ok(response) => {
                let status = response.status();

                if status.as_u16() == 429 && attempt < 2 {
                    sleep(Duration::from_millis(400 * 2_u64.pow(attempt as u32))).await;
                    continue;
                }

                if !refreshed_csrf && attempt < 2 {
                    if let Some(fresh) = next_csrf_from_403(status, response.headers(), csrf.as_str()) {
                        *csrf = fresh;
                        refreshed_csrf = true;
                        continue;
                    }
                }

                return Ok(response);
            }
            Err(error) => {
                last_error = error.to_string();
                if attempt < 2 {
                    sleep(Duration::from_millis(400 * 2_u64.pow(attempt as u32))).await;
                    continue;
                }
            }
        }
    }

    Err(format!("Request failed: {}", last_error))
}

pub async fn get_auth_ticket(security_token: &str) -> Result<String, String> {
    let client = build_client();

    let response = send_authenticated(security_token, |csrf| {
        client
            .post("https://auth.roblox.com/v1/authentication-ticket/")
            .header(COOKIE, cookie_header(security_token))
            .header("x-csrf-token", csrf)
            .header(REFERER, REFERER_URL)
            .header("RBXAuthenticationNegotiation", "1")
            .header("Content-Type", "application/json")
            .body("")
    })
    .await?;

    if let Some(ticket) = response
        .headers()
        .get("rbx-authentication-ticket")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
    {
        return Ok(ticket);
    }

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    Err(format!(
        "Failed to get authentication ticket (status {}): {}",
        status.as_u16(),
        body
    ))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PinInfo {
    #[serde(rename = "isEnabled")]
    pub is_enabled: bool,
    #[serde(rename = "unlockedUntil", default)]
    pub unlocked_until: Option<serde_json::Value>,
}

pub async fn check_pin(security_token: &str) -> Result<bool, String> {
    let _csrf = get_csrf_token(security_token).await?;

    let client = build_client();

    let response = client
        .get("https://auth.roblox.com/v1/account/pin/")
        .header(COOKIE, cookie_header(security_token))
        .header(REFERER, "https://www.roblox.com/")
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to check pin (status {})",
            response.status().as_u16()
        ));
    }

    let info: PinInfo = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse pin info: {}", e))?;

    if !info.is_enabled {
        return Ok(true);
    }

    match &info.unlocked_until {
        Some(serde_json::Value::Number(n)) if n.as_i64().unwrap_or(0) > 0 => Ok(true),
        _ => Ok(false),
    }
}

pub async fn unlock_pin(security_token: &str, pin: &str) -> Result<bool, String> {
    if pin.len() != 4 {
        return Err("Pin must be 4 digits".to_string());
    }

    let client = build_client();

    let response = send_authenticated(security_token, |csrf| {
        client
            .post("https://auth.roblox.com/v1/account/pin/unlock")
            .header(COOKIE, cookie_header(security_token))
            .header(REFERER, "https://www.roblox.com/")
            .header("X-CSRF-TOKEN", csrf)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(format!("pin={}", pin))
    })
    .await?;

    if !response.status().is_success() {
        return Ok(false);
    }

    let info: PinInfo = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse pin response: {}", e))?;

    Ok(info.is_enabled
        && matches!(&info.unlocked_until, Some(serde_json::Value::Number(n)) if n.as_i64().unwrap_or(0) > 0))
}

pub struct RefreshResult {
    pub success: bool,
    pub new_cookie: Option<String>,
}

pub async fn log_out_other_sessions(security_token: &str) -> Result<RefreshResult, String> {
    let client = build_client();

    let response = send_authenticated(security_token, |csrf| {
        client
            .post("https://www.roblox.com/authentication/signoutfromallsessionsandreauthenticate")
            .header(COOKIE, cookie_header(security_token))
            .header(REFERER, "https://www.roblox.com/")
            .header("X-CSRF-TOKEN", csrf)
            .header("Content-Type", "application/x-www-form-urlencoded")
    })
    .await?;

    // Roblox may return redirects for this endpoint while still setting cookies.
    if !(response.status().is_success() || response.status().is_redirection()) {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "Failed to sign out other sessions (status {}): {}",
            status.as_u16(),
            body
        ));
    }

    let new_cookie = response
        .headers()
        .get_all("set-cookie")
        .iter()
        .find_map(|v| {
            let s = v.to_str().ok()?;
            if s.starts_with(".ROBLOSECURITY=") {
                let value = s.strip_prefix(".ROBLOSECURITY=")?;
                let value = value.split(';').next()?;
                Some(value.to_string())
            } else {
                None
            }
        });

    Ok(RefreshResult {
        success: true,
        new_cookie,
    })
}

pub async fn change_password(
    security_token: &str,
    current_password: &str,
    new_password: &str,
) -> Result<Option<String>, String> {
    let client = build_client();

    let response = send_authenticated(security_token, |csrf| {
        client
            .post("https://auth.roblox.com/v2/user/passwords/change")
            .header(COOKIE, cookie_header(security_token))
            .header(REFERER, "https://www.roblox.com/")
            .header("X-CSRF-TOKEN", csrf)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(format!(
                "currentPassword={}&newPassword={}",
                urlencoding::encode(current_password),
                urlencoding::encode(new_password)
            ))
    })
    .await?;

    if !response.status().is_success() {
        return Err("Failed to change password".to_string());
    }

    let new_cookie = response
        .headers()
        .get_all("set-cookie")
        .iter()
        .find_map(|v| {
            let s = v.to_str().ok()?;
            if s.starts_with(".ROBLOSECURITY=") {
                let value = s.strip_prefix(".ROBLOSECURITY=")?;
                let value = value.split(';').next()?;
                Some(value.to_string())
            } else {
                None
            }
        });

    Ok(new_cookie)
}

pub async fn change_email(
    security_token: &str,
    password: &str,
    new_email: &str,
) -> Result<(), String> {
    let client = build_client();

    let response = send_authenticated(security_token, |csrf| {
        client
            .post("https://accountsettings.roblox.com/v1/email")
            .header(COOKIE, cookie_header(security_token))
            .header(REFERER, "https://www.roblox.com/")
            .header("X-CSRF-TOKEN", csrf)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(format!(
                "password={}&emailAddress={}",
                urlencoding::encode(password),
                urlencoding::encode(new_email)
            ))
    })
    .await?;

    if response.status().is_success() {
        Ok(())
    } else {
        Err("Failed to change email".to_string())
    }
}

pub async fn quick_login_enter_code(
    security_token: &str,
    code: &str,
) -> Result<serde_json::Value, String> {
    let normalized_code = normalize_quick_login_code(code);
    if normalized_code.len() != 6 {
        return Err("Code must be 6 digits".to_string());
    }

    let client = build_client();

    let response = send_authenticated(security_token, |csrf| {
        client
            .post("https://apis.roblox.com/auth-token-service/v1/login/enterCode")
            .header(COOKIE, cookie_header(security_token))
            .header("X-CSRF-TOKEN", csrf)
            .json(&serde_json::json!({ "code": normalized_code }))
    })
    .await?;

    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Failed to enter code: {}", body));
    }

    response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))
}

pub async fn quick_login_validate_code(security_token: &str, code: &str) -> Result<(), String> {
    let normalized_code = normalize_quick_login_code(code);
    if normalized_code.len() != 6 {
        return Err("Code must be 6 digits".to_string());
    }

    let client = build_client();

    let response = send_authenticated(security_token, |csrf| {
        client
            .post("https://apis.roblox.com/auth-token-service/v1/login/validateCode")
            .header(COOKIE, cookie_header(security_token))
            .header("X-CSRF-TOKEN", csrf)
            .json(&serde_json::json!({ "code": normalized_code }))
    })
    .await?;

    if response.status().is_success() {
        Ok(())
    } else {
        Err("Failed to validate code".to_string())
    }
}

pub async fn set_display_name(
    security_token: &str,
    user_id: i64,
    display_name: &str,
) -> Result<(), String> {
    let client = build_client();

    let response = send_authenticated(security_token, |csrf| {
        client
            .patch(&format!(
                "https://users.roblox.com/v1/users/{}/display-names",
                user_id
            ))
            .header(COOKIE, cookie_header(security_token))
            .header("X-CSRF-TOKEN", csrf)
            .json(&serde_json::json!({ "newDisplayName": display_name }))
    })
    .await?;

    if response.status().is_success() {
        Ok(())
    } else {
        let body = response.text().await.unwrap_or_default();
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
            if let Some(msg) = json["errors"][0]["message"].as_str() {
                return Err(msg.to_string());
            }
        }
        Err(format!("Failed to set display name: {}", body))
    }
}

#[cfg(test)]
mod tests {
    use super::next_csrf_from_403;
    use reqwest::header::{HeaderMap, HeaderValue};
    use reqwest::StatusCode;

    fn headers_with_token(token: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("x-csrf-token", HeaderValue::from_str(token).unwrap());
        headers
    }

    #[test]
    fn refreshes_on_403_with_new_token() {
        let headers = headers_with_token("fresh-token");
        assert_eq!(
            next_csrf_from_403(StatusCode::FORBIDDEN, &headers, "stale-token"),
            Some("fresh-token".to_string())
        );
    }

    #[test]
    fn ignores_non_403_status() {
        let headers = headers_with_token("fresh-token");
        assert_eq!(
            next_csrf_from_403(StatusCode::OK, &headers, "stale-token"),
            None
        );
    }

    #[test]
    fn ignores_403_without_token_header() {
        assert_eq!(
            next_csrf_from_403(StatusCode::FORBIDDEN, &HeaderMap::new(), "stale-token"),
            None
        );
    }

    #[test]
    fn ignores_403_with_unchanged_token() {
        let headers = headers_with_token("same-token");
        assert_eq!(
            next_csrf_from_403(StatusCode::FORBIDDEN, &headers, "same-token"),
            None
        );
    }
}
