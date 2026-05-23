pub struct SettingsStore {
    ini: Mutex<IniFile>,
    file_path: PathBuf,
}

impl SettingsStore {
    pub fn new(file_path: PathBuf) -> Self {
        let file_existed = file_path.exists();
        let ini = if file_existed {
            IniFile::load(&file_path)
        } else {
            IniFile::new()
        };

        let store = Self {
            ini: Mutex::new(ini),
            file_path,
        };

        store.apply_defaults(file_existed);
        store
    }

    fn apply_defaults(&self, settings_file_existed: bool) {
        let mut ini = self.ini.lock().unwrap();

        let defaults: &[(&str, &str, Option<&str>)] = &[
            ("CheckForUpdates", "true", None),
            ("UpdaterReleaseChannel", "beta", None),
            ("UpdaterFeatureChannel", "standard", None),
            ("AccountJoinDelay", "8", None),
            ("AsyncJoin", "false", None),
            ("DisableAgingAlert", "false", None),
            ("HideUsernames", "false", None),
            (
                "ServerRegionFormat",
                "<city>, <countryCode>",
                Some("Visit http://ip-api.com/json/1.1.1.1 to see available format options"),
            ),
            ("MaxRecentGames", "8", None),
            ("Language", "en", None),
            ("AutoCookieRefresh", "true", None),
            ("AutoCloseLastProcess", "false", None),
            ("AutoCloseRobloxForMultiRbx", "false", None),
            ("ShowPresence", "true", None),
            ("PresenceUpdateRate", "5", None),
            ("WarnOnOnlineJoin", "true", None),
            ("UnlockFPS", "false", None),
            ("MaxFPSValue", "120", None),
            ("CustomClientSettings", "", None),
            ("OverrideClientVolume", "false", None),
            ("ClientVolume", "0.5", None),
            ("OverrideClientGraphics", "false", None),
            ("ClientGraphicsLevel", "10", None),
            ("OverrideClientWindowSize", "false", None),
            ("ClientWindowWidth", "1280", None),
            ("ClientWindowHeight", "720", None),
            ("StartRobloxMinimized", "false", None),
            ("StartOnPCStartup", "false", None),
            ("MinimizeToTray", "false", None),
            ("ThemeWindowsNavbar", "true", None),
            ("RestrictedBackgroundStyle", "warp", None),
            ("BottingEnabled", "false", None),
            ("BottingUseSharedClientProfile", "true", None),
            ("BottingAutoShareLaunchFields", "true", None),
            ("BottingDualPanelDialog", "true", None),
            ("BottingPlayerUnlockFPS", "false", None),
            ("BottingPlayerMaxFPSValue", "120", None),
            ("BottingPlayerCustomClientSettings", "", None),
            ("BottingPlayerOverrideClientVolume", "false", None),
            ("BottingPlayerClientVolume", "0.5", None),
            ("BottingPlayerOverrideClientGraphics", "false", None),
            ("BottingPlayerClientGraphicsLevel", "10", None),
            ("BottingPlayerOverrideClientWindowSize", "false", None),
            ("BottingPlayerClientWindowWidth", "1280", None),
            ("BottingPlayerClientWindowHeight", "720", None),
            ("BottingPlayerStartRobloxMinimized", "false", None),
            ("BottingBotUnlockFPS", "false", None),
            ("BottingBotMaxFPSValue", "120", None),
            ("BottingBotCustomClientSettings", "", None),
            ("BottingBotOverrideClientVolume", "false", None),
            ("BottingBotClientVolume", "0.5", None),
            ("BottingBotOverrideClientGraphics", "false", None),
            ("BottingBotClientGraphicsLevel", "10", None),
            ("BottingBotOverrideClientWindowSize", "false", None),
            ("BottingBotClientWindowWidth", "1280", None),
            ("BottingBotClientWindowHeight", "720", None),
            ("BottingBotStartRobloxMinimized", "false", None),
            ("BottingDefaultIntervalMinutes", "19", None),
            ("BottingLaunchDelaySeconds", "20", None),
            ("BottingRetryMax", "6", None),
            ("BottingRetryBaseSeconds", "8", None),
            ("BottingPlayerGraceMinutes", "15", None),
            ("BottingDraftPlaceId", "", None),
            ("BottingDraftJobId", "", None),
            ("BottingDraftLaunchData", "", None),
            ("BottingDraftPlayerAccountId", "", None),
            ("BottingDraftPlayerAccountIds", "", None),
            ("BottingDraftSelectedUserIds", "", None),
        ];

        let general = ini.section("General");
        for (key, value, comment) in defaults {
            if !general.exists(key) {
                general.set(key, value, *comment);
            }
        }
        if !general.exists("EncryptionMethod") {
            general.set("EncryptionMethod", "default", None);
        }
        if !general.exists("ThemeWindowsNavbarAutoEnabledV1") {
            general.set("ThemeWindowsNavbar", "true", None);
            general.set("ThemeWindowsNavbarAutoEnabledV1", "true", None);
        }
        if !general.exists("EncryptionOnboardingState") {
            general.set(
                "EncryptionOnboardingState",
                if settings_file_existed {
                    "completed"
                } else {
                    "pending"
                },
                None,
            );
        }
        if !general.exists("FirstRunWalkthroughState") {
            general.set(
                "FirstRunWalkthroughState",
                if settings_file_existed {
                    "completed"
                } else {
                    "pending"
                },
                None,
            );
        }

        let developer = ini.section("Developer");
        if !developer.exists("DevMode") {
            developer.set("DevMode", "false", None);
        }
        if !developer.exists("EnableWebServer") {
            developer.set("EnableWebServer", "false", None);
        }
        if !developer.exists("IsTeleport") {
            developer.set("IsTeleport", "false", None);
        }
        if !developer.exists("UseOldJoin") {
            developer.set("UseOldJoin", "false", None);
        }

        let ws_defaults: &[(&str, &str)] = &[
            ("WebServerPort", "7963"),
            ("AllowGetCookie", "false"),
            ("AllowGetAccounts", "false"),
            ("AllowLaunchAccount", "false"),
            ("AllowAccountEditing", "false"),
            ("EveryRequestRequiresPassword", "false"),
            ("AllowExternalConnections", "false"),
        ];

        let webserver = ini.section("WebServer");
        for (key, value) in ws_defaults {
            if !webserver.exists(key) {
                webserver.set(key, value, None);
            }
        }

        let ac_defaults: &[(&str, &str)] = &[
            ("AllowExternalConnections", "false"),
            ("StartOnLaunch", "false"),
            ("RelaunchDelay", "60"),
            ("LauncherDelay", "9"),
            ("NexusPort", "5242"),
            ("AutoMinimizeEnabled", "false"),
            ("AutoCloseEnabled", "false"),
            ("InternetCheck", "false"),
            ("UsePresence", "false"),
            ("AutoMinimizeInterval", "15"),
            ("AutoCloseInterval", "5"),
            ("MaxInstances", "3"),
            ("AutoCloseType", "0"),
        ];

        let account_control = ini.section("AccountControl");
        for (key, value) in ac_defaults {
            if !account_control.exists(key) {
                account_control.set(key, value, None);
            }
        }

        let watcher_defaults: &[(&str, &str)] = &[
            ("Enabled", "false"),
            ("ScanInterval", "6"),
            ("ReadInterval", "250"),
            ("ExitIfNoConnection", "false"),
            ("NoConnectionTimeout", "60"),
            ("ExitOnBeta", "false"),
            ("CloseRbxMemory", "false"),
            ("MemoryLowValue", "200"),
            ("CloseRbxWindowTitle", "false"),
            ("ExpectedWindowTitle", "Roblox"),
            ("SaveWindowPositions", "false"),
        ];

        let watcher = ini.section("Watcher");
        for (key, value) in watcher_defaults {
            if !watcher.exists(key) {
                watcher.set(key, value, None);
            }
        }

        let optimization_defaults: &[(&str, &str)] = &[
            ("NormalEnableProcessPolicy", "false"),
            ("NormalProcessPolicyDelayMs", "1500"),
            ("NormalPriorityClass", "normal"),
            ("NormalBackgroundMode", "false"),
            ("NormalEcoQos", "false"),
            ("NormalIgnoreTimerResolution", "false"),
            ("NormalMemoryPriority", "normal"),
            ("NormalEnableFastFlags", "false"),
            ("NormalFastFlagsJson", ""),
            ("NormalEnableJobCpuLimit", "false"),
            ("NormalJobCpuLimitPercent", "25"),
            ("NormalEnableJobMemoryLimit", "false"),
            ("NormalJobMemoryLimitMb", "2048"),
            ("BottingPlayerEnableProcessPolicy", "false"),
            ("BottingPlayerProcessPolicyDelayMs", "1500"),
            ("BottingPlayerPriorityClass", "normal"),
            ("BottingPlayerBackgroundMode", "false"),
            ("BottingPlayerEcoQos", "false"),
            ("BottingPlayerIgnoreTimerResolution", "false"),
            ("BottingPlayerMemoryPriority", "normal"),
            ("BottingPlayerEnableFastFlags", "false"),
            ("BottingPlayerFastFlagsJson", ""),
            ("BottingPlayerEnableJobCpuLimit", "false"),
            ("BottingPlayerJobCpuLimitPercent", "25"),
            ("BottingPlayerEnableJobMemoryLimit", "false"),
            ("BottingPlayerJobMemoryLimitMb", "2048"),
            ("BottingBotEnableProcessPolicy", "false"),
            ("BottingBotProcessPolicyDelayMs", "1500"),
            ("BottingBotPriorityClass", "below_normal"),
            ("BottingBotBackgroundMode", "true"),
            ("BottingBotEcoQos", "true"),
            ("BottingBotIgnoreTimerResolution", "true"),
            ("BottingBotMemoryPriority", "low"),
            ("BottingBotEnableFastFlags", "false"),
            ("BottingBotFastFlagsJson", ""),
            ("BottingBotEnableJobCpuLimit", "false"),
            ("BottingBotJobCpuLimitPercent", "20"),
            ("BottingBotEnableJobMemoryLimit", "false"),
            ("BottingBotJobMemoryLimitMb", "1536"),
        ];

        let optimization = ini.section("Optimization");
        for (key, value) in optimization_defaults {
            if !optimization.exists(key) {
                optimization.set(key, value, None);
            }
        }

        let linux_defaults: &[(&str, &str)] = &[
            ("PreferredRunner", "sober"),
            ("CustomLaunchCommand", ""),
            ("CustomProcessMatch", "sober,flatpak,roblox,robloxplayerbeta"),
            ("CustomLogDir", ""),
            ("EnableExperimentalMultiRbx", "false"),
            ("WindowControlBackend", "auto"),
        ];

        let linux = ini.section("Linux");
        for (key, value) in linux_defaults {
            if !linux.exists(key) {
                linux.set(key, value, None);
            }
        }

        let generator_defaults: &[(&str, &str)] = &[
            ("Provider", "bloxgen"),
            ("ExtraDelaySeconds", "1"),
            ("TargetGroup", "BloxGen"),
            ("MaxAccounts", "0"),
            ("MaxConsecutiveFailures", "3"),
        ];

        let generator = ini.section("Generator");
        for (key, value) in generator_defaults {
            if !generator.exists(key) {
                generator.set(key, value, None);
            }
        }

        let bloxgen_defaults: &[(&str, &str)] = &[
            ("Endpoint", "https://core.bloxgen.net"),
            ("ApiKey", ""),
            ("AccountType", "alt"),
        ];

        let bloxgen = ini.section("BloxGen");
        for (key, value) in bloxgen_defaults {
            if !bloxgen.exists(key) {
                bloxgen.set(key, value, None);
            }
        }

        let isolation_defaults: &[(&str, &str)] = &[
            ("Mode", "Off"),
            ("SpoofMachineGuid", "false"),
            ("SpoofMacAddress", "false"),
            ("TargetAdapter", ""),
            ("IncludeStudio", "false"),
            ("PreserveFastFlags", "true"),
            ("PreserveBasicSettings", "true"),
            ("BackupMachineGuid", ""),
            ("BackupNetworkAddress", ""),
            ("BackupAdapterId", ""),
        ];

        let isolation = ini.section("Isolation");
        for (key, value) in isolation_defaults {
            if !isolation.exists(key) {
                isolation.set(key, value, None);
            }
        }

        ini.section("Prompts");

        drop(ini);
        let _ = self.save();
    }

    pub fn save(&self) -> Result<(), String> {
        let ini = self.ini.lock().map_err(|e| e.to_string())?;
        ini.save(&self.file_path)
    }

    pub fn get_all(&self) -> Result<HashMap<String, HashMap<String, String>>, String> {
        let ini = self.ini.lock().map_err(|e| e.to_string())?;
        Ok(ini.to_map())
    }

    pub fn get(&self, section: &str, key: &str) -> Result<Option<String>, String> {
        let ini = self.ini.lock().map_err(|e| e.to_string())?;
        Ok(ini
            .get_section(section)
            .and_then(|s| s.get(key))
            .map(|v| v.to_string()))
    }

    pub fn get_bool(&self, section: &str, key: &str) -> bool {
        self.get(section, key)
            .ok()
            .flatten()
            .map(|v| v == "true")
            .unwrap_or(false)
    }

    pub fn get_int(&self, section: &str, key: &str) -> Option<i64> {
        self.get(section, key)
            .ok()
            .flatten()
            .and_then(|v| v.parse().ok())
    }

    pub fn get_float(&self, section: &str, key: &str) -> Option<f64> {
        self.get(section, key)
            .ok()
            .flatten()
            .and_then(|v| v.parse().ok())
    }

    pub fn get_string(&self, section: &str, key: &str) -> String {
        self.get(section, key).ok().flatten().unwrap_or_default()
    }

    pub fn set(&self, section: &str, key: &str, value: &str) -> Result<(), String> {
        let mut ini = self.ini.lock().map_err(|e| e.to_string())?;
        ini.section(section).set(key, value, None);
        drop(ini);
        self.save()
    }
}
