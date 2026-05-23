#[tauri::command]
fn versions_list_installed(
    catalog: tauri::State<'_, data::versions::VersionsCatalogStore>,
) -> Result<Vec<data::versions::VersionEntry>, String> {
    Ok(catalog.list())
}

#[tauri::command]
async fn versions_list_remote() -> Result<serde_json::Value, String> {
    #[cfg(target_os = "windows")]
    {
        let catalog = platform::windows::fetch_remote_catalog().await?;
        Ok(serde_json::json!({
            "current": catalog.current,
            "past": catalog.past,
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
    #[cfg(target_os = "windows")]
    {
        platform::windows::uninstall_version(&channel, &version_hash)?;
    }
    catalog.remove(&channel, &version_hash)?;

    let version_id = format!("{}:{}", channel, version_hash);
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
