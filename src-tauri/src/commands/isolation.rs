#[cfg(target_os = "windows")]
fn isolation_options_from_settings(settings: &SettingsStore) -> platform::windows::IsolationOptions {
    use platform::windows::IsolationMode;

    let mode = IsolationMode::from_str(&settings.get_string("Isolation", "Mode"));
    platform::windows::IsolationOptions {
        mode,
        spoof_machine_guid: settings.get_bool("Isolation", "SpoofMachineGuid"),
        spoof_mac: settings.get_bool("Isolation", "SpoofMacAddress"),
        target_adapter: settings.get_string("Isolation", "TargetAdapter"),
        include_studio: settings.get_bool("Isolation", "IncludeStudio"),
        preserve_fast_flags: settings
            .get("Isolation", "PreserveFastFlags")
            .ok()
            .flatten()
            .map(|v| v == "true")
            .unwrap_or(true),
        preserve_basic_settings: settings
            .get("Isolation", "PreserveBasicSettings")
            .ok()
            .flatten()
            .map(|v| v == "true")
            .unwrap_or(true),
    }
}

#[cfg(target_os = "windows")]
fn persist_isolation_backups(
    settings: &SettingsStore,
    report: &platform::windows::IsolationReport,
) {
    if let Some(guid) = report.captured_machine_guid.as_deref() {
        let existing = settings.get_string("Isolation", "BackupMachineGuid");
        if existing.trim().is_empty() {
            let _ = settings.set("Isolation", "BackupMachineGuid", guid);
        }
    }
    if let Some(subkey) = report.captured_adapter_subkey.as_deref() {
        let existing_subkey = settings.get_string("Isolation", "BackupAdapterId");
        if existing_subkey.trim().is_empty() {
            let _ = settings.set("Isolation", "BackupAdapterId", subkey);
            let value = report.captured_network_address.clone().unwrap_or_default();
            let _ = settings.set("Isolation", "BackupNetworkAddress", &value);
        }
    }
}

#[cfg(target_os = "windows")]
pub(crate) async fn run_pre_launch_isolation(
    app: &tauri::AppHandle,
    settings: &SettingsStore,
) -> Result<Option<platform::windows::IsolationReport>, String> {
    let opts = isolation_options_from_settings(settings);
    if !opts.does_anything() {
        return Ok(None);
    }
    let app_owned = app.clone();
    let opts_owned = opts;
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        platform::windows::apply_pre_launch(&app_owned, &opts_owned)
    })
    .await
    .map_err(|e| format!("Isolation task panicked: {}", e))?;

    match outcome {
        Ok(report) => {
            persist_isolation_backups(settings, &report);
            Ok(Some(report))
        }
        Err(failure) => {
            persist_isolation_backups(settings, &failure.partial);
            Err(failure.message)
        }
    }
}

#[cfg(target_os = "windows")]
pub(crate) async fn apply_pending_fast_flags_when_ready(timeout: std::time::Duration) {
    let Some(local) = std::env::var_os("LOCALAPPDATA") else {
        return;
    };
    let versions_root = std::path::PathBuf::from(local).join("Roblox").join("Versions");
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if !platform::windows::has_pending_fast_flags() {
            return;
        }
        if let Ok(entries) = std::fs::read_dir(&versions_root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                if !path.join("RobloxPlayerBeta.exe").exists() {
                    continue;
                }
                if platform::windows::apply_pending_fast_flags_to(&path) {
                    return;
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
}

#[cfg(not(target_os = "windows"))]
pub(crate) async fn apply_pending_fast_flags_when_ready(_timeout: std::time::Duration) {}

#[tauri::command]
fn isolation_get_status(
    settings: tauri::State<'_, SettingsStore>,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "windows")]
    {
        let opts = isolation_options_from_settings(&settings);
        let backup_guid = settings.get_string("Isolation", "BackupMachineGuid");
        let backup_mac = settings.get_string("Isolation", "BackupNetworkAddress");
        let backup_adapter = settings.get_string("Isolation", "BackupAdapterId");
        Ok(serde_json::json!({
            "platformSupported": true,
            "mode": opts.mode.as_str(),
            "spoofMachineGuid": opts.spoof_machine_guid,
            "spoofMac": opts.spoof_mac,
            "targetAdapter": opts.target_adapter,
            "includeStudio": opts.include_studio,
            "preserveFastFlags": opts.preserve_fast_flags,
            "preserveBasicSettings": opts.preserve_basic_settings,
            "backupMachineGuid": backup_guid,
            "backupNetworkAddress": backup_mac,
            "backupAdapterId": backup_adapter,
        }))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = settings;
        Ok(serde_json::json!({
            "platformSupported": false,
        }))
    }
}

#[tauri::command]
fn isolation_save(
    settings: tauri::State<'_, SettingsStore>,
    mode: String,
    spoof_machine_guid: bool,
    spoof_mac: bool,
    target_adapter: String,
    include_studio: bool,
    preserve_fast_flags: bool,
    preserve_basic_settings: bool,
) -> Result<(), String> {
    let mode_normalized = match mode.trim().to_ascii_lowercase().as_str() {
        "light" => "Light",
        "medium" => "Medium",
        "full" => "Full",
        _ => "Off",
    };
    settings.set("Isolation", "Mode", mode_normalized)?;
    settings.set(
        "Isolation",
        "SpoofMachineGuid",
        if spoof_machine_guid { "true" } else { "false" },
    )?;
    settings.set(
        "Isolation",
        "SpoofMacAddress",
        if spoof_mac { "true" } else { "false" },
    )?;
    settings.set("Isolation", "TargetAdapter", target_adapter.trim())?;
    settings.set(
        "Isolation",
        "IncludeStudio",
        if include_studio { "true" } else { "false" },
    )?;
    settings.set(
        "Isolation",
        "PreserveFastFlags",
        if preserve_fast_flags { "true" } else { "false" },
    )?;
    settings.set(
        "Isolation",
        "PreserveBasicSettings",
        if preserve_basic_settings { "true" } else { "false" },
    )?;
    Ok(())
}

#[tauri::command]
fn isolation_list_adapters() -> Result<Vec<serde_json::Value>, String> {
    #[cfg(target_os = "windows")]
    {
        let adapters = platform::windows::list_network_adapters()?;
        Ok(adapters
            .into_iter()
            .map(|a| {
                serde_json::json!({
                    "subkey": a.subkey,
                    "description": a.description,
                    "currentMac": a.current_mac,
                    "netCfgInstanceId": a.net_cfg_instance_id,
                })
            })
            .collect())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(Vec::new())
    }
}

#[tauri::command]
async fn isolation_restore_network_identifiers(
    settings: tauri::State<'_, SettingsStore>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let backup_guid = settings.get_string("Isolation", "BackupMachineGuid");
        let backup_adapter = settings.get_string("Isolation", "BackupAdapterId");
        let backup_mac = settings.get_string("Isolation", "BackupNetworkAddress");

        let guid_opt = if backup_guid.trim().is_empty() {
            None
        } else {
            Some(backup_guid.clone())
        };
        let adapter_opt = if backup_adapter.trim().is_empty() {
            None
        } else {
            Some(backup_adapter.clone())
        };
        let mac_opt = if backup_mac.trim().is_empty() {
            None
        } else {
            Some(backup_mac.clone())
        };

        if guid_opt.is_none() && adapter_opt.is_none() {
            return Err("No backup values stored; nothing to restore".into());
        }

        tauri::async_runtime::spawn_blocking(move || {
            platform::windows::restore_network_identifiers(
                guid_opt.as_deref(),
                adapter_opt.as_deref(),
                mac_opt.as_deref(),
            )
        })
        .await
        .map_err(|e| format!("Restore task panicked: {}", e))??;

        let _ = settings.set("Isolation", "BackupMachineGuid", "");
        let _ = settings.set("Isolation", "BackupNetworkAddress", "");
        let _ = settings.set("Isolation", "BackupAdapterId", "");
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = settings;
        Err("Available on Windows only".into())
    }
}

#[tauri::command]
fn isolation_dry_run(
    mode: String,
    spoof_machine_guid: bool,
    spoof_mac: bool,
    target_adapter: String,
    include_studio: bool,
    preserve_fast_flags: bool,
    preserve_basic_settings: bool,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "windows")]
    {
        let opts = platform::windows::IsolationOptions {
            mode: platform::windows::IsolationMode::from_str(&mode),
            spoof_machine_guid,
            spoof_mac,
            target_adapter,
            include_studio,
            preserve_fast_flags,
            preserve_basic_settings,
        };
        let report = platform::windows::dry_run(&opts)?;
        Ok(serde_json::json!({
            "paths": report.paths,
            "registryKeys": report.registry_keys,
        }))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (
            mode,
            spoof_machine_guid,
            spoof_mac,
            target_adapter,
            include_studio,
            preserve_fast_flags,
            preserve_basic_settings,
        );
        Err("Available on Windows only".into())
    }
}
