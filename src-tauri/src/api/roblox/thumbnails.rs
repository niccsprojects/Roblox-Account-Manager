#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThumbnailRequest {
    #[serde(rename = "requestId")]
    pub request_id: String,
    #[serde(rename = "type", alias = "thumbnailType")]
    pub thumbnail_type: String,
    #[serde(rename = "targetId")]
    pub target_id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    pub size: String,
    pub format: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThumbnailResponse {
    #[serde(rename = "targetId")]
    pub target_id: i64,
    #[serde(rename = "imageUrl")]
    pub image_url: Option<String>,
    #[serde(rename = "errorCode", default)]
    pub error_code: i32,
    #[serde(rename = "requestId", default)]
    pub request_id: String,
    #[serde(default)]
    pub state: String,
}

pub async fn batch_thumbnails(requests: Vec<ThumbnailRequest>) -> Result<Vec<ThumbnailResponse>, String> {
    if requests.is_empty() {
        return Ok(Vec::new());
    }

    let client = reqwest::Client::new();
    let mut all_results = Vec::new();

    for chunk in requests.chunks(100) {
        let response = send_with_retry(|| {
            client
                .post("https://thumbnails.roblox.com/v1/batch")
                .json(&chunk)
        })
        .await?;

        if !response.status().is_success() {
            return Err(format!("Batch request failed (status {})", response.status().as_u16()));
        }

        let body: serde_json::Value = response.json().await.map_err(|e| format!("Failed to parse: {}", e))?;

        if let Some(data) = body["data"].as_array() {
            for item in data {
                if let Ok(t) = serde_json::from_value::<ThumbnailResponse>(item.clone()) {
                    all_results.push(t);
                }
            }
        }
    }

    Ok(all_results)
}

pub async fn get_avatar_headshots(user_ids: &[i64], size: &str) -> Result<Vec<ThumbnailResponse>, String> {
    if user_ids.is_empty() {
        return Ok(Vec::new());
    }

    let client = reqwest::Client::new();
    let ids: String = user_ids.iter().map(|id| id.to_string()).collect::<Vec<_>>().join(",");

    let url = format!(
        "https://thumbnails.roblox.com/v1/users/avatar-headshot?size={}&format=png&userIds={}",
        size, ids
    );
    let response = send_with_retry(|| client.get(&url)).await?;

    if !response.status().is_success() {
        return Err(format!("Failed to get headshots (status {})", response.status().as_u16()));
    }

    let body: serde_json::Value = response.json().await.map_err(|e| format!("Failed to parse: {}", e))?;

    Ok(body["data"]
        .as_array()
        .map(|arr| arr.iter().filter_map(|v| serde_json::from_value(v.clone()).ok()).collect())
        .unwrap_or_default())
}

pub async fn get_asset_thumbnails(
    asset_ids: &[i64],
    size: &str,
    security_token: Option<&str>,
) -> Result<Vec<ThumbnailResponse>, String> {
    if asset_ids.is_empty() {
        return Ok(Vec::new());
    }

    let client = reqwest::Client::new();
    let ids: String = asset_ids.iter().map(|id| id.to_string()).collect::<Vec<_>>().join(",");

    let mut request = client.get(format!(
        "https://thumbnails.roblox.com/v1/assets?assetIds={}&returnPolicy=PlaceHolder&size={}&format=Png&isCircular=false",
        ids, size
    ));

    if let Some(token) = security_token {
        request = request.header(COOKIE, cookie_header(token));
    }

    let response = request.send().await.map_err(|e| format!("Request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Failed to get asset thumbnails (status {})", response.status().as_u16()));
    }

    let body: serde_json::Value = response.json().await.map_err(|e| format!("Failed to parse: {}", e))?;

    Ok(body["data"]
        .as_array()
        .map(|arr| arr.iter().filter_map(|v| serde_json::from_value(v.clone()).ok()).collect())
        .unwrap_or_default())
}
