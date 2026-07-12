pub fn get_primary_work_area() -> (i32, i32, i32, i32) {
    unsafe {
        let mut rect: RECT = std::mem::zeroed();
        if SystemParametersInfoW(
            SPI_GETWORKAREA,
            0,
            &mut rect as *mut RECT as *mut std::ffi::c_void,
            0,
        ) != 0
        {
            return (
                rect.left,
                rect.top,
                rect.right - rect.left,
                rect.bottom - rect.top,
            );
        }
        (
            0,
            0,
            GetSystemMetrics(SM_CXSCREEN),
            GetSystemMetrics(SM_CYSCREEN),
        )
    }
}

pub fn window_is_arrangeable(hwnd: HWND) -> bool {
    !get_window_title(hwnd).to_ascii_lowercase().contains("crash")
}

pub fn collect_arrangeable_windows() -> Vec<HWND> {
    let mut hwnds: Vec<HWND> = Vec::new();
    let mut seen_pids: Vec<u32> = Vec::new();

    let mut tracked = tracker().get_all();
    tracked.sort_by_key(|p| p.user_id);
    for process in tracked {
        if let Some(hwnd) = find_main_window(process.pid) {
            if window_is_arrangeable(hwnd) {
                hwnds.push(hwnd);
            }
            seen_pids.push(process.pid);
        }
    }

    let mut untracked = get_roblox_pids();
    untracked.sort_unstable();
    for pid in untracked {
        if seen_pids.contains(&pid) {
            continue;
        }
        if let Some(hwnd) = find_main_window(pid) {
            if window_is_arrangeable(hwnd) {
                hwnds.push(hwnd);
            }
        }
    }

    hwnds
}

fn window_frame_insets(hwnd: HWND) -> (i32, i32, i32, i32) {
    unsafe {
        let mut outer: RECT = std::mem::zeroed();
        if GetWindowRect(hwnd, &mut outer) == 0 {
            return (0, 0, 0, 0);
        }
        let mut visible: RECT = std::mem::zeroed();
        let hr = DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS as u32,
            &mut visible as *mut RECT as *mut std::ffi::c_void,
            std::mem::size_of::<RECT>() as u32,
        );
        if hr != 0 {
            return (0, 0, 0, 0);
        }
        (
            (visible.left - outer.left).max(0),
            (visible.top - outer.top).max(0),
            (outer.right - visible.right).max(0),
            (outer.bottom - visible.bottom).max(0),
        )
    }
}

pub fn arrange_roblox_windows_grid(padding: i32) -> u32 {
    let windows = collect_arrangeable_windows();
    let count = windows.len() as i32;
    if count == 0 {
        return 0;
    }

    let (area_x, area_y, area_w, area_h) = get_primary_work_area();
    let cols = (count as f64).sqrt().ceil().max(1.0) as i32;
    let rows = (count + cols - 1) / cols;
    let pad = padding.max(0);
    let cell_w = area_w / cols;
    let cell_h = area_h / rows;

    let mut arranged = 0u32;
    for (i, hwnd) in windows.into_iter().enumerate() {
        let col = (i as i32) % cols;
        let row = (i as i32) / cols;
        let x = area_x + col * cell_w + pad;
        let y = area_y + row * cell_h + pad;
        let w = (cell_w - pad * 2).max(200);
        let h = (cell_h - pad * 2).max(150);
        unsafe {
            ShowWindow(hwnd, SW_RESTORE);
        }
        let (il, it, ir, ib) = window_frame_insets(hwnd);
        if set_window_position(hwnd, x - il, y - it, w + il + ir, h + it + ib) {
            arranged += 1;
        }
    }
    arranged
}
