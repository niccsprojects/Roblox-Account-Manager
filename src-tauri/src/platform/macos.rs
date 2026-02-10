use std::collections::{HashMap, HashSet};
use std::ffi::CString;
use std::io::{Read, Seek, SeekFrom};
use std::os::raw::{c_char, c_int};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

const SINGLE_INSTANCE_SEMAPHORE: &str = "/RobloxPlayerUniq";

static MULTI_ROBLOX_ENABLED: AtomicBool = AtomicBool::new(false);
static TRACKER: LazyLock<ProcessTracker> = LazyLock::new(ProcessTracker::new);

unsafe extern "C" {
    fn sem_unlink(name: *const c_char) -> c_int;
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

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn clear_single_instance_semaphore() -> Result<(), String> {
    let name = CString::new(SINGLE_INSTANCE_SEMAPHORE)
        .map_err(|_| "Invalid semaphore name bytes".to_string())?;
    let result = unsafe { sem_unlink(name.as_ptr()) };
    if result == 0 {
        return Ok(());
    }

    let err = std::io::Error::last_os_error();
    if err.raw_os_error() == Some(2) {
        Ok(())
    } else {
        Err(format!(
            "Failed to clear Roblox single-instance semaphore: {}",
            err
        ))
    }
}

fn pre_launch_multi_step() {
    if MULTI_ROBLOX_ENABLED.load(Ordering::Relaxed) {
        let _ = clear_single_instance_semaphore();
    }
}

pub fn enable_multi_roblox() -> Result<bool, String> {
    MULTI_ROBLOX_ENABLED.store(true, Ordering::Relaxed);
    let _ = clear_single_instance_semaphore();
    Ok(true)
}

pub fn disable_multi_roblox() -> Result<(), String> {
    MULTI_ROBLOX_ENABLED.store(false, Ordering::Relaxed);
    Ok(())
}

pub fn get_roblox_path() -> Result<String, String> {
    let mut candidates = vec![
        PathBuf::from("/Applications/Roblox.app"),
        PathBuf::from("/Applications/RobloxPlayer.app"),
    ];

    if let Some(home) = home_dir() {
        candidates.push(home.join("Applications/Roblox.app"));
        candidates.push(home.join("Applications/RobloxPlayer.app"));
    }

    for path in candidates {
        if path.exists() {
            return Ok(path.to_string_lossy().into_owned());
        }
    }

    Err("Roblox app not found (looked in /Applications and ~/Applications)".into())
}

fn parse_pid_output(output: &str) -> Vec<u32> {
    output
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .collect()
}

pub fn get_roblox_pids() -> Vec<u32> {
    let mut all = HashSet::new();
    for name in ["RobloxPlayer", "Roblox", "RobloxPlayerBeta"] {
        let output = Command::new("pgrep").args(["-x", name]).output();
        if let Ok(out) = output {
            let stdout = String::from_utf8_lossy(&out.stdout);
            for pid in parse_pid_output(&stdout) {
                all.insert(pid);
            }
        }
    }

    if all.is_empty() {
        if let Ok(out) = Command::new("pgrep").args(["-if", "roblox"]).output() {
            let stdout = String::from_utf8_lossy(&out.stdout);
            for pid in parse_pid_output(&stdout) {
                all.insert(pid);
            }
        }
    }

    let mut pids: Vec<u32> = all.into_iter().collect();
    pids.sort_unstable();
    pids
}

pub fn kill_process(pid: u32) -> Result<(), String> {
    let pid_str = pid.to_string();
    let status = Command::new("kill")
        .args(["-TERM", &pid_str])
        .status()
        .map_err(|e| format!("Failed to send TERM to {}: {}", pid, e))?;
    if !status.success() {
        return Err(format!("Failed to send TERM to process {}", pid));
    }

    std::thread::sleep(std::time::Duration::from_millis(250));

    if get_roblox_pids().contains(&pid) {
        let kill_status = Command::new("kill")
            .args(["-KILL", &pid_str])
            .status()
            .map_err(|e| format!("Failed to send KILL to {}: {}", pid, e))?;
        if !kill_status.success() {
            return Err(format!("Failed to force kill process {}", pid));
        }
    }

    Ok(())
}

pub fn kill_all_roblox() -> u32 {
    let pids = get_roblox_pids();
    let mut killed = 0u32;
    for pid in pids {
        if kill_process(pid).is_ok() {
            killed += 1;
        }
    }
    killed
}

pub fn build_launch_url(
    ticket: &str,
    place_id: i64,
    job_id: &str,
    browser_tracker_id: &str,
    launch_data: &str,
    follow_user: bool,
    join_vip: bool,
    access_code: &str,
    link_code: &str,
    is_teleport: bool,
) -> String {
    let launch_time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();

    let ld_param = if launch_data.is_empty() {
        String::new()
    } else {
        format!("&launchData={}", urlencoding::encode(launch_data))
    };

    let place_launcher_url = if join_vip {
        format!(
            "https://assetgame.roblox.com/game/PlaceLauncher.ashx?request=RequestPrivateGame&placeId={}&accessCode={}&linkCode={}{}",
            place_id, access_code, link_code, ld_param
        )
    } else if follow_user {
        format!(
            "https://assetgame.roblox.com/game/PlaceLauncher.ashx?request=RequestFollowUser&userId={}{}",
            place_id, ld_param
        )
    } else {
        let req = if job_id.is_empty() {
            "RequestGame"
        } else {
            "RequestGameJob"
        };
        let gid = if job_id.is_empty() {
            String::new()
        } else {
            format!("&gameId={}", job_id)
        };
        let tp = if is_teleport { "&isTeleport=true" } else { "" };
        format!(
            "https://assetgame.roblox.com/game/PlaceLauncher.ashx?request={}&browserTrackerId={}&placeId={}{}&isPlayTogetherGame=false{}{}",
            req, browser_tracker_id, place_id, gid, tp, ld_param
        )
    };

    format!(
        "roblox-player:1+launchmode:play+gameinfo:{}+launchtime:{}+placelauncherurl:{}+browsertrackerid:{}+robloxLocale:en_us+gameLocale:en_us+channel:+LaunchExp:InApp",
        ticket,
        launch_time,
        urlencoding::encode(&place_launcher_url),
        browser_tracker_id
    )
}

pub fn launch_url(url: &str) -> Result<(), String> {
    pre_launch_multi_step();

    if MULTI_ROBLOX_ENABLED.load(Ordering::Relaxed) {
        if let Ok(app_path) = get_roblox_path() {
            Command::new("open")
                .args(["-n", "-a"])
                .arg(&app_path)
                .arg(url)
                .spawn()
                .map_err(|e| format!("Failed to launch Roblox: {}", e))?;
            return Ok(());
        }
    }

    Command::new("open")
        .arg(url)
        .spawn()
        .map_err(|e| format!("Failed to launch Roblox URL: {}", e))?;
    Ok(())
}

pub fn launch_old_join(
    ticket: &str,
    place_id: i64,
    job_id: &str,
    launch_data: &str,
    follow_user: bool,
    join_vip: bool,
    access_code: &str,
    link_code: &str,
    is_teleport: bool,
) -> Result<(), String> {
    let browser_tracker_id = generate_browser_tracker_id();
    let url = build_launch_url(
        ticket,
        place_id,
        job_id,
        &browser_tracker_id,
        launch_data,
        follow_user,
        join_vip,
        access_code,
        link_code,
        is_teleport,
    );
    launch_url(&url)
}

fn get_client_settings_file() -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Some(home) = home_dir() {
        candidates.push(
            home.join("Library")
                .join("Application Support")
                .join("Roblox")
                .join("ClientSettings")
                .join("ClientAppSettings.json"),
        );
        candidates.push(
            home.join("Library")
                .join("Roblox")
                .join("ClientSettings")
                .join("ClientAppSettings.json"),
        );
    }

    if let Ok(app) = get_roblox_path() {
        let app_path = Path::new(&app);
        candidates.push(
            app_path
                .join("Contents")
                .join("MacOS")
                .join("ClientSettings")
                .join("ClientAppSettings.json"),
        );
        candidates.push(
            app_path
                .join("Contents")
                .join("Resources")
                .join("ClientSettings")
                .join("ClientAppSettings.json"),
        );
    }

    if let Some(existing) = candidates.iter().find(|p| p.exists()) {
        return Ok(existing.clone());
    }

    let fallback = candidates
        .into_iter()
        .next()
        .ok_or_else(|| "No macOS ClientSettings path candidates available".to_string())?;
    if let Some(parent) = fallback.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create ClientSettings folder: {}", e))?;
    }
    Ok(fallback)
}

pub fn apply_fps_unlock(max_fps: u32) -> Result<(), String> {
    let settings_file = get_client_settings_file()?;

    let mut settings: serde_json::Value = if settings_file.exists() {
        std::fs::read_to_string(&settings_file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    settings["DFIntTaskSchedulerTargetFps"] = serde_json::json!(max_fps);

    std::fs::write(
        &settings_file,
        serde_json::to_string(&settings).unwrap_or_default(),
    )
    .map_err(|e| format!("Failed to write ClientAppSettings.json: {}", e))
}

pub fn copy_custom_client_settings(custom_settings_path: &str) -> Result<(), String> {
    let custom_path = Path::new(custom_settings_path);
    if !custom_path.exists() {
        return Err("Custom ClientAppSettings.json path does not exist".into());
    }

    let content = std::fs::read_to_string(custom_path)
        .map_err(|e| format!("Failed to read custom settings file: {}", e))?;
    serde_json::from_str::<serde_json::Value>(&content)
        .map_err(|e| format!("Custom settings file is not valid JSON: {}", e))?;

    let settings_file = get_client_settings_file()?;
    std::fs::write(settings_file, content)
        .map_err(|e| format!("Failed to copy custom ClientAppSettings.json: {}", e))
}

pub fn candidate_log_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = home_dir() {
        dirs.push(home.join("Library").join("Logs").join("Roblox"));
        dirs.push(home.join("Library").join("Roblox").join("logs"));
    }
    dirs
}

fn all_log_files() -> Vec<PathBuf> {
    let mut out = Vec::new();
    for dir in candidate_log_dirs() {
        if !dir.exists() {
            continue;
        }
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }
                if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                    if ext.eq_ignore_ascii_case("log") {
                        out.push(path);
                    }
                }
            }
        }
    }
    out
}

pub fn latest_log_file_for_pid(pid: u32) -> Option<PathBuf> {
    let pid_str = pid.to_string();
    let files = all_log_files();

    let mut pid_best: Option<(SystemTime, PathBuf)> = None;
    let mut any_best: Option<(SystemTime, PathBuf)> = None;

    for path in files {
        let modified = std::fs::metadata(&path)
            .and_then(|m| m.modified())
            .unwrap_or(UNIX_EPOCH);
        if any_best
            .as_ref()
            .map(|(ts, _)| modified > *ts)
            .unwrap_or(true)
        {
            any_best = Some((modified, path.clone()));
        }

        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if name.contains(&pid_str)
            && pid_best
                .as_ref()
                .map(|(ts, _)| modified > *ts)
                .unwrap_or(true)
        {
            pid_best = Some((modified, path));
        }
    }

    pid_best.or(any_best).map(|(_, p)| p)
}

pub fn read_log_delta(path: &Path, cursor: &mut u64) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|e| format!("Open log failed: {}", e))?;
    let len = file
        .metadata()
        .map_err(|e| format!("Stat log failed: {}", e))?
        .len();
    if *cursor > len {
        *cursor = 0;
    }
    file.seek(SeekFrom::Start(*cursor))
        .map_err(|e| format!("Seek log failed: {}", e))?;
    let mut buf = String::new();
    file.read_to_string(&mut buf)
        .map_err(|e| format!("Read log failed: {}", e))?;
    *cursor = len;
    Ok(buf)
}

#[derive(Debug, Clone, Serialize)]
pub struct TrackedProcess {
    pub pid: u32,
    pub user_id: i64,
    pub browser_tracker_id: String,
}

pub struct ProcessTracker {
    instances: Mutex<HashMap<i64, TrackedProcess>>,
    watcher_active: AtomicBool,
    launcher_cancelled: AtomicBool,
    next_account: AtomicBool,
}

impl ProcessTracker {
    pub fn new() -> Self {
        Self {
            instances: Mutex::new(HashMap::new()),
            watcher_active: AtomicBool::new(false),
            launcher_cancelled: AtomicBool::new(false),
            next_account: AtomicBool::new(false),
        }
    }

    pub fn track(&self, user_id: i64, pid: u32, browser_tracker_id: String) {
        if let Ok(mut instances) = self.instances.lock() {
            instances.insert(
                user_id,
                TrackedProcess {
                    pid,
                    user_id,
                    browser_tracker_id,
                },
            );
        }
    }

    pub fn untrack(&self, user_id: i64) {
        if let Ok(mut instances) = self.instances.lock() {
            instances.remove(&user_id);
        }
    }

    pub fn get_pid(&self, user_id: i64) -> Option<u32> {
        self.instances
            .lock()
            .ok()
            .and_then(|i| i.get(&user_id).map(|p| p.pid))
    }

    pub fn get_tracked_pids(&self) -> Vec<u32> {
        self.instances
            .lock()
            .ok()
            .map(|i| i.values().map(|p| p.pid).collect())
            .unwrap_or_default()
    }

    pub fn get_all(&self) -> Vec<TrackedProcess> {
        self.instances
            .lock()
            .ok()
            .map(|i| i.values().cloned().collect())
            .unwrap_or_default()
    }

    pub fn kill_for_user(&self, user_id: i64) -> bool {
        if let Some(pid) = self.get_pid(user_id) {
            let result = kill_process(pid).is_ok();
            self.untrack(user_id);
            result
        } else {
            false
        }
    }

    pub fn is_watcher_active(&self) -> bool {
        self.watcher_active.load(Ordering::Relaxed)
    }

    pub fn set_watcher_active(&self, active: bool) {
        self.watcher_active.store(active, Ordering::Relaxed);
    }

    pub fn cancel_launch(&self) {
        self.launcher_cancelled.store(true, Ordering::Relaxed);
    }

    pub fn is_launch_cancelled(&self) -> bool {
        self.launcher_cancelled.load(Ordering::Relaxed)
    }

    pub fn reset_launch_cancelled(&self) {
        self.launcher_cancelled.store(false, Ordering::Relaxed);
    }

    pub fn signal_next_account(&self) {
        self.next_account.store(true, Ordering::Relaxed);
    }

    pub fn is_next_account(&self) -> bool {
        self.next_account.load(Ordering::Relaxed)
    }

    pub fn reset_next_account(&self) {
        self.next_account.store(false, Ordering::Relaxed);
    }

    pub fn cleanup_dead_processes(&self) -> Vec<i64> {
        let alive_pids = get_roblox_pids();
        let mut dead_user_ids = Vec::new();

        if let Ok(mut instances) = self.instances.lock() {
            instances.retain(|user_id, process| {
                if alive_pids.contains(&process.pid) {
                    true
                } else {
                    dead_user_ids.push(*user_id);
                    false
                }
            });
        }

        dead_user_ids
    }
}
