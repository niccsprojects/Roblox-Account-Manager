use std::sync::atomic::AtomicU64;

#[derive(Debug, Clone, Serialize)]
pub struct TrackedProcess {
    pub pid: u32,
    pub user_id: i64,
    pub browser_tracker_id: String,
    #[serde(default)]
    pub version_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PendingLaunch {
    pub id: u64,
    pub user_id: i64,
    pub version_id: Option<String>,
    pub deadline: std::time::Instant,
}

pub struct ProcessTracker {
    instances: Mutex<HashMap<i64, TrackedProcess>>,
    pending_launches: Mutex<Vec<PendingLaunch>>,
    next_pending_id: AtomicU64,
    job_handles: Mutex<HashMap<u32, SendHandle>>,
    watcher_active: AtomicBool,
    watcher_session: AtomicU64,
    watcher_state_lock: Mutex<()>,
    launcher_cancelled: AtomicBool,
    next_account: AtomicBool,
}

impl ProcessTracker {
    pub fn new() -> Self {
        Self {
            instances: Mutex::new(HashMap::new()),
            pending_launches: Mutex::new(Vec::new()),
            next_pending_id: AtomicU64::new(1),
            job_handles: Mutex::new(HashMap::new()),
            watcher_active: AtomicBool::new(false),
            watcher_session: AtomicU64::new(0),
            watcher_state_lock: Mutex::new(()),
            launcher_cancelled: AtomicBool::new(false),
            next_account: AtomicBool::new(false),
        }
    }

    pub fn add_pending_launch(
        &self,
        user_id: i64,
        version_id: Option<String>,
        timeout: Duration,
    ) -> u64 {
        let id = self
            .next_pending_id
            .fetch_add(1, Ordering::Relaxed);
        if let Ok(mut pending) = self.pending_launches.lock() {
            pending.retain(|p| p.deadline > std::time::Instant::now());
            pending.push(PendingLaunch {
                id,
                user_id,
                version_id,
                deadline: std::time::Instant::now() + timeout,
            });
        }
        id
    }

    pub fn clear_pending_launch(&self, id: u64) {
        if let Ok(mut pending) = self.pending_launches.lock() {
            pending.retain(|p| p.id != id);
        }
    }

    fn prune_pending_locked(pending: &mut Vec<PendingLaunch>) {
        let now = std::time::Instant::now();
        pending.retain(|p| p.deadline > now);
    }

    pub fn track(&self, user_id: i64, pid: u32, browser_tracker_id: String) {
        self.track_with_version(user_id, pid, browser_tracker_id, None);
    }

    pub fn track_with_version(
        &self,
        user_id: i64,
        pid: u32,
        browser_tracker_id: String,
        version_id: Option<String>,
    ) {
        if let Ok(mut instances) = self.instances.lock() {
            if let Some(previous) = instances.insert(
                user_id,
                TrackedProcess {
                    pid,
                    user_id,
                    browser_tracker_id,
                    version_id,
                },
            ) {
                self.clear_job_handle_for_pid(previous.pid);
            }
        }
    }

    pub fn running_version_keys(&self) -> std::collections::HashSet<Option<String>> {
        let mut set = std::collections::HashSet::new();
        if let Ok(instances) = self.instances.lock() {
            for tracked in instances.values() {
                set.insert(tracked.version_id.clone());
            }
        }
        if let Ok(mut pending) = self.pending_launches.lock() {
            Self::prune_pending_locked(&mut pending);
            for p in pending.iter() {
                set.insert(p.version_id.clone());
            }
        }
        set
    }

    pub fn untrack(&self, user_id: i64) {
        if let Ok(mut instances) = self.instances.lock() {
            if let Some(previous) = instances.remove(&user_id) {
                self.clear_job_handle_for_pid(previous.pid);
            }
        }
    }

    pub fn get_pid(&self, user_id: i64) -> Option<u32> {
        self.instances
            .lock()
            .ok()
            .and_then(|i| i.get(&user_id).map(|p| p.pid))
    }

    #[allow(dead_code)]
    pub fn get_tracked_pids(&self) -> Vec<u32> {
        self.instances
            .lock()
            .ok()
            .map(|i| i.values().map(|p| p.pid).collect())
            .unwrap_or_default()
    }

    pub fn get_all(&self) -> Vec<TrackedProcess> {
        self.instances
            .lock()
            .ok()
            .map(|i| i.values().cloned().collect())
            .unwrap_or_default()
    }

    pub fn set_job_handle(&self, pid: u32, handle: HANDLE) {
        if handle.is_null() {
            return;
        }
        self.clear_job_handle_for_pid(pid);
        if let Ok(mut jobs) = self.job_handles.lock() {
            jobs.insert(pid, SendHandle(handle));
        } else {
            unsafe {
                CloseHandle(handle);
            }
        }
    }

    pub fn clear_job_handle_for_pid(&self, pid: u32) {
        let handle = self
            .job_handles
            .lock()
            .ok()
            .and_then(|mut jobs| jobs.remove(&pid));
        if let Some(SendHandle(handle)) = handle {
            unsafe {
                CloseHandle(handle);
            }
        }
    }

    pub fn kill_for_user(&self, user_id: i64) -> bool {
        if let Some(pid) = self.get_pid(user_id) {
            if kill_process(pid).is_ok() {
                let exited = wait_for_process_exit(pid, Duration::from_millis(1200));
                if exited {
                    self.untrack(user_id);
                }
                exited
            } else if !is_roblox_pid_alive(pid) {
                self.untrack(user_id);
                true
            } else {
                false
            }
        } else {
            false
        }
    }

    pub fn kill_for_user_graceful(&self, user_id: i64, timeout_ms: u64) -> bool {
        let Some(pid) = self.get_pid(user_id) else {
            return true;
        };

        let exited = if kill_process(pid).is_ok() {
            wait_for_process_exit(pid, Duration::from_millis(timeout_ms.max(250)))
        } else {
            !is_roblox_pid_alive(pid)
        };

        if exited {
            self.untrack(user_id);
        }

        exited
    }

    pub fn is_watcher_active(&self) -> bool {
        self.watcher_active.load(Ordering::SeqCst)
    }

    fn lock_watcher_state(&self) -> std::sync::MutexGuard<'_, ()> {
        match self.watcher_state_lock.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    pub fn set_watcher_active(&self, active: bool) {
        let _guard = self.lock_watcher_state();
        self.watcher_active.store(active, Ordering::SeqCst);
        self.watcher_session.fetch_add(1, Ordering::SeqCst);
    }

    pub fn try_start_watcher(&self) -> Option<u64> {
        let _guard = self.lock_watcher_state();
        if self.watcher_active.load(Ordering::SeqCst) {
            return None;
        }

        self.watcher_active.store(true, Ordering::SeqCst);

        Some(
            self.watcher_session
                .fetch_add(1, Ordering::SeqCst)
                .wrapping_add(1),
        )
    }

    pub fn stop_watcher(&self) {
        let _guard = self.lock_watcher_state();
        self.watcher_active.store(false, Ordering::SeqCst);
        self.watcher_session.fetch_add(1, Ordering::SeqCst);
    }

    pub fn is_watcher_session_active(&self, session: u64) -> bool {
        self.watcher_active.load(Ordering::SeqCst)
            && self.watcher_session.load(Ordering::SeqCst) == session
    }

    pub fn cancel_launch(&self) {
        self.launcher_cancelled.store(true, Ordering::Relaxed);
    }

    pub fn is_launch_cancelled(&self) -> bool {
        self.launcher_cancelled.load(Ordering::Relaxed)
    }

    pub fn reset_launch_cancelled(&self) {
        self.launcher_cancelled.store(false, Ordering::Relaxed);
    }

    pub fn signal_next_account(&self) {
        self.next_account.store(true, Ordering::Relaxed);
    }

    pub fn is_next_account(&self) -> bool {
        self.next_account.load(Ordering::Relaxed)
    }

    pub fn reset_next_account(&self) {
        self.next_account.store(false, Ordering::Relaxed);
    }

    pub fn cleanup_dead_processes(&self) -> Vec<i64> {
        let alive_pids = get_roblox_pids();
        let mut dead_user_ids = Vec::new();
        let mut dead_pids = Vec::new();

        if let Ok(mut instances) = self.instances.lock() {
            instances.retain(|user_id, process| {
                if alive_pids.contains(&process.pid) {
                    true
                } else {
                    dead_user_ids.push(*user_id);
                    dead_pids.push(process.pid);
                    false
                }
            });
        }

        for pid in dead_pids {
            self.clear_job_handle_for_pid(pid);
        }

        dead_user_ids
    }
}
