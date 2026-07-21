pub struct AccountStore {
    accounts: Mutex<Vec<Account>>,
    password_hash: Mutex<Option<Vec<u8>>>,
    master_key: Mutex<Option<Vec<u8>>>,
    user_locked: Mutex<bool>,
    loaded: Mutex<bool>,
    file_path: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OldAccountImportSummary {
    pub total: usize,
    pub added: usize,
    pub replaced: usize,
    pub skipped: usize,
}

const IMPORT_PASSWORD_REQUIRED: &str = "IMPORT_PASSWORD_REQUIRED";

impl AccountStore {
    pub fn new(file_path: PathBuf) -> Self {
        Self {
            accounts: Mutex::new(Vec::new()),
            password_hash: Mutex::new(None),
            master_key: Mutex::new(None),
            user_locked: Mutex::new(false),
            loaded: Mutex::new(false),
            file_path,
        }
    }

    fn key_file_path(&self) -> PathBuf {
        vault_key::key_file_path_for(&self.file_path)
    }

    fn set_session_key(&self, hash: Vec<u8>, master: Option<Vec<u8>>) -> Result<(), String> {
        let mut password_hash = self.password_hash.lock().map_err(|e| e.to_string())?;
        *password_hash = Some(hash);
        drop(password_hash);
        let mut master_key = self.master_key.lock().map_err(|e| e.to_string())?;
        *master_key = master;
        Ok(())
    }

    fn backup_vault_file(&self) {
        if !self.file_path.exists() {
            return;
        }
        let backup = self.file_path.with_extension("json.bak");
        if let Err(e) = fs::copy(&self.file_path, &backup) {
            eprintln!("Warning: Failed to back up account file: {}", e);
        }
    }

    pub fn is_encrypted(&self) -> Result<bool, String> {
        if !self.file_path.exists() {
            return Ok(false);
        }

        let data =
            fs::read(&self.file_path).map_err(|e| format!("Failed to read account file: {}", e))?;

        Ok(crypto::is_encrypted(&data))
    }

    pub fn needs_password(&self, recovery_hashes: &[Vec<u8>]) -> Result<bool, String> {
        {
            let password_hash = self.password_hash.lock().map_err(|e| e.to_string())?;
            if password_hash.is_some() {
                return Ok(false);
            }
        }

        if !self.file_path.exists() {
            return Ok(false);
        }

        let data =
            fs::read(&self.file_path).map_err(|e| format!("Failed to read account file: {}", e))?;

        if data.is_empty() || !crypto::is_encrypted(&data) {
            return Ok(false);
        }

        let key_path = self.key_file_path();
        let master = vault_key::load_master_key(&key_path, recovery_hashes);
        let master_hash = master.as_ref().map(|m| vault_key::master_password_hash(m));
        let device_candidates = crypto::fresh_device_hash_candidates();

        let mut decrypted: Option<Vec<u8>> = None;
        let mut used_master = false;
        let mut used_primary_device = false;

        if let Some(hash) = master_hash.as_ref() {
            if let Ok(content) = crypto::decrypt(&data, hash) {
                decrypted = Some(content);
                used_master = true;
            }
        }
        if decrypted.is_none() {
            for (index, hash) in device_candidates
                .iter()
                .chain(recovery_hashes.iter())
                .enumerate()
            {
                if let Ok(content) = crypto::decrypt(&data, hash) {
                    decrypted = Some(content);
                    used_primary_device = index == 0;
                    break;
                }
            }
        }

        let Some(decrypted) = decrypted else {
            return Ok(true);
        };

        let accounts = Self::parse_accounts_json(&decrypted)?;
        let mut store = self.accounts.lock().map_err(|e| e.to_string())?;
        *store = accounts;
        drop(store);
        let mut user_locked = self.user_locked.lock().map_err(|e| e.to_string())?;
        *user_locked = false;
        drop(user_locked);
        let mut loaded = self.loaded.lock().map_err(|e| e.to_string())?;
        *loaded = true;
        drop(loaded);

        if used_master {
            self.set_session_key(
                master_hash.expect("master hash present when used_master"),
                master,
            )?;
            return Ok(false);
        }

        let primary_device_hash = device_candidates
            .first()
            .cloned()
            .unwrap_or_else(crypto::device_password_hash);

        #[cfg(target_os = "windows")]
        let should_save = {
            let master_bytes = master.unwrap_or_else(vault_key::generate_master_key);
            match vault_key::store_master_key(&key_path, &master_bytes, &primary_device_hash) {
                Ok(()) => {
                    let new_hash = vault_key::master_password_hash(&master_bytes);
                    self.set_session_key(new_hash, Some(master_bytes))?;
                    true
                }
                Err(e) => {
                    eprintln!("Warning: Failed to write vault key file: {}", e);
                    self.set_session_key(primary_device_hash, None)?;
                    !used_primary_device
                }
            }
        };
        #[cfg(not(target_os = "windows"))]
        let should_save = {
            self.set_session_key(primary_device_hash, None)?;
            !used_primary_device
        };

        if should_save {
            self.backup_vault_file();
            if let Err(e) = self.save() {
                eprintln!(
                    "Warning: Failed to re-encrypt account file with current key: {}",
                    e
                );
            }
        }

        Ok(false)
    }

    pub fn rekey_after_identifier_change(&self, new_identifier: &str) -> Result<(), String> {
        {
            let user_locked = self.user_locked.lock().map_err(|e| e.to_string())?;
            if *user_locked {
                return Ok(());
            }
        }

        let new_device_hash = crypto::device_hash_for_identifier(new_identifier);
        let key_path = self.key_file_path();

        let master = self.master_key.lock().map_err(|e| e.to_string())?.clone();
        if let Some(master) = master {
            return vault_key::store_master_key(&key_path, &master, &new_device_hash);
        }

        let loaded = *self.loaded.lock().map_err(|e| e.to_string())?;
        if !loaded {
            let existing_len = fs::metadata(&self.file_path).map(|m| m.len()).unwrap_or(0);
            if existing_len > 0 {
                return Err("Account vault is locked; cannot rekey it".to_string());
            }
            return self.set_session_key(new_device_hash, None);
        }

        self.backup_vault_file();
        self.set_session_key(new_device_hash, None)?;
        self.save()
    }

    pub fn load(&self) -> Result<(), String> {
        {
            let loaded = self.loaded.lock().map_err(|e| e.to_string())?;
            if *loaded {
                return Ok(());
            }
        }

        if !self.file_path.exists() {
            let mut loaded = self.loaded.lock().map_err(|e| e.to_string())?;
            *loaded = true;
            return Ok(());
        }

        let data =
            fs::read(&self.file_path).map_err(|e| format!("Failed to read account file: {}", e))?;

        if data.is_empty() {
            let mut loaded = self.loaded.lock().map_err(|e| e.to_string())?;
            *loaded = true;
            return Ok(());
        }

        let was_encrypted = crypto::is_encrypted(&data);
        let accounts = self.decode_accounts_for_load(&data)?;
        let should_migrate = !was_encrypted && !accounts.is_empty();

        let mut store = self.accounts.lock().map_err(|e| e.to_string())?;
        *store = accounts;
        drop(store);

        let mut loaded = self.loaded.lock().map_err(|e| e.to_string())?;
        *loaded = true;
        drop(loaded);

        if should_migrate {
            if let Err(e) = self.save() {
                eprintln!(
                    "Warning: Failed to migrate account file to encrypted storage: {}",
                    e
                );
            }
        }

        Ok(())
    }

    pub fn load_with_password(&self, password: &str) -> Result<(), String> {
        let hash = crypto::hash_password(password.trim());
        if !self.file_path.exists() {
            let mut password_hash = self.password_hash.lock().map_err(|e| e.to_string())?;
            *password_hash = Some(hash);
            drop(password_hash);
            let mut user_locked = self.user_locked.lock().map_err(|e| e.to_string())?;
            *user_locked = true;
            return Ok(());
        }

        let data =
            fs::read(&self.file_path).map_err(|e| format!("Failed to read account file: {}", e))?;

        if data.is_empty() {
            let mut accounts = self.accounts.lock().map_err(|e| e.to_string())?;
            *accounts = Vec::new();
            drop(accounts);
            let mut password_hash = self.password_hash.lock().map_err(|e| e.to_string())?;
            *password_hash = Some(hash);
            drop(password_hash);
            let mut user_locked = self.user_locked.lock().map_err(|e| e.to_string())?;
            *user_locked = true;
            return Ok(());
        }

        let accounts = if crypto::is_encrypted(&data) {
            let decrypted =
                crypto::decrypt(&data, &hash).map_err(|e| format!("Failed to decrypt: {}", e))?;
            Self::parse_accounts_json(&decrypted)?
        } else {
            Self::decode_plain_or_legacy_accounts(&data)?
        };

        let mut store = self.accounts.lock().map_err(|e| e.to_string())?;
        *store = accounts;
        drop(store);

        let mut password_hash = self.password_hash.lock().map_err(|e| e.to_string())?;
        *password_hash = Some(hash);
        drop(password_hash);
        let mut user_locked = self.user_locked.lock().map_err(|e| e.to_string())?;
        *user_locked = true;
        drop(user_locked);
        let mut loaded = self.loaded.lock().map_err(|e| e.to_string())?;
        *loaded = true;
        Ok(())
    }

    pub fn save(&self) -> Result<(), String> {
        {
            let loaded = self.loaded.lock().map_err(|e| e.to_string())?;
            if !*loaded {
                let existing_len = fs::metadata(&self.file_path).map(|m| m.len()).unwrap_or(0);
                if existing_len > 0 {
                    return Err(
                        "Refusing to overwrite existing account data before it was unlocked"
                            .to_string(),
                    );
                }
            }
        }

        let accounts = self.accounts.lock().map_err(|e| e.to_string())?;

        let json = serde_json::to_string_pretty(&*accounts)
            .map_err(|e| format!("Failed to serialize accounts: {}", e))?;

        let password_hash = self.password_hash.lock().map_err(|e| e.to_string())?;
        let hash = password_hash
            .as_ref()
            .cloned()
            .unwrap_or_else(crypto::device_password_hash);
        drop(password_hash);

        let data = crypto::encrypt(&json, &hash).map_err(|e| format!("Failed to encrypt: {}", e))?;

        fs::write(&self.file_path, data)
            .map_err(|e| format!("Failed to write account file: {}", e))?;

        let mut loaded = self.loaded.lock().map_err(|e| e.to_string())?;
        *loaded = true;

        Ok(())
    }

    pub fn set_password(&self, password: Option<&str>) -> Result<(), String> {
        if let Some(value) = password {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return Err("Password cannot be empty".to_string());
            }
            if trimmed.chars().count() < 8 {
                return Err("Password must be at least 8 characters".to_string());
            }
        }
        let key_path = self.key_file_path();

        if let Some(value) = password {
            self.set_session_key(crypto::hash_password(value.trim()), None)?;
            let mut user_locked = self.user_locked.lock().map_err(|e| e.to_string())?;
            *user_locked = true;
            drop(user_locked);
            self.save()?;
            vault_key::remove_key_file(&key_path);
            return Ok(());
        }

        let mut user_locked = self.user_locked.lock().map_err(|e| e.to_string())?;
        *user_locked = false;
        drop(user_locked);

        #[cfg(target_os = "windows")]
        {
            let master_bytes = vault_key::generate_master_key();
            let primary_device_hash = crypto::fresh_device_hash_candidates()
                .first()
                .cloned()
                .unwrap_or_else(crypto::device_password_hash);
            match vault_key::store_master_key(&key_path, &master_bytes, &primary_device_hash) {
                Ok(()) => {
                    let hash = vault_key::master_password_hash(&master_bytes);
                    self.set_session_key(hash, Some(master_bytes))?;
                }
                Err(e) => {
                    eprintln!("Warning: Failed to write vault key file: {}", e);
                    self.set_session_key(primary_device_hash, None)?;
                }
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            let mut password_hash = self.password_hash.lock().map_err(|e| e.to_string())?;
            *password_hash = None;
            drop(password_hash);
            let mut master_key = self.master_key.lock().map_err(|e| e.to_string())?;
            *master_key = None;
            drop(master_key);
        }

        self.save()
    }

    pub fn is_user_locked(&self) -> Result<bool, String> {
        let user_locked = self.user_locked.lock().map_err(|e| e.to_string())?;
        Ok(*user_locked)
    }

    pub fn get_all(&self) -> Result<Vec<Account>, String> {
        let accounts = self.accounts.lock().map_err(|e| e.to_string())?;
        Ok(accounts.clone())
    }

    pub fn add(&self, account: Account) -> Result<(), String> {
        let mut accounts = self.accounts.lock().map_err(|e| e.to_string())?;

        if let Some(existing) = accounts.iter_mut().find(|a| a.user_id == account.user_id) {
            existing.security_token = account.security_token;
            existing.username = account.username;
            existing.valid = account.valid;
            existing.last_use = account.last_use;
            if !account.password.is_empty() {
                existing.password = account.password;
            }
        } else {
            accounts.push(account);
        }

        drop(accounts);
        self.save()
    }

    pub fn remove(&self, user_id: i64) -> Result<bool, String> {
        let mut accounts = self.accounts.lock().map_err(|e| e.to_string())?;
        let initial_len = accounts.len();
        accounts.retain(|a| a.user_id != user_id);
        let removed = accounts.len() < initial_len;

        drop(accounts);
        if removed {
            self.save()?;
        }

        Ok(removed)
    }

    pub fn update(&self, account: Account) -> Result<bool, String> {
        let mut accounts = self.accounts.lock().map_err(|e| e.to_string())?;

        if let Some(existing) = accounts.iter_mut().find(|a| a.user_id == account.user_id) {
            *existing = account;
            drop(accounts);
            self.save()?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub fn reorder(&self, user_ids: &[i64]) -> Result<(), String> {
        let mut accounts = self.accounts.lock().map_err(|e| e.to_string())?;

        if accounts.is_empty() || user_ids.is_empty() {
            return Ok(());
        }

        let mut ordered = Vec::with_capacity(accounts.len());

        for user_id in user_ids {
            if let Some(pos) = accounts.iter().position(|a| a.user_id == *user_id) {
                ordered.push(accounts.remove(pos));
            }
        }

        ordered.append(&mut accounts);
        *accounts = ordered;

        drop(accounts);
        self.save()
    }

    fn decode_plain_or_legacy_accounts(data: &[u8]) -> Result<Vec<Account>, String> {
        if let Ok(accounts) = Self::parse_accounts_json(data) {
            return Ok(accounts);
        }

        if let Some(legacy_decrypted) = crypto::try_decrypt_legacy_dpapi(data) {
            return Self::parse_accounts_json(&legacy_decrypted);
        }

        Err("Invalid account data format (failed plaintext and legacy DPAPI decode)".to_string())
    }

    fn decode_accounts_for_load(&self, data: &[u8]) -> Result<Vec<Account>, String> {
        if data.is_empty() {
            return Ok(Vec::new());
        }

        if crypto::is_encrypted(data) {
            let password_hash = self.password_hash.lock().map_err(|e| e.to_string())?;
            let hash = password_hash.as_ref().cloned();
            drop(password_hash);
            let decrypted = if let Some(hash) = hash {
                crypto::decrypt(data, &hash).map_err(|e| format!("Failed to decrypt: {}", e))?
            } else {
                crypto::decrypt(data, &crypto::device_password_hash())
                    .map_err(|_| "Password required for encrypted file".to_string())?
            };
            return Self::parse_accounts_json(&decrypted);
        }

        Self::decode_plain_or_legacy_accounts(data)
    }

    fn decode_accounts_for_import(
        &self,
        data: &[u8],
        import_password: Option<&str>,
    ) -> Result<Vec<Account>, String> {
        if data.is_empty() {
            return Ok(Vec::new());
        }

        if crypto::is_encrypted(data) {
            let Some(password) = import_password else {
                return Err(IMPORT_PASSWORD_REQUIRED.to_string());
            };
            let hash = crypto::hash_password(password);
            let decrypted = crypto::decrypt(data, &hash)
                .map_err(|_| "Import password is incorrect".to_string())?;
            return Self::parse_accounts_json(&decrypted);
        }

        Self::decode_plain_or_legacy_accounts(data)
    }

    fn parse_accounts_json(data: &[u8]) -> Result<Vec<Account>, String> {
        serde_json::from_slice::<Vec<Account>>(data)
            .map_err(|e| format!("Failed to parse account JSON: {}", e))
    }

    pub fn import_old_account_data(
        &self,
        data: &[u8],
        import_password: Option<&str>,
    ) -> Result<OldAccountImportSummary, String> {
        let imported_accounts = self.decode_accounts_for_import(data, import_password)?;
        let total = imported_accounts.len();
        let mut skipped = 0usize;

        let mut imported_by_user_id: HashMap<i64, Account> = HashMap::new();
        let mut imported_order: Vec<i64> = Vec::new();

        for account in imported_accounts {
            let user_id = account.user_id;
            if user_id <= 0 {
                skipped += 1;
                continue;
            }

            if imported_by_user_id.contains_key(&user_id) {
                skipped += 1;
            } else {
                imported_order.push(user_id);
            }
            imported_by_user_id.insert(user_id, account);
        }

        let mut accounts = self.accounts.lock().map_err(|e| e.to_string())?;
        let mut current_index_by_user_id: HashMap<i64, usize> = accounts
            .iter()
            .enumerate()
            .map(|(idx, account)| (account.user_id, idx))
            .collect();

        let mut added = 0usize;
        let mut replaced = 0usize;

        for user_id in imported_order {
            let Some(account) = imported_by_user_id.remove(&user_id) else {
                continue;
            };
            if let Some(existing_index) = current_index_by_user_id.get(&user_id).copied() {
                accounts[existing_index] = account;
                replaced += 1;
            } else {
                let next_index = accounts.len();
                current_index_by_user_id.insert(user_id, next_index);
                accounts.push(account);
                added += 1;
            }
        }

        let mut seen_user_ids = HashSet::new();
        accounts.retain(|account| seen_user_ids.insert(account.user_id));

        drop(accounts);

        if added > 0 || replaced > 0 {
            self.save()?;
        }

        Ok(OldAccountImportSummary {
            total,
            added,
            replaced,
            skipped,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_test_path(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("ram-{name}-{nanos}.json"))
    }

    fn new_test_store(name: &str) -> AccountStore {
        crypto::init();
        AccountStore::new(unique_test_path(name))
    }

    #[test]
    fn decode_plain_or_legacy_accounts_should_accept_legacy_null_string_fields() {
        let json = br#"
        [
          {
            "Valid": true,
            "SecurityToken": "_|WARNING:-DO-NOT-SHARE",
            "Username": "LegacyUser",
            "LastUse": "2024-03-05T12:34:56",
            "Alias": null,
            "Description": null,
            "Password": null,
            "Group": null,
            "UserID": 12345,
            "Fields": { "Note": null, "Rank": "Admin" },
            "LastAttemptedRefresh": "2024-03-05T12:34:56",
            "BrowserTrackerID": null
          }
        ]
        "#;

        let accounts = AccountStore::decode_plain_or_legacy_accounts(json).unwrap();

        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].alias, "");
        assert_eq!(accounts[0].description, "");
        assert_eq!(accounts[0].password, "");
        assert_eq!(accounts[0].group, "Default");
        assert_eq!(accounts[0].browser_tracker_id, "");
        assert_eq!(accounts[0].fields.get("Note").map(String::as_str), Some(""));
        assert_eq!(
            accounts[0].fields.get("Rank").map(String::as_str),
            Some("Admin")
        );
    }

    #[test]
    fn import_old_account_data_should_accept_current_v4_encrypted_exports() {
        let store = new_test_store("import-current-v4");
        let current = vec![Account::new(
            "_|WARNING:-DO-NOT-SHARE".to_string(),
            "CurrentUser".to_string(),
            67890,
        )];
        let json = serde_json::to_string(&current).unwrap();
        let password = "compatibility-pass";
        let hash = crypto::hash_password(password);
        let encrypted = crypto::encrypt(&json, &hash).unwrap();

        let summary = store
            .import_old_account_data(&encrypted, Some(password))
            .unwrap();
        let imported = store.get_all().unwrap();

        assert_eq!(summary.total, 1);
        assert_eq!(summary.added, 1);
        assert_eq!(summary.replaced, 0);
        assert_eq!(summary.skipped, 0);
        assert_eq!(imported.len(), 1);
        assert_eq!(imported[0].user_id, 67890);
        assert_eq!(imported[0].username, "CurrentUser");

        let _ = fs::remove_file(&store.file_path);
    }

    fn cleanup_store_files(store: &AccountStore) {
        let _ = fs::remove_file(&store.file_path);
        let _ = fs::remove_file(store.file_path.with_extension("json.bak"));
        let _ = fs::remove_file(store.key_file_path());
    }

    fn encrypted_test_vault(hash: &[u8]) -> Vec<u8> {
        let accounts = vec![Account::new(
            "_|WARNING:-DO-NOT-SHARE".to_string(),
            "VaultUser".to_string(),
            13579,
        )];
        let json = serde_json::to_string(&accounts).unwrap();
        crypto::encrypt(&json, hash).unwrap()
    }

    #[test]
    fn needs_password_should_recover_with_extra_candidate_and_back_up() {
        let store = new_test_store("recover-extra-candidate");
        let old_hash = crypto::device_hash_for_identifier("11111111-1111-4111-8111-111111111111");
        fs::write(&store.file_path, encrypted_test_vault(&old_hash)).unwrap();

        let result = store.needs_password(&[old_hash]).unwrap();

        assert!(!result);
        assert_eq!(store.get_all().unwrap().len(), 1);
        assert!(store.file_path.with_extension("json.bak").exists());
        #[cfg(target_os = "windows")]
        assert!(store.key_file_path().exists());

        cleanup_store_files(&store);
    }

    #[test]
    fn needs_password_should_stay_locked_and_keep_file_untouched() {
        let store = new_test_store("stay-locked");
        let unknown_hash = crypto::hash_password("some-unknown-device");
        let original = encrypted_test_vault(&unknown_hash);
        fs::write(&store.file_path, &original).unwrap();

        let result = store.needs_password(&[]).unwrap();

        assert!(result);
        assert_eq!(fs::read(&store.file_path).unwrap(), original);
        assert!(!store.file_path.with_extension("json.bak").exists());

        cleanup_store_files(&store);
    }

    #[test]
    fn save_should_refuse_overwriting_unloaded_vault() {
        let store = new_test_store("save-guard");
        let unknown_hash = crypto::hash_password("another-unknown-device");
        let original = encrypted_test_vault(&unknown_hash);
        fs::write(&store.file_path, &original).unwrap();

        let result = store.save();

        assert!(result.is_err());
        assert_eq!(fs::read(&store.file_path).unwrap(), original);

        cleanup_store_files(&store);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn rekey_after_identifier_change_should_keep_vault_unlockable() {
        let store = new_test_store("rekey-identifier");
        fs::write(
            &store.file_path,
            encrypted_test_vault(&crypto::device_password_hash()),
        )
        .unwrap();

        assert!(!store.needs_password(&[]).unwrap());
        store
            .rekey_after_identifier_change("22222222-2222-4222-8222-222222222222")
            .unwrap();

        let reopened = AccountStore::new(store.file_path.clone());
        assert!(!reopened.needs_password(&[]).unwrap());
        assert_eq!(reopened.get_all().unwrap().len(), 1);

        cleanup_store_files(&store);
    }

    #[test]
    fn rekey_after_identifier_change_should_fail_on_locked_vault() {
        let store = new_test_store("rekey-locked");
        let unknown_hash = crypto::hash_password("locked-device");
        let original = encrypted_test_vault(&unknown_hash);
        fs::write(&store.file_path, &original).unwrap();

        let result = store.rekey_after_identifier_change("33333333-3333-4333-8333-333333333333");

        assert!(result.is_err());
        assert_eq!(fs::read(&store.file_path).unwrap(), original);

        cleanup_store_files(&store);
    }

    #[test]
    fn set_password_should_remove_key_file_and_require_password() {
        let store = new_test_store("set-password");
        store
            .add(Account::new(
                "_|WARNING:-DO-NOT-SHARE".to_string(),
                "PassUser".to_string(),
                24680,
            ))
            .unwrap();
        store.set_password(Some("super-secret-pass")).unwrap();

        assert!(!store.key_file_path().exists());

        let reopened = AccountStore::new(store.file_path.clone());
        assert!(reopened.needs_password(&[]).unwrap());
        reopened.load_with_password("super-secret-pass").unwrap();
        assert_eq!(reopened.get_all().unwrap().len(), 1);

        cleanup_store_files(&store);
    }

    #[test]
    fn import_old_account_data_should_accept_current_v4_plain_exports() {
        let store = new_test_store("import-current-v4-plain");
        let current = vec![Account::new(
            "_|WARNING:-DO-NOT-SHARE".to_string(),
            "PlainUser".to_string(),
            24680,
        )];
        let json = serde_json::to_vec(&current).unwrap();

        let summary = store.import_old_account_data(&json, None).unwrap();
        let imported = store.get_all().unwrap();

        assert_eq!(summary.total, 1);
        assert_eq!(summary.added, 1);
        assert_eq!(summary.replaced, 0);
        assert_eq!(summary.skipped, 0);
        assert_eq!(imported.len(), 1);
        assert_eq!(imported[0].user_id, 24680);
        assert_eq!(imported[0].username, "PlainUser");

        let _ = fs::remove_file(&store.file_path);
    }
}
