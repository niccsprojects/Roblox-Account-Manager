use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Child;
use std::sync::Mutex;

use tauri::AppHandle;

use super::download;

pub const LOGIN_KEY: i64 = i64::MIN;

#[derive(Default)]
pub struct ChromiumManager {
    children: Mutex<HashMap<i64, Child>>,
    login_cookie: Mutex<Option<String>>,
}

impl ChromiumManager {
    pub fn new() -> Self {
        Self::default()
    }

    fn profiles_root(app: &AppHandle) -> Result<PathBuf, String> {
        Ok(download::chromium_dir(app)?
            .parent()
            .ok_or("Could not resolve data directory")?
            .join("chromium-profiles"))
    }

    pub fn account_profile(app: &AppHandle, user_id: i64) -> Result<PathBuf, String> {
        Ok(Self::profiles_root(app)?.join(user_id.to_string()))
    }

    pub fn login_profile(app: &AppHandle) -> Result<PathBuf, String> {
        Ok(Self::profiles_root(app)?.join("_login"))
    }

    pub fn is_alive(&self, user_id: i64) -> bool {
        let mut children = self.children.lock().unwrap();
        match children.get_mut(&user_id) {
            Some(child) => matches!(child.try_wait(), Ok(None)),
            None => false,
        }
    }

    pub fn track(&self, user_id: i64, child: Child) {
        let mut children = self.children.lock().unwrap();
        if let Some(mut old) = children.insert(user_id, child) {
            let _ = old.kill();
            let _ = old.wait();
        }
    }

    pub fn kill(&self, user_id: i64) {
        let child = self.children.lock().unwrap().remove(&user_id);
        if let Some(mut child) = child {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    pub fn close_login_session(&self) {
        self.kill(LOGIN_KEY);
        *self.login_cookie.lock().unwrap() = None;
    }

    pub fn set_login_cookie(&self, cookie: Option<String>) {
        *self.login_cookie.lock().unwrap() = cookie;
    }

    pub fn login_cookie(&self) -> Option<String> {
        self.login_cookie.lock().unwrap().clone()
    }
}
