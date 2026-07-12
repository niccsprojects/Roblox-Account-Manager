#[cfg(target_os = "windows")]
#[tauri::command]
fn arrange_roblox_windows(settings: tauri::State<'_, SettingsStore>) -> Result<u32, String> {
    use platform::windows;
    let padding = settings.get_int("WindowArrange", "Padding").unwrap_or(0) as i32;
    Ok(windows::arrange_roblox_windows_grid(padding))
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn arrange_roblox_windows() -> Result<u32, String> {
    Err("Not supported on this platform".into())
}
