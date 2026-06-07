use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::data::accounts::{Account, AccountStore};
use crate::data::settings::SettingsStore;

use super::cdp::{spawn_chrome, CdpClient};
use super::download::{ensure_chromium, is_installed};
use super::manager::{ChromiumManager, LOGIN_KEY};

const ROBLOX_LOGIN_URL: &str = "https://www.roblox.com/login";
const ROBLOX_HOME_URL: &str = "https://www.roblox.com/home";

fn normalize_security_token(raw: &str) -> String {
    let trimmed = raw.trim();
    let no_name = trimmed.strip_prefix(".ROBLOSECURITY=").unwrap_or(trimmed);
    let no_attrs = no_name.split(';').next().unwrap_or(no_name);
    no_attrs.trim_matches('"').trim().to_string()
}

#[derive(Serialize)]
pub struct ImportedAccount {
    pub user_id: i64,
    pub name: String,
}

#[tauri::command]
pub fn is_browser_ready(app: AppHandle) -> bool {
    is_installed(&app)
}

#[tauri::command]
pub async fn ensure_browser(app: AppHandle) -> Result<(), String> {
    ensure_chromium(&app).await.map(|_| ())
}

#[tauri::command]
pub async fn open_account_browser(
    app: AppHandle,
    state: State<'_, AccountStore>,
    chromium: State<'_, ChromiumManager>,
    settings: State<'_, SettingsStore>,
    user_id: i64,
) -> Result<(), String> {
    let token = {
        let accounts = state.get_all()?;
        let account = accounts
            .iter()
            .find(|a| a.user_id == user_id)
            .ok_or("Account not found")?;
        normalize_security_token(&account.security_token)
    };
    if token.is_empty() {
        return Err("Account has no .ROBLOSECURITY token".into());
    }

    let stealth = settings.get_bool("Login", "StealthMode");
    let binary = ensure_chromium(&app).await?;
    let profile = ChromiumManager::account_profile(&app, user_id)?;

    let (child, port) = spawn_chrome(&binary, &profile, "about:blank", true, stealth).await?;

    let Some(port) = port else {
        let mut child = child;
        if !matches!(child.try_wait(), Ok(Some(_))) {
            chromium.track(user_id, child);
        }
        return Ok(());
    };

    match CdpClient::connect(port).await {
        Ok(mut cdp) => {
            if stealth {
                let _ = cdp.inject_stealth().await;
            }
            let _ = cdp.set_roblosecurity(&token, ".roblox.com").await;
            let _ = cdp.set_roblosecurity(&token, "www.roblox.com").await;
            let _ = cdp.navigate(ROBLOX_HOME_URL).await;
            chromium.track(user_id, child);
            Ok(())
        }
        Err(e) => {
            chromium.track(user_id, child);
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn open_login_browser(
    app: AppHandle,
    chromium: State<'_, ChromiumManager>,
    settings: State<'_, SettingsStore>,
) -> Result<(), String> {
    let binary = ensure_chromium(&app).await?;
    chromium.close_login_session();

    let persistent = settings.get_bool("Login", "PersistentProfile");
    let stealth = settings.get_bool("Login", "StealthMode");

    let profile = ChromiumManager::login_profile(&app)?;
    if !persistent {
        let _ = std::fs::remove_dir_all(&profile);
    }

    let start_url = if persistent || stealth {
        "about:blank"
    } else {
        ROBLOX_LOGIN_URL
    };
    let (child, port) = spawn_chrome(&binary, &profile, start_url, true, stealth).await?;
    chromium.track(LOGIN_KEY, child);

    let port = port.ok_or("Could not start the login browser")?;

    let app_task = app.clone();
    tauri::async_runtime::spawn(async move {
        let Ok(mut cdp) = CdpClient::connect(port).await else {
            return;
        };
        if stealth {
            let _ = cdp.inject_stealth().await;
        }
        if persistent {
            let _ = cdp.delete_roblosecurity(".roblox.com").await;
            let _ = cdp.delete_roblosecurity("www.roblox.com").await;
        }
        if start_url != ROBLOX_LOGIN_URL {
            let _ = cdp.navigate(ROBLOX_LOGIN_URL).await;
        }
        let chromium = app_task.state::<ChromiumManager>();
        for _ in 0..480 {
            if !chromium.is_alive(LOGIN_KEY) {
                return;
            }
            if let Ok(Some(cookie)) = cdp.get_roblosecurity().await {
                chromium.set_login_cookie(Some(cookie));
                let _ = app_task.emit("browser-login-detected", ());
                return;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn extract_browser_cookie(chromium: State<'_, ChromiumManager>) -> Result<String, String> {
    chromium
        .login_cookie()
        .filter(|c| !c.trim().is_empty())
        .ok_or_else(|| "No .ROBLOSECURITY cookie found. Make sure you completed the login.".into())
}

#[tauri::command]
pub async fn close_login_browser(
    app: AppHandle,
    chromium: State<'_, ChromiumManager>,
    settings: State<'_, SettingsStore>,
) -> Result<(), String> {
    chromium.close_login_session();
    if !settings.get_bool("Login", "PersistentProfile") {
        if let Ok(profile) = ChromiumManager::login_profile(&app) {
            let _ = std::fs::remove_dir_all(profile);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn import_userpass(
    app: AppHandle,
    state: State<'_, AccountStore>,
    chromium: State<'_, ChromiumManager>,
    settings: State<'_, SettingsStore>,
    username: String,
    password: String,
) -> Result<ImportedAccount, String> {
    if username.trim().is_empty() || password.is_empty() {
        return Err("Enter a username and password".into());
    }

    let binary = ensure_chromium(&app).await?;
    chromium.close_login_session();

    let persistent = settings.get_bool("Login", "PersistentProfile");
    let stealth = settings.get_bool("Login", "StealthMode");

    let profile = ChromiumManager::login_profile(&app)?;
    if !persistent {
        let _ = std::fs::remove_dir_all(&profile);
    }

    let start_url = if persistent || stealth {
        "about:blank"
    } else {
        ROBLOX_LOGIN_URL
    };
    let (child, port) = spawn_chrome(&binary, &profile, start_url, true, stealth).await?;
    chromium.track(LOGIN_KEY, child);

    let port = port.ok_or("Could not start the login browser")?;
    let mut cdp = CdpClient::connect(port).await?;

    if stealth {
        let _ = cdp.inject_stealth().await;
    }
    if persistent {
        let _ = cdp.delete_roblosecurity(".roblox.com").await;
        let _ = cdp.delete_roblosecurity("www.roblox.com").await;
    }
    if start_url != ROBLOX_LOGIN_URL {
        let _ = cdp.navigate(ROBLOX_LOGIN_URL).await;
    }

    if cdp.wait_for_selector("#login-username", 40).await {
        let _ = cdp.fill_login(&username, &password).await;
    }

    let mut captured = None;
    for _ in 0..480 {
        if !chromium.is_alive(LOGIN_KEY) {
            return Err("Login window was closed before sign-in completed".into());
        }
        if let Ok(Some(cookie)) = cdp.get_roblosecurity().await {
            captured = Some(cookie);
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    chromium.close_login_session();
    if !persistent {
        let _ = std::fs::remove_dir_all(&profile);
    }

    let cookie = captured.ok_or("Timed out waiting for sign-in")?;
    let info = crate::api::auth::validate_cookie(&cookie).await?;

    let mut account = Account::new(cookie, info.name.clone(), info.user_id);
    account.password = password;
    state.add(account)?;

    Ok(ImportedAccount {
        user_id: info.user_id,
        name: info.name,
    })
}
