pub struct AccountStore {
    accounts: Mutex<Vec<Account>>,
    password_hash: Mutex<Option<Vec<u8>>>,
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
            file_path,
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

    pub fn needs_password(&self) -> Result<bool, String> {
        let password_hash = self.password_hash.lock().map_err(|e| e.to_string())?;
        if password_hash.is_some() {
            return Ok(false);
        }
        self.is_encrypted()
    }

    pub fn load(&self) -> Result<(), String> {
        if !self.file_path.exists() {
            return Ok(());
        }

        let data =
            fs::read(&self.file_path).map_err(|e| format!("Failed to read account file: {}", e))?;

        if data.is_empty() {
            return Ok(());
        }

        let accounts = self.decode_accounts_for_load(&data)?;

        let mut store = self.accounts.lock().map_err(|e| e.to_string())?;
        *store = accounts;

        Ok(())
    }

    pub fn load_with_password(&self, password: &str) -> Result<(), String> {
        let hash = crypto::hash_password(password.trim());
        if !self.file_path.exists() {
            let mut password_hash = self.password_hash.lock().map_err(|e| e.to_string())?;
            *password_hash = Some(hash);
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
        Ok(())
    }

    pub fn save(&self) -> Result<(), String> {
        let accounts = self.accounts.lock().map_err(|e| e.to_string())?;

        let json = serde_json::to_string_pretty(&*accounts)
            .map_err(|e| format!("Failed to serialize accounts: {}", e))?;

        let password_hash = self.password_hash.lock().map_err(|e| e.to_string())?;

        let data = if let Some(hash) = password_hash.as_ref() {
            crypto::encrypt(&json, hash).map_err(|e| format!("Failed to encrypt: {}", e))?
        } else {
            json.into_bytes()
        };

        fs::write(&self.file_path, data)
            .map_err(|e| format!("Failed to write account file: {}", e))?;

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
        let mut password_hash = self.password_hash.lock().map_err(|e| e.to_string())?;
        *password_hash = password.map(|p| crypto::hash_password(p.trim()));
        drop(password_hash);
        self.save()
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
            let hash = password_hash
                .as_ref()
                .ok_or_else(|| "Password required for encrypted file".to_string())?;
            let decrypted =
                crypto::decrypt(data, hash).map_err(|e| format!("Failed to decrypt: {}", e))?;
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
