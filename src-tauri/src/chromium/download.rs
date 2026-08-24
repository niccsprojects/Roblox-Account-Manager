use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;

const VERSIONS_URL: &str =
    "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";

static ENSURE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

#[derive(Clone, Serialize)]
struct DownloadProgress {
    stage: String,
    downloaded: u64,
    total: u64,
}

fn platform_key() -> &'static str {
    if cfg!(target_os = "windows") {
        if cfg!(target_arch = "x86") {
            "win32"
        } else {
            "win64"
        }
    } else if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            "mac-arm64"
        } else {
            "mac-x64"
        }
    } else {
        "linux64"
    }
}

fn binary_path(version_dir: &Path) -> PathBuf {
    let folder = format!("chrome-{}", platform_key());
    let base = version_dir.join(folder);
    if cfg!(target_os = "windows") {
        base.join("chrome.exe")
    } else if cfg!(target_os = "macos") {
        base.join("Google Chrome for Testing.app")
            .join("Contents")
            .join("MacOS")
            .join("Google Chrome for Testing")
    } else {
        base.join("chrome")
    }
}

pub fn chromium_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Could not resolve data directory: {}", e))?
        .join("chromium");
    Ok(dir)
}

fn cached_binary(app: &AppHandle) -> Option<PathBuf> {
    let dir = chromium_dir(app).ok()?;
    let manifest = dir.join("version.json");
    let raw = std::fs::read_to_string(manifest).ok()?;
    let json: Value = serde_json::from_str(&raw).ok()?;
    let binary = json.get("binary").and_then(Value::as_str)?;
    let path = PathBuf::from(binary);
    if path.exists() {
        Some(path)
    } else {
        None
    }
}

pub fn is_installed(app: &AppHandle) -> bool {
    cached_binary(app).is_some()
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FallbackNotice {
    browser: String,
    error: String,
}

#[cfg(target_os = "windows")]
fn system_chromium_candidates() -> Vec<(PathBuf, &'static str)> {
    let roots: Vec<PathBuf> = ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]
        .iter()
        .filter_map(|var| std::env::var(var).ok())
        .map(PathBuf::from)
        .collect();

    let relative: [(&[&str], &str); 4] = [
        (&["Google", "Chrome", "Application", "chrome.exe"], "Google Chrome"),
        (&["Chromium", "Application", "chrome.exe"], "Chromium"),
        (
            &["BraveSoftware", "Brave-Browser", "Application", "brave.exe"],
            "Brave",
        ),
        (&["Microsoft", "Edge", "Application", "msedge.exe"], "Microsoft Edge"),
    ];

    let mut out = Vec::new();
    for (parts, name) in relative {
        for root in &roots {
            let mut path = root.clone();
            for part in parts {
                path = path.join(part);
            }
            out.push((path, name));
        }
    }
    out
}

#[cfg(target_os = "macos")]
fn system_chromium_candidates() -> Vec<(PathBuf, &'static str)> {
    [
        (
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "Google Chrome",
        ),
        ("/Applications/Chromium.app/Contents/MacOS/Chromium", "Chromium"),
        (
            "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
            "Brave",
        ),
        (
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "Microsoft Edge",
        ),
    ]
    .iter()
    .map(|(path, name)| (PathBuf::from(path), *name))
    .collect()
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn system_chromium_candidates() -> Vec<(PathBuf, &'static str)> {
    [
        ("/usr/bin/google-chrome", "Google Chrome"),
        ("/usr/bin/google-chrome-stable", "Google Chrome"),
        ("/usr/bin/chromium", "Chromium"),
        ("/usr/bin/chromium-browser", "Chromium"),
        ("/usr/bin/brave-browser", "Brave"),
        ("/usr/bin/microsoft-edge", "Microsoft Edge"),
    ]
    .iter()
    .map(|(path, name)| (PathBuf::from(path), *name))
    .collect()
}

pub fn find_system_chromium() -> Option<(PathBuf, String)> {
    system_chromium_candidates()
        .into_iter()
        .find(|(path, _)| path.exists())
        .map(|(path, name)| (path, name.to_string()))
}

pub async fn ensure_chromium_or_fallback(app: &AppHandle) -> Result<(PathBuf, bool), String> {
    match ensure_chromium(app).await {
        Ok(binary) => Ok((binary, false)),
        Err(err) => {
            let _ = app.emit(
                "chromium-download-progress",
                DownloadProgress {
                    stage: "error".into(),
                    downloaded: 0,
                    total: 0,
                },
            );
            if let Some((binary, browser)) = find_system_chromium() {
                let _ = app.emit(
                    "chromium-fallback",
                    FallbackNotice {
                        browser,
                        error: err,
                    },
                );
                Ok((binary, true))
            } else {
                Err(with_download_hint(err))
            }
        }
    }
}

pub fn with_download_hint(err: String) -> String {
    format!(
        "{}. Check your internet connection or antivirus, then retry from Settings > General > Login browser.",
        err
    )
}

pub async fn reinstall_chromium(app: &AppHandle) -> Result<PathBuf, String> {
    {
        let _guard = ENSURE_LOCK.lock().await;
        let dir = chromium_dir(app)?;
        if dir.exists() {
            std::fs::remove_dir_all(&dir)
                .map_err(|e| format!("Could not remove the existing browser: {}", e))?;
        }
    }
    ensure_chromium(app).await
}

pub async fn ensure_chromium(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(binary) = cached_binary(app) {
        return Ok(binary);
    }

    let _guard = ENSURE_LOCK.lock().await;
    if let Some(binary) = cached_binary(app) {
        return Ok(binary);
    }

    let dir = chromium_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create data directory: {}", e))?;

    let _ = app.emit(
        "chromium-download-progress",
        DownloadProgress {
            stage: "resolving".into(),
            downloaded: 0,
            total: 0,
        },
    );

    let (version, url) = match resolve_download().await {
        Ok(resolved) => resolved,
        Err(err) => {
            if let Some((version, binary)) = find_existing_install(&dir) {
                make_executable(&binary)?;
                let manifest = serde_json::json!({
                    "version": version,
                    "binary": binary.to_string_lossy(),
                });
                let _ = std::fs::write(
                    dir.join("version.json"),
                    serde_json::to_string_pretty(&manifest).unwrap_or_default(),
                );
                let _ = app.emit(
                    "chromium-download-progress",
                    DownloadProgress {
                        stage: "ready".into(),
                        downloaded: 0,
                        total: 0,
                    },
                );
                return Ok(binary);
            }
            return Err(err);
        }
    };
    let version_dir = dir.join(&version);
    let binary = binary_path(&version_dir);

    if !binary.exists() {
        let archive = dir.join("download.zip");
        download_archive(app, &url, &archive).await?;

        let _ = app.emit(
            "chromium-download-progress",
            DownloadProgress {
                stage: "extracting".into(),
                downloaded: 0,
                total: 0,
            },
        );

        let extract_target = version_dir.clone();
        let archive_for_extract = archive.clone();
        tauri::async_runtime::spawn_blocking(move || {
            extract_archive(&archive_for_extract, &extract_target)
        })
        .await
        .map_err(|e| format!("Extraction task failed: {}", e))??;

        let _ = std::fs::remove_file(&archive);
    }

    if !binary.exists() {
        return Err("Browser archive did not contain the expected executable".into());
    }

    make_executable(&binary)?;

    let manifest = serde_json::json!({
        "version": version,
        "binary": binary.to_string_lossy(),
    });
    std::fs::write(
        dir.join("version.json"),
        serde_json::to_string_pretty(&manifest).unwrap_or_default(),
    )
    .map_err(|e| format!("Could not write version manifest: {}", e))?;

    let _ = app.emit(
        "chromium-download-progress",
        DownloadProgress {
            stage: "ready".into(),
            downloaded: 0,
            total: 0,
        },
    );

    Ok(binary)
}

fn find_existing_install(dir: &Path) -> Option<(String, PathBuf)> {
    let mut versions: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    versions.sort_by_key(|path| {
        path.file_name()
            .and_then(|name| name.to_str())
            .map(|name| {
                name.split('.')
                    .filter_map(|part| part.parse::<u32>().ok())
                    .collect::<Vec<u32>>()
            })
            .unwrap_or_default()
    });
    versions.into_iter().rev().find_map(|version_dir| {
        let binary = binary_path(&version_dir);
        if binary.exists() {
            let version = version_dir.file_name()?.to_string_lossy().to_string();
            Some((version, binary))
        } else {
            None
        }
    })
}

async fn resolve_download() -> Result<(String, String), String> {
    let mut last_error = String::new();
    for attempt in 0..3u32 {
        match fetch_version_list().await {
            Ok(json) => return parse_download(&json),
            Err(err) => {
                last_error = err;
                if attempt < 2 {
                    tokio::time::sleep(std::time::Duration::from_millis(400 * 2_u64.pow(attempt)))
                        .await;
                }
            }
        }
    }
    Err(last_error)
}

async fn fetch_version_list() -> Result<Value, String> {
    reqwest::get(VERSIONS_URL)
        .await
        .and_then(|response| response.error_for_status())
        .map_err(|e| format!("Could not reach browser download service: {}", e))?
        .json()
        .await
        .map_err(|e| format!("Could not read browser version list: {}", e))
}

fn parse_download(json: &Value) -> Result<(String, String), String> {
    let stable = json
        .get("channels")
        .and_then(|c| c.get("Stable"))
        .ok_or("Browser version list is missing the Stable channel")?;

    let version = stable
        .get("version")
        .and_then(Value::as_str)
        .ok_or("Browser version list is missing a version")?
        .to_string();

    let url = stable
        .get("downloads")
        .and_then(|d| d.get("chrome"))
        .and_then(Value::as_array)
        .and_then(|entries| {
            entries
                .iter()
                .find(|entry| entry.get("platform").and_then(Value::as_str) == Some(platform_key()))
        })
        .and_then(|entry| entry.get("url").and_then(Value::as_str))
        .ok_or("No browser build is available for this platform")?
        .to_string();

    Ok((version, url))
}

async fn download_archive(app: &AppHandle, url: &str, target: &Path) -> Result<(), String> {
    let mut response = reqwest::get(url)
        .await
        .map_err(|e| format!("Browser download failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Browser download failed (status {})",
            response.status().as_u16()
        ));
    }

    let total = response.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut file =
        std::fs::File::create(target).map_err(|e| format!("Could not write download: {}", e))?;
    use std::io::Write;

    let mut last_emit = 0u64;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("Browser download interrupted: {}", e))?
    {
        file.write_all(&chunk)
            .map_err(|e| format!("Could not write download: {}", e))?;
        downloaded += chunk.len() as u64;
        if downloaded - last_emit >= 2_000_000 {
            last_emit = downloaded;
            let _ = app.emit(
                "chromium-download-progress",
                DownloadProgress {
                    stage: "downloading".into(),
                    downloaded,
                    total,
                },
            );
        }
    }

    file.flush().map_err(|e| format!("Could not finalize download: {}", e))?;
    Ok(())
}

fn extract_archive(archive: &Path, target: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|e| format!("Could not open download: {}", e))?;
    let mut zip =
        zip::ZipArchive::new(file).map_err(|e| format!("Could not read download: {}", e))?;
    std::fs::create_dir_all(target).map_err(|e| format!("Could not create browser directory: {}", e))?;

    for i in 0..zip.len() {
        let mut entry = zip
            .by_index(i)
            .map_err(|e| format!("Could not read archive entry: {}", e))?;
        let Some(rel) = entry.enclosed_name() else {
            continue;
        };
        let out_path = target.join(rel);

        if entry.is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
            continue;
        }

        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }

        let mut out =
            std::fs::File::create(&out_path).map_err(|e| format!("Could not write file: {}", e))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("Could not write file: {}", e))?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Some(mode) = entry.unix_mode() {
                let _ = std::fs::set_permissions(&out_path, std::fs::Permissions::from_mode(mode));
            }
        }
    }

    Ok(())
}

fn make_executable(binary: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(binary, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("Could not set browser executable permissions: {}", e))?;
    }
    #[cfg(not(unix))]
    {
        let _ = binary;
    }
    Ok(())
}
