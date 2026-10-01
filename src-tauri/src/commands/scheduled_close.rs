#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ScheduledCloseStatus {
    user_ids: Vec<i64>,
    close_at_ms: i64,
}

struct ScheduledClose {
    status: ScheduledCloseStatus,
    abort: tokio::task::AbortHandle,
}

static SCHEDULED_CLOSE: std::sync::LazyLock<std::sync::Mutex<Option<ScheduledClose>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(None));

fn take_scheduled_close_if(
    slot: &mut Option<ScheduledClose>,
    close_at_ms: i64,
) -> Option<ScheduledClose> {
    if slot.as_ref().map(|s| s.status.close_at_ms) == Some(close_at_ms) {
        slot.take()
    } else {
        None
    }
}

fn scheduled_close_slot() -> std::sync::MutexGuard<'static, Option<ScheduledClose>> {
    SCHEDULED_CLOSE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

async fn close_tracked_client(user_id: i64) -> bool {
    #[cfg(target_os = "windows")]
    {
        let tracker = platform::windows::tracker();
        let Some(pid) = tracker.get_pid(user_id) else {
            return false;
        };
        if !platform::windows::get_roblox_pids().contains(&pid) {
            tracker.untrack(user_id);
            return false;
        }
        tracker.kill_for_user_graceful_async(user_id, 4500).await
    }
    #[cfg(target_os = "macos")]
    {
        platform::macos::tracker().kill_for_user(user_id)
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        let _ = user_id;
        false
    }
}

async fn fire_scheduled_close(app: tauri::AppHandle, close_at_ms: i64, delay_ms: u64) {
    tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
    let Some(taken) = take_scheduled_close_if(&mut scheduled_close_slot(), close_at_ms) else {
        return;
    };
    let mut closed = 0u32;
    for user_id in taken.status.user_ids {
        if close_tracked_client(user_id).await {
            closed += 1;
        }
    }
    let _ = app.emit(
        "scheduled-close-fired",
        serde_json::json!({ "closeAtMs": close_at_ms, "count": closed }),
    );
}

#[tauri::command]
async fn schedule_close_accounts(
    app: tauri::AppHandle,
    user_ids: Vec<i64>,
    minutes: u32,
) -> Result<ScheduledCloseStatus, String> {
    if user_ids.is_empty() {
        return Err("No accounts selected".into());
    }
    if minutes == 0 || minutes > 1440 {
        return Err("Minutes must be between 1 and 1440".into());
    }
    let delay_ms = u64::from(minutes) * 60_000;
    let status = ScheduledCloseStatus {
        user_ids,
        close_at_ms: now_ms() + delay_ms as i64,
    };
    let mut slot = scheduled_close_slot();
    let abort = tokio::spawn(fire_scheduled_close(app, status.close_at_ms, delay_ms)).abort_handle();
    if let Some(previous) = slot.replace(ScheduledClose {
        status: status.clone(),
        abort,
    }) {
        previous.abort.abort();
    }
    Ok(status)
}

#[tauri::command]
fn cancel_scheduled_close() -> Result<bool, String> {
    match scheduled_close_slot().take() {
        Some(previous) => {
            previous.abort.abort();
            Ok(true)
        }
        None => Ok(false),
    }
}

#[tauri::command]
fn get_scheduled_close() -> Option<ScheduledCloseStatus> {
    scheduled_close_slot().as_ref().map(|s| s.status.clone())
}

#[cfg(test)]
mod scheduled_close_tests {
    use super::{take_scheduled_close_if, ScheduledClose, ScheduledCloseStatus};

    fn entry(close_at_ms: i64) -> ScheduledClose {
        ScheduledClose {
            status: ScheduledCloseStatus {
                user_ids: vec![1, 2],
                close_at_ms,
            },
            abort: tokio::spawn(std::future::pending::<()>()).abort_handle(),
        }
    }

    #[tokio::test]
    async fn takes_matching_schedule() {
        let mut slot = Some(entry(1000));
        assert!(take_scheduled_close_if(&mut slot, 1000).is_some());
        assert!(slot.is_none());
    }

    #[tokio::test]
    async fn keeps_replacement_schedule() {
        let mut slot = Some(entry(2000));
        assert!(take_scheduled_close_if(&mut slot, 1000).is_none());
        assert_eq!(slot.map(|s| s.status.close_at_ms), Some(2000));
    }
}
