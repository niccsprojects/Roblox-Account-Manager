fn load_client_app_settings(settings_file: &std::path::Path) -> serde_json::Value {
    if settings_file.exists() {
        std::fs::read_to_string(settings_file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    }
}

fn write_client_app_settings(
    settings_file: &std::path::Path,
    settings: &serde_json::Value,
) -> Result<(), String> {
    std::fs::write(
        settings_file,
        serde_json::to_string(settings).unwrap_or_default(),
    )
    .map_err(|e| format!("Failed to write ClientAppSettings.json: {}", e))
}

fn apply_client_app_settings_overrides(
    max_fps: Option<u32>,
    fast_flags: Option<&serde_json::Map<String, serde_json::Value>>,
) -> Result<(), String> {
    let settings_file = get_client_settings_file()?;
    let mut settings = load_client_app_settings(&settings_file);

    if let Some(fps) = max_fps {
        settings["DFIntTaskSchedulerTargetFps"] = serde_json::json!(fps);
    }

    if let Some(flags) = fast_flags {
        if !settings.is_object() {
            settings = serde_json::json!({});
        }
        if let Some(target) = settings.as_object_mut() {
            for (key, value) in flags {
                target.insert(key.clone(), value.clone());
            }
        }
    }

    write_client_app_settings(&settings_file, &settings)
}

pub fn apply_fps_unlock(max_fps: u32) -> Result<(), String> {
    apply_client_app_settings_overrides(Some(max_fps), None)
}

fn get_global_basic_settings_file() -> Option<PathBuf> {
    let local_app_data = std::env::var("LOCALAPPDATA").ok()?;
    Some(
        std::path::Path::new(&local_app_data)
            .join("Roblox")
            .join("GlobalBasicSettings_13.xml"),
    )
}

fn find_user_game_settings_properties_range(xml: &str) -> Option<(usize, usize)> {
    let class_pos = xml.find("class=\"UserGameSettings\"")?;
    let item_start = xml[..class_pos].rfind("<Item")?;
    let properties_open_rel = xml[item_start..].find("<Properties>")?;
    let properties_open = item_start + properties_open_rel;
    let content_start = properties_open + "<Properties>".len();
    let properties_close_rel = xml[content_start..].find("</Properties>")?;
    let content_end = content_start + properties_close_rel;
    Some((content_start, content_end))
}

fn upsert_scalar_property(props: &mut String, tag: &str, name: &str, value: &str) {
    let open = format!("<{} name=\"{}\">", tag, name);
    let close = format!("</{}>", tag);

    if let Some(start) = props.find(&open) {
        let value_start = start + open.len();
        if let Some(end_rel) = props[value_start..].find(&close) {
            let value_end = value_start + end_rel;
            props.replace_range(value_start..value_end, value);
            return;
        }
    }

    if !props.ends_with('\n') {
        props.push('\n');
    }
    props.push_str(&format!(
        "\t\t\t<{} name=\"{}\">{}</{}>\n",
        tag, name, value, tag
    ));
}

fn upsert_vector2_property(props: &mut String, name: &str, x: u32, y: u32) {
    let open = format!("<Vector2 name=\"{}\">", name);
    let close = "</Vector2>";
    let block = format!(
        "<Vector2 name=\"{}\">\n\t\t\t\t<X>{}</X>\n\t\t\t\t<Y>{}</Y>\n\t\t\t</Vector2>",
        name, x, y
    );

    if let Some(start) = props.find(&open) {
        if let Some(end_rel) = props[start..].find(close) {
            let end = start + end_rel + close.len();
            props.replace_range(start..end, &block);
            return;
        }
    }

    if !props.ends_with('\n') {
        props.push('\n');
    }
    props.push_str("\t\t\t");
    props.push_str(&block);
    props.push('\n');
}

fn apply_global_basic_settings_overrides(
    max_fps: Option<u32>,
    master_volume: Option<f32>,
    graphics_level: Option<u32>,
    window_size: Option<(u32, u32)>,
) -> Result<(), String> {
    let Some(path) = get_global_basic_settings_file() else {
        return Ok(());
    };
    if !path.exists() {
        return Ok(());
    }

    let mut xml = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read GlobalBasicSettings_13.xml: {}", e))?;

    let Some((start, end)) = find_user_game_settings_properties_range(&xml) else {
        return Ok(());
    };

    let mut props = xml[start..end].to_string();

    if let Some(fps) = max_fps {
        upsert_scalar_property(&mut props, "int", "FramerateCap", &fps.to_string());
    }

    if let Some(volume) = master_volume {
        let clamped = volume.clamp(0.0, 1.0);
        upsert_scalar_property(
            &mut props,
            "float",
            "MasterVolume",
            &format!("{:.6}", clamped),
        );
    }

    if let Some(level) = graphics_level {
        let clamped = level.clamp(1, 10);
        upsert_scalar_property(
            &mut props,
            "int",
            "GraphicsQualityLevel",
            &clamped.to_string(),
        );
        upsert_scalar_property(
            &mut props,
            "token",
            "SavedQualityLevel",
            &clamped.to_string(),
        );
        upsert_scalar_property(&mut props, "int", "QualityResetLevel", &clamped.to_string());
        upsert_scalar_property(&mut props, "bool", "MaxQualityEnabled", "false");
    }

    if let Some((w, h)) = window_size {
        let width = w.max(320);
        let height = h.max(240);
        upsert_scalar_property(&mut props, "bool", "StartMaximized", "false");
        upsert_scalar_property(&mut props, "bool", "Fullscreen", "false");
        upsert_vector2_property(&mut props, "StartScreenSize", width, height);
    }

    xml.replace_range(start..end, &props);
    std::fs::write(&path, xml)
        .map_err(|e| format!("Failed to write GlobalBasicSettings_13.xml: {}", e))
}

pub fn apply_runtime_client_settings(
    max_fps: Option<u32>,
    master_volume: Option<f32>,
    graphics_level: Option<u32>,
    window_size: Option<(u32, u32)>,
    fast_flags: Option<&serde_json::Map<String, serde_json::Value>>,
) -> Result<(), String> {
    if max_fps.is_some() || fast_flags.is_some() {
        apply_client_app_settings_overrides(max_fps, fast_flags)?;
    }

    if max_fps.is_some()
        || master_volume.is_some()
        || graphics_level.is_some()
        || window_size.is_some()
    {
        apply_global_basic_settings_overrides(max_fps, master_volume, graphics_level, window_size)?;
    }

    Ok(())
}

pub fn copy_custom_client_settings(custom_settings_path: &str) -> Result<(), String> {
    let custom_path = std::path::Path::new(custom_settings_path);
    if !custom_path.exists() {
        return Err("Custom ClientAppSettings.json path does not exist".into());
    }

    let content = std::fs::read_to_string(custom_path)
        .map_err(|e| format!("Failed to read custom settings file: {}", e))?;
    serde_json::from_str::<serde_json::Value>(&content)
        .map_err(|e| format!("Custom settings file is not valid JSON: {}", e))?;

    let settings_file = get_client_settings_file()?;
    std::fs::write(settings_file, content)
        .map_err(|e| format!("Failed to copy custom ClientAppSettings.json: {}", e))
}
