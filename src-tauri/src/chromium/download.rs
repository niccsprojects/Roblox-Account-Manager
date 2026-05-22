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

    let (version, url) = resolve_download().await?;
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

    make_executable(&binary);

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

async fn resolve_download() -> Result<(String, String), String> {
    let json: Value = reqwest::get(VERSIONS_URL)
        .await
        .map_err(|e| format!("Could not reach browser download service: {}", e))?
        .json()
        .await
        .map_err(|e| format!("Could not read browser version list: {}", e))?;

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

fn make_executable(binary: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(binary, std::fs::Permissions::from_mode(0o755));
    }
    #[cfg(not(unix))]
    {
        let _ = binary;
    }
}
