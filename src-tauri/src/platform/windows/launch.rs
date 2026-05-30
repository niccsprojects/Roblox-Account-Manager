pub fn build_launch_url(
    ticket: &str,
    place_id: i64,
    job_id: &str,
    browser_tracker_id: &str,
    launch_data: &str,
    follow_user: bool,
    join_vip: bool,
    access_code: &str,
    link_code: &str,
    is_teleport: bool,
) -> String {
    let launch_time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();

    let ld_param = if launch_data.is_empty() {
        String::new()
    } else {
        format!("&launchData={}", urlencoding::encode(launch_data))
    };

    let place_launcher_url = if join_vip {
        let access_param = if access_code.is_empty() {
            String::new()
        } else {
            format!("&accessCode={}", urlencoding::encode(access_code))
        };
        let link_param = if link_code.is_empty() {
            String::new()
        } else {
            format!("&linkCode={}", urlencoding::encode(link_code))
        };
        format!(
            "https://assetgame.roblox.com/game/PlaceLauncher.ashx?request=RequestPrivateGame&placeId={}{}{}{}",
            place_id, access_param, link_param, ld_param
        )
    } else if follow_user {
        format!(
            "https://assetgame.roblox.com/game/PlaceLauncher.ashx?request=RequestFollowUser&userId={}{}",
            place_id, ld_param
        )
    } else {
        let req = if job_id.is_empty() {
            "RequestGame"
        } else {
            "RequestGameJob"
        };
        let gid = if job_id.is_empty() {
            String::new()
        } else {
            format!("&gameId={}", job_id)
        };
        let tp = if is_teleport { "&isTeleport=true" } else { "" };
        format!(
            "https://assetgame.roblox.com/game/PlaceLauncher.ashx?request={}&browserTrackerId={}&placeId={}{}&isPlayTogetherGame=false{}{}",
            req, browser_tracker_id, place_id, gid, tp, ld_param
        )
    };

    format!(
        "roblox-player:1+launchmode:play+gameinfo:{}+launchtime:{}+placelauncherurl:{}+browsertrackerid:{}+robloxLocale:en_us+gameLocale:en_us+channel:+LaunchExp:InApp",
        ticket,
        launch_time,
        urlencoding::encode(&place_launcher_url),
        browser_tracker_id
    )
}

pub fn launch_url(url: &str) -> Result<(), String> {
    std::process::Command::new("cmd")
        .args(["/C", "start", "", url])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("Failed to launch: {}", e))?;
    Ok(())
}

pub fn launch_old_join(
    ticket: &str,
    place_id: i64,
    job_id: &str,
    launch_data: &str,
    follow_user: bool,
    join_vip: bool,
    access_code: &str,
    link_code: &str,
    is_teleport: bool,
) -> Result<(), String> {
    let version_folder = get_roblox_path()?;
    launch_old_join_from(
        &version_folder,
        ticket,
        place_id,
        job_id,
        launch_data,
        follow_user,
        join_vip,
        access_code,
        link_code,
        is_teleport,
    )
}

pub fn launch_old_join_from(
    base_path: &str,
    ticket: &str,
    place_id: i64,
    job_id: &str,
    launch_data: &str,
    follow_user: bool,
    join_vip: bool,
    access_code: &str,
    link_code: &str,
    is_teleport: bool,
) -> Result<(), String> {
    let version_folder = base_path;
    let exe = std::path::Path::new(version_folder).join("RobloxPlayerBeta.exe");
    if !exe.exists() {
        return Err("RobloxPlayerBeta.exe not found in Roblox version folder".into());
    }

    let ld_param = if launch_data.is_empty() {
        String::new()
    } else {
        format!("&launchData={}", urlencoding::encode(launch_data))
    };

    let join_url = if join_vip {
        let access_param = if access_code.is_empty() {
            String::new()
        } else {
            format!("&accessCode={}", urlencoding::encode(access_code))
        };
        let link_param = if link_code.is_empty() {
            String::new()
        } else {
            format!("&linkCode={}", urlencoding::encode(link_code))
        };
        format!(
            "https://assetgame.roblox.com/game/PlaceLauncher.ashx?request=RequestPrivateGame&placeId={}{}{}{}",
            place_id, access_param, link_param, ld_param
        )
    } else if follow_user {
        format!(
            "https://assetgame.roblox.com/game/PlaceLauncher.ashx?request=RequestFollowUser&userId={}{}",
            place_id, ld_param
        )
    } else {
        let req = if job_id.is_empty() {
            "RequestGame"
        } else {
            "RequestGameJob"
        };
        let gid = if job_id.is_empty() {
            String::new()
        } else {
            format!("&gameId={}", job_id)
        };
        let tp = if is_teleport { "&isTeleport=true" } else { "" };
        format!(
            "https://assetgame.roblox.com/game/PlaceLauncher.ashx?request={}&placeId={}{}&isPlayTogetherGame=false{}{}",
            req, place_id, gid, tp, ld_param
        )
    };

    std::process::Command::new(exe)
        .arg("--app")
        .arg("-t")
        .arg(ticket)
        .arg("-j")
        .arg(join_url)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("Failed to launch old join: {}", e))?;

    Ok(())
}
