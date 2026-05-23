#![cfg_attr(debug_assertions, allow(dead_code))]

mod api;
mod chromium;
mod data;
#[cfg(feature = "nexus")]
mod nexus;
mod platform;

use api::batch::ImageCache;
use data::accounts::{get_account_data_path, AccountStore};
use data::crypto;
use data::scripts::{get_scripts_path, ScriptStore};
use data::settings::{
    get_settings_path, get_theme_path, get_theme_presets_path, SettingsStore, ThemePresetStore,
    ThemeStore,
};
use std::collections::{HashMap, HashSet};
#[cfg(target_os = "windows")]
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
#[cfg(target_os = "windows")]
use std::sync::{Arc, LazyLock, Mutex};
use tauri::menu::{MenuBuilder, MenuEvent, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_autostart::MacosLauncher;

include!("commands/account_api.rs");
include!("commands/image_cache.rs");
include!("commands/account_helpers.rs");
include!("commands/launch_shared.rs");
include!("commands/botting.rs");
include!("commands/generators.rs");
include!("commands/launch.rs");
include!("commands/diagnostics.rs");
include!("commands/isolation.rs");
include!("commands/watcher.rs");
include!("commands/services.rs");
include!("commands/updater.rs");

#[cfg(target_os = "windows")]
fn cleanup_multi_roblox_on_exit(app: &AppHandle<Wry>) {
    let settings = app.state::<SettingsStore>();
    if !settings.get_bool("General", "EnableMultiRbx") {
        return;
    }

    let pids = platform::windows::get_roblox_pids();
    if pids.len() > 1 {
        let _ = platform::windows::kill_all_roblox();
    }

    let tracker = platform::windows::tracker();
    for process in tracker.get_all() {
        tracker.untrack(process.user_id);
    }

    let _ = platform::windows::disable_multi_roblox();
}

#[cfg(target_os = "macos")]
fn cleanup_multi_roblox_on_exit(app: &AppHandle<Wry>) {
    let settings = app.state::<SettingsStore>();
    if !settings.get_bool("General", "EnableMultiRbx") {
        return;
    }

    let pids = platform::macos::get_roblox_pids();
    if pids.len() > 1 {
        let _ = platform::macos::kill_all_roblox();
    }

    let tracker = platform::macos::tracker();
    for process in tracker.get_all() {
        tracker.untrack(process.user_id);
    }

    let _ = platform::macos::disable_multi_roblox();
}

pub fn run() {
    crypto::init();

    let account_store = AccountStore::new(get_account_data_path());

    match account_store.needs_password() {
        Ok(true) => eprintln!("Encrypted account file detected, password required"),
        Ok(false) => {
            if let Err(e) = account_store.load() {
                eprintln!("Warning: Failed to load accounts: {}", e);
            }
        }
        Err(e) => eprintln!("Warning: Failed to check encryption: {}", e),
    }

    let settings_store = SettingsStore::new(get_settings_path());
    let theme_store = ThemeStore::new(get_theme_path());
    let theme_preset_store = ThemePresetStore::new(get_theme_presets_path());
    let script_store = ScriptStore::new(get_scripts_path());
    let image_cache = ImageCache::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(account_store)
        .manage(settings_store)
        .manage(theme_store)
        .manage(theme_preset_store)
        .manage(script_store)
        .manage(image_cache)
        .manage(UpdaterRuntimeState::default())
        .manage(chromium::ChromiumManager::new())
        .setup(|app| {
            let show = MenuItemBuilder::with_id("show", "Show").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Roblox Account Manager")
                .menu(&menu)
                .on_menu_event(
                    |app: &AppHandle<Wry>, event: MenuEvent| match event.id().as_ref() {
                        "show" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.unminimize();
                                let _ = w.set_focus();
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    },
                )
                .on_tray_icon_event(|tray: &TrayIcon<Wry>, event: TrayIconEvent| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

            #[cfg(any(feature = "nexus", feature = "webserver"))]
            let settings = app.state::<SettingsStore>();
            #[cfg(feature = "nexus")]
            if settings.get_bool("AccountControl", "StartOnLaunch") {
                let handle = app.handle().clone();
                let port = settings
                    .get_int("AccountControl", "NexusPort")
                    .unwrap_or(5242) as u16;
                let allow_external =
                    settings.get_bool("AccountControl", "AllowExternalConnections");
                tauri::async_runtime::spawn(async move {
                    match nexus::websocket::nexus()
                        .start(port, allow_external, handle)
                        .await
                    {
                        Ok(port) => eprintln!("Nexus server started on port {}", port),
                        Err(e) => eprintln!("Failed to start Nexus server: {}", e),
                    }
                });
            }

            #[cfg(feature = "webserver")]
            if settings.get_bool("Developer", "EnableWebServer") {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let accounts: &'static AccountStore = unsafe {
                        &*(handle.state::<AccountStore>().inner() as *const AccountStore)
                    };
                    let settings: &'static SettingsStore = unsafe {
                        &*(handle.state::<SettingsStore>().inner() as *const SettingsStore)
                    };
                    match api::server::start(accounts, settings).await {
                        Ok(port) => eprintln!("Web server started on port {}", port),
                        Err(e) => eprintln!("Failed to start web server: {}", e),
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            data::accounts::get_accounts,
            data::accounts::save_accounts,
            data::accounts::add_account,
            data::accounts::remove_account,
            data::accounts::update_account,
            data::accounts::unlock_accounts,
            data::accounts::is_accounts_encrypted,
            data::accounts::needs_password,
            data::accounts::set_encryption_password,
            data::accounts::reorder_accounts,
            data::accounts::import_old_account_data,
            data::scripts::get_scripts,
            data::scripts::save_script,
            data::scripts::delete_script,
            data::settings::get_all_settings,
            data::settings::get_setting,
            data::settings::update_setting,
            data::settings::get_theme,
            data::settings::update_theme,
            data::settings::get_theme_presets,
            data::settings::save_theme_preset,
            data::settings::delete_theme_preset,
            data::settings::import_theme_preset_file,
            data::settings::export_theme_preset_file,
            data::settings::import_theme_font_asset,
            data::settings::resolve_theme_font_asset,
            check_for_updates_with_channels,
            download_selected_update,
            install_selected_update,
            test_auth,
            validate_cookie,
            get_csrf_token,
            get_auth_ticket,
            check_pin,
            unlock_pin,
            refresh_cookie,
            get_robux,
            get_user_info,
            lookup_user,
            send_friend_request,
            block_user,
            unblock_user,
            get_blocked_users,
            unblock_all_users,
            set_follow_privacy,
            get_private_server_invite_privacy,
            set_private_server_invite_privacy,
            set_avatar,
            get_outfits,
            get_outfit_details,
            get_place_details,
            get_servers,
            join_game_instance,
            join_game,
            search_games,
            get_universe_places,
            parse_private_server_link_code,
            join_group,
            get_presence,
            batch_thumbnails,
            get_avatar_headshots,
            get_asset_thumbnails,
            get_asset_details,
            purchase_product,
            change_password,
            change_email,
            set_display_name,
            quick_login_enter_code,
            quick_login_validate_code,
            batched_get_image,
            batched_get_avatar_headshots,
            batched_get_game_icon,
            get_cached_thumbnail,
            clear_image_cache,
            launch_roblox,
            launch_multiple,
            cancel_launch,
            next_account,
            start_botting_mode,
            stop_botting_mode,
            get_botting_mode_status,
            add_botting_accounts,
            set_botting_player_accounts,
            botting_account_action,
            start_generator,
            stop_generator,
            get_generator_status,
            generator_test_key,
            cmd_kill_roblox,
            focus_roblox_window,
            cmd_kill_all_roblox,
            get_running_instances,
            cmd_enable_multi_roblox,
            cmd_disable_multi_roblox,
            cmd_get_roblox_path,
            cmd_apply_fps_unlock,
            kill_legacy_ram_processes,
            diagnose_mutex_holder,
            isolation_get_status,
            isolation_save,
            isolation_list_adapters,
            isolation_restore_network_identifiers,
            isolation_dry_run,
            start_watcher,
            stop_watcher,
            chromium::commands::open_login_browser,
            chromium::commands::extract_browser_cookie,
            chromium::commands::close_login_browser,
            chromium::commands::open_account_browser,
            chromium::commands::import_userpass,
            chromium::commands::is_browser_ready,
            chromium::commands::ensure_browser,
            start_web_server,
            stop_web_server,
            get_web_server_status,
            start_nexus_server,
            stop_nexus_server,
            get_nexus_status,
            get_nexus_accounts,
            add_nexus_account,
            remove_nexus_accounts,
            update_nexus_account,
            nexus_send_command,
            nexus_send_to_all,
            get_nexus_log,
            clear_nexus_log,
            get_nexus_elements,
            set_nexus_element_value,
            export_nexus_lua,
            open_repo_url,
            sync_windows_navbar_theme,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested { .. } => {
                #[cfg(target_os = "windows")]
                cleanup_multi_roblox_on_exit(app);
                #[cfg(target_os = "macos")]
                cleanup_multi_roblox_on_exit(app);
            }
            tauri::RunEvent::Exit => {
                #[cfg(target_os = "windows")]
                cleanup_multi_roblox_on_exit(app);
                #[cfg(target_os = "macos")]
                cleanup_multi_roblox_on_exit(app);
                app.state::<chromium::ChromiumManager>().close_login_session();
            }
            _ => {}
        });
}
