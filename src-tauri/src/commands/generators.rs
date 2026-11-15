const DEFAULT_BLOXGEN_ENDPOINT: &str = "https://core.bloxgen.net";
const GENERATOR_TRANSIENT_BACKOFF_MS: i64 = 15_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GeneratorProvider {
    BloxGen,
}

impl GeneratorProvider {
    fn from_id(id: &str) -> Result<Self, String> {
        match id.trim().to_ascii_lowercase().as_str() {
            "bloxgen" => Ok(GeneratorProvider::BloxGen),
            other => Err(format!("Unknown generator provider: {}", other)),
        }
    }

    fn id(&self) -> &'static str {
        match self {
            GeneratorProvider::BloxGen => "bloxgen",
        }
    }

    fn default_endpoint(&self) -> &'static str {
        match self {
            GeneratorProvider::BloxGen => DEFAULT_BLOXGEN_ENDPOINT,
        }
    }

    fn default_account_type(&self) -> &'static str {
        match self {
            GeneratorProvider::BloxGen => "alt",
        }
    }
}

#[derive(Debug, Clone)]
struct GeneratorConfig {
    provider: GeneratorProvider,
    endpoint: String,
    api_keys: Vec<String>,
    account_type: String,
    extra_delay_ms: i64,
    target_group: String,
    max_accounts: i64,
    max_consecutive_failures: i64,
}

#[derive(Debug, Clone)]
struct GeneratorRuntime {
    active: bool,
    phase: String,
    total_generated: i64,
    next_attempt_at_ms: Option<i64>,
    last_username: Option<String>,
    last_user_id: Option<i64>,
    last_error: Option<String>,
    last_generated_at_ms: Option<i64>,
    key_count: usize,
    keys_cooling: usize,
    keys_rejected: usize,
    active_key_index: Option<usize>,
    active_key_hint: Option<String>,
}

#[derive(Clone)]
struct GeneratorSession {
    id: u64,
    stop_flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
    stopped_notify: std::sync::Arc<tokio::sync::Notify>,
    started_at_ms: i64,
    config: std::sync::Arc<std::sync::Mutex<GeneratorConfig>>,
    runtime: std::sync::Arc<std::sync::Mutex<GeneratorRuntime>>,
}

struct GeneratorManager {
    session: std::sync::Mutex<Option<GeneratorSession>>,
    next_id: std::sync::atomic::AtomicU64,
}

impl GeneratorManager {
    fn new() -> Self {
        Self {
            session: std::sync::Mutex::new(None),
            next_id: std::sync::atomic::AtomicU64::new(1),
        }
    }

    fn next_session_id(&self) -> u64 {
        self.next_id
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    }

    fn get_session(&self) -> Option<GeneratorSession> {
        self.session.lock().ok().and_then(|s| s.as_ref().cloned())
    }

    fn replace_session(&self, session: Option<GeneratorSession>) {
        if let Ok(mut guard) = self.session.lock() {
            *guard = session;
        }
    }
}

static GENERATOR_MANAGER: std::sync::LazyLock<GeneratorManager> =
    std::sync::LazyLock::new(GeneratorManager::new);

#[derive(Debug, Clone, serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct GeneratorStatusPayload {
    active: bool,
    started_at_ms: Option<i64>,
    provider: String,
    endpoint: String,
    account_type: String,
    extra_delay_seconds: i64,
    target_group: String,
    max_accounts: i64,
    phase: String,
    next_attempt_at_ms: Option<i64>,
    total_generated: i64,
    last_username: Option<String>,
    last_user_id: Option<i64>,
    last_error: Option<String>,
    last_generated_at_ms: Option<i64>,
    key_count: usize,
    keys_cooling: usize,
    keys_rejected: usize,
    active_key_index: Option<usize>,
    active_key_hint: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GeneratorKeyTestResult {
    index: usize,
    hint: String,
    balance: Option<f64>,
    error: Option<String>,
}

struct GeneratedAccount {
    cookie: String,
    password: String,
    username: String,
    user_id: Option<i64>,
}

enum GenerateOutcome {
    Account(Box<GeneratedAccount>),
    Cooldown(i64),
    Fatal(String),
    Transient(String),
}

fn parse_api_keys(raw: &str) -> Vec<String> {
    let mut keys: Vec<String> = Vec::new();
    for key in raw
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|k| !k.is_empty())
    {
        if !keys.iter().any(|k| k == key) {
            keys.push(key.to_string());
        }
    }
    keys
}

fn mask_api_key(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    if chars.len() < 8 {
        return "…".to_string();
    }
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("…{}", tail)
}

fn redact_api_key(message: &str, key: &str) -> String {
    if key.is_empty() {
        return message.to_string();
    }
    message.replace(key, &mask_api_key(key))
}

#[derive(Debug, PartialEq, Eq)]
enum KeyChoice {
    Use(usize),
    WaitUntil(i64),
    Exhausted,
}

struct KeyRotation {
    keys: Vec<String>,
    cooldown_until: Vec<i64>,
    rejected: Vec<bool>,
    current: usize,
}

impl KeyRotation {
    fn new(keys: Vec<String>) -> Self {
        let count = keys.len();
        Self {
            keys,
            cooldown_until: vec![0; count],
            rejected: vec![false; count],
            current: 0,
        }
    }

    fn next(&mut self, now: i64) -> KeyChoice {
        let count = self.keys.len();
        let mut earliest: Option<i64> = None;
        for offset in 0..count {
            let index = (self.current + offset) % count;
            if self.rejected[index] {
                continue;
            }
            let until = self.cooldown_until[index];
            if until <= now {
                self.current = index;
                return KeyChoice::Use(index);
            }
            earliest = Some(earliest.map_or(until, |e| e.min(until)));
        }
        earliest.map_or(KeyChoice::Exhausted, KeyChoice::WaitUntil)
    }

    fn cool_down(&mut self, index: usize, until: i64) {
        self.cooldown_until[index] = until;
    }

    fn reject(&mut self, index: usize) {
        self.rejected[index] = true;
    }

    fn cooling_count(&self, now: i64) -> usize {
        (0..self.keys.len())
            .filter(|&i| !self.rejected[i] && self.cooldown_until[i] > now)
            .count()
    }

    fn rejected_count(&self) -> usize {
        self.rejected.iter().filter(|&&r| r).count()
    }
}

fn sync_key_rotation(
    runtime: &std::sync::Mutex<GeneratorRuntime>,
    rotation: &KeyRotation,
    active: Option<usize>,
) {
    let now = now_ms();
    set_generator_runtime(runtime, |r| {
        r.key_count = rotation.keys.len();
        r.keys_cooling = rotation.cooling_count(now);
        r.keys_rejected = rotation.rejected_count();
        r.active_key_index = active;
        r.active_key_hint = active.map(|i| mask_api_key(&rotation.keys[i]));
    });
}

fn generator_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

fn response_snippet(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return "Empty response".to_string();
    }
    trimmed.chars().take(200).collect()
}

fn set_generator_runtime<F>(runtime: &std::sync::Mutex<GeneratorRuntime>, update: F)
where
    F: FnOnce(&mut GeneratorRuntime),
{
    if let Ok(mut guard) = runtime.lock() {
        update(&mut guard);
    }
}

async fn sleep_interruptible(stop_flag: &std::sync::atomic::AtomicBool, total_ms: i64) {
    let mut remaining = total_ms.max(0);
    while remaining > 0 {
        if stop_flag.load(std::sync::atomic::Ordering::Relaxed) {
            return;
        }
        let chunk = remaining.min(250);
        tokio::time::sleep(std::time::Duration::from_millis(chunk as u64)).await;
        remaining -= chunk;
    }
}

async fn provider_generate(
    client: &reqwest::Client,
    config: &GeneratorConfig,
    api_key: &str,
) -> GenerateOutcome {
    let outcome = match config.provider {
        GeneratorProvider::BloxGen => bloxgen_generate(client, config, api_key).await,
    };
    match outcome {
        GenerateOutcome::Fatal(m) => GenerateOutcome::Fatal(redact_api_key(&m, api_key)),
        GenerateOutcome::Transient(m) => GenerateOutcome::Transient(redact_api_key(&m, api_key)),
        other => other,
    }
}

async fn provider_test_key(
    provider: GeneratorProvider,
    endpoint: &str,
    api_key: &str,
) -> Result<f64, String> {
    match provider {
        GeneratorProvider::BloxGen => bloxgen_test_key(endpoint, api_key).await,
    }
}

async fn add_generated_account(
    app: &tauri::AppHandle,
    account: &GeneratedAccount,
    target_group: &str,
    stop_flag: &std::sync::atomic::AtomicBool,
) -> Result<Option<(i64, String)>, String> {
    if stop_flag.load(std::sync::atomic::Ordering::Relaxed) {
        return Ok(None);
    }

    let cookie = account.cookie.clone();
    let (user_id, username) = match api::auth::validate_cookie(&cookie).await {
        Ok(info) => (info.user_id, info.name),
        Err(e) => match account.user_id {
            Some(id) if id > 0 && !account.username.is_empty() => (id, account.username.clone()),
            _ => return Err(format!("Generated cookie failed validation: {}", e)),
        },
    };

    if stop_flag.load(std::sync::atomic::Ordering::Relaxed) {
        return Ok(None);
    }

    let group = if target_group.trim().is_empty() {
        "Default".to_string()
    } else {
        target_group.trim().to_string()
    };

    let mut model = data::accounts::Account::new(cookie, username.clone(), user_id);
    model.password = account.password.clone();
    model.group = group;

    let state = app.state::<AccountStore>();
    state.add(model)?;

    Ok(Some((user_id, username)))
}

async fn run_generator_session(
    app: tauri::AppHandle,
    session_id: u64,
    stop_flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
    stopped_notify: std::sync::Arc<tokio::sync::Notify>,
    config: std::sync::Arc<std::sync::Mutex<GeneratorConfig>>,
    runtime: std::sync::Arc<std::sync::Mutex<GeneratorRuntime>>,
) {
    let cfg = match config.lock() {
        Ok(cfg) => cfg.clone(),
        Err(_) => return,
    };
    let client = generator_client();
    let mut consecutive_failures: i64 = 0;
    let mut rotation = KeyRotation::new(cfg.api_keys.clone());

    loop {
        if stop_flag.load(std::sync::atomic::Ordering::Relaxed) {
            break;
        }

        let key_index = match rotation.next(now_ms()) {
            KeyChoice::Use(index) => index,
            KeyChoice::WaitUntil(until) => {
                let wait = (until - now_ms()).max(0) + cfg.extra_delay_ms;
                sync_key_rotation(&runtime, &rotation, None);
                set_generator_runtime(&runtime, |r| {
                    r.phase = "cooldown".to_string();
                    r.next_attempt_at_ms = Some(now_ms() + wait);
                });
                emit_generator_status(&app);
                sleep_interruptible(&stop_flag, wait).await;
                continue;
            }
            KeyChoice::Exhausted => {
                sync_key_rotation(&runtime, &rotation, None);
                set_generator_runtime(&runtime, |r| {
                    r.active = false;
                    r.phase = "error".to_string();
                    if r.last_error.is_none() {
                        r.last_error = Some("No usable API key left".to_string());
                    }
                    r.next_attempt_at_ms = None;
                });
                break;
            }
        };
        let api_key = rotation.keys[key_index].clone();

        sync_key_rotation(&runtime, &rotation, Some(key_index));
        set_generator_runtime(&runtime, |r| {
            r.phase = "generating".to_string();
            r.next_attempt_at_ms = None;
        });
        emit_generator_status(&app);

        let outcome = provider_generate(&client, &cfg, &api_key).await;
        if stop_flag.load(std::sync::atomic::Ordering::Relaxed) {
            break;
        }

        match outcome {
            GenerateOutcome::Account(account) => {
                set_generator_runtime(&runtime, |r| r.phase = "adding".to_string());
                emit_generator_status(&app);

                match add_generated_account(&app, &account, &cfg.target_group, &stop_flag).await {
                    Ok(Some((user_id, username))) => {
                        consecutive_failures = 0;
                        let total = {
                            let mut total = 0;
                            set_generator_runtime(&runtime, |r| {
                                r.total_generated += 1;
                                r.last_user_id = Some(user_id);
                                r.last_username = Some(username.clone());
                                r.last_error = None;
                                r.last_generated_at_ms = Some(now_ms());
                                r.phase = "cooldown".to_string();
                                total = r.total_generated;
                            });
                            total
                        };
                        let _ = app.emit(
                            "generator-account-added",
                            serde_json::json!({ "userId": user_id, "username": username }),
                        );
                        emit_generator_status(&app);

                        if cfg.max_accounts > 0 && total >= cfg.max_accounts {
                            set_generator_runtime(&runtime, |r| {
                                r.active = false;
                                r.phase = "completed".to_string();
                                r.next_attempt_at_ms = None;
                            });
                            break;
                        }
                    }
                    Ok(None) => {
                        break;
                    }
                    Err(e) => {
                        consecutive_failures += 1;
                        if cfg.max_consecutive_failures > 0
                            && consecutive_failures >= cfg.max_consecutive_failures
                        {
                            set_generator_runtime(&runtime, |r| {
                                r.active = false;
                                r.phase = "error".to_string();
                                r.last_error = Some(format!(
                                    "Stopped after {} consecutive failures: {}",
                                    consecutive_failures, e
                                ));
                                r.next_attempt_at_ms = None;
                            });
                            break;
                        }
                        let wait = GENERATOR_TRANSIENT_BACKOFF_MS + cfg.extra_delay_ms;
                        set_generator_runtime(&runtime, |r| {
                            r.phase = "waiting".to_string();
                            r.last_error = Some(e);
                            r.next_attempt_at_ms = Some(now_ms() + wait);
                        });
                        emit_generator_status(&app);
                        sleep_interruptible(&stop_flag, wait).await;
                    }
                }
            }
            GenerateOutcome::Cooldown(ms) => {
                rotation.cool_down(key_index, now_ms() + ms);
                set_generator_runtime(&runtime, |r| r.last_error = None);
            }
            GenerateOutcome::Transient(message) => {
                let wait = GENERATOR_TRANSIENT_BACKOFF_MS + cfg.extra_delay_ms;
                set_generator_runtime(&runtime, |r| {
                    r.phase = "waiting".to_string();
                    r.last_error = Some(message);
                    r.next_attempt_at_ms = Some(now_ms() + wait);
                });
                emit_generator_status(&app);
                sleep_interruptible(&stop_flag, wait).await;
            }
            GenerateOutcome::Fatal(message) => {
                rotation.reject(key_index);
                set_generator_runtime(&runtime, |r| r.last_error = Some(message));
            }
        }
    }

    set_generator_runtime(&runtime, |r| {
        r.active = false;
        if r.phase != "completed" && r.phase != "error" {
            r.phase = "stopped".to_string();
        }
        r.next_attempt_at_ms = None;
    });

    let _ = session_id;
    stopped_notify.notify_waiters();
    let _ = app.emit("generator-stopped", serde_json::json!({}));
    emit_generator_status(&app);
}

fn generator_status_from_session(session: &GeneratorSession) -> GeneratorStatusPayload {
    let cfg = session.config.lock().ok();
    let runtime = session.runtime.lock().ok();
    GeneratorStatusPayload {
        active: runtime.as_ref().map(|r| r.active).unwrap_or(false),
        started_at_ms: Some(session.started_at_ms),
        provider: cfg
            .as_ref()
            .map(|c| c.provider.id().to_string())
            .unwrap_or_default(),
        endpoint: cfg.as_ref().map(|c| c.endpoint.clone()).unwrap_or_default(),
        account_type: cfg.as_ref().map(|c| c.account_type.clone()).unwrap_or_default(),
        extra_delay_seconds: cfg.as_ref().map(|c| c.extra_delay_ms / 1000).unwrap_or(0),
        target_group: cfg.as_ref().map(|c| c.target_group.clone()).unwrap_or_default(),
        max_accounts: cfg.as_ref().map(|c| c.max_accounts).unwrap_or(0),
        phase: runtime.as_ref().map(|r| r.phase.clone()).unwrap_or_default(),
        next_attempt_at_ms: runtime.as_ref().and_then(|r| r.next_attempt_at_ms),
        total_generated: runtime.as_ref().map(|r| r.total_generated).unwrap_or(0),
        last_username: runtime.as_ref().and_then(|r| r.last_username.clone()),
        last_user_id: runtime.as_ref().and_then(|r| r.last_user_id),
        last_error: runtime.as_ref().and_then(|r| r.last_error.clone()),
        last_generated_at_ms: runtime.as_ref().and_then(|r| r.last_generated_at_ms),
        key_count: runtime.as_ref().map(|r| r.key_count).unwrap_or(0),
        keys_cooling: runtime.as_ref().map(|r| r.keys_cooling).unwrap_or(0),
        keys_rejected: runtime.as_ref().map(|r| r.keys_rejected).unwrap_or(0),
        active_key_index: runtime.as_ref().and_then(|r| r.active_key_index),
        active_key_hint: runtime.as_ref().and_then(|r| r.active_key_hint.clone()),
    }
}

fn current_generator_status() -> GeneratorStatusPayload {
    if let Some(session) = GENERATOR_MANAGER.get_session() {
        generator_status_from_session(&session)
    } else {
        GeneratorStatusPayload::default()
    }
}

fn emit_generator_status(app: &tauri::AppHandle) {
    let _ = app.emit("generator-status", current_generator_status());
}

#[tauri::command]
async fn start_generator(
    app: tauri::AppHandle,
    provider: String,
    endpoint: String,
    api_key: String,
    account_type: String,
    extra_delay_seconds: i64,
    target_group: String,
    max_accounts: i64,
) -> Result<GeneratorStatusPayload, String> {
    let provider = GeneratorProvider::from_id(&provider)?;

    let api_keys = parse_api_keys(&api_key);
    if api_keys.is_empty() {
        return Err("An API key is required".to_string());
    }

    let endpoint = {
        let trimmed = endpoint.trim().trim_end_matches('/');
        if trimmed.is_empty() {
            provider.default_endpoint().to_string()
        } else {
            trimmed.to_string()
        }
    };
    let account_type = {
        let trimmed = account_type.trim();
        if trimmed.is_empty() {
            provider.default_account_type().to_string()
        } else {
            trimmed.to_string()
        }
    };
    let extra_delay_ms = extra_delay_seconds.clamp(0, 3600) * 1000;
    let target_group = target_group.trim().to_string();
    let max_accounts = max_accounts.max(0);
    let max_consecutive_failures = app
        .state::<SettingsStore>()
        .get_int("Generator", "MaxConsecutiveFailures")
        .unwrap_or(3)
        .max(0);

    if let Some(existing) = GENERATOR_MANAGER.get_session() {
        existing
            .stop_flag
            .store(true, std::sync::atomic::Ordering::Relaxed);
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            existing.stopped_notify.notified(),
        )
        .await;
    }

    let cfg = GeneratorConfig {
        provider,
        endpoint,
        api_keys,
        account_type,
        extra_delay_ms,
        target_group,
        max_accounts,
        max_consecutive_failures,
    };
    let runtime = GeneratorRuntime {
        active: true,
        phase: "starting".to_string(),
        total_generated: 0,
        next_attempt_at_ms: None,
        last_username: None,
        last_user_id: None,
        last_error: None,
        last_generated_at_ms: None,
        key_count: 0,
        keys_cooling: 0,
        keys_rejected: 0,
        active_key_index: None,
        active_key_hint: None,
    };

    let session_id = GENERATOR_MANAGER.next_session_id();
    let stop_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stopped_notify = std::sync::Arc::new(tokio::sync::Notify::new());
    let session = GeneratorSession {
        id: session_id,
        stop_flag: stop_flag.clone(),
        stopped_notify: stopped_notify.clone(),
        started_at_ms: now_ms(),
        config: std::sync::Arc::new(std::sync::Mutex::new(cfg)),
        runtime: std::sync::Arc::new(std::sync::Mutex::new(runtime)),
    };

    GENERATOR_MANAGER.replace_session(Some(session.clone()));
    emit_generator_status(&app);

    tokio::spawn(run_generator_session(
        app.clone(),
        session_id,
        stop_flag,
        stopped_notify,
        session.config.clone(),
        session.runtime.clone(),
    ));

    Ok(current_generator_status())
}

#[tauri::command]
fn stop_generator(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(session) = GENERATOR_MANAGER.get_session() {
        session
            .stop_flag
            .store(true, std::sync::atomic::Ordering::Relaxed);
        set_generator_runtime(&session.runtime, |r| {
            r.active = false;
            if r.phase != "completed" && r.phase != "error" {
                r.phase = "stopped".to_string();
            }
            r.next_attempt_at_ms = None;
        });
    }
    let _ = app.emit("generator-stopped", serde_json::json!({}));
    emit_generator_status(&app);
    Ok(())
}

#[tauri::command]
fn get_generator_status() -> Result<GeneratorStatusPayload, String> {
    Ok(current_generator_status())
}

#[tauri::command]
async fn generator_test_key(
    provider: String,
    endpoint: String,
    api_key: String,
) -> Result<Vec<GeneratorKeyTestResult>, String> {
    let provider = GeneratorProvider::from_id(&provider)?;
    let keys = parse_api_keys(&api_key);
    if keys.is_empty() {
        return Err("An API key is required".to_string());
    }
    let outcomes = futures_util::future::join_all(
        keys.iter().map(|key| provider_test_key(provider, &endpoint, key)),
    )
    .await;
    Ok(keys
        .iter()
        .zip(outcomes)
        .enumerate()
        .map(|(index, (key, outcome))| GeneratorKeyTestResult {
            index,
            hint: mask_api_key(key),
            balance: outcome.as_ref().ok().copied(),
            error: outcome.err().map(|e| redact_api_key(&e, key)),
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Provider: BloxGen (https://docs.bloxgen.net)
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
struct BloxGenData {
    #[serde(default)]
    username: String,
    #[serde(default)]
    password: String,
    #[serde(default)]
    cookie: String,
    #[serde(default)]
    id: Option<i64>,
}

#[derive(serde::Deserialize)]
struct BloxGenResponse {
    #[serde(default)]
    success: bool,
    #[serde(default)]
    data: Option<BloxGenData>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(rename = "timeRemaining", default)]
    time_remaining: Option<i64>,
}

#[derive(serde::Deserialize)]
struct BloxGenBalanceData {
    #[serde(default)]
    balance: f64,
}

#[derive(serde::Deserialize)]
struct BloxGenBalanceResponse {
    #[serde(default)]
    success: bool,
    #[serde(default)]
    data: Option<BloxGenBalanceData>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

fn bloxgen_base(endpoint: &str) -> String {
    let trimmed = endpoint.trim().trim_end_matches('/');
    let base = if trimmed.is_empty() {
        DEFAULT_BLOXGEN_ENDPOINT
    } else {
        trimmed
    };
    base.trim_end_matches("/api/generate")
        .trim_end_matches('/')
        .to_string()
}

async fn bloxgen_generate(
    client: &reqwest::Client,
    config: &GeneratorConfig,
    api_key: &str,
) -> GenerateOutcome {
    let url = format!("{}/api/generate", bloxgen_base(&config.endpoint));
    let body = serde_json::json!({ "apiKey": api_key, "type": config.account_type });
    let response = match client.post(&url).json(&body).send().await {
        Ok(response) => response,
        Err(e) => return GenerateOutcome::Transient(format!("Request failed: {}", e)),
    };

    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    let parsed: Option<BloxGenResponse> = serde_json::from_str(&text).ok();

    if status.as_u16() == 200 {
        if let Some(payload) = parsed {
            if payload.success {
                if let Some(data) = payload.data {
                    if data.cookie.is_empty() {
                        return GenerateOutcome::Transient(
                            "Generated account did not include a cookie".to_string(),
                        );
                    }
                    return GenerateOutcome::Account(Box::new(GeneratedAccount {
                        cookie: data.cookie,
                        password: data.password,
                        username: data.username,
                        user_id: data.id,
                    }));
                }
                return GenerateOutcome::Transient(
                    "API returned success but no account data".to_string(),
                );
            }
            let message = payload
                .message
                .or(payload.error)
                .unwrap_or_else(|| "Account generation failed".to_string());
            return GenerateOutcome::Transient(message);
        }
        return GenerateOutcome::Transient(response_snippet(&text));
    }

    let message = parsed
        .as_ref()
        .and_then(|p| p.message.clone().or_else(|| p.error.clone()))
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| response_snippet(&text));

    match status.as_u16() {
        429 => match parsed.as_ref().and_then(|p| p.time_remaining) {
            Some(ms) if ms > 0 => GenerateOutcome::Cooldown(ms),
            _ => GenerateOutcome::Transient(message),
        },
        404 | 500 | 502 | 503 | 504 => GenerateOutcome::Transient(message),
        _ => GenerateOutcome::Fatal(message),
    }
}

async fn bloxgen_test_key(endpoint: &str, api_key: &str) -> Result<f64, String> {
    let url = format!("{}/api/balance", bloxgen_base(endpoint));
    let client = generator_client();
    let response = client
        .get(&url)
        .header("x-api-key", api_key)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    let parsed: Option<BloxGenBalanceResponse> = serde_json::from_str(&text).ok();

    if status.is_success() {
        if let Some(payload) = parsed {
            if payload.success {
                if let Some(data) = payload.data {
                    return Ok(data.balance);
                }
            }
            return Err(payload
                .message
                .or(payload.error)
                .unwrap_or_else(|| "Failed to read balance".to_string()));
        }
        return Err(response_snippet(&text));
    }

    Err(parsed
        .and_then(|p| p.message.or(p.error))
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| format!("Balance check failed (status {})", status.as_u16())))
}

#[cfg(test)]
mod generator_key_rotation_tests {
    use super::{mask_api_key, parse_api_keys, redact_api_key, KeyChoice, KeyRotation};

    fn rotation(count: usize) -> KeyRotation {
        KeyRotation::new((0..count).map(|i| format!("KEY-{:08}", i)).collect())
    }

    #[test]
    fn parses_legacy_single_key_and_lists() {
        assert_eq!(parse_api_keys(" BLOX-ONE "), vec!["BLOX-ONE"]);
        assert_eq!(parse_api_keys(" A ,B\r\n\nA\n C,,"), vec!["A", "B", "C"]);
        assert!(parse_api_keys("  \n , ").is_empty());
    }

    #[test]
    fn masks_keys_to_last_four_characters() {
        assert_eq!(mask_api_key("BLOX-ABCDEFGH1234"), "…1234");
        assert_eq!(mask_api_key("short"), "…");
        assert_eq!(
            redact_api_key("bad key BLOX-ABCDEFGH1234", "BLOX-ABCDEFGH1234"),
            "bad key …1234"
        );
    }

    #[test]
    fn single_key_waits_for_its_cooldown_then_reuses_it() {
        let mut r = rotation(1);
        assert_eq!(r.next(0), KeyChoice::Use(0));
        r.cool_down(0, 5_000);
        assert_eq!(r.next(1_000), KeyChoice::WaitUntil(5_000));
        assert_eq!(r.next(5_000), KeyChoice::Use(0));
    }

    #[test]
    fn stays_on_ready_key_and_skips_cooling_ones() {
        let mut r = rotation(3);
        assert_eq!(r.next(0), KeyChoice::Use(0));
        assert_eq!(r.next(10), KeyChoice::Use(0));
        r.cool_down(0, 1_000);
        assert_eq!(r.next(20), KeyChoice::Use(1));
        r.cool_down(1, 2_000);
        assert_eq!(r.next(30), KeyChoice::Use(2));
        assert_eq!(r.cooling_count(30), 2);
    }

    #[test]
    fn all_cooling_waits_for_earliest() {
        let mut r = rotation(3);
        r.cool_down(0, 9_000);
        r.cool_down(1, 4_000);
        r.cool_down(2, 6_000);
        assert_eq!(r.next(0), KeyChoice::WaitUntil(4_000));
        assert_eq!(r.next(4_000), KeyChoice::Use(1));
    }

    #[test]
    fn rejected_keys_leave_rotation() {
        let mut r = rotation(3);
        r.reject(0);
        assert_eq!(r.next(0), KeyChoice::Use(1));
        r.cool_down(1, 3_000);
        r.reject(2);
        assert_eq!(r.next(100), KeyChoice::WaitUntil(3_000));
        assert_eq!(r.rejected_count(), 2);
        assert_eq!(r.cooling_count(100), 1);
    }

    #[test]
    fn stops_when_no_usable_key_is_left() {
        let mut r = rotation(2);
        r.reject(0);
        r.reject(1);
        assert_eq!(r.next(0), KeyChoice::Exhausted);
        assert_eq!(KeyRotation::new(Vec::new()).next(0), KeyChoice::Exhausted);
    }
}
