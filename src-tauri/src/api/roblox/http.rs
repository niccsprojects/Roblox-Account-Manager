fn cookie_header(security_token: &str) -> String {
    format!(".ROBLOSECURITY={}", security_token)
}

fn game_join_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("Roblox/WinInet")
        .build()
        .unwrap()
}

async fn send_with_retry<F>(mut make_request: F) -> Result<reqwest::Response, String>
where
    F: FnMut() -> reqwest::RequestBuilder,
{
    let mut last_error = String::new();

    for attempt in 0..3 {
        match make_request().send().await {
            Ok(response) => {
                if response.status().as_u16() == 429 && attempt < 2 {
                    let delay = Duration::from_millis(400 * 2_u64.pow(attempt as u32));
                    sleep(delay).await;
                    continue;
                }
                return Ok(response);
            }
            Err(e) => {
                last_error = e.to_string();
                if attempt < 2 {
                    let delay = Duration::from_millis(400 * 2_u64.pow(attempt as u32));
                    sleep(delay).await;
                    continue;
                }
            }
        }
    }

    Err(format!("Request failed: {}", last_error))
}
