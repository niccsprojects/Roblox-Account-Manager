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
    stealth: bool,
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
    if stealth {
        cmd.arg("--lang=en-US");
    }
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
        let mut ws_url = None;
        for _ in 0..40 {
            if let Ok(resp) = reqwest::get(format!("http://127.0.0.1:{}/json", port)).await {
                if let Ok(targets) = resp.json::<Value>().await {
                    ws_url = targets.as_array().and_then(|arr| {
                        arr.iter()
                            .find(|t| t.get("type").and_then(Value::as_str) == Some("page"))
                            .and_then(|t| t.get("webSocketDebuggerUrl").and_then(Value::as_str))
                            .map(|s| s.to_string())
                    });
                    if ws_url.is_some() {
                        break;
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        let ws_url = ws_url.ok_or("Could not attach to the browser")?;
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

    pub async fn inject_stealth(&mut self) -> Result<(), String> {
        let _ = self.send("Page.enable", json!({})).await;
        let source = "Object.defineProperty(navigator, 'webdriver', { get: () => undefined });";
        self.send(
            "Page.addScriptToEvaluateOnNewDocument",
            json!({ "source": source }),
        )
        .await?;
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

    pub async fn wait_for_selector(&mut self, selector: &str, attempts: u32) -> bool {
        let expression = format!(
            "document.querySelector({}) ? true : false",
            serde_json::to_string(selector).unwrap_or_default()
        );
        for _ in 0..attempts {
            if let Ok(Value::Bool(true)) = self.eval(&expression).await {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        false
    }

    pub async fn fill_login(&mut self, username: &str, password: &str) -> Result<(), String> {
        let user = serde_json::to_string(username).unwrap_or_default();
        let pass = serde_json::to_string(password).unwrap_or_default();
        let script = format!(
            "(function(){{\
var u=document.querySelector('#login-username');\
var p=document.querySelector('#login-password');\
var b=document.querySelector('#login-button');\
if(!u||!p)return 'no-fields';\
var s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;\
s.call(u,{user});u.dispatchEvent(new Event('input',{{bubbles:true}}));\
s.call(p,{pass});p.dispatchEvent(new Event('input',{{bubbles:true}}));\
if(b){{b.disabled=false;b.click();return 'clicked';}}\
return 'filled';}})()",
            user = user,
            pass = pass
        );
        self.eval(&script).await?;
        Ok(())
    }
}
