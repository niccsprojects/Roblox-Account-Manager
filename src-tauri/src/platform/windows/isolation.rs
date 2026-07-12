use std::path::Path;

use tauri::Emitter;

use windows_sys::Win32::System::Registry::{
    RegCreateKeyExW, RegDeleteTreeW, RegEnumKeyExW, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE,
    KEY_ALL_ACCESS,
};
use windows_sys::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};

const NETWORK_ADAPTER_CLASS_GUID: &str = "{4D36E972-E325-11CE-BFC1-08002BE10318}";
const MACHINE_GUID_KEY: &str = "SOFTWARE\\Microsoft\\Cryptography";
const MACHINE_GUID_VALUE: &str = "MachineGuid";
const ROBLOX_HKCU_KEY: &str = "Software\\ROBLOX Corporation";

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IsolationMode {
    Off,
    Light,
    Medium,
    Full,
}

impl IsolationMode {
    pub fn from_str(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "light" => Self::Light,
            "medium" => Self::Medium,
            "full" => Self::Full,
            _ => Self::Off,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Light => "light",
            Self::Medium => "medium",
            Self::Full => "full",
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IsolationOptions {
    pub mode: IsolationMode,
    #[serde(default)]
    pub spoof_machine_guid: bool,
    #[serde(default)]
    pub spoof_mac: bool,
    #[serde(default)]
    pub target_adapter: String,
    #[serde(default)]
    pub include_studio: bool,
    #[serde(default = "default_true")]
    pub preserve_fast_flags: bool,
    #[serde(default = "default_true")]
    pub preserve_basic_settings: bool,
    #[serde(default)]
    pub create_restore_point: bool,
}

fn default_true() -> bool {
    true
}

impl IsolationOptions {
    pub fn does_anything(&self) -> bool {
        !matches!(self.mode, IsolationMode::Off) || self.spoof_machine_guid || self.spoof_mac
    }
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IsolationReport {
    pub paths_cleaned: u32,
    pub bytes_freed: u64,
    pub machine_guid_rotated: bool,
    pub mac_rotated: bool,
    pub skipped_reason: Option<String>,
    pub captured_machine_guid: Option<String>,
    pub captured_network_address: Option<String>,
    pub captured_adapter_subkey: Option<String>,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IsolationDryRunReport {
    pub paths: Vec<String>,
    pub registry_keys: Vec<String>,
}

#[derive(Debug)]
pub struct IsolationFailure {
    pub message: String,
    pub partial: IsolationReport,
}

impl From<&str> for IsolationFailure {
    fn from(message: &str) -> Self {
        Self {
            message: message.to_string(),
            partial: IsolationReport::default(),
        }
    }
}

impl From<String> for IsolationFailure {
    fn from(message: String) -> Self {
        Self {
            message,
            partial: IsolationReport::default(),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct IsolationProgress {
    stage: String,
    message: String,
    paths_cleaned: u32,
    bytes_freed: u64,
    finished: bool,
}

fn emit_isolation_progress(
    app: &tauri::AppHandle,
    stage: &str,
    message: &str,
    report: &IsolationReport,
    finished: bool,
) {
    let _ = app.emit(
        "isolation-progress",
        IsolationProgress {
            stage: stage.to_string(),
            message: message.to_string(),
            paths_cleaned: report.paths_cleaned,
            bytes_freed: report.bytes_freed,
            finished,
        },
    );
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterInfo {
    pub subkey: String,
    pub description: String,
    pub current_mac: Option<String>,
    pub net_cfg_instance_id: Option<String>,
}

fn read_string_value(hive: isize, sub_key: &str, value_name: &str) -> Option<String> {
    use windows_sys::Win32::System::Registry::{RegCloseKey, RegOpenKeyExW, RegQueryValueExW, KEY_READ, REG_SZ};

    let sub_wide = encode_wide(sub_key);
    let value_wide = encode_wide(value_name);

    unsafe {
        let mut hkey: windows_sys::Win32::System::Registry::HKEY = std::ptr::null_mut();
        if RegOpenKeyExW(hive as _, sub_wide.as_ptr(), 0, KEY_READ, &mut hkey) != 0 {
            return None;
        }

        let mut buf = [0u16; 1024];
        let mut buf_size = (buf.len() * 2) as u32;
        let mut value_type = 0u32;

        let result = RegQueryValueExW(
            hkey,
            value_wide.as_ptr(),
            std::ptr::null_mut(),
            &mut value_type,
            buf.as_mut_ptr() as *mut u8,
            &mut buf_size,
        );

        RegCloseKey(hkey);

        if result != 0 || value_type != REG_SZ {
            return None;
        }

        let len = (buf_size as usize / 2).saturating_sub(1);
        Some(String::from_utf16_lossy(&buf[..len]))
    }
}

fn open_adapter_class_key() -> Option<windows_sys::Win32::System::Registry::HKEY> {
    use windows_sys::Win32::System::Registry::{RegOpenKeyExW, KEY_READ};

    let path = format!(
        "SYSTEM\\CurrentControlSet\\Control\\Class\\{}",
        NETWORK_ADAPTER_CLASS_GUID
    );
    let wide = encode_wide(&path);

    unsafe {
        let mut hkey: windows_sys::Win32::System::Registry::HKEY = std::ptr::null_mut();
        if RegOpenKeyExW(HKEY_LOCAL_MACHINE, wide.as_ptr(), 0, KEY_READ, &mut hkey) != 0 {
            return None;
        }
        Some(hkey)
    }
}

pub fn list_network_adapters() -> Result<Vec<AdapterInfo>, String> {
    use windows_sys::Win32::System::Registry::RegCloseKey;

    let Some(class_key) = open_adapter_class_key() else {
        return Err("Could not open network adapter class registry key".into());
    };

    let mut adapters = Vec::new();
    let mut index: u32 = 0;
    let mut name_buf = [0u16; 256];

    unsafe {
        loop {
            let mut name_len = name_buf.len() as u32;
            let result = RegEnumKeyExW(
                class_key,
                index,
                name_buf.as_mut_ptr(),
                &mut name_len,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            );
            if result != 0 {
                break;
            }
            index += 1;
            let subkey = String::from_utf16_lossy(&name_buf[..name_len as usize]);

            if subkey.len() != 4 || !subkey.chars().all(|c| c.is_ascii_digit()) {
                continue;
            }

            let sub_path = format!(
                "SYSTEM\\CurrentControlSet\\Control\\Class\\{}\\{}",
                NETWORK_ADAPTER_CLASS_GUID, subkey
            );

            let Some(desc) = read_string_value(HKEY_LOCAL_MACHINE as _, &sub_path, "DriverDesc")
            else {
                continue;
            };

            let lower_desc = desc.to_ascii_lowercase();
            if lower_desc.contains("wan miniport")
                || lower_desc.contains("kernel debugger")
                || lower_desc.contains("microsoft hosted network")
                || lower_desc.contains("packet scheduler")
            {
                continue;
            }

            let current_mac =
                read_string_value(HKEY_LOCAL_MACHINE as _, &sub_path, "NetworkAddress");
            let net_cfg_instance_id =
                read_string_value(HKEY_LOCAL_MACHINE as _, &sub_path, "NetCfgInstanceId");

            adapters.push(AdapterInfo {
                subkey,
                description: desc,
                current_mac,
                net_cfg_instance_id,
            });
        }
        RegCloseKey(class_key);
    }

    Ok(adapters)
}

fn read_machine_guid() -> Option<String> {
    read_string_value(HKEY_LOCAL_MACHINE as _, MACHINE_GUID_KEY, MACHINE_GUID_VALUE)
}

fn ram_isolation_backup_dir() -> Option<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")?;
    Some(
        PathBuf::from(local)
            .join("Roblox Account Manager")
            .join("IsolationBackup"),
    )
}

fn dir_size(path: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    total = total.saturating_add(meta.len());
                } else if meta.is_dir() {
                    total = total.saturating_add(dir_size(&entry.path()));
                }
            }
        }
    }
    total
}

fn wipe_path(path: &Path, report: &mut IsolationReport, dry_paths: Option<&mut Vec<String>>) {
    if !path.exists() {
        return;
    }
    if let Some(list) = dry_paths {
        list.push(path.display().to_string());
        return;
    }
    if path.is_dir() {
        let size = dir_size(path);
        if std::fs::remove_dir_all(path).is_ok() {
            report.paths_cleaned = report.paths_cleaned.saturating_add(1);
            report.bytes_freed = report.bytes_freed.saturating_add(size);
        }
    } else {
        let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        if std::fs::remove_file(path).is_ok() {
            report.paths_cleaned = report.paths_cleaned.saturating_add(1);
            report.bytes_freed = report.bytes_freed.saturating_add(size);
        }
    }
}

fn wipe_glob_in_dir(
    dir: &Path,
    starts_with: &str,
    report: &mut IsolationReport,
    mut dry: Option<&mut Vec<String>>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name
            .to_ascii_lowercase()
            .starts_with(&starts_with.to_ascii_lowercase())
        {
            wipe_path(&entry.path(), report, dry.as_deref_mut());
        }
    }
}

fn appdata_roaming_roblox() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|s| PathBuf::from(s).join("Roblox"))
}

fn localappdata_roblox() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|s| PathBuf::from(s).join("Roblox"))
}

fn windows_prefetch_dir() -> PathBuf {
    let root = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("C:\\Windows"));
    root.join("Prefetch")
}

fn temp_dir() -> Option<PathBuf> {
    std::env::var_os("TEMP").map(PathBuf::from)
}

fn programdata_roblox() -> Option<PathBuf> {
    std::env::var_os("PROGRAMDATA").map(|s| PathBuf::from(s).join("Roblox"))
}

fn programfiles_roblox_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(pf) = std::env::var_os("ProgramFiles") {
        out.push(PathBuf::from(pf).join("Roblox").join("Versions"));
    }
    if let Some(pf86) = std::env::var_os("ProgramFiles(x86)") {
        out.push(PathBuf::from(pf86).join("Roblox").join("Versions"));
    }
    out
}

fn is_under_ram_managed(path: &Path) -> bool {
    if let Some(root) = crate::data::versions::ram_managed_versions_root() {
        path.starts_with(&root)
    } else {
        false
    }
}

fn wipe_light(report: &mut IsolationReport, mut dry: Option<&mut Vec<String>>) {
    if let Some(roaming) = appdata_roaming_roblox() {
        wipe_path(&roaming.join("http"), report, dry.as_deref_mut());
        wipe_path(&roaming.join("logs"), report, dry.as_deref_mut());
    }

    if let Some(tmp) = temp_dir() {
        wipe_glob_in_dir(&tmp, "Roblox", report, dry.as_deref_mut());
    }

    let prefetch = windows_prefetch_dir();
    if prefetch.exists() {
        wipe_glob_in_dir(&prefetch, "ROBLOXPLAYERBETA.EXE-", report, dry.as_deref_mut());
        wipe_glob_in_dir(&prefetch, "ROBLOXCRASHHANDLER.EXE-", report, dry.as_deref_mut());
    }
}

fn delete_hkcu_roblox(report: &mut IsolationReport, dry: Option<&mut Vec<String>>) {
    if let Some(list) = dry {
        list.push(format!("HKCU\\{}", ROBLOX_HKCU_KEY));
        return;
    }
    let wide = encode_wide(ROBLOX_HKCU_KEY);
    let result = unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, wide.as_ptr()) };
    if result == 0 {
        report.paths_cleaned = report.paths_cleaned.saturating_add(1);
    }
}

fn wipe_full_versions(
    include_studio: bool,
    report: &mut IsolationReport,
    mut dry: Option<&mut Vec<String>>,
) {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(local) = localappdata_roblox() {
        roots.push(local.join("Versions"));
        roots.push(local.join("Downloads"));
        roots.push(local.join("Logs"));
    }
    for root in programfiles_roblox_paths() {
        roots.push(root);
    }

    for root in roots {
        if !root.exists() {
            continue;
        }
        if root.file_name().map(|n| n.to_string_lossy().into_owned()) != Some("Versions".into()) {
            wipe_path(&root, report, dry.as_deref_mut());
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if is_under_ram_managed(&path) {
                continue;
            }
            if !include_studio && path.join("RobloxStudioBeta.exe").exists() {
                continue;
            }
            wipe_path(&path, report, dry.as_deref_mut());
        }
    }

    if let Some(pd) = programdata_roblox() {
        wipe_path(&pd, report, dry.as_deref_mut());
    }

    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let local = PathBuf::from(local);
        for launcher in &["Bloxstrap", "Fishstrap", "Voidstrap"] {
            let base = local.join(launcher);
            if !base.exists() {
                continue;
            }
            wipe_path(&base.join("Logs"), report, dry.as_deref_mut());
            wipe_path(&base.join("Downloads"), report, dry.as_deref_mut());

            let launcher_versions = base.join("Versions");
            if let Ok(entries) = std::fs::read_dir(&launcher_versions) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if !include_studio && path.join("RobloxStudioBeta.exe").exists() {
                        continue;
                    }
                    wipe_path(&path, report, dry.as_deref_mut());
                }
            }
        }
    }
}

pub struct FastFlagBackup {
    pub name: String,
    pub content: Vec<u8>,
    pub modified: std::time::SystemTime,
}

fn backup_fast_flags() -> Vec<FastFlagBackup> {
    let mut backups = Vec::new();
    let Some(local) = localappdata_roblox() else {
        return backups;
    };
    let versions = local.join("Versions");
    let Ok(entries) = std::fs::read_dir(&versions) else {
        return backups;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if is_under_ram_managed(&path) {
            continue;
        }
        let settings_path = path.join("ClientSettings").join("ClientAppSettings.json");
        if let Ok(data) = std::fs::read(&settings_path) {
            let modified = std::fs::metadata(&settings_path)
                .and_then(|m| m.modified())
                .unwrap_or(UNIX_EPOCH);
            let name = entry.file_name().to_string_lossy().into_owned();
            backups.push(FastFlagBackup {
                name,
                content: data,
                modified,
            });
        }
    }
    backups
}

fn pending_fast_flags_path() -> Option<PathBuf> {
    Some(ram_isolation_backup_dir()?.join("PendingFastFlags.json"))
}

fn restore_fast_flags(backups: &[FastFlagBackup]) {
    let Some(backup_dir) = ram_isolation_backup_dir() else {
        return;
    };
    let _ = std::fs::create_dir_all(&backup_dir);
    for backup in backups {
        let path = backup_dir.join(format!("{}-ClientAppSettings.json", backup.name));
        let _ = std::fs::write(&path, &backup.content);
    }
    if let Some(pending) = pending_fast_flags_path() {
        let latest = backups.iter().max_by_key(|b| b.modified);
        if let Some(b) = latest {
            let _ = std::fs::write(&pending, &b.content);
        }
    }
}

pub fn apply_pending_fast_flags_to(version_dir: &Path) -> bool {
    let Some(pending) = pending_fast_flags_path() else {
        return false;
    };
    if !pending.exists() {
        return false;
    }
    let Ok(content) = std::fs::read(&pending) else {
        return false;
    };
    let target = version_dir
        .join("ClientSettings")
        .join("ClientAppSettings.json");
    if let Some(parent) = target.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return false;
        }
    }
    if std::fs::write(&target, content).is_ok() {
        let _ = std::fs::remove_file(&pending);
        true
    } else {
        false
    }
}

pub fn has_pending_fast_flags() -> bool {
    pending_fast_flags_path()
        .map(|p| p.exists())
        .unwrap_or(false)
}

fn backup_basic_settings() -> Option<Vec<u8>> {
    let local = localappdata_roblox()?;
    let path = local.join("GlobalBasicSettings_13.xml");
    std::fs::read(&path).ok()
}

fn restore_basic_settings(content: &[u8]) {
    let Some(local) = localappdata_roblox() else {
        return;
    };
    let _ = std::fs::create_dir_all(&local);
    let path = local.join("GlobalBasicSettings_13.xml");
    let _ = std::fs::write(&path, content);
}

fn fill_secure_random(buf: &mut [u8]) -> Result<(), String> {
    use windows_sys::Win32::Security::Cryptography::{
        BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
    };
    let status = unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            buf.as_mut_ptr(),
            buf.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status == 0 {
        Ok(())
    } else {
        Err(format!("BCryptGenRandom failed with NTSTATUS 0x{:08X}", status))
    }
}

fn new_random_mac() -> Result<String, String> {
    let mut bytes = [0u8; 6];
    fill_secure_random(&mut bytes)?;
    bytes[0] = (bytes[0] & 0xFE) | 0x02;
    Ok(bytes
        .iter()
        .map(|b| format!("{:02X}", b))
        .collect::<Vec<_>>()
        .join(""))
}

fn new_random_machine_guid() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    fill_secure_random(&mut bytes)?;
    bytes[6] = (bytes[6] & 0x0F) | 0x40;
    bytes[8] = (bytes[8] & 0x3F) | 0x80;
    Ok(format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    ))
}

fn write_machine_guid_directly(value: &str) -> bool {
    use windows_sys::Win32::System::Registry::{RegCloseKey, RegSetValueExW, REG_SZ};

    let sub_wide = encode_wide(MACHINE_GUID_KEY);
    let name_wide = encode_wide(MACHINE_GUID_VALUE);
    let value_wide = encode_wide(value);
    let mut disposition = 0u32;

    unsafe {
        let mut hkey: windows_sys::Win32::System::Registry::HKEY = std::ptr::null_mut();
        if RegCreateKeyExW(
            HKEY_LOCAL_MACHINE,
            sub_wide.as_ptr(),
            0,
            std::ptr::null_mut(),
            0,
            KEY_ALL_ACCESS,
            std::ptr::null(),
            &mut hkey,
            &mut disposition,
        ) != 0
        {
            return false;
        }
        let bytes = std::slice::from_raw_parts(
            value_wide.as_ptr() as *const u8,
            value_wide.len() * 2,
        );
        let result = RegSetValueExW(
            hkey,
            name_wide.as_ptr(),
            0,
            REG_SZ,
            bytes.as_ptr(),
            bytes.len() as u32,
        );
        RegCloseKey(hkey);
        result == 0
    }
}

fn is_valid_machine_guid(value: &str) -> bool {
    if value.len() != 36 {
        return false;
    }
    let parts: Vec<&str> = value.split('-').collect();
    let expected_lens = [8usize, 4, 4, 4, 12];
    if parts.len() != expected_lens.len() {
        return false;
    }
    parts
        .iter()
        .zip(expected_lens.iter())
        .all(|(p, n)| p.len() == *n && p.chars().all(|c| c.is_ascii_hexdigit()))
}

fn is_valid_mac_hex(value: &str) -> bool {
    value.len() == 12 && value.chars().all(|c| c.is_ascii_hexdigit())
}

fn is_valid_adapter_subkey(value: &str) -> bool {
    value.len() == 4 && value.chars().all(|c| c.is_ascii_digit())
}

fn build_spoof_script(
    opts: &IsolationOptions,
    new_machine_guid: Option<&str>,
    adapter_subkey: Option<&str>,
    new_mac: Option<&str>,
) -> Result<String, String> {
    let mut script = String::new();
    script.push_str("$ErrorActionPreference = 'Stop'\n");

    if opts.create_restore_point {
        script.push_str("try {\n");
        script.push_str("  Enable-ComputerRestore -Drive $env:SystemDrive -ErrorAction SilentlyContinue\n");
        script.push_str("  New-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\SystemRestore' -Name 'SystemRestorePointCreationFrequency' -Value 0 -PropertyType DWord -Force -ErrorAction SilentlyContinue | Out-Null\n");
        script.push_str("  Checkpoint-Computer -Description 'Roblox Account Manager pre-spoof' -RestorePointType 'MODIFY_SETTINGS' -ErrorAction Stop\n");
        script.push_str("} catch {}\n");
    }

    if let (true, Some(guid)) = (opts.spoof_machine_guid, new_machine_guid) {
        if !is_valid_machine_guid(guid) {
            return Err("Refusing to run spoof script: generated MachineGuid is not a valid GUID".into());
        }
        script.push_str(&format!(
            "Set-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography' -Name 'MachineGuid' -Value '{}'\n",
            guid
        ));
    }

    if let (true, Some(subkey), Some(mac)) = (opts.spoof_mac, adapter_subkey, new_mac) {
        if !is_valid_adapter_subkey(subkey) {
            return Err("Refusing to run spoof script: adapter subkey is not a 4-digit identifier".into());
        }
        if !is_valid_mac_hex(mac) {
            return Err("Refusing to run spoof script: generated MAC is not 12 hex characters".into());
        }
        let class_path = format!(
            "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{}\\{}",
            NETWORK_ADAPTER_CLASS_GUID, subkey
        );
        script.push_str(&format!(
            "Set-ItemProperty -Path '{}' -Name 'NetworkAddress' -Value '{}'\n",
            class_path, mac
        ));
        script.push_str(&format!(
            "$desc = (Get-ItemProperty -Path '{}').DriverDesc\n",
            class_path
        ));
        script.push_str(
            "try { $adapter = Get-NetAdapter | Where-Object { $_.InterfaceDescription -eq $desc } | Select-Object -First 1 } catch { $adapter = $null }\n"
        );
        script.push_str("if ($adapter) {\n");
        script.push_str("  try { Disable-NetAdapter -Name $adapter.Name -Confirm:$false -ErrorAction SilentlyContinue } catch {}\n");
        script.push_str("  Start-Sleep -Milliseconds 600\n");
        script.push_str("  try { Enable-NetAdapter -Name $adapter.Name -Confirm:$false -ErrorAction SilentlyContinue } catch {}\n");
        script.push_str("  try { ipconfig /release | Out-Null } catch {}\n");
        script.push_str("  try { ipconfig /renew | Out-Null } catch {}\n");
        script.push_str("}\n");
    }

    Ok(script)
}

fn build_restore_script(
    machine_guid: Option<&str>,
    adapter_subkey: Option<&str>,
    network_address: Option<&str>,
) -> Result<String, String> {
    let mut script = String::new();
    script.push_str("$ErrorActionPreference = 'Stop'\n");

    if let Some(guid) = machine_guid {
        if !is_valid_machine_guid(guid) {
            return Err(
                "Refusing to run restore script: stored MachineGuid backup is not a valid GUID".into(),
            );
        }
        script.push_str(&format!(
            "Set-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography' -Name 'MachineGuid' -Value '{}'\n",
            guid
        ));
    }

    if let Some(subkey) = adapter_subkey {
        if !is_valid_adapter_subkey(subkey) {
            return Err(
                "Refusing to run restore script: stored adapter subkey is not a 4-digit identifier".into(),
            );
        }
        let class_path = format!(
            "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{}\\{}",
            NETWORK_ADAPTER_CLASS_GUID, subkey
        );
        let prior_mac = network_address
            .map(|m| m.trim())
            .filter(|m| !m.is_empty())
            .filter(|m| is_valid_mac_hex(m));
        if let Some(mac) = prior_mac {
            script.push_str(&format!(
                "Set-ItemProperty -Path '{}' -Name 'NetworkAddress' -Value '{}'\n",
                class_path, mac
            ));
        } else {
            script.push_str(&format!(
                "try {{ Remove-ItemProperty -Path '{}' -Name 'NetworkAddress' -ErrorAction Stop }} catch {{}}\n",
                class_path
            ));
        }
        script.push_str(&format!(
            "$desc = (Get-ItemProperty -Path '{}').DriverDesc\n",
            class_path
        ));
        script.push_str(
            "try { $adapter = Get-NetAdapter | Where-Object { $_.InterfaceDescription -eq $desc } | Select-Object -First 1 } catch { $adapter = $null }\n"
        );
        script.push_str("if ($adapter) {\n");
        script.push_str("  try { Disable-NetAdapter -Name $adapter.Name -Confirm:$false -ErrorAction SilentlyContinue } catch {}\n");
        script.push_str("  Start-Sleep -Milliseconds 600\n");
        script.push_str("  try { Enable-NetAdapter -Name $adapter.Name -Confirm:$false -ErrorAction SilentlyContinue } catch {}\n");
        script.push_str("}\n");
    }

    Ok(script)
}

fn run_elevated_powershell(script: &str) -> Result<(), String> {
    let script_dir = ram_isolation_backup_dir()
        .ok_or("Could not resolve LOCALAPPDATA for isolation scripts")?
        .join("Scripts");
    std::fs::create_dir_all(&script_dir)
        .map_err(|e| format!("Failed to create isolation script dir: {}", e))?;
    let mut seed = [0u8; 16];
    fill_secure_random(&mut seed)?;
    let token: String = seed.iter().map(|b| format!("{:02x}", b)).collect();
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let script_path = script_dir.join(format!("ram_isolation_{}_{}.ps1", stamp, token));
    std::fs::write(&script_path, script)
        .map_err(|e| format!("Failed to write isolation script: {}", e))?;

    let parameters = format!(
        "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"{}\"",
        script_path.display()
    );
    let verb = encode_wide("runas");
    let file = encode_wide("powershell.exe");
    let params = encode_wide(&parameters);

    let mut sei: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    sei.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    sei.fMask = SEE_MASK_NOCLOSEPROCESS;
    sei.lpVerb = verb.as_ptr();
    sei.lpFile = file.as_ptr();
    sei.lpParameters = params.as_ptr();
    sei.nShow = 0;

    let ok = unsafe { ShellExecuteExW(&mut sei) };
    if ok == 0 {
        let _ = std::fs::remove_file(&script_path);
        return Err("UAC prompt was denied or PowerShell could not be launched".into());
    }

    let mut exit_status: Result<(), String> = Ok(());
    if !sei.hProcess.is_null() {
        unsafe {
            let wait_rc = WaitForSingleObject(sei.hProcess, 60_000);
            if wait_rc != WAIT_OBJECT_0 && wait_rc != WAIT_ABANDONED_0 {
                CloseHandle(sei.hProcess);
                let _ = std::fs::remove_file(&script_path);
                return Err(
                    "Elevated PowerShell did not finish within 60s. Accept the UAC prompt sooner or close the running script.".into(),
                );
            }
            let mut exit_code: u32 = 0;
            let got = windows_sys::Win32::System::Threading::GetExitCodeProcess(
                sei.hProcess,
                &mut exit_code,
            );
            CloseHandle(sei.hProcess);
            if got == 0 {
                exit_status = Err("Could not read elevated PowerShell exit code".into());
            } else if exit_code != 0 {
                exit_status = Err(format!(
                    "Elevated PowerShell exited with code {}",
                    exit_code
                ));
            }
        }
    } else {
        exit_status = Err("Elevated PowerShell did not return a process handle".into());
    }

    let _ = std::fs::remove_file(&script_path);
    exit_status
}

fn select_adapter<'a>(
    adapters: &'a [AdapterInfo],
    preference: &str,
) -> Option<&'a AdapterInfo> {
    let pref = preference.trim();
    if !pref.is_empty() {
        if let Some(found) = adapters.iter().find(|a| {
            a.subkey == pref
                || a.description.eq_ignore_ascii_case(pref)
                || a.net_cfg_instance_id
                    .as_deref()
                    .map(|id| id.eq_ignore_ascii_case(pref))
                    .unwrap_or(false)
        }) {
            return Some(found);
        }
    }
    adapters
        .iter()
        .find(|a| {
            let lower = a.description.to_ascii_lowercase();
            !lower.contains("virtual") && !lower.contains("loopback")
        })
        .or_else(|| adapters.first())
}

pub fn dry_run(opts: &IsolationOptions) -> Result<IsolationDryRunReport, String> {
    let mut report = IsolationReport::default();
    let mut paths: Vec<String> = Vec::new();
    let mut registry_keys: Vec<String> = Vec::new();

    match opts.mode {
        IsolationMode::Off => {}
        IsolationMode::Light => {
            wipe_light(&mut report, Some(&mut paths));
        }
        IsolationMode::Medium => {
            wipe_light(&mut report, Some(&mut paths));
            delete_hkcu_roblox(&mut report, Some(&mut registry_keys));
        }
        IsolationMode::Full => {
            wipe_light(&mut report, Some(&mut paths));
            delete_hkcu_roblox(&mut report, Some(&mut registry_keys));
            wipe_full_versions(opts.include_studio, &mut report, Some(&mut paths));
        }
    }

    if opts.spoof_machine_guid {
        registry_keys.push(format!("HKLM\\{}\\{}", MACHINE_GUID_KEY, MACHINE_GUID_VALUE));
    }
    if opts.spoof_mac {
        let adapters = list_network_adapters().unwrap_or_default();
        match select_adapter(&adapters, &opts.target_adapter) {
            Some(adapter) => {
                registry_keys.push(format!(
                    "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{}\\{}\\NetworkAddress ({})",
                    NETWORK_ADAPTER_CLASS_GUID, adapter.subkey, adapter.description
                ));
            }
            None => {
                registry_keys.push(
                    "MAC rotation requested but no eligible network adapter found (skipped)".into(),
                );
            }
        }
    }

    Ok(IsolationDryRunReport {
        paths,
        registry_keys,
    })
}

pub fn apply_pre_launch(
    app: &tauri::AppHandle,
    opts: &IsolationOptions,
) -> Result<IsolationReport, IsolationFailure> {
    let mut report = IsolationReport::default();

    if !opts.does_anything() {
        return Ok(report);
    }

    emit_isolation_progress(app, "starting", "Preparing pre-launch isolation", &report, false);

    let running = find_roblox_pids_all();
    if !running.is_empty() {
        let _ = tracker().cleanup_dead_processes();
        let tracked = tracker().get_tracked_pids();
        let protected = running.iter().filter(|pid| tracked.contains(pid)).count();
        if protected > 0 {
            eprintln!(
                "[isolation] skipping pre-launch cleanup: {} tracked / {} running Roblox process(es)",
                protected,
                running.len()
            );
            report.skipped_reason = Some(format!(
                "{} account(s) launched by this app are still running. Isolation skipped to protect them.",
                protected
            ));
            emit_isolation_progress(
                app,
                "skipped",
                report.skipped_reason.as_deref().unwrap_or("Isolation skipped"),
                &report,
                true,
            );
            return Ok(report);
        }
        eprintln!(
            "[isolation] closing {} untracked Roblox process(es) before launch",
            running.len()
        );
        emit_isolation_progress(
            app,
            "closing-roblox",
            &format!(
                "Closing {} untracked Roblox process(es) (player, launcher, crash handler)",
                running.len()
            ),
            &report,
            false,
        );
        let _ = kill_all_roblox_related();
        std::thread::sleep(std::time::Duration::from_millis(600));
        let still_running = find_roblox_pids_all();
        if !still_running.is_empty() {
            report.skipped_reason = Some(
                "Another Roblox client is still running. Isolation skipped to avoid corrupting its state.".into(),
            );
            emit_isolation_progress(
                app,
                "skipped",
                report.skipped_reason.as_deref().unwrap_or("Isolation skipped"),
                &report,
                true,
            );
            return Ok(report);
        }
    }

    let preserved_fast_flags = if opts.preserve_fast_flags
        && matches!(opts.mode, IsolationMode::Full)
    {
        emit_isolation_progress(
            app,
            "preserving",
            "Backing up fast flags before wipe",
            &report,
            false,
        );
        let backups = backup_fast_flags();
        if backups.is_empty() {
            None
        } else {
            Some(backups)
        }
    } else {
        None
    };

    let preserved_basic_settings = if opts.preserve_basic_settings
        && matches!(opts.mode, IsolationMode::Full)
    {
        backup_basic_settings()
    } else {
        None
    };

    if matches!(
        opts.mode,
        IsolationMode::Light | IsolationMode::Medium | IsolationMode::Full
    ) {
        emit_isolation_progress(
            app,
            "wiping-cache",
            "Wiping HTTP cache, logs, prefetch entries",
            &report,
            false,
        );
        wipe_light(&mut report, None);
    }
    if matches!(opts.mode, IsolationMode::Medium | IsolationMode::Full) {
        emit_isolation_progress(
            app,
            "wiping-registry",
            "Removing HKCU\\Software\\ROBLOX Corporation",
            &report,
            false,
        );
        delete_hkcu_roblox(&mut report, None);
    }
    if matches!(opts.mode, IsolationMode::Full) {
        emit_isolation_progress(
            app,
            "wiping-versions",
            "Removing Roblox install Versions folders",
            &report,
            false,
        );
        wipe_full_versions(opts.include_studio, &mut report, None);
    }

    if let Some(backups) = preserved_fast_flags {
        emit_isolation_progress(
            app,
            "restoring",
            "Restoring preserved fast flag backups",
            &report,
            false,
        );
        restore_fast_flags(&backups);
    }
    if let Some(content) = preserved_basic_settings {
        restore_basic_settings(&content);
    }

    if opts.spoof_machine_guid {
        report.captured_machine_guid = read_machine_guid();
    }

    let adapter_subkey: Option<String> = if opts.spoof_mac {
        let adapters = list_network_adapters().unwrap_or_default();
        let selected = select_adapter(&adapters, &opts.target_adapter);
        if let Some(adapter) = selected {
            report.captured_network_address = adapter.current_mac.clone();
            report.captured_adapter_subkey = Some(adapter.subkey.clone());
            Some(adapter.subkey.clone())
        } else {
            None
        }
    } else {
        None
    };

    if opts.spoof_machine_guid || opts.spoof_mac {
        let new_mac = if opts.spoof_mac {
            Some(new_random_mac().map_err(|e| IsolationFailure {
                message: e,
                partial: report.clone(),
            })?)
        } else {
            None
        };
        let new_guid = if opts.spoof_machine_guid {
            Some(new_random_machine_guid().map_err(|e| IsolationFailure {
                message: e,
                partial: report.clone(),
            })?)
        } else {
            None
        };

        let will_rotate_guid = opts.spoof_machine_guid && new_guid.is_some();
        let will_rotate_mac =
            opts.spoof_mac && adapter_subkey.is_some() && new_mac.is_some();

        if !will_rotate_guid && !will_rotate_mac {
            if opts.spoof_mac && adapter_subkey.is_none() {
                emit_isolation_progress(
                    app,
                    "spoof-skipped",
                    "MAC rotation skipped: no eligible network adapter found",
                    &report,
                    true,
                );
            } else {
                emit_isolation_progress(app, "finished", "Done (no spoof performed)", &report, true);
            }
            return Ok(report);
        }

        let script = build_spoof_script(
            opts,
            new_guid.as_deref(),
            adapter_subkey.as_deref(),
            new_mac.as_deref(),
        )
        .map_err(|e| IsolationFailure {
            message: e,
            partial: report.clone(),
        })?;

        let elevation_msg = match (will_rotate_guid, will_rotate_mac) {
            (true, true) => "Waiting for UAC consent (MachineGuid + MAC rotation)",
            (true, false) => "Waiting for UAC consent (MachineGuid rotation)",
            (false, true) => "Waiting for UAC consent (MAC rotation)",
            (false, false) => "Waiting for UAC consent",
        };
        emit_isolation_progress(app, "requesting-elevation", elevation_msg, &report, false);

        let result = run_elevated_powershell(&script);
        if let Err(err) = result {
            emit_isolation_progress(
                app,
                "spoof-failed",
                &format!("Network identity rotation failed: {}", err),
                &report,
                true,
            );
            return Err(IsolationFailure {
                message: err,
                partial: report,
            });
        }

        if will_rotate_guid {
            report.machine_guid_rotated = true;
        }
        if will_rotate_mac {
            report.mac_rotated = true;
        }
        emit_isolation_progress(
            app,
            "spoof-applied",
            "Network identity rotated",
            &report,
            false,
        );
    }

    let summary = format!(
        "Cleaned {} path(s), freed {} MB",
        report.paths_cleaned,
        report.bytes_freed / 1024 / 1024
    );
    emit_isolation_progress(app, "finished", &summary, &report, true);

    Ok(report)
}

pub fn restore_network_identifiers(
    machine_guid: Option<&str>,
    adapter_subkey: Option<&str>,
    network_address: Option<&str>,
) -> Result<(), String> {
    if machine_guid.is_none() && adapter_subkey.is_none() {
        return Err("No backup values to restore".into());
    }
    let script = build_restore_script(machine_guid, adapter_subkey, network_address)?;
    if script.trim().is_empty() {
        return Err("No backup values to restore".into());
    }
    run_elevated_powershell(&script)?;
    Ok(())
}

pub fn write_machine_guid_unelevated(value: &str) -> bool {
    write_machine_guid_directly(value)
}
