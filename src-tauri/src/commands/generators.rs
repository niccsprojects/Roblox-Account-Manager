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
    api_key: String,
    account_type: String,
    extra_delay_ms: i64,
    target_group: String,
    max_accounts: i64,
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
) -> GenerateOutcome {
    match config.provider {
        GeneratorProvider::BloxGen => bloxgen_generate(client, config).await,
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

    loop {
        if stop_flag.load(std::sync::atomic::Ordering::Relaxed) {
            break;
        }

        set_generator_runtime(&runtime, |r| {
            r.phase = "generating".to_string();
            r.next_attempt_at_ms = None;
        });
        emit_generator_status(&app);

        let outcome = provider_generate(&client, &cfg).await;
        if stop_flag.load(std::sync::atomic::Ordering::Relaxed) {
            break;
        }

        match outcome {
            GenerateOutcome::Account(account) => {
                set_generator_runtime(&runtime, |r| r.phase = "adding".to_string());
                emit_generator_status(&app);

                match add_generated_account(&app, &account, &cfg.target_group, &stop_flag).await {
                    Ok(Some((user_id, username))) => {
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
                let wait = ms + cfg.extra_delay_ms;
                set_generator_runtime(&runtime, |r| {
                    r.phase = "cooldown".to_string();
                    r.last_error = None;
                    r.next_attempt_at_ms = Some(now_ms() + wait);
                });
                emit_generator_status(&app);
                sleep_interruptible(&stop_flag, wait).await;
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
                set_generator_runtime(&runtime, |r| {
                    r.active = false;
                    r.phase = "error".to_string();
                    r.last_error = Some(message);
                    r.next_attempt_at_ms = None;
                });
                break;
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

    let api_key = api_key.trim().to_string();
    if api_key.is_empty() {
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
        api_key,
        account_type,
        extra_delay_ms,
        target_group,
        max_accounts,
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
) -> Result<f64, String> {
    let provider = GeneratorProvider::from_id(&provider)?;
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("An API key is required".to_string());
    }
    provider_test_key(provider, &endpoint, api_key).await
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

async fn bloxgen_generate(client: &reqwest::Client, config: &GeneratorConfig) -> GenerateOutcome {
    let url = format!("{}/api/generate", bloxgen_base(&config.endpoint));
    let body = serde_json::json!({ "apiKey": config.api_key, "type": config.account_type });
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
        400 | 401 | 403 => GenerateOutcome::Fatal(message),
        _ => GenerateOutcome::Transient(message),
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
