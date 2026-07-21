pub fn get_account_data_path() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default())
        .join("AccountData.json")
}

#[tauri::command]
pub fn get_accounts(state: tauri::State<'_, AccountStore>) -> Result<Vec<Account>, String> {
    state.get_all()
}

#[tauri::command]
pub fn save_accounts(state: tauri::State<'_, AccountStore>) -> Result<(), String> {
    state.save()
}

#[tauri::command]
pub fn add_account(
    state: tauri::State<'_, AccountStore>,
    security_token: String,
    username: String,
    user_id: i64,
    password: Option<String>,
) -> Result<(), String> {
    let mut account = Account::new(security_token, username, user_id);
    if let Some(password) = password {
        account.password = password;
    }
    state.add(account)
}

#[tauri::command]
pub fn remove_account(state: tauri::State<'_, AccountStore>, user_id: i64) -> Result<bool, String> {
    state.remove(user_id)
}

#[tauri::command]
pub fn update_account(
    state: tauri::State<'_, AccountStore>,
    account: Account,
) -> Result<bool, String> {
    state.update(account)
}

#[tauri::command]
pub fn unlock_accounts(
    state: tauri::State<'_, AccountStore>,
    password: String,
) -> Result<(), String> {
    state.load_with_password(&password)
}

#[tauri::command]
pub fn is_pass_lock_enabled(state: tauri::State<'_, AccountStore>) -> Result<bool, String> {
    state.is_user_locked()
}

#[tauri::command]
pub fn needs_password(
    state: tauri::State<'_, AccountStore>,
    settings: tauri::State<'_, SettingsStore>,
) -> Result<bool, String> {
    state.needs_password(&crate::data::vault_recovery_candidates(&settings))
}

#[tauri::command]
pub fn set_encryption_password(
    state: tauri::State<'_, AccountStore>,
    password: Option<String>,
) -> Result<(), String> {
    state.set_password(password.as_deref())
}

#[tauri::command]
pub fn reorder_accounts(
    state: tauri::State<'_, AccountStore>,
    user_ids: Vec<i64>,
) -> Result<(), String> {
    state.reorder(&user_ids)
}

#[tauri::command]
pub fn import_old_account_data(
    state: tauri::State<'_, AccountStore>,
    file_data: Vec<u8>,
    password: Option<String>,
) -> Result<OldAccountImportSummary, String> {
    state.import_old_account_data(&file_data, password.as_deref())
}
