use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use cookie::Cookie;
use tauri::{AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindowBuilder};

use crate::data::accounts::AccountStore;

const AUTH_POLL_JS: &str = r#"
if (!window.__ramPoll) {
    window.__ramPoll = true;
    (async function check() {
        try {
            var r = await fetch('https://users.roblox.com/v1/users/authenticated', {credentials: 'include'});
            if (r.ok) {
                window.location.href = 'https://www.roblox.com/home';
                return;
            }
        } catch (e) {}
        setTimeout(check, 2000);
    })();
}
"#;

fn find_roblosecurity_tauri(app: &AppHandle) -> Option<String> {
    let browser = app.get_webview_window("login-browser")?;
    let urls: [&str; 2] = [
        "https://www.roblox.com",
        "https://www.roblox.com/home",
    ];
    for raw in urls {
        if let Ok(url) = raw.parse::<Url>() {
            if let Ok(cookies) = browser.cookies_for_url(url) {
                if let Some(c) = cookies
                    .iter()
                    .find(|c| c.name() == ".ROBLOSECURITY" && !c.value().is_empty())
                {
                    return Some(c.value().to_string());
                }
            }
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn find_roblosecurity_native() -> Option<String> {
    use objc2_app_kit::NSApplication;
    use objc2::MainThreadMarker;
    use objc2_foundation::NSHTTPCookieStorage;

    unsafe {
        let shared = NSHTTPCookieStorage::sharedHTTPCookieStorage();
        if let Some(cookies) = shared.cookies() {
            for cookie in cookies.iter() {
                let name = cookie.name().to_string();
                if name == ".ROBLOSECURITY" {
                    let value = cookie.value().to_string();
                    if !value.is_empty() {
                        return Some(value);
                    }
                }
            }
        }
    }

    if let Some(mtm) = MainThreadMarker::new() {
        let app = NSApplication::sharedApplication(mtm);
        let windows = app.windows();
        for window in windows.iter() {
            let title = window.title().to_string();
            if !title.contains("Roblox Login") {
                continue;
            }
            if let Some(cv) = window.contentView() {
                if let Some(val) = extract_from_view_hierarchy(&cv) {
                    return Some(val);
                }
            }
        }
    }

    None
}

#[cfg(target_os = "macos")]
fn extract_from_view_hierarchy(view: &objc2_app_kit::NSView) -> Option<String> {
    use objc2::ClassType;
    use objc2_web_kit::WKWebView;
    use std::sync::mpsc;

    unsafe {
        let obj: &objc2::runtime::AnyObject = &*(view as *const _ as *const _);
        if obj.class() == WKWebView::class() {
            let webview: &WKWebView = &*(view as *const _ as *const WKWebView);
            let config = webview.configuration();
            let store = config.websiteDataStore();
            let cookie_store = store.httpCookieStore();

            let (tx, rx) = mpsc::sync_channel::<Option<String>>(1);
            let block =
                block2::RcBlock::new(move |cookies: std::ptr::NonNull<objc2_foundation::NSArray<objc2_foundation::NSHTTPCookie>>| {
                    let cookies = cookies.as_ref();
                    for c in cookies.iter() {
                        if c.name().to_string() == ".ROBLOSECURITY" {
                            let v = c.value().to_string();
                            if !v.is_empty() {
                                let _ = tx.send(Some(v));
                                return;
                            }
                        }
                    }
                    let _ = tx.send(None);
                });
            cookie_store.getAllCookies(&block);
            return rx.recv_timeout(Duration::from_secs(5)).ok().flatten();
        }

        for sub in view.subviews().iter() {
            if let Some(val) = extract_from_view_hierarchy(&sub) {
                return Some(val);
            }
        }
    }
    None
}

#[cfg(not(target_os = "macos"))]
fn find_roblosecurity_native() -> Option<String> {
    None
}

fn find_roblosecurity(app: &AppHandle) -> Option<String> {
    if let Some(v) = find_roblosecurity_tauri(app) {
        return Some(v);
    }
    find_roblosecurity_native()
}

async fn extract_and_emit_cookie(app: AppHandle) {
    tokio::time::sleep(Duration::from_millis(800)).await;

    for _ in 0..30 {
        let Some(_) = app.get_webview_window("login-browser") else {
            app.emit("browser-login-failed", "Browser window closed").ok();
            return;
        };

        if let Some(cookie) = find_roblosecurity(&app) {
            app.emit("browser-login-complete", cookie).ok();
            return;
        }

        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    app.emit(
        "browser-login-failed",
        "No .ROBLOSECURITY cookie found after login. Please try again.",
    )
    .ok();
}

#[tauri::command]
pub async fn open_login_browser(app: AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("login-browser") {
        existing.close().map_err(|e| e.to_string())?;
    }

    let detected = Arc::new(AtomicBool::new(false));
    let detected_nav = detected.clone();
    let app_nav = app.clone();

    WebviewWindowBuilder::new(
        &app,
        "login-browser",
        WebviewUrl::External("https://www.roblox.com/login".parse().unwrap()),
    )
    .title("Roblox Login")
    .inner_size(900.0, 720.0)
    .center()
    .on_navigation(move |url| {
        if let Some(host) = url.host_str() {
            let path = url.path();
            let is_roblox = host.ends_with("roblox.com");
            let is_post_auth = path == "/home"
                || path.starts_with("/home/")
                || path.starts_with("/discover")
                || path.starts_with("/games")
                || path.starts_with("/experiences");

            if is_roblox
                && is_post_auth
                && !detected_nav.swap(true, Ordering::SeqCst)
            {
                let h = app_nav.clone();
                tauri::async_runtime::spawn(extract_and_emit_cookie(h));
            }
        }
        true
    })
    .build()
    .map_err(|e| e.to_string())?;

    let poll_detected = detected.clone();
    let poll_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut js_injected = false;

        for i in 0..240 {
            if poll_detected.load(Ordering::SeqCst) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(750)).await;

            let Some(browser) = poll_app.get_webview_window("login-browser") else {
                return;
            };

            if !js_injected && i >= 4 {
                let _ = browser.eval(AUTH_POLL_JS);
                js_injected = true;
            }

            if find_roblosecurity(&poll_app).is_some()
                && !poll_detected.swap(true, Ordering::SeqCst)
            {
                tauri::async_runtime::spawn(extract_and_emit_cookie(poll_app.clone()));
                return;
            }
        }

        if !poll_detected.load(Ordering::SeqCst) {
            poll_app
                .emit("browser-login-failed", "Login timed out. Please try again.")
                .ok();
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn extract_browser_cookie(app: AppHandle) -> Result<String, String> {
    find_roblosecurity(&app)
        .ok_or_else(|| "No .ROBLOSECURITY cookie found. Make sure you completed the login.".into())
}

#[tauri::command]
pub async fn close_login_browser(app: AppHandle) -> Result<(), String> {
    if let Some(browser) = app.get_webview_window("login-browser") {
        browser.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn open_account_browser(
    app: AppHandle,
    state: tauri::State<'_, AccountStore>,
    user_id: i64,
) -> Result<(), String> {
    let accounts = state.get_all()?;
    let account = accounts
        .iter()
        .find(|a| a.user_id == user_id)
        .ok_or("Account not found")?;

    let security_token = account.security_token.clone();
    let username = account.username.clone();
    let label = format!("account-browser-{}", user_id);

    if let Some(existing) = app.get_webview_window(&label) {
        existing.close().map_err(|e| e.to_string())?;
    }

    let browser = WebviewWindowBuilder::new(
        &app,
        &label,
        WebviewUrl::External("about:blank".parse().unwrap()),
    )
    .title(format!("Roblox — {}", username))
    .inner_size(1100.0, 750.0)
    .center()
    .build()
    .map_err(|e| e.to_string())?;

    let cookie = Cookie::build((".ROBLOSECURITY", security_token))
        .domain(".roblox.com")
        .path("/")
        .secure(true)
        .http_only(true)
        .build();

    browser.set_cookie(cookie).map_err(|e| e.to_string())?;
    browser
        .eval("window.location.href = 'https://www.roblox.com/home'")
        .map_err(|e| e.to_string())?;

    Ok(())
}
