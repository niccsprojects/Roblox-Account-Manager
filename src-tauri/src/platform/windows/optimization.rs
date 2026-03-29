use crate::data::settings::SettingsStore;
use crate::LaunchClientProfile;
use std::mem::{size_of, zeroed};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
    JOBOBJECT_CPU_RATE_CONTROL_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOBOBJECT_CPU_RATE_CONTROL_INFORMATION_0, JOB_OBJECT_CPU_RATE_CONTROL_ENABLE,
    JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP, JOB_OBJECT_LIMIT_PROCESS_MEMORY,
    JobObjectCpuRateControlInformation, JobObjectExtendedLimitInformation,
};
use windows_sys::Win32::System::Threading::{
    SetPriorityClass, SetProcessInformation, BELOW_NORMAL_PRIORITY_CLASS, IDLE_PRIORITY_CLASS,
    MEMORY_PRIORITY_INFORMATION, NORMAL_PRIORITY_CLASS,
    PROCESS_POWER_THROTTLING_CURRENT_VERSION, PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
    PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION, PROCESS_POWER_THROTTLING_STATE,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_INFORMATION, PROCESS_SET_QUOTA,
    ProcessMemoryPriority, ProcessPowerThrottling,
};

const MEMORY_PRIORITY_VERY_LOW: u32 = 1;
const MEMORY_PRIORITY_LOW: u32 = 3;
const MEMORY_PRIORITY_NORMAL: u32 = 5;

pub(crate) const WINDOWS_FASTFLAG_ALLOWLIST: &[&str] = &[
    "DFFlagTextureQualityOverrideEnabled",
    "DFIntTextureQualityOverride",
    "DFFlagDebugRenderForceTechnologyVoxel",
    "DFFlagDebugRenderForceTechnologyFuture",
    "DFFlagRenderForceLowQualityLightmaps",
    "DFFlagDisableDPIScale",
    "FFlagDebugGraphicsDisableDirect3D11",
    "FFlagDebugGraphicsPreferD3D11FL10",
    "FIntDebugForceMSAASamples",
    "FFlagDebugSkyGray",
    "DFFlagDebugPauseVoxelizer",
    "DFFlagDebugRenderForceMoonAngularSize",
    "DFIntDebugRenderForceMoonTextureSize",
    "DFIntDebugFRMQualityLevelOverride",
    "DFIntRenderShadowIntensity",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowsPriorityClass {
    Normal,
    BelowNormal,
    Idle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowsMemoryPriority {
    Normal,
    Low,
    VeryLow,
}

#[derive(Debug, Clone)]
pub(crate) struct WindowsProcessPolicy {
    pub enabled: bool,
    pub delay_ms: u64,
    pub priority_class: WindowsPriorityClass,
    pub background_mode: bool,
    pub eco_qos: bool,
    pub ignore_timer_resolution: bool,
    pub memory_priority: WindowsMemoryPriority,
}

impl Default for WindowsProcessPolicy {
    fn default() -> Self {
        Self {
            enabled: false,
            delay_ms: 1500,
            priority_class: WindowsPriorityClass::Normal,
            background_mode: false,
            eco_qos: false,
            ignore_timer_resolution: false,
            memory_priority: WindowsMemoryPriority::Normal,
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct WindowsExperimentalPolicy {
    pub enable_fast_flags: bool,
    pub fast_flags_json: String,
    pub enable_job_cpu_limit: bool,
    pub job_cpu_limit_percent: u32,
    pub enable_job_memory_limit: bool,
    pub job_memory_limit_mb: u64,
}

impl Default for WindowsExperimentalPolicy {
    fn default() -> Self {
        Self {
            enable_fast_flags: false,
            fast_flags_json: String::new(),
            enable_job_cpu_limit: false,
            job_cpu_limit_percent: 25,
            enable_job_memory_limit: false,
            job_memory_limit_mb: 2048,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub(crate) struct WindowsOptimizationProfile {
    pub process: WindowsProcessPolicy,
    pub experimental: WindowsExperimentalPolicy,
}

fn optimization_prefix(profile: LaunchClientProfile) -> &'static str {
    match profile {
        LaunchClientProfile::Normal => "Normal",
        LaunchClientProfile::BottingPlayer => "BottingPlayer",
        LaunchClientProfile::BottingBot => "BottingBot",
    }
}

fn optimization_key(profile: LaunchClientProfile, suffix: &str) -> String {
    format!("{}{}", optimization_prefix(profile), suffix)
}

fn optimization_clamped_u64(
    settings: &SettingsStore,
    profile: LaunchClientProfile,
    suffix: &str,
    default: i64,
    min: i64,
    max: i64,
) -> u64 {
    settings
        .get_int("Optimization", &optimization_key(profile, suffix))
        .unwrap_or(default)
        .clamp(min, max) as u64
}

fn optimization_clamped_u32(
    settings: &SettingsStore,
    profile: LaunchClientProfile,
    suffix: &str,
    default: i64,
    min: i64,
    max: i64,
) -> u32 {
    optimization_clamped_u64(settings, profile, suffix, default, min, max) as u32
}

fn optimization_bool(settings: &SettingsStore, profile: LaunchClientProfile, suffix: &str) -> bool {
    settings.get_bool("Optimization", &optimization_key(profile, suffix))
}

fn optimization_string(
    settings: &SettingsStore,
    profile: LaunchClientProfile,
    suffix: &str,
) -> String {
    settings.get_string("Optimization", &optimization_key(profile, suffix))
}

fn parse_priority_class(value: &str) -> WindowsPriorityClass {
    match value.trim().to_ascii_lowercase().as_str() {
        "below_normal" => WindowsPriorityClass::BelowNormal,
        "idle" => WindowsPriorityClass::Idle,
        _ => WindowsPriorityClass::Normal,
    }
}

fn parse_memory_priority(value: &str) -> WindowsMemoryPriority {
    match value.trim().to_ascii_lowercase().as_str() {
        "low" => WindowsMemoryPriority::Low,
        "very_low" => WindowsMemoryPriority::VeryLow,
        _ => WindowsMemoryPriority::Normal,
    }
}

pub(crate) fn load_optimization_profile(
    settings: &SettingsStore,
    profile: LaunchClientProfile,
) -> WindowsOptimizationProfile {
    WindowsOptimizationProfile {
        process: WindowsProcessPolicy {
            enabled: optimization_bool(settings, profile, "EnableProcessPolicy"),
            delay_ms: optimization_clamped_u64(
                settings,
                profile,
                "ProcessPolicyDelayMs",
                1500,
                0,
                15000,
            ),
            priority_class: parse_priority_class(&optimization_string(
                settings,
                profile,
                "PriorityClass",
            )),
            background_mode: optimization_bool(settings, profile, "BackgroundMode"),
            eco_qos: optimization_bool(settings, profile, "EcoQos"),
            ignore_timer_resolution: optimization_bool(
                settings,
                profile,
                "IgnoreTimerResolution",
            ),
            memory_priority: parse_memory_priority(&optimization_string(
                settings,
                profile,
                "MemoryPriority",
            )),
        },
        experimental: WindowsExperimentalPolicy {
            enable_fast_flags: optimization_bool(settings, profile, "EnableFastFlags"),
            fast_flags_json: optimization_string(settings, profile, "FastFlagsJson"),
            enable_job_cpu_limit: optimization_bool(settings, profile, "EnableJobCpuLimit"),
            job_cpu_limit_percent: optimization_clamped_u32(
                settings,
                profile,
                "JobCpuLimitPercent",
                25,
                5,
                100,
            ),
            enable_job_memory_limit: optimization_bool(
                settings,
                profile,
                "EnableJobMemoryLimit",
            ),
            job_memory_limit_mb: optimization_clamped_u64(
                settings,
                profile,
                "JobMemoryLimitMb",
                2048,
                256,
                32768,
            ),
        },
    }
}

pub(crate) fn parse_allowlisted_fast_flags_json(
    payload: &str,
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let trimmed = payload.trim();
    if trimmed.is_empty() {
        return Err("Allowlisted fast flags JSON cannot be empty while enabled".into());
    }

    let value: serde_json::Value = serde_json::from_str(trimmed)
        .map_err(|e| format!("Invalid allowlisted fast flags JSON: {}", e))?;
    let object = value
        .as_object()
        .ok_or_else(|| "Allowlisted fast flags JSON must be a JSON object".to_string())?;

    let invalid_keys: Vec<String> = object
        .keys()
        .filter(|key| !WINDOWS_FASTFLAG_ALLOWLIST.contains(&key.as_str()))
        .cloned()
        .collect();

    if !invalid_keys.is_empty() {
        return Err(format!(
            "Only Roblox allowlisted keys are accepted: {}",
            invalid_keys.join(", ")
        ));
    }

    Ok(object.clone())
}

fn power_throttling_mask(profile: &WindowsProcessPolicy) -> u32 {
    let mut mask = 0u32;
    if profile.eco_qos {
        mask |= PROCESS_POWER_THROTTLING_EXECUTION_SPEED;
    }
    if profile.ignore_timer_resolution {
        mask |= PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION;
    }
    mask
}

fn apply_priority_class(process: HANDLE, profile: &WindowsProcessPolicy) -> Result<(), String> {
    unsafe {
        let class = if profile.background_mode {
            IDLE_PRIORITY_CLASS
        } else {
            match profile.priority_class {
                WindowsPriorityClass::Normal => NORMAL_PRIORITY_CLASS,
                WindowsPriorityClass::BelowNormal => BELOW_NORMAL_PRIORITY_CLASS,
                WindowsPriorityClass::Idle => IDLE_PRIORITY_CLASS,
            }
        };
        if SetPriorityClass(process, class) == 0 {
            return Err("Failed to set process priority class".into());
        }
    }

    Ok(())
}

fn apply_memory_priority(process: HANDLE, profile: &WindowsProcessPolicy) -> Result<(), String> {
    let memory_priority = match profile.memory_priority {
        WindowsMemoryPriority::Normal => MEMORY_PRIORITY_NORMAL,
        WindowsMemoryPriority::Low => MEMORY_PRIORITY_LOW,
        WindowsMemoryPriority::VeryLow => MEMORY_PRIORITY_VERY_LOW,
    };

    let info = MEMORY_PRIORITY_INFORMATION {
        MemoryPriority: memory_priority,
    };

    unsafe {
        if SetProcessInformation(
            process,
            ProcessMemoryPriority,
            &info as *const _ as *const _,
            size_of::<MEMORY_PRIORITY_INFORMATION>() as u32,
        ) == 0
        {
            return Err("Failed to set process memory priority".into());
        }
    }

    Ok(())
}

fn apply_power_throttling(process: HANDLE, profile: &WindowsProcessPolicy) -> Result<(), String> {
    let mask = power_throttling_mask(profile);
    if mask == 0 {
        return Ok(());
    }

    let state = PROCESS_POWER_THROTTLING_STATE {
        Version: PROCESS_POWER_THROTTLING_CURRENT_VERSION,
        ControlMask: mask,
        StateMask: mask,
    };

    unsafe {
        if SetProcessInformation(
            process,
            ProcessPowerThrottling,
            &state as *const _ as *const _,
            size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32,
        ) == 0
        {
            return Err("Failed to set process power throttling".into());
        }
    }

    Ok(())
}

fn build_job_handle(experimental: &WindowsExperimentalPolicy) -> Result<Option<HANDLE>, String> {
    if !experimental.enable_job_cpu_limit && !experimental.enable_job_memory_limit {
        return Ok(None);
    }

    let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if job.is_null() {
        return Err("Failed to create job object".into());
    }

    if experimental.enable_job_cpu_limit {
        let cpu_info = JOBOBJECT_CPU_RATE_CONTROL_INFORMATION {
            ControlFlags: JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP,
            Anonymous: JOBOBJECT_CPU_RATE_CONTROL_INFORMATION_0 {
                CpuRate: experimental.job_cpu_limit_percent.saturating_mul(100),
            },
        };

        unsafe {
            if SetInformationJobObject(
                job,
                JobObjectCpuRateControlInformation,
                &cpu_info as *const _ as *const _,
                size_of::<JOBOBJECT_CPU_RATE_CONTROL_INFORMATION>() as u32,
            ) == 0
            {
                CloseHandle(job);
                return Err("Failed to configure job CPU limit".into());
            }
        }
    }

    if experimental.enable_job_memory_limit {
        let mut limit_info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limit_info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_PROCESS_MEMORY;
        limit_info.ProcessMemoryLimit =
            experimental.job_memory_limit_mb.saturating_mul(1024 * 1024) as usize;

        unsafe {
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limit_info as *const _ as *const _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                CloseHandle(job);
                return Err("Failed to configure job memory limit".into());
            }
        }
    }

    Ok(Some(job))
}

pub(crate) fn apply_optimization_to_pid(
    pid: u32,
    profile: &WindowsOptimizationProfile,
) -> Result<(), String> {
    let needs_process_settings = profile.process.enabled;
    let needs_job = profile.experimental.enable_job_cpu_limit
        || profile.experimental.enable_job_memory_limit;

    if !needs_process_settings && !needs_job {
        tracker().clear_job_handle_for_pid(pid);
        return Ok(());
    }

    unsafe {
        let mut access = PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION;
        if needs_job {
            access |= PROCESS_SET_QUOTA | PROCESS_TERMINATE;
        }

        let process = OpenProcess(access, 0, pid);
        if process.is_null() {
            return Err(format!("Failed to open Roblox process {}", pid));
        }

        let result = (|| -> Result<(), String> {
            if profile.process.enabled {
                apply_priority_class(process, &profile.process)?;
                apply_power_throttling(process, &profile.process)?;
                apply_memory_priority(process, &profile.process)?;
            }

            if let Some(job) = build_job_handle(&profile.experimental)? {
                if AssignProcessToJobObject(job, process) == 0 {
                    CloseHandle(job);
                    return Err("Failed to assign Roblox process to job object".into());
                }
                tracker().set_job_handle(pid, job);
            } else {
                tracker().clear_job_handle_for_pid(pid);
            }

            Ok(())
        })();

        CloseHandle(process);
        result
    }
}
