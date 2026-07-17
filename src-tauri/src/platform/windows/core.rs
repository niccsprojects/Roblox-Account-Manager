struct SendHandle(HANDLE);
unsafe impl Send for SendHandle {}

static MULTI_ROBLOX_HANDLE: Mutex<Option<SendHandle>> = Mutex::new(None);
static COOKIES_LOCK_HANDLE: Mutex<Option<SendHandle>> = Mutex::new(None);
static TRACKER: LazyLock<ProcessTracker> = LazyLock::new(ProcessTracker::new);

fn encode_wide(s: impl AsRef<OsStr>) -> Vec<u16> {
    s.as_ref().encode_wide().chain(std::iter::once(0)).collect()
}

pub fn tracker() -> &'static ProcessTracker {
    &TRACKER
}

pub fn generate_browser_tracker_id() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let a = (now % 75000 + 100000) as u64;
    let b = ((now / 31) % 800000 + 100000) as u64;
    format!("{}{}", a, b)
}

pub fn enable_multi_roblox() -> Result<bool, String> {
    let mut handle = MULTI_ROBLOX_HANDLE.lock().map_err(|e| e.to_string())?;
    if handle.is_none() {
        let name = encode_wide("ROBLOX_singletonMutex");
        unsafe {
            let h = CreateMutexW(std::ptr::null(), 1, name.as_ptr());
            if h.is_null() {
                return Err("Failed to create mutex".into());
            }
            let result = WaitForSingleObject(h, 0);
            if result != WAIT_OBJECT_0 && result != WAIT_ABANDONED_0 {
                CloseHandle(h);
                return Ok(false);
            }
            *handle = Some(SendHandle(h));
        }
    }
    drop(handle);

    lock_roblox_cookies()?;
    Ok(true)
}

pub fn release_multi_roblox_handle() {
    if let Ok(mut handle) = MULTI_ROBLOX_HANDLE.lock() {
        if let Some(SendHandle(h)) = handle.take() {
            unsafe {
                ReleaseMutex(h);
                CloseHandle(h);
            }
        }
    }
    if let Ok(mut cookie_handle) = COOKIES_LOCK_HANDLE.lock() {
        if let Some(SendHandle(h)) = cookie_handle.take() {
            unsafe {
                CloseHandle(h);
            }
        }
    }
}

pub fn multi_roblox_mutex_exists() -> bool {
    if this_process_holds_multi_roblox() {
        return true;
    }
    let name = encode_wide("ROBLOX_singletonMutex");
    unsafe {
        let h = CreateMutexW(std::ptr::null(), 0, name.as_ptr());
        if h.is_null() {
            return false;
        }
        let existed = GetLastError() == ERROR_ALREADY_EXISTS;
        CloseHandle(h);
        existed
    }
}

pub fn this_process_holds_multi_roblox() -> bool {
    MULTI_ROBLOX_HANDLE
        .lock()
        .map(|g| g.is_some())
        .unwrap_or(false)
}

pub fn disable_multi_roblox() -> Result<(), String> {
    let mut handle = MULTI_ROBLOX_HANDLE.lock().map_err(|e| e.to_string())?;
    if let Some(SendHandle(h)) = handle.take() {
        unsafe {
            ReleaseMutex(h);
            CloseHandle(h);
        }
    }
    drop(handle);

    lock_roblox_cookies()?;
    Ok(())
}

fn lock_roblox_cookies() -> Result<(), String> {
    let mut handle = COOKIES_LOCK_HANDLE.lock().map_err(|e| e.to_string())?;
    if handle.is_some() || is_773_fix_disabled() {
        return Ok(());
    }

    let Some(path) = get_roblox_cookies_path() else {
        return Ok(());
    };

    let wide = encode_wide(path.as_os_str());
    unsafe {
        let cookie_handle = CreateFileW(
            wide.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        );
        if cookie_handle == INVALID_HANDLE_VALUE {
            eprintln!("Warning: Could not lock RobloxCookies.dat for the 773 fix");
            return Ok(());
        }
        *handle = Some(SendHandle(cookie_handle));
    }

    Ok(())
}

fn get_roblox_cookies_path() -> Option<PathBuf> {
    let local_app_data = std::env::var_os("LOCALAPPDATA")?;
    let path = PathBuf::from(local_app_data)
        .join("Roblox")
        .join("LocalStorage")
        .join("RobloxCookies.dat");
    path.exists().then_some(path)
}

fn is_773_fix_disabled() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|dir| dir.join("no773fix.txt")))
        .map(|path| path.exists())
        .unwrap_or(false)
}

static CUSTOM_ROBLOX_PATH: Mutex<Option<String>> = Mutex::new(None);

pub fn set_custom_roblox_path(path: Option<String>) {
    if let Ok(mut guard) = CUSTOM_ROBLOX_PATH.lock() {
        *guard = path
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty());
    }
}

fn custom_roblox_path() -> Option<String> {
    CUSTOM_ROBLOX_PATH.lock().ok().and_then(|g| g.clone())
}

fn scan_versions_dir(dir: &std::path::Path) -> Option<(SystemTime, String)> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut best: Option<(SystemTime, String)> = None;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with("version-") && entry.path().join("RobloxPlayerBeta.exe").exists() {
            if let Ok(meta) = entry.metadata() {
                if let Ok(modified) = meta.modified() {
                    if best.as_ref().map_or(true, |(t, _)| modified > *t) {
                        best = Some((modified, entry.path().to_string_lossy().into_owned()));
                    }
                }
            }
        }
    }
    best
}

fn candidate_versions_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let local = PathBuf::from(local);
        for root in ["Roblox", "Bloxstrap", "Fishstrap", "Voidstrap"] {
            dirs.push(local.join(root).join("Versions"));
        }
    }
    if let Ok(pf86) = std::env::var("ProgramFiles(x86)") {
        dirs.push(PathBuf::from(pf86).join("Roblox").join("Versions"));
    }
    if let Ok(pf) = std::env::var("ProgramFiles") {
        dirs.push(PathBuf::from(pf).join("Roblox").join("Versions"));
    }
    dirs
}

pub fn normalize_install_folder(folder: &str) -> Option<String> {
    let folder = folder.trim();
    if folder.is_empty() {
        return None;
    }
    let path = std::path::Path::new(folder);
    if path.join("RobloxPlayerBeta.exe").exists() {
        return Some(path.to_string_lossy().into_owned());
    }
    if let Some((_, resolved)) = scan_versions_dir(path) {
        return Some(resolved);
    }
    if let Some((_, resolved)) = scan_versions_dir(&path.join("Versions")) {
        return Some(resolved);
    }
    None
}

pub fn auto_detect_roblox_path() -> Result<String, String> {
    unsafe {
        let key_name = encode_wide("roblox\\DefaultIcon");
        let mut hkey: windows_sys::Win32::System::Registry::HKEY = std::ptr::null_mut();

        if RegOpenKeyExW(HKEY_CLASSES_ROOT, key_name.as_ptr(), 0, KEY_READ, &mut hkey) == 0 {
            let mut buf = [0u16; 512];
            let mut buf_size = (buf.len() * 2) as u32;
            let mut value_type = 0u32;

            let result = RegQueryValueExW(
                hkey,
                std::ptr::null(),
                std::ptr::null_mut(),
                &mut value_type,
                buf.as_mut_ptr() as *mut u8,
                &mut buf_size,
            );

            RegCloseKey(hkey);

            if result == 0 && value_type == REG_SZ {
                let len = (buf_size as usize / 2).saturating_sub(1);
                let path = String::from_utf16_lossy(&buf[..len]);
                if let Some(parent) = std::path::Path::new(&path).parent() {
                    if parent.join("RobloxPlayerBeta.exe").exists() {
                        return Ok(parent.to_string_lossy().into_owned());
                    }
                }
            }
        }
    }

    let mut best: Option<(SystemTime, String)> = None;
    for dir in candidate_versions_dirs() {
        if let Some((modified, path)) = scan_versions_dir(&dir) {
            if best.as_ref().map_or(true, |(t, _)| modified > *t) {
                best = Some((modified, path));
            }
        }
    }
    if let Some((_, path)) = best {
        return Ok(path);
    }

    Err("Roblox installation not found".into())
}

pub fn get_roblox_path() -> Result<String, String> {
    if let Some(custom) = custom_roblox_path() {
        if let Some(resolved) = normalize_install_folder(&custom) {
            return Ok(resolved);
        }
    }
    auto_detect_roblox_path()
}

fn get_client_settings_file() -> Result<PathBuf, String> {
    let version_folder = get_roblox_path()?;
    let settings_dir = std::path::Path::new(&version_folder).join("ClientSettings");

    if !settings_dir.exists() {
        std::fs::create_dir_all(&settings_dir)
            .map_err(|e| format!("Failed to create ClientSettings: {}", e))?;
    }

    Ok(settings_dir.join("ClientAppSettings.json"))
}
