pub async fn join_group(security_token: &str, group_id: i64) -> Result<(), String> {
    let client = reqwest::Client::new();

    let response = crate::api::auth::send_authenticated(security_token, |csrf| {
        client
            .post(format!("https://groups.roblox.com/v1/groups/{}/users", group_id))
            .header(COOKIE, cookie_header(security_token))
            .header("X-CSRF-TOKEN", csrf)
            .header("Content-Type", "application/json")
            .body("{}")
    })
    .await?;

    if response.status().is_success() {
        Ok(())
    } else {
        let body = response.text().await.unwrap_or_default();
        Err(format!("Failed to join group: {}", body))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserPresence {
    #[serde(rename = "userPresenceType")]
    pub user_presence_type: i32,
    #[serde(rename = "lastLocation", default)]
    pub last_location: String,
    #[serde(rename = "placeId")]
    pub place_id: Option<i64>,
    #[serde(rename = "rootPlaceId")]
    pub root_place_id: Option<i64>,
    #[serde(rename = "gameId")]
    pub game_id: Option<String>,
    #[serde(rename = "universeId")]
    pub universe_id: Option<i64>,
    #[serde(rename = "userId")]
    pub user_id: i64,
    #[serde(rename = "lastOnline", default)]
    pub last_online: String,
}

pub async fn get_presence(user_ids: &[i64]) -> Result<Vec<UserPresence>, String> {
    let client = reqwest::Client::new();

    let response = client
        .post("https://presence.roblox.com/v1/presence/users")
        .json(&serde_json::json!({ "userIds": user_ids }))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Failed to get presence (status {})", response.status().as_u16()));
    }

    let body: serde_json::Value = response.json().await.map_err(|e| format!("Failed to parse: {}", e))?;

    Ok(body["userPresences"]
        .as_array()
        .map(|arr| arr.iter().filter_map(|v| serde_json::from_value(v.clone()).ok()).collect())
        .unwrap_or_default())
}
