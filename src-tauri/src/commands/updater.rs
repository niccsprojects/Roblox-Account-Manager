const UPDATER_MANIFEST_BASE: &str =
    "https://raw.githubusercontent.com/niccsprojects/Roblox-Account-Manager/update-manifests";

type PendingUpdate = (tauri_plugin_updater::Update, String, String);

#[derive(Default)]
struct UpdaterRuntimeState {
    pending_update: std::sync::Mutex<Option<PendingUpdate>>,
    downloaded_bytes: std::sync::Mutex<Option<(String, Vec<u8>)>>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdaterCheckResponse {
    version: String,
    current_version: String,
    date: String,
    body: String,
    release_channel: String,
    feature_channel: String,
}

fn normalize_updater_release_channel(raw: &str) -> &'static str {
    if raw.eq_ignore_ascii_case("stable") {
        "stable"
    } else {
        "beta"
    }
}

fn normalize_updater_feature_channel(raw: &str) -> &'static str {
    if raw.eq_ignore_ascii_case("nexus-ws")
        || raw.eq_ignore_ascii_case("nexus")
        || raw.eq_ignore_ascii_case("full")
    {
        "nexus-ws"
    } else {
        "standard"
    }
}

fn resolve_manifest_channel(release_channel: &str, feature_channel: &str) -> String {
    if feature_channel == "nexus-ws" {
        format!("{}-nexus-ws", release_channel)
    } else {
        release_channel.to_string()
    }
}

fn build_manifest_endpoint(release_channel: &str, feature_channel: &str) -> Result<reqwest::Url, String> {
    let channel = resolve_manifest_channel(release_channel, feature_channel);
    let endpoint = format!("{}/{}/latest.json", UPDATER_MANIFEST_BASE, channel);
    reqwest::Url::parse(&endpoint).map_err(|e| format!("Invalid updater endpoint: {}", e))
}

fn update_payload_key(update: Option<&PendingUpdate>) -> Option<String> {
    update.map(|(item, release_channel, feature_channel)| {
        format!(
            "{}|{}|{}|{}|{}|{}",
            item.version,
            item.target,
            item.download_url,
            item.signature,
            release_channel,
            feature_channel
        )
    })
}

fn parse_semver(raw: &str) -> Option<semver::Version> {
    semver::Version::parse(raw.trim().trim_start_matches('v')).ok()
}

fn select_preferred_update(
    primary: Option<PendingUpdate>,
    fallback: Option<PendingUpdate>,
) -> Option<PendingUpdate> {
    match (primary, fallback) {
        (None, None) => None,
        (Some(primary), None) => Some(primary),
        (None, Some(fallback)) => Some(fallback),
        (Some(primary), Some(fallback)) => {
            let primary_version = parse_semver(&primary.0.version);
            let fallback_version = parse_semver(&fallback.0.version);

            match (primary_version, fallback_version) {
                (Some(left), Some(right)) if right > left => Some(fallback),
                _ => Some(primary),
            }
        }
    }
}

async fn check_update_for_channel(
    app: &tauri::AppHandle,
    release_channel: &str,
    feature_channel: &str,
) -> Result<Option<PendingUpdate>, String> {
    use tauri_plugin_updater::UpdaterExt;

    let endpoint = build_manifest_endpoint(release_channel, feature_channel)?;
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|e| format!("Failed to configure updater endpoint: {}", e))?
        .build()
        .map_err(|e| format!("Failed to initialize updater: {}", e))?;

    let update = updater
        .check()
        .await
        .map_err(|e| format!("Failed to check for updates: {}", e))?;

    Ok(update.map(|item| {
        (
            item,
            release_channel.to_string(),
            feature_channel.to_string(),
        )
    }))
}

#[tauri::command]
async fn check_for_updates_with_channels(
    app: tauri::AppHandle,
    updater_state: tauri::State<'_, UpdaterRuntimeState>,
    release_channel: Option<String>,
    feature_channel: Option<String>,
) -> Result<Option<UpdaterCheckResponse>, String> {
    let normalized_release = normalize_updater_release_channel(
        release_channel.as_deref().unwrap_or("beta"),
    );
    let normalized_feature = normalize_updater_feature_channel(
        feature_channel.as_deref().unwrap_or("standard"),
    );

    let primary_update = check_update_for_channel(&app, normalized_release, normalized_feature).await?;
    let fallback_update = if normalized_release == "beta" {
        check_update_for_channel(&app, "stable", normalized_feature).await?
    } else {
        None
    };
    let update = select_preferred_update(primary_update, fallback_update);

    let previous_payload_key = {
        let pending = updater_state
            .pending_update
            .lock()
            .map_err(|e| e.to_string())?;
        update_payload_key(pending.as_ref())
    };

    let next_payload_key = update_payload_key(update.as_ref());

    if previous_payload_key != next_payload_key {
        let mut downloaded = updater_state
            .downloaded_bytes
            .lock()
            .map_err(|e| e.to_string())?;
        *downloaded = None;
    }

    {
        let mut pending = updater_state
            .pending_update
            .lock()
            .map_err(|e| e.to_string())?;
        *pending = update.clone();
    }

    Ok(update.map(|(item, resolved_release_channel, resolved_feature_channel)| UpdaterCheckResponse {
        version: item.version,
        current_version: item.current_version,
        date: item.date.map(|d| d.to_string()).unwrap_or_default(),
        body: item.body.unwrap_or_default(),
        release_channel: resolved_release_channel,
        feature_channel: resolved_feature_channel,
    }))
}

#[tauri::command]
async fn download_selected_update(
    updater_state: tauri::State<'_, UpdaterRuntimeState>,
) -> Result<(), String> {
    let pending_update = {
        let pending = updater_state
            .pending_update
            .lock()
            .map_err(|e| e.to_string())?;
        pending
            .clone()
            .ok_or_else(|| "No pending update selected".to_string())?
    };
    let (update, _, _) = pending_update.clone();

    let payload_key =
        update_payload_key(Some(&pending_update)).ok_or_else(|| "No pending update selected".to_string())?;

    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|e| format!("Failed to download update: {}", e))?;

    let mut downloaded = updater_state
        .downloaded_bytes
        .lock()
        .map_err(|e| e.to_string())?;
    *downloaded = Some((payload_key, bytes));

    Ok(())
}

#[tauri::command]
fn install_selected_update(updater_state: tauri::State<'_, UpdaterRuntimeState>) -> Result<(), String> {
    let pending_update = {
        let pending = updater_state
            .pending_update
            .lock()
            .map_err(|e| e.to_string())?;
        pending
            .clone()
            .ok_or_else(|| "No pending update selected".to_string())?
    };
    let (update, _, _) = pending_update.clone();

    let pending_payload_key =
        update_payload_key(Some(&pending_update)).ok_or_else(|| "No pending update selected".to_string())?;

    let (downloaded_payload_key, bytes) = {
        let downloaded = updater_state
            .downloaded_bytes
            .lock()
            .map_err(|e| e.to_string())?;
        downloaded
            .clone()
            .ok_or_else(|| "No downloaded update found".to_string())?
    };

    if downloaded_payload_key != pending_payload_key {
        return Err(
            "Downloaded update no longer matches selected channel/version. Download again.".into(),
        );
    }

    update
        .install(bytes)
        .map_err(|e| format!("Failed to install update: {}", e))
}
