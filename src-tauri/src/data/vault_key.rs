use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::data::crypto;

pub const MASTER_KEY_LEN: usize = 32;

#[derive(Serialize, Deserialize)]
struct KeyFile {
    v: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    dpapi: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    device: Option<String>,
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{:02x}", byte));
    }
    out
}

fn hex_decode(input: &str) -> Option<Vec<u8>> {
    let input = input.trim();
    if !input.len().is_multiple_of(2) {
        return None;
    }
    (0..input.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(input.get(i..i + 2)?, 16).ok())
        .collect()
}

pub fn key_file_path_for(vault_path: &Path) -> PathBuf {
    vault_path.with_extension("key")
}

pub fn master_password_hash(master: &[u8]) -> Vec<u8> {
    crypto::hash_password(&format!("ram-master-v1|{}", hex_encode(master)))
}

pub fn generate_master_key() -> Vec<u8> {
    sodiumoxide::randombytes::randombytes(MASTER_KEY_LEN)
}

pub fn load_master_key(key_path: &Path, extra_device_hashes: &[Vec<u8>]) -> Option<Vec<u8>> {
    let data = fs::read(key_path).ok()?;
    let file: KeyFile = serde_json::from_slice(&data).ok()?;

    if let Some(blob) = file.dpapi.as_deref().and_then(hex_decode) {
        if let Some(master) = dpapi_unprotect(&blob) {
            if master.len() == MASTER_KEY_LEN {
                return Some(master);
            }
        }
    }

    let blob = file.device.as_deref().and_then(hex_decode)?;
    let mut hashes = crypto::fresh_device_hash_candidates();
    hashes.push(crypto::device_password_hash());
    hashes.extend(crypto::device_password_hash_fallbacks());
    hashes.extend_from_slice(extra_device_hashes);

    for hash in &hashes {
        if let Ok(decrypted) = crypto::decrypt(&blob, hash) {
            let master = std::str::from_utf8(&decrypted)
                .ok()
                .and_then(hex_decode)?;
            if master.len() == MASTER_KEY_LEN {
                return Some(master);
            }
        }
    }

    None
}

pub fn store_master_key(
    key_path: &Path,
    master: &[u8],
    device_hash: &[u8],
) -> Result<(), String> {
    let device_blob = crypto::encrypt(&hex_encode(master), device_hash)
        .map_err(|e| format!("Failed to wrap master key with device hash: {}", e))?;

    let file = KeyFile {
        v: 1,
        dpapi: dpapi_protect(master).map(|blob| hex_encode(&blob)),
        device: Some(hex_encode(&device_blob)),
    };

    let json = serde_json::to_string(&file)
        .map_err(|e| format!("Failed to serialize key file: {}", e))?;
    fs::write(key_path, json).map_err(|e| format!("Failed to write key file: {}", e))?;
    Ok(())
}

pub fn remove_key_file(key_path: &Path) {
    if key_path.exists() {
        let _ = fs::remove_file(key_path);
    }
}

#[cfg(target_os = "windows")]
const DPAPI_ENTROPY: &[u8] = b"ram-vault-master-key-v1";

#[cfg(target_os = "windows")]
fn dpapi_protect(data: &[u8]) -> Option<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    unsafe {
        let in_blob = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let entropy_blob = CRYPT_INTEGER_BLOB {
            cbData: DPAPI_ENTROPY.len() as u32,
            pbData: DPAPI_ENTROPY.as_ptr() as *mut u8,
        };
        let mut out_blob = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };

        let ok = CryptProtectData(
            &in_blob,
            std::ptr::null(),
            &entropy_blob,
            std::ptr::null_mut(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        );
        if ok == 0 || out_blob.pbData.is_null() {
            return None;
        }

        let protected =
            std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec();
        LocalFree(out_blob.pbData as *mut core::ffi::c_void);
        Some(protected)
    }
}

#[cfg(target_os = "windows")]
fn dpapi_unprotect(data: &[u8]) -> Option<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    unsafe {
        let in_blob = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let entropy_blob = CRYPT_INTEGER_BLOB {
            cbData: DPAPI_ENTROPY.len() as u32,
            pbData: DPAPI_ENTROPY.as_ptr() as *mut u8,
        };
        let mut out_blob = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };

        let ok = CryptUnprotectData(
            &in_blob,
            std::ptr::null_mut(),
            &entropy_blob,
            std::ptr::null_mut(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        );
        if ok == 0 || out_blob.pbData.is_null() {
            return None;
        }

        let decrypted =
            std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec();
        LocalFree(out_blob.pbData as *mut core::ffi::c_void);
        Some(decrypted)
    }
}

#[cfg(not(target_os = "windows"))]
fn dpapi_protect(_data: &[u8]) -> Option<Vec<u8>> {
    None
}

#[cfg(not(target_os = "windows"))]
fn dpapi_unprotect(_data: &[u8]) -> Option<Vec<u8>> {
    None
}
