use std::io::Read;
use futures_util::future::{BoxFuture, FutureExt};
use futures_util::stream::{FuturesUnordered, StreamExt};
use tauri::Manager;

const CDN_HOST: &str = "https://setup-aws.rbxcdn.com";
const WEAO_CURRENT_URL: &str = "https://weao.xyz/api/versions/current";
const WEAO_PAST_URL: &str = "https://weao.xyz/api/versions/past";

const EXTRACT_ROOTS: &[(&str, &str)] = &[
    ("RobloxApp.zip", ""),
    ("redist.zip", ""),
    ("WebView2.zip", ""),
    ("Libraries.zip", ""),
    ("LibrariesQt5.zip", ""),
    ("shaders.zip", "shaders/"),
    ("ssl.zip", "ssl/"),
    ("WebView2RuntimeInstaller.zip", "WebView2RuntimeInstaller/"),
    ("content-avatar.zip", "content/avatar/"),
    ("content-configs.zip", "content/configs/"),
    ("content-fonts.zip", "content/fonts/"),
    ("content-models.zip", "content/models/"),
    ("content-music.zip", "content/music/"),
    ("content-particles.zip", "content/particles/"),
    ("content-sky.zip", "content/sky/"),
    ("content-sounds.zip", "content/sounds/"),
    ("content-textures.zip", "content/textures/"),
    ("content-textures2.zip", "content/textures/"),
    ("content-textures3.zip", "PlatformContent/pc/textures/"),
    ("content-terrain.zip", "PlatformContent/pc/terrain/"),
    ("content-platform-fonts.zip", "PlatformContent/pc/fonts/"),
    (
        "content-platform-dictionaries.zip",
        "PlatformContent/pc/shared_compression_dictionaries/",
    ),
    ("content-platform-shaders.zip", "PlatformContent/pc/shaders/"),
    ("extracontent-luapackages.zip", "ExtraContent/LuaPackages/"),
    ("extracontent-models.zip", "ExtraContent/models/"),
    ("extracontent-places.zip", "ExtraContent/places/"),
    ("extracontent-scripts.zip", "ExtraContent/scripts/"),
    ("extracontent-textures.zip", "ExtraContent/textures/"),
    ("extracontent-translations.zip", "ExtraContent/translations/"),
    ("Plugins.zip", "Plugins/"),
];

const APP_SETTINGS_XML: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<Settings>
\t<ContentFolder>content</ContentFolder>
\t<BaseUrl>http://www.roblox.com</BaseUrl>
</Settings>
";

fn extract_root_for(filename: &str) -> Option<&'static str> {
    for (name, root) in EXTRACT_ROOTS {
        if name.eq_ignore_ascii_case(filename) {
            return Some(*root);
        }
    }
    None
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInstallProgress {
    pub install_id: String,
    pub channel: String,
    pub version_hash: String,
    pub stage: String,
    pub package: Option<String>,
    pub current: u64,
    pub total: u64,
    pub message: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteVersionEntry {
    pub binary_type: String,
    pub version_hash: String,
    pub display_version: Option<String>,
    pub deploy_date: Option<String>,
    pub channel: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCatalog {
    pub current: Vec<RemoteVersionEntry>,
    pub past: Vec<RemoteVersionEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub past_error: Option<String>,
}

fn channel_base_url(channel: &str) -> String {
    let trimmed = channel.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("LIVE") {
        format!("{}/", CDN_HOST)
    } else {
        format!("{}/channel/{}/", CDN_HOST, trimmed.to_ascii_lowercase())
    }
}

fn fallback_common_base_url() -> String {
    format!("{}/channel/common/", CDN_HOST)
}

async fn http_client_versioned() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .user_agent("RobloxAccountManager/4")
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

async fn fetch_text(client: &reqwest::Client, url: &str) -> Result<String, String> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {}", e))?;
    if !response.status().is_success() {
        return Err(format!(
            "HTTP {} for {}",
            response.status().as_u16(),
            url
        ));
    }
    response
        .text()
        .await
        .map_err(|e| format!("Could not read response: {}", e))
}

async fn fetch_bytes(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {}", e))?;
    if !response.status().is_success() {
        return Err(format!(
            "HTTP {} for {}",
            response.status().as_u16(),
            url
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Download failed: {}", e))?;
    Ok(bytes.to_vec())
}

pub async fn fetch_remote_catalog() -> Result<RemoteCatalog, String> {
    let client = http_client_versioned().await;
    let current_raw = fetch_text(&client, WEAO_CURRENT_URL).await?;
    let (past_raw, mut past_error): (String, Option<String>) =
        match fetch_text(&client, WEAO_PAST_URL).await {
            Ok(text) => (text, None),
            Err(err) => (String::new(), Some(err)),
        };

    let current: serde_json::Value =
        serde_json::from_str(&current_raw).map_err(|e| format!("Parse error: {}", e))?;
    let past: serde_json::Value = if past_raw.is_empty() {
        serde_json::json!({})
    } else {
        match serde_json::from_str(&past_raw) {
            Ok(value) => value,
            Err(err) => {
                past_error = Some(format!("Parse error: {}", err));
                serde_json::json!({})
            }
        }
    };

    let mut current_out = Vec::new();
    if let Some(v) = current.get("Windows").and_then(|v| v.as_str()) {
        current_out.push(RemoteVersionEntry {
            binary_type: "WindowsPlayer".into(),
            version_hash: v.to_string(),
            display_version: current
                .get("WindowsResponse")
                .and_then(|r| r.get("version"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            deploy_date: current
                .get("WindowsDate")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            channel: "LIVE".into(),
        });
    }
    if let Some(v) = current.get("Mac").and_then(|v| v.as_str()) {
        current_out.push(RemoteVersionEntry {
            binary_type: "MacPlayer".into(),
            version_hash: v.to_string(),
            display_version: current
                .get("MacResponse")
                .and_then(|r| r.get("version"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            deploy_date: current
                .get("MacDate")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            channel: "LIVE".into(),
        });
    }

    let mut past_out = Vec::new();
    if let Some(v) = past.get("Windows").and_then(|v| v.as_str()) {
        past_out.push(RemoteVersionEntry {
            binary_type: "WindowsPlayer".into(),
            version_hash: v.to_string(),
            display_version: past
                .get("WindowsResponse")
                .and_then(|r| r.get("version"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            deploy_date: past
                .get("WindowsDate")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            channel: "LIVE".into(),
        });
    }
    if let Some(v) = past.get("Mac").and_then(|v| v.as_str()) {
        past_out.push(RemoteVersionEntry {
            binary_type: "MacPlayer".into(),
            version_hash: v.to_string(),
            display_version: past
                .get("MacResponse")
                .and_then(|r| r.get("version"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            deploy_date: past
                .get("MacDate")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            channel: "LIVE".into(),
        });
    }

    Ok(RemoteCatalog {
        current: current_out,
        past: past_out,
        past_error,
    })
}

#[derive(Debug, Clone)]
pub struct PkgManifestEntry {
    pub filename: String,
    pub hash: Option<String>,
}

fn parse_pkg_manifest(text: &str) -> Result<Vec<PkgManifestEntry>, String> {
    let mut lines = text
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty());
    let header = lines.next().ok_or("Empty manifest")?;
    if !header.eq_ignore_ascii_case("v0") {
        return Err(format!("Unexpected manifest header: {}", header));
    }
    let rest: Vec<&str> = lines.collect();
    let mut packages = Vec::new();
    let mut i = 0;
    while i + 3 < rest.len() {
        let filename = rest[i];
        if !filename.to_ascii_lowercase().ends_with(".zip") {
            i += 1;
            continue;
        }
        let hash_candidate = rest[i + 1];
        let hash = if hash_candidate.chars().all(|c| c.is_ascii_hexdigit())
            && (hash_candidate.len() == 32 || hash_candidate.len() == 64)
        {
            Some(hash_candidate.to_string())
        } else {
            None
        };
        packages.push(PkgManifestEntry {
            filename: filename.to_string(),
            hash,
        });
        i += 4;
    }
    Ok(packages)
}

fn verify_hash(bytes: &[u8], expected: &str) -> bool {
    use md5::Digest;
    match expected.len() {
        32 => {
            let mut hasher = md5::Md5::new();
            hasher.update(bytes);
            let computed = hasher.finalize();
            let hex: String = computed.iter().map(|b| format!("{:02x}", b)).collect();
            hex.eq_ignore_ascii_case(expected)
        }
        64 => {
            let mut hasher = sha2::Sha256::new();
            hasher.update(bytes);
            let computed = hasher.finalize();
            let hex: String = computed.iter().map(|b| format!("{:02x}", b)).collect();
            hex.eq_ignore_ascii_case(expected)
        }
        _ => true,
    }
}

fn ensure_dir(dir: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("mkdir failed: {}", e))
}

fn is_valid_channel_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
        && value != "."
        && value != ".."
}

fn is_valid_version_hash(value: &str) -> bool {
    value.len() >= 9
        && value.len() <= 96
        && value.starts_with("version-")
        && value[8..].chars().all(|c| c.is_ascii_hexdigit())
}

fn install_target_dir(channel: &str, version_hash: &str) -> Result<PathBuf, String> {
    if !is_valid_channel_name(channel) {
        return Err(format!(
            "Invalid channel name: must be alphanumeric, underscore, hyphen, or dot (got {:?})",
            channel
        ));
    }
    if !is_valid_version_hash(version_hash) {
        return Err(format!(
            "Invalid version hash: must look like 'version-<hex>' (got {:?})",
            version_hash
        ));
    }
    let root = versions_root_dir().ok_or_else(|| "Could not resolve LOCALAPPDATA".to_string())?;
    Ok(root.join(channel).join(version_hash))
}

fn versions_root_dir() -> Option<PathBuf> {
    crate::data::versions::ram_managed_versions_root()
}

fn emit_progress(app: &tauri::AppHandle, progress: &VersionInstallProgress) {
    let _ = app.emit("version-install-progress", progress);
}

fn folder_size(path: &std::path::Path) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    total = total.saturating_add(meta.len());
                } else if meta.is_dir() {
                    total = total.saturating_add(folder_size(&entry.path()));
                }
            }
        }
    }
    total
}

fn extract_package_into(
    archive_bytes: &[u8],
    target_root: &std::path::Path,
    subdir: &str,
) -> Result<(), String> {
    let cursor = std::io::Cursor::new(archive_bytes);
    let mut zip = zip::ZipArchive::new(cursor).map_err(|e| format!("Bad zip: {}", e))?;

    let prefix = if subdir.is_empty() {
        std::path::PathBuf::new()
    } else {
        std::path::PathBuf::from(subdir.replace('/', std::path::MAIN_SEPARATOR_STR))
    };
    let base = target_root.join(&prefix);
    ensure_dir(&base)?;

    for i in 0..zip.len() {
        let mut entry = zip
            .by_index(i)
            .map_err(|e| format!("Could not read zip entry: {}", e))?;
        let Some(rel) = entry.enclosed_name() else {
            continue;
        };
        let out_path = base.join(rel);

        if entry.is_dir() {
            ensure_dir(&out_path)?;
            continue;
        }

        if let Some(parent) = out_path.parent() {
            ensure_dir(parent)?;
        }

        let mut buf = Vec::with_capacity(entry.size() as usize);
        entry
            .read_to_end(&mut buf)
            .map_err(|e| format!("Could not read entry: {}", e))?;
        std::fs::write(&out_path, &buf)
            .map_err(|e| format!("Could not write {}: {}", out_path.display(), e))?;
    }

    Ok(())
}

struct StagingGuard {
    staging: PathBuf,
    committed: bool,
}

impl Drop for StagingGuard {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        if self.staging.exists() {
            let _ = std::fs::remove_dir_all(&self.staging);
        }
    }
}

async fn download_version_into(
    app: tauri::AppHandle,
    install_id: String,
    channel: String,
    version_hash: String,
    target: PathBuf,
) -> Result<(), String> {
    let staging_name = format!(
        "{}.staging-{}",
        target
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("install"),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let staging = target.with_file_name(staging_name);
    if let Some(parent) = staging.parent() {
        ensure_dir(parent)?;
    }
    if staging.exists() {
        std::fs::remove_dir_all(&staging)
            .map_err(|e| format!("Could not clear stale staging directory: {}", e))?;
    }
    ensure_dir(&staging)?;
    let mut guard = StagingGuard {
        staging: staging.clone(),
        committed: false,
    };

    let client = http_client_versioned().await;

    emit_progress(
        &app,
        &VersionInstallProgress {
            install_id: install_id.clone(),
            channel: channel.clone(),
            version_hash: version_hash.clone(),
            stage: "resolving".into(),
            package: None,
            current: 0,
            total: 0,
            message: None,
        },
    );

    let mut base = channel_base_url(&channel);
    let manifest_name = format!("{}-rbxPkgManifest.txt", version_hash);

    let manifest_url = format!("{}{}", base, manifest_name);
    let manifest_text = match fetch_text(&client, &manifest_url).await {
        Ok(t) => t,
        Err(_) if !channel.eq_ignore_ascii_case("LIVE") => {
            base = fallback_common_base_url();
            fetch_text(&client, &format!("{}{}", base, manifest_name)).await?
        }
        Err(e) => return Err(e),
    };

    let packages = parse_pkg_manifest(&manifest_text)?;
    if packages.is_empty() {
        return Err("Manifest contained no packages".into());
    }

    let total = packages.len() as u64;

    let max_parallel = app
        .state::<crate::data::settings::SettingsStore>()
        .get_int("Versions", "MaxParallelDownloads")
        .unwrap_or(4)
        .clamp(1, 8) as usize;

    let mut completed: u64 = 0;
    let mut pipeline: FuturesUnordered<BoxFuture<'static, Result<String, String>>> =
        FuturesUnordered::new();
    let mut iter = packages.iter().cloned();
    let spawn_one = |entry: PkgManifestEntry,
                     client: reqwest::Client,
                     base: String,
                     version_hash: String,
                     staging: PathBuf| {
        async move {
            let url = format!("{}{}-{}", base, version_hash, entry.filename);
            let bytes = fetch_bytes(&client, &url).await?;
            if let Some(expected) = entry.hash.as_deref() {
                if !verify_hash(&bytes, expected) {
                    return Err(format!(
                        "Package {} failed integrity check (expected hash {})",
                        entry.filename, expected
                    ));
                }
            }
            let filename = entry.filename.clone();
            tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
                let subdir = extract_root_for(&filename).unwrap_or("");
                extract_package_into(&bytes, &staging, subdir)?;
                Ok(filename)
            })
            .await
            .map_err(|e| format!("Extraction task panicked: {}", e))?
        }
        .boxed()
    };

    for _ in 0..max_parallel.min(packages.len()) {
        if let Some(entry) = iter.next() {
            pipeline.push(spawn_one(
                entry,
                client.clone(),
                base.clone(),
                version_hash.clone(),
                staging.clone(),
            ));
        }
    }

    while let Some(result) = pipeline.next().await {
        let pkg = result?;
        completed += 1;
        emit_progress(
            &app,
            &VersionInstallProgress {
                install_id: install_id.clone(),
                channel: channel.clone(),
                version_hash: version_hash.clone(),
                stage: "installing".into(),
                package: Some(pkg),
                current: completed,
                total,
                message: None,
            },
        );
        if let Some(next_entry) = iter.next() {
            pipeline.push(spawn_one(
                next_entry,
                client.clone(),
                base.clone(),
                version_hash.clone(),
                staging.clone(),
            ));
        }
    }

    let app_settings_path = staging.join("AppSettings.xml");
    std::fs::write(&app_settings_path, APP_SETTINGS_XML)
        .map_err(|e| format!("Could not write AppSettings.xml: {}", e))?;

    let exe_path = staging.join("RobloxPlayerBeta.exe");
    if !exe_path.exists() {
        return Err("Install completed but RobloxPlayerBeta.exe is missing".into());
    }

    let backup_target = if target.exists() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let candidate = target.with_file_name(format!(
            "{}.old-{}",
            target.file_name().and_then(|n| n.to_str()).unwrap_or("version"),
            stamp
        ));
        std::fs::rename(&target, &candidate).map_err(|e| {
            format!(
                "Could not set aside existing version directory: {}",
                e
            )
        })?;
        Some(candidate)
    } else {
        None
    };

    if let Err(e) = std::fs::rename(&staging, &target) {
        if let Some(backup) = &backup_target {
            let _ = std::fs::rename(backup, &target);
        }
        return Err(format!("Could not move staged install into place: {}", e));
    }
    guard.committed = true;
    if let Some(backup) = backup_target {
        let _ = std::fs::remove_dir_all(&backup);
    }

    Ok(())
}

pub async fn install_version(
    app: tauri::AppHandle,
    install_id: String,
    channel: String,
    version_hash: String,
    label: Option<String>,
) -> Result<crate::data::versions::VersionEntry, String> {
    use crate::data::versions::VersionEntry;

    let target = install_target_dir(&channel, &version_hash)?;
    download_version_into(
        app.clone(),
        install_id.clone(),
        channel.clone(),
        version_hash.clone(),
        target.clone(),
    )
    .await?;

    let install_size = folder_size(&target);

    let entry = VersionEntry {
        channel: channel.clone(),
        version_hash: version_hash.clone(),
        binary_type: "WindowsPlayer".into(),
        display_version: None,
        install_path: target.to_string_lossy().into_owned(),
        install_size_bytes: install_size,
        installed_at: Some(chrono::Utc::now()),
        last_launched_at: None,
        user_label: label.filter(|l| !l.trim().is_empty()),
    };

    let store = app.state::<crate::data::versions::VersionsCatalogStore>();
    store.upsert(entry.clone()).map_err(|e| {
        format!(
            "Files installed at {} but catalog write failed: {}. Re-run install to register.",
            target.display(),
            e
        )
    })?;

    emit_progress(
        &app,
        &VersionInstallProgress {
            install_id,
            channel,
            version_hash,
            stage: "ready".into(),
            package: None,
            current: 0,
            total: 0,
            message: None,
        },
    );

    Ok(entry)
}

fn pristine_cache_dir() -> Option<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")?;
    Some(
        PathBuf::from(local)
            .join("Roblox Account Manager")
            .join("IsolationCache"),
    )
}

pub struct PristineRoblox {
    pub channel: String,
    pub version_hash: String,
    pub path: PathBuf,
}

pub async fn ensure_pristine_roblox(app: &tauri::AppHandle) -> Result<PristineRoblox, String> {
    let catalog = fetch_remote_catalog().await?;
    let current = catalog
        .current
        .iter()
        .find(|e| e.binary_type.eq_ignore_ascii_case("WindowsPlayer"))
        .ok_or_else(|| "Could not determine the current Roblox version".to_string())?;
    let channel = if current.channel.trim().is_empty() {
        "LIVE".to_string()
    } else {
        current.channel.clone()
    };
    let version_hash = current.version_hash.clone();
    if !is_valid_channel_name(&channel) {
        return Err(format!("Invalid Roblox channel name: {:?}", channel));
    }
    if !is_valid_version_hash(&version_hash) {
        return Err(format!("Invalid Roblox version hash: {:?}", version_hash));
    }

    let root = pristine_cache_dir().ok_or_else(|| "Could not resolve LOCALAPPDATA".to_string())?;
    let path = root.join(&version_hash);

    if path.join("RobloxPlayerBeta.exe").exists() {
        return Ok(PristineRoblox {
            channel,
            version_hash,
            path,
        });
    }

    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            if entry.path() != path {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
    ensure_dir(&root)?;

    download_version_into(
        app.clone(),
        "isolation-pristine".to_string(),
        channel.clone(),
        version_hash.clone(),
        path.clone(),
    )
    .await?;

    Ok(PristineRoblox {
        channel,
        version_hash,
        path,
    })
}

fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    ensure_dir(dst)?;
    let entries =
        std::fs::read_dir(src).map_err(|e| format!("Could not read {}: {}", src.display(), e))?;
    for entry in entries {
        let entry =
            entry.map_err(|e| format!("Could not read entry in {}: {}", src.display(), e))?;
        let path = entry.path();
        let dest = dst.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|e| format!("Could not read {}: {}", path.display(), e))?;
        if file_type.is_dir() {
            copy_dir_recursive(&path, &dest)?;
        } else {
            std::fs::copy(&path, &dest)
                .map_err(|e| format!("Could not copy {}: {}", path.display(), e))?;
        }
    }
    Ok(())
}

pub fn swap_in_standard_roblox(pristine: &PristineRoblox) -> Result<String, String> {
    let local =
        std::env::var_os("LOCALAPPDATA").ok_or_else(|| "Could not resolve LOCALAPPDATA".to_string())?;
    let target = PathBuf::from(local)
        .join("Roblox")
        .join("Versions")
        .join(&pristine.version_hash);
    if target.exists() {
        std::fs::remove_dir_all(&target)
            .map_err(|e| format!("Could not clear existing Roblox install: {}", e))?;
    }
    if let Some(parent) = target.parent() {
        ensure_dir(parent)?;
    }
    copy_dir_recursive(&pristine.path, &target)?;
    Ok(target.to_string_lossy().into_owned())
}

pub fn uninstall_version(channel: &str, version_hash: &str) -> Result<bool, String> {
    if let Ok(target) = install_target_dir(channel, version_hash) {
        if target.exists() {
            std::fs::remove_dir_all(&target)
                .map_err(|e| format!("Could not delete version folder: {}", e))?;
        }
    }
    Ok(true)
}

pub fn resolve_roblox_install_path(
    account_version: Option<&str>,
    settings: &crate::data::settings::SettingsStore,
    catalog: &crate::data::versions::VersionsCatalogStore,
) -> Result<(String, Option<String>), String> {
    if let Some(version_id) = account_version.filter(|v| !v.trim().is_empty()) {
        if let Some(entry) = catalog.find(version_id) {
            let path = std::path::Path::new(&entry.install_path);
            if path.join("RobloxPlayerBeta.exe").exists() {
                return Ok((entry.install_path.clone(), Some(entry.version_id())));
            }
        }
    }

    let default = settings.get_string("Versions", "DefaultVersion");
    if !default.trim().is_empty() {
        if let Some(entry) = catalog.find(&default) {
            let path = std::path::Path::new(&entry.install_path);
            if path.join("RobloxPlayerBeta.exe").exists() {
                return Ok((entry.install_path.clone(), Some(entry.version_id())));
            }
        }
    }

    get_roblox_path().map(|p| (p, None))
}
