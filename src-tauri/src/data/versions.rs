use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[cfg(target_os = "windows")]
fn atomic_replace(src: &Path, dst: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH};

    let src_wide: Vec<u16> = src.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let dst_wide: Vec<u16> = dst.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let ok = unsafe {
        MoveFileExW(
            src_wide.as_ptr(),
            dst_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        let err = std::io::Error::last_os_error();
        return Err(format!("MoveFileExW failed: {}", err));
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn atomic_replace(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::rename(src, dst).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionEntry {
    pub channel: String,
    pub version_hash: String,
    pub binary_type: String,
    #[serde(default)]
    pub display_version: Option<String>,
    pub install_path: String,
    #[serde(default)]
    pub install_size_bytes: u64,
    #[serde(default)]
    pub installed_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub last_launched_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub user_label: Option<String>,
}

impl VersionEntry {
    pub fn version_id(&self) -> String {
        format!("{}:{}", self.channel, self.version_hash)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct VersionsCatalogFile {
    #[serde(default)]
    pub installed: Vec<VersionEntry>,
}

pub struct VersionsCatalogStore {
    catalog: Mutex<VersionsCatalogFile>,
    file_path: PathBuf,
}

impl VersionsCatalogStore {
    pub fn new(file_path: PathBuf) -> Self {
        let loaded = if file_path.exists() {
            std::fs::read_to_string(&file_path)
                .ok()
                .and_then(|s| serde_json::from_str::<VersionsCatalogFile>(&s).ok())
                .unwrap_or_default()
        } else {
            VersionsCatalogFile::default()
        };

        Self {
            catalog: Mutex::new(loaded),
            file_path,
        }
    }

    fn save_locked(&self, catalog: &VersionsCatalogFile) -> Result<(), String> {
        let json = serde_json::to_string_pretty(catalog).map_err(|e| e.to_string())?;
        if let Some(parent) = self.file_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let tmp_path = self.file_path.with_extension("json.tmp");
        std::fs::write(&tmp_path, json).map_err(|e| e.to_string())?;
        atomic_replace(&tmp_path, &self.file_path)
    }

    pub fn list(&self) -> Vec<VersionEntry> {
        self.catalog
            .lock()
            .map(|c| c.installed.clone())
            .unwrap_or_default()
    }

    pub fn find(&self, version_id: &str) -> Option<VersionEntry> {
        let mut parts = version_id.splitn(2, ':');
        let channel = parts.next()?;
        let hash = parts.next()?;
        self.catalog
            .lock()
            .ok()
            .and_then(|c| {
                c.installed
                    .iter()
                    .find(|e| e.channel == channel && e.version_hash == hash)
                    .cloned()
            })
    }

    pub fn upsert(&self, entry: VersionEntry) -> Result<(), String> {
        let mut catalog = self.catalog.lock().map_err(|e| e.to_string())?;
        if let Some(existing) = catalog
            .installed
            .iter_mut()
            .find(|e| e.channel == entry.channel && e.version_hash == entry.version_hash)
        {
            *existing = entry;
        } else {
            catalog.installed.push(entry);
        }
        self.save_locked(&catalog)
    }

    pub fn remove(&self, channel: &str, version_hash: &str) -> Result<bool, String> {
        let mut catalog = self.catalog.lock().map_err(|e| e.to_string())?;
        let before = catalog.installed.len();
        catalog
            .installed
            .retain(|e| !(e.channel == channel && e.version_hash == version_hash));
        let removed = catalog.installed.len() != before;
        if removed {
            self.save_locked(&catalog)?;
        }
        Ok(removed)
    }

    pub fn set_label(
        &self,
        channel: &str,
        version_hash: &str,
        label: Option<String>,
    ) -> Result<(), String> {
        let mut catalog = self.catalog.lock().map_err(|e| e.to_string())?;
        if let Some(entry) = catalog
            .installed
            .iter_mut()
            .find(|e| e.channel == channel && e.version_hash == version_hash)
        {
            entry.user_label = label.filter(|l| !l.trim().is_empty());
            self.save_locked(&catalog)
        } else {
            Err("Version not found in catalog".into())
        }
    }

    pub fn touch_launched(&self, channel: &str, version_hash: &str) {
        if let Ok(mut catalog) = self.catalog.lock() {
            if let Some(entry) = catalog
                .installed
                .iter_mut()
                .find(|e| e.channel == channel && e.version_hash == version_hash)
            {
                entry.last_launched_at = Some(Utc::now());
                let _ = self.save_locked(&catalog);
            }
        }
    }
}

fn legacy_versions_catalog_path() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default())
        .join("RAMVersions.json")
}

pub fn get_versions_catalog_path() -> PathBuf {
    let modern = std::env::var_os("LOCALAPPDATA").map(|local| {
        PathBuf::from(local)
            .join("Roblox Account Manager")
            .join("RAMVersions.json")
    });
    let Some(modern) = modern else {
        return legacy_versions_catalog_path();
    };

    if !modern.exists() {
        let legacy = legacy_versions_catalog_path();
        if legacy.exists() {
            if let Some(parent) = modern.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::copy(&legacy, &modern);
        }
    }

    modern
}

pub fn ram_managed_versions_root() -> Option<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")?;
    Some(
        PathBuf::from(local)
            .join("Roblox Account Manager")
            .join("RobloxVersions"),
    )
}
