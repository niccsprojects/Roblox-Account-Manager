pub const AFK_KEYS: &[(&str, u16)] = &[
    ("Space", 0x20),
    ("W", 0x57),
    ("A", 0x41),
    ("S", 0x53),
    ("D", 0x44),
    ("E", 0x45),
    ("F", 0x46),
    ("R", 0x52),
    ("Q", 0x51),
    ("1", 0x31),
    ("2", 0x32),
    ("3", 0x33),
    ("4", 0x34),
    ("5", 0x35),
];

pub fn vk_and_scan(key: &str) -> Option<(u16, u16)> {
    let vk = AFK_KEYS
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(key))
        .map(|(_, vk)| *vk)?;
    let scan = unsafe { MapVirtualKeyW(vk as u32, MAPVK_VK_TO_VSC) } as u16;
    Some((vk, scan))
}

pub fn window_exists(hwnd: HWND) -> bool {
    unsafe { IsWindow(hwnd) != 0 }
}

pub fn send_key(vk: u16, scan: u16, up: bool) -> bool {
    let mut input: INPUT = unsafe { std::mem::zeroed() };
    input.r#type = INPUT_KEYBOARD;
    input.Anonymous.ki = KEYBDINPUT {
        wVk: vk,
        wScan: scan,
        dwFlags: if up { KEYEVENTF_KEYUP } else { 0 },
        time: 0,
        dwExtraInfo: 0,
    };
    unsafe { SendInput(1, &input, std::mem::size_of::<INPUT>() as i32) == 1 }
}
