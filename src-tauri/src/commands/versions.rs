#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct InstalledVersionInfo {
    channel: String,
    version_hash: String,
    binary_type: String,
    install_path: String,
    display_version: Option<String>,
    install_size_bytes: u64,
    installed_at: Option<chrono::DateTime<chrono::Utc>>,
    last_launched_at: Option<chrono::DateTime<chrono::Utc>>,
    user_label: Option<String>,
    exists: bool,
}

fn version_files_present(install_path: &str) -> bool {
    std::path::Path::new(install_path)
        .join("RobloxPlayerBeta.exe")
        .exists()
}

#[tauri::command]
fn versions_list_installed(
    catalog: tauri::State<'_, data::versions::VersionsCatalogStore>,
) -> Result<Vec<InstalledVersionInfo>, String> {
    Ok(catalog
        .list()
        .into_iter()
        .map(|e| {
            let exists = version_files_present(&e.install_path);
            InstalledVersionInfo {
                channel: e.channel,
                version_hash: e.version_hash,
                binary_type: e.binary_type,
                install_path: e.install_path,
                display_version: e.display_version,
                install_size_bytes: e.install_size_bytes,
                installed_at: e.installed_at,
                last_launched_at: e.last_launched_at,
                user_label: e.user_label,
                exists,
            }
        })
        .collect())
}

#[tauri::command]
fn versions_prune_missing(
    catalog: tauri::State<'_, data::versions::VersionsCatalogStore>,
    settings: tauri::State<'_, SettingsStore>,
    accounts: tauri::State<'_, AccountStore>,
) -> Result<usize, String> {
    #[cfg(target_os = "windows")]
    let tracker = {
        let tracker = platform::windows::tracker();
        let _ = tracker.cleanup_dead_processes();
        tracker
    };

    let default = settings.get_string("Versions", "DefaultVersion");
    let mut removed = 0usize;

    for entry in catalog.list() {
        if version_files_present(&entry.install_path) {
            continue;
        }
        let version_id = entry.version_id();

        #[cfg(target_os = "windows")]
        if tracker.running_version_keys().contains(&Some(version_id.clone())) {
            continue;
        }

        catalog.remove(&entry.channel, &entry.version_hash)?;
        removed += 1;

        if default == version_id {
            let _ = settings.set("Versions", "DefaultVersion", "");
        }

        let mut snapshot = accounts.get_all()?;
        for account in snapshot.iter_mut() {
            if account.fields.get("RobloxVersion") == Some(&version_id) {
                account.fields.remove("RobloxVersion");
                accounts.update(account.clone())?;
            }
        }
    }

    Ok(removed)
}

#[tauri::command]
async fn versions_list_remote() -> Result<serde_json::Value, String> {
    #[cfg(target_os = "windows")]
    {
        let catalog = platform::windows::fetch_remote_catalog().await?;
        Ok(serde_json::json!({
            "current": catalog.current,
            "past": catalog.past,
            "pastError": catalog.past_error,
        }))
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Available on Windows only".into())
    }
}

#[tauri::command]
async fn versions_install(
    app: tauri::AppHandle,
    install_id: String,
    channel: String,
    version_hash: String,
    label: Option<String>,
) -> Result<data::versions::VersionEntry, String> {
    #[cfg(target_os = "windows")]
    {
        let channel_normalized = if channel.trim().is_empty() {
            "LIVE".to_string()
        } else {
            channel.trim().to_string()
        };
        let version_hash_normalized = version_hash.trim().to_string();
        if version_hash_normalized.is_empty() {
            return Err("Version hash is required".into());
        }
        let install_id = if install_id.trim().is_empty() {
            format!("install-{}", now_ms())
        } else {
            install_id.trim().to_string()
        };
        platform::windows::install_version(
            app,
            install_id,
            channel_normalized,
            version_hash_normalized,
            label,
        )
        .await
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, install_id, channel, version_hash, label);
        Err("Available on Windows only".into())
    }
}

#[tauri::command]
fn versions_uninstall(
    catalog: tauri::State<'_, data::versions::VersionsCatalogStore>,
    settings: tauri::State<'_, SettingsStore>,
    accounts: tauri::State<'_, AccountStore>,
    channel: String,
    version_hash: String,
) -> Result<(), String> {
    let version_id = format!("{}:{}", channel, version_hash);
    #[cfg(target_os = "windows")]
    {
        let tracker = platform::windows::tracker();
        let _ = tracker.cleanup_dead_processes();
        if tracker
            .running_version_keys()
            .contains(&Some(version_id.clone()))
        {
            return Err(
                "Cannot uninstall: this Roblox version is currently running. Close all accounts using it first.".into(),
            );
        }
        platform::windows::uninstall_version(&channel, &version_hash)?;
    }
    catalog.remove(&channel, &version_hash)?;
    let default = settings.get_string("Versions", "DefaultVersion");
    if default == version_id {
        let _ = settings.set("Versions", "DefaultVersion", "");
    }

    let mut updated = false;
    let mut snapshot = accounts.get_all()?;
    for account in snapshot.iter_mut() {
        if let Some(value) = account.fields.get("RobloxVersion") {
            if value == &version_id {
                account.fields.remove("RobloxVersion");
                updated = true;
                accounts.update(account.clone())?;
            }
        }
    }
    let _ = updated;
    Ok(())
}

#[tauri::command]
fn versions_set_default(
    settings: tauri::State<'_, SettingsStore>,
    version_id: Option<String>,
) -> Result<(), String> {
    let value = version_id.unwrap_or_default();
    settings.set("Versions", "DefaultVersion", value.trim())
}

#[tauri::command]
fn versions_set_account_override(
    accounts: tauri::State<'_, AccountStore>,
    user_id: i64,
    version_id: Option<String>,
) -> Result<(), String> {
    let snapshot = accounts.get_all()?;
    let Some(mut account) = snapshot.into_iter().find(|a| a.user_id == user_id) else {
        return Err("Account not found".into());
    };
    match version_id.map(|v| v.trim().to_string()) {
        Some(v) if !v.is_empty() => {
            account.fields.insert("RobloxVersion".to_string(), v);
        }
        _ => {
            account.fields.remove("RobloxVersion");
        }
    }
    accounts.update(account)?;
    Ok(())
}

#[tauri::command]
fn versions_set_label(
    catalog: tauri::State<'_, data::versions::VersionsCatalogStore>,
    channel: String,
    version_hash: String,
    label: Option<String>,
) -> Result<(), String> {
    catalog.set_label(&channel, &version_hash, label)
}

#[tauri::command]
fn versions_detect_install_path() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        platform::windows::auto_detect_roblox_path()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Available on Windows only".into())
    }
}

#[tauri::command]
fn versions_set_custom_install_path(
    settings: tauri::State<'_, SettingsStore>,
    path: Option<String>,
) -> Result<String, String> {
    let trimmed = path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());

    let Some(folder) = trimmed else {
        settings.set("Versions", "CustomInstallPath", "")?;
        #[cfg(target_os = "windows")]
        platform::windows::set_custom_roblox_path(None);
        return Ok(String::new());
    };

    #[cfg(target_os = "windows")]
    {
        let resolved = platform::windows::normalize_install_folder(&folder).ok_or_else(|| {
            "RobloxPlayerBeta.exe not found in that folder. Pick the Roblox install folder (for example a version-... folder).".to_string()
        })?;
        settings.set("Versions", "CustomInstallPath", &resolved)?;
        platform::windows::set_custom_roblox_path(Some(resolved.clone()));
        Ok(resolved)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = folder;
        Err("Available on Windows only".into())
    }
}

#[tauri::command]
fn versions_open_folder(
    catalog: tauri::State<'_, data::versions::VersionsCatalogStore>,
    channel: String,
    version_hash: String,
) -> Result<(), String> {
    let entry = catalog
        .find(&format!("{}:{}", channel, version_hash))
        .ok_or("Version not found")?;
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&entry.install_path)
            .spawn()
            .map_err(|e| format!("Could not open folder: {}", e))?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = entry;
        Err("Available on Windows only".into())
    }
}
