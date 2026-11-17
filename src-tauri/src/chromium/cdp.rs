use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

pub async fn spawn_chrome(
    binary: &Path,
    profile: &Path,
    start_url: &str,
    debug: bool,
) -> Result<(Child, Option<u16>), String> {
    let _ = std::fs::create_dir_all(profile);
    let active_port_file = profile.join("DevToolsActivePort");
    if debug {
        let _ = std::fs::remove_file(&active_port_file);
    }

    let mut cmd = Command::new(binary);
    cmd.arg(format!("--user-data-dir={}", profile.to_string_lossy()));
    cmd.arg("--no-first-run");
    cmd.arg("--no-default-browser-check");
    cmd.arg("--disable-features=Translate");
    cmd.arg("--lang=en-US");
    if debug {
        cmd.arg("--remote-debugging-port=0");
    }
    cmd.arg(start_url);
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());

    let child = cmd.spawn().map_err(|e| format!("Could not start browser: {}", e))?;

    if !debug {
        return Ok((child, None));
    }

    for _ in 0..160 {
        if let Ok(contents) = std::fs::read_to_string(&active_port_file) {
            if let Some(port) = contents.lines().next().and_then(|l| l.trim().parse::<u16>().ok()) {
                return Ok((child, Some(port)));
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    Ok((child, None))
}

pub struct CdpClient {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    next_id: i64,
}

impl CdpClient {
    pub async fn connect(port: u16) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(2))
            .build()
            .map_err(|e| format!("Could not attach to the browser: {}", e))?;

        let mut ws_url = None;
        let mut last_error = String::new();
        for _ in 0..80 {
            match client.get(format!("http://127.0.0.1:{}/json", port)).send().await {
                Ok(resp) => match resp.json::<Value>().await {
                    Ok(targets) => {
                        ws_url = targets.as_array().and_then(|arr| pick_page_target(arr));
                        if ws_url.is_some() {
                            break;
                        }
                        last_error = "no debuggable page yet".to_string();
                    }
                    Err(e) => last_error = e.to_string(),
                },
                Err(e) => last_error = e.to_string(),
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        let ws_url = ws_url.ok_or_else(|| {
            if last_error.is_empty() {
                "Could not attach to the browser".to_string()
            } else {
                format!("Could not attach to the browser: {}", last_error)
            }
        })?;
        let (socket, _) = connect_async(ws_url.as_str())
            .await
            .map_err(|e| format!("Could not attach to the browser: {}", e))?;

        let mut client = Self { socket, next_id: 0 };
        let _ = client.send("Network.enable", json!({})).await;
        Ok(client)
    }

    pub async fn send(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        let payload = json!({ "id": id, "method": method, "params": params });
        self.socket
            .send(Message::Text(payload.to_string().into()))
            .await
            .map_err(|e| format!("Browser command failed: {}", e))?;

        let socket = &mut self.socket;
        let recv = async {
            loop {
                let frame = match socket.next().await {
                    Some(frame) => frame.map_err(|e| format!("Browser connection lost: {}", e))?,
                    None => return Err("Browser connection closed".to_string()),
                };

                let text = match frame {
                    Message::Text(text) => text,
                    Message::Close(_) => return Err("Browser connection closed".to_string()),
                    _ => continue,
                };

                let value: Value = match serde_json::from_str(&text) {
                    Ok(value) => value,
                    Err(_) => continue,
                };

                if value.get("id").and_then(Value::as_i64) == Some(id) {
                    if let Some(error) = value.get("error") {
                        let message = error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("Browser command failed");
                        return Err(message.to_string());
                    }
                    return Ok(value.get("result").cloned().unwrap_or(Value::Null));
                }
            }
        };

        match tokio::time::timeout(Duration::from_secs(20), recv).await {
            Ok(result) => result,
            Err(_) => Err("Browser stopped responding".to_string()),
        }
    }

    pub async fn eval(&mut self, expression: &str) -> Result<Value, String> {
        let result = self
            .send(
                "Runtime.evaluate",
                json!({ "expression": expression, "returnByValue": true, "awaitPromise": true }),
            )
            .await?;
        Ok(result
            .get("result")
            .and_then(|r| r.get("value"))
            .cloned()
            .unwrap_or(Value::Null))
    }

    pub async fn navigate(&mut self, url: &str) -> Result<(), String> {
        self.send("Page.navigate", json!({ "url": url })).await?;
        Ok(())
    }

    pub async fn delete_roblosecurity(&mut self, domain: &str) -> Result<(), String> {
        self.send(
            "Network.deleteCookies",
            json!({ "name": ".ROBLOSECURITY", "domain": domain, "path": "/" }),
        )
        .await?;
        Ok(())
    }

    pub async fn set_roblosecurity(&mut self, value: &str, domain: &str) -> Result<(), String> {
        self.send(
            "Network.setCookie",
            json!({
                "name": ".ROBLOSECURITY",
                "value": value,
                "domain": domain,
                "path": "/",
                "secure": true,
                "httpOnly": true,
                "sameSite": "None",
            }),
        )
        .await?;
        Ok(())
    }

    pub async fn get_roblosecurity(&mut self) -> Result<Option<String>, String> {
        let result = self.send("Network.getAllCookies", json!({})).await?;
        Ok(result
            .get("cookies")
            .and_then(Value::as_array)
            .and_then(|cookies| {
                cookies
                    .iter()
                    .find(|c| {
                        c.get("name").and_then(Value::as_str) == Some(".ROBLOSECURITY")
                            && c.get("value")
                                .and_then(Value::as_str)
                                .map(|v| !v.is_empty())
                                .unwrap_or(false)
                    })
                    .and_then(|c| c.get("value").and_then(Value::as_str))
                    .map(|s| s.to_string())
            }))
    }

    pub async fn fill_login(&mut self, username: &str, password: &str) -> String {
        let user = serde_json::to_string(username).unwrap_or_default();
        let pass = serde_json::to_string(password).unwrap_or_default();
        let script = format!(
            "(function(){{\
if(!/(^|\\.)roblox\\.com$/.test(location.hostname))return 'wrong-page';\
var w=window,changed=false;\
if(w.__ramSubmitted)return 'submitted';\
var u=document.querySelector('#login-username');\
var p=document.querySelector('#login-password');\
var b=document.querySelector('#login-button');\
if(!u)return 'no-fields';\
function put(e,v,k){{\
if(e.value===v)return true;\
if(w[k])return false;\
w[k]=1;e.focus();\
Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,v);\
e.dispatchEvent(new Event('input',{{bubbles:true}}));\
e.dispatchEvent(new Event('change',{{bubbles:true}}));\
changed=true;return true;}}\
if(!put(u,{user},'__ramUser'))return 'retype-user';\
if(!p||p.offsetParent===null){{\
if(!changed&&b&&!b.disabled&&!w.__ramNext){{w.__ramNext=1;b.click();return 'continued';}}\
return 'waiting-password';}}\
if(!put(p,{pass},'__ramPass'))return 'retype-pass';\
if(changed)return 'filled';\
if(!b||b.disabled)return 'waiting-button';\
w.__ramSubmitted=1;b.click();return 'clicked';}})()",
            user = user,
            pass = pass
        );
        match self.eval(&script).await {
            Ok(Value::String(status)) => status,
            _ => String::new(),
        }
    }

    pub async fn insert_text(&mut self, selector: &str, text: &str) -> Result<(), String> {
        let focus = format!(
            "(function(){{var e=document.querySelector({});if(!e)return false;e.focus();e.select();return true;}})()",
            serde_json::to_string(selector).unwrap_or_default()
        );
        if self.eval(&focus).await? != Value::Bool(true) {
            return Err("Field not found".to_string());
        }
        self.send("Input.insertText", json!({ "text": text })).await?;
        Ok(())
    }
}

fn pick_page_target(targets: &[Value]) -> Option<String> {
    let pages: Vec<&Value> = targets
        .iter()
        .filter(|t| t.get("type").and_then(Value::as_str) == Some("page"))
        .filter(|t| t.get("webSocketDebuggerUrl").and_then(Value::as_str).is_some())
        .collect();
    pages
        .iter()
        .find(|t| {
            t.get("url")
                .and_then(Value::as_str)
                .is_some_and(|u| u.starts_with("https://www.roblox.com/login"))
        })
        .or(pages.first())
        .and_then(|t| t.get("webSocketDebuggerUrl").and_then(Value::as_str))
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_login_page_over_other_tabs() {
        let targets = vec![
            json!({ "type": "service_worker", "url": "https://www.roblox.com/login", "webSocketDebuggerUrl": "ws://sw" }),
            json!({ "type": "page", "url": "chrome://welcome/", "webSocketDebuggerUrl": "ws://welcome" }),
            json!({ "type": "page", "url": "https://www.roblox.com/login?returnUrl=x", "webSocketDebuggerUrl": "ws://login" }),
        ];
        assert_eq!(pick_page_target(&targets).as_deref(), Some("ws://login"));
    }

    #[test]
    fn falls_back_to_first_debuggable_page() {
        let targets = vec![
            json!({ "type": "page", "url": "about:blank" }),
            json!({ "type": "page", "url": "about:blank", "webSocketDebuggerUrl": "ws://blank" }),
        ];
        assert_eq!(pick_page_target(&targets).as_deref(), Some("ws://blank"));
        assert_eq!(pick_page_target(&[]), None);
    }
}
