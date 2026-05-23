fn find_pids_for_exes(exe_names: &[&str]) -> Vec<u32> {
    let mut pids = Vec::new();
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot.is_null() || snapshot == INVALID_HANDLE_VALUE {
            return pids;
        }

        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                let name_len = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..name_len]);
                for needle in exe_names {
                    if name.eq_ignore_ascii_case(needle) {
                        pids.push(entry.th32ProcessID);
                        break;
                    }
                }
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
    }
    pids
}

pub fn get_roblox_pids() -> Vec<u32> {
    find_pids_for_exes(&["RobloxPlayerBeta.exe"])
}

pub fn find_roblox_pids_all() -> Vec<u32> {
    find_pids_for_exes(&[
        "RobloxPlayerBeta.exe",
        "RobloxPlayerLauncher.exe",
        "RobloxCrashHandler.exe",
    ])
}

pub fn find_legacy_ram_pids() -> Vec<u32> {
    let current = std::env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_default();
    let candidates = ["Roblox Account Manager.exe", "RBX Alt Manager.exe"];
    let pids = find_pids_for_exes(&candidates);

    if current.eq_ignore_ascii_case("Roblox Account Manager.exe")
        || current.eq_ignore_ascii_case("RBX Alt Manager.exe")
    {
        let self_pid = unsafe { windows_sys::Win32::System::Threading::GetCurrentProcessId() };
        pids.into_iter().filter(|p| *p != self_pid).collect()
    } else {
        pids
    }
}

pub fn kill_process(pid: u32) -> Result<(), String> {
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if handle.is_null() {
            return Err(format!("Failed to open process {}", pid));
        }
        let result = TerminateProcess(handle, 1);
        CloseHandle(handle);
        if result == 0 {
            return Err(format!("Failed to terminate process {}", pid));
        }
    }
    Ok(())
}

pub fn kill_all_roblox() -> u32 {
    let pids = get_roblox_pids();
    let mut killed = 0u32;
    for pid in pids {
        if kill_process(pid).is_ok() {
            killed += 1;
        }
    }
    killed
}

pub fn kill_all_roblox_related() -> u32 {
    let pids = find_roblox_pids_all();
    let mut killed = 0u32;
    for pid in pids {
        if kill_process(pid).is_ok() {
            killed += 1;
        }
    }
    killed
}

pub fn kill_all_roblox_except(keep_pids: &[u32]) -> u32 {
    let pids = get_roblox_pids();
    let mut killed = 0u32;
    for pid in pids {
        if keep_pids.contains(&pid) {
            continue;
        }
        if kill_process(pid).is_ok() {
            killed += 1;
        }
    }
    killed
}
