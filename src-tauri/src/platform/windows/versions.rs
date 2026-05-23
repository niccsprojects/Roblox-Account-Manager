use std::io::Read;
use futures_util::future::{BoxFuture, FutureExt};
use futures_util::stream::{FuturesUnordered, StreamExt};
use tauri::Manager;

const CDN_HOST: &str = "https://setup-aws.rbxcdn.com";
const WEAO_CURRENT_URL: &str = "https://weao.gg/api/versions/current";
const WEAO_PAST_URL: &str = "https://weao.gg/api/versions/past";

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
    let past_raw = fetch_text(&client, WEAO_PAST_URL).await.unwrap_or_default();

    let current: serde_json::Value =
        serde_json::from_str(&current_raw).map_err(|e| format!("Parse error: {}", e))?;
    let past: serde_json::Value = serde_json::from_str(&past_raw).unwrap_or(serde_json::json!({}));

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

fn install_target_dir(channel: &str, version_hash: &str) -> Result<PathBuf, String> {
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

pub async fn install_version(
    app: tauri::AppHandle,
    install_id: String,
    channel: String,
    version_hash: String,
    label: Option<String>,
) -> Result<crate::data::versions::VersionEntry, String> {
    use crate::data::versions::VersionEntry;

    let target = install_target_dir(&channel, &version_hash)?;
    if target.exists() {
        std::fs::remove_dir_all(&target)
            .map_err(|e| format!("Could not remove existing version directory: {}", e))?;
    }
    ensure_dir(&target)?;

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

    let mut downloaded: u64 = 0;
    let mut futures: FuturesUnordered<
        BoxFuture<'static, (PkgManifestEntry, Result<Vec<u8>, String>)>,
    > = FuturesUnordered::new();
    let mut iter = packages.iter().cloned();
    let spawn_one =
        |entry: PkgManifestEntry, client: reqwest::Client, base: String, version_hash: String| {
            async move {
                let url = format!("{}{}-{}", base, version_hash, entry.filename);
                let bytes = fetch_bytes(&client, &url).await;
                (entry, bytes)
            }
            .boxed()
        };

    for _ in 0..max_parallel.min(packages.len()) {
        if let Some(entry) = iter.next() {
            futures.push(spawn_one(
                entry,
                client.clone(),
                base.clone(),
                version_hash.clone(),
            ));
        }
    }

    let mut package_bytes: Vec<(String, Vec<u8>)> = Vec::with_capacity(packages.len());

    while let Some((entry, bytes_result)) = futures.next().await {
        let bytes = bytes_result?;
        if let Some(expected) = entry.hash.as_deref() {
            if !verify_hash(&bytes, expected) {
                return Err(format!(
                    "Package {} failed integrity check (expected hash {})",
                    entry.filename, expected
                ));
            }
        }
        downloaded += 1;
        emit_progress(
            &app,
            &VersionInstallProgress {
                install_id: install_id.clone(),
                channel: channel.clone(),
                version_hash: version_hash.clone(),
                stage: "downloading".into(),
                package: Some(entry.filename.clone()),
                current: downloaded,
                total,
                message: None,
            },
        );
        package_bytes.push((entry.filename, bytes));
        if let Some(next_entry) = iter.next() {
            futures.push(spawn_one(
                next_entry,
                client.clone(),
                base.clone(),
                version_hash.clone(),
            ));
        }
    }

    emit_progress(
        &app,
        &VersionInstallProgress {
            install_id: install_id.clone(),
            channel: channel.clone(),
            version_hash: version_hash.clone(),
            stage: "extracting".into(),
            package: None,
            current: 0,
            total,
            message: None,
        },
    );

    let target_for_extract = target.clone();
    let install_id_for_extract = install_id.clone();
    let channel_for_extract = channel.clone();
    let version_for_extract = version_hash.clone();
    let app_for_extract = app.clone();
    let extracted = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut count = 0u64;
        for (pkg, bytes) in &package_bytes {
            let subdir = extract_root_for(pkg).unwrap_or("");
            extract_package_into(bytes, &target_for_extract, subdir)?;
            count += 1;
            let _ = app_for_extract.emit(
                "version-install-progress",
                VersionInstallProgress {
                    install_id: install_id_for_extract.clone(),
                    channel: channel_for_extract.clone(),
                    version_hash: version_for_extract.clone(),
                    stage: "extracting".into(),
                    package: Some(pkg.clone()),
                    current: count,
                    total: package_bytes.len() as u64,
                    message: None,
                },
            );
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Extraction task panicked: {}", e))?;
    extracted?;

    let app_settings_path = target.join("AppSettings.xml");
    std::fs::write(&app_settings_path, APP_SETTINGS_XML)
        .map_err(|e| format!("Could not write AppSettings.xml: {}", e))?;

    let exe_path = target.join("RobloxPlayerBeta.exe");
    if !exe_path.exists() {
        return Err("Install completed but RobloxPlayerBeta.exe is missing".into());
    }

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
    store.upsert(entry.clone())?;

    emit_progress(
        &app,
        &VersionInstallProgress {
            install_id,
            channel,
            version_hash,
            stage: "ready".into(),
            package: None,
            current: total,
            total,
            message: None,
        },
    );

    Ok(entry)
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
