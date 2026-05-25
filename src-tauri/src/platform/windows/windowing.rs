struct EnumWindowData {
    target_pid: u32,
    result_hwnd: HWND,
}

unsafe extern "system" fn enum_window_callback(hwnd: HWND, lparam: isize) -> i32 {
    let data = &mut *(lparam as *mut EnumWindowData);
    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, &mut pid);
    if pid == data.target_pid && IsWindowVisible(hwnd) != 0 {
        data.result_hwnd = hwnd;
        return 0;
    }
    1
}

pub fn find_main_window(target_pid: u32) -> Option<HWND> {
    let mut data = EnumWindowData {
        target_pid,
        result_hwnd: std::ptr::null_mut(),
    };
    unsafe {
        EnumWindows(Some(enum_window_callback), &mut data as *mut _ as isize);
    }
    if !data.result_hwnd.is_null() {
        Some(data.result_hwnd)
    } else {
        None
    }
}

pub fn get_window_position(hwnd: HWND) -> Option<(i32, i32, i32, i32)> {
    unsafe {
        let mut rect: RECT = std::mem::zeroed();
        if GetWindowRect(hwnd, &mut rect) != 0 {
            Some((
                rect.left,
                rect.top,
                rect.right - rect.left,
                rect.bottom - rect.top,
            ))
        } else {
            None
        }
    }
}

pub fn set_window_position(hwnd: HWND, x: i32, y: i32, w: i32, h: i32) -> bool {
    unsafe { MoveWindow(hwnd, x, y, w, h, 1) != 0 }
}

pub fn minimize_window(hwnd: HWND) -> bool {
    unsafe { ShowWindow(hwnd, SW_MINIMIZE) != 0 }
}

pub fn focus_window(hwnd: HWND) -> bool {
    unsafe {
        let _ = ShowWindow(hwnd, SW_RESTORE);

        // Windows blocks SetForegroundWindow from threads that don't own the
        // foreground lock (e.g. after another instance exits and the OS
        // reclaims focus). Without AttachThreadInput the call silently fails:
        // the window appears focused but never receives keyboard input.
        //
        // Fix: borrow input-queue ownership from whichever thread currently
        // holds the foreground, make our call, then immediately detach.
        let fg_hwnd = GetForegroundWindow();
        let fg_thread = GetWindowThreadProcessId(fg_hwnd, std::ptr::null_mut());
        let target_thread = GetWindowThreadProcessId(hwnd, std::ptr::null_mut());

        let attached = fg_thread != 0
            && target_thread != 0
            && fg_thread != target_thread
            && AttachThreadInput(fg_thread, target_thread, 1) != 0;

        SetForegroundWindow(hwnd);
        BringWindowToTop(hwnd);

        if attached {
            AttachThreadInput(fg_thread, target_thread, 0);
        }

        GetForegroundWindow() == hwnd
    }
}

fn wait_for_process_exit(pid: u32, timeout: Duration) -> bool {
    let started = std::time::Instant::now();
    while started.elapsed() < timeout {
        if !get_roblox_pids().contains(&pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    !get_roblox_pids().contains(&pid)
}

fn is_roblox_pid_alive(pid: u32) -> bool {
    get_roblox_pids().contains(&pid)
}

pub fn get_foreground_hwnd() -> HWND {
    unsafe { GetForegroundWindow() }
}

pub fn get_window_title(hwnd: HWND) -> String {
    unsafe {
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return String::new();
        }
        let mut buf = vec![0u16; (len + 1) as usize];
        let read = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        if read > 0 {
            String::from_utf16_lossy(&buf[..read as usize])
        } else {
            String::new()
        }
    }
}

pub fn get_process_memory_mb(pid: u32) -> Option<u64> {
    #[repr(C)]
    struct ProcessMemoryCounters {
        cb: u32,
        page_fault_count: u32,
        peak_working_set_size: usize,
        working_set_size: usize,
        quota_peak_paged_pool_usage: usize,
        quota_paged_pool_usage: usize,
        quota_peak_non_paged_pool_usage: usize,
        quota_non_paged_pool_usage: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
    }

    extern "system" {
        fn K32GetProcessMemoryInfo(
            process: HANDLE,
            ppsmemcounters: *mut ProcessMemoryCounters,
            cb: u32,
        ) -> i32;
    }

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut counters: ProcessMemoryCounters = std::mem::zeroed();
        counters.cb = std::mem::size_of::<ProcessMemoryCounters>() as u32;
        let result = K32GetProcessMemoryInfo(
            handle,
            &mut counters,
            std::mem::size_of::<ProcessMemoryCounters>() as u32,
        );
        CloseHandle(handle);
        if result != 0 {
            Some(counters.working_set_size as u64 / 1024 / 1024)
        } else {
            None
        }
    }
}
