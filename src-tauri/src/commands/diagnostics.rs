#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MutexDiagnosis {
    holder: &'static str,
    roblox_pids: Vec<u32>,
    legacy_ram_pids: Vec<u32>,
    this_process_holds: bool,
}

#[tauri::command]
fn kill_legacy_ram_processes() -> Result<u32, String> {
    #[cfg(target_os = "windows")]
    {
        let pids = platform::windows::find_legacy_ram_pids();
        let mut killed = 0u32;
        for pid in pids {
            if platform::windows::kill_process(pid).is_ok() {
                killed += 1;
            }
        }
        if killed > 0 {
            std::thread::sleep(std::time::Duration::from_millis(400));
        }
        Ok(killed)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(0)
    }
}

#[tauri::command]
fn diagnose_mutex_holder() -> Result<MutexDiagnosis, String> {
    #[cfg(target_os = "windows")]
    {
        let roblox_pids = platform::windows::get_roblox_pids();
        let legacy_ram_pids = platform::windows::find_legacy_ram_pids();
        let this_process_holds = platform::windows::this_process_holds_multi_roblox();

        let holder = if this_process_holds {
            "thisProcess"
        } else if !roblox_pids.is_empty() {
            "roblox"
        } else if !legacy_ram_pids.is_empty() {
            "legacyRam"
        } else if platform::windows::multi_roblox_mutex_exists() {
            "otherTool"
        } else {
            "free"
        };

        Ok(MutexDiagnosis {
            holder,
            roblox_pids,
            legacy_ram_pids,
            this_process_holds,
        })
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(MutexDiagnosis {
            holder: "free",
            roblox_pids: Vec::new(),
            legacy_ram_pids: Vec::new(),
            this_process_holds: false,
        })
    }
}
