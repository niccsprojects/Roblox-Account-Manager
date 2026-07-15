pub async fn parse_private_server_link_code(
    security_token: &str,
    place_id: i64,
    link_code: &str,
) -> Result<String, String> {
    let client = game_join_client();

    let normalized_link_code = normalize_private_server_link_code(link_code);
    if normalized_link_code.is_empty() {
        return Err("Failed to parse private server access code".to_string());
    }
    let encoded_link_code = urlencoding::encode(&normalized_link_code);
    let referer = format!("https://www.roblox.com/games/{}", place_id);

    let candidates = [
        format!(
            "https://www.roblox.com/games/{}?privateServerLinkCode={}",
            place_id, encoded_link_code
        ),
        format!(
            "https://www.roblox.com/share-links?code={}&type=Server",
            encoded_link_code
        ),
        format!(
            "https://www.roblox.com/share?code={}&type=Server",
            encoded_link_code
        ),
        format!(
            "https://web.roblox.com/games/{}?privateServerLinkCode={}",
            place_id, encoded_link_code
        ),
        format!(
            "https://web.roblox.com/share-links?code={}&type=Server",
            encoded_link_code
        ),
    ];

    for url in candidates {
        let response = crate::api::auth::send_authenticated(security_token, |csrf| {
            client
                .get(&url)
                .header(COOKIE, cookie_header(security_token))
                .header("X-CSRF-TOKEN", csrf)
                .header("Referer", &referer)
        })
        .await?;

        if response.status().is_success() {
            let body = response
                .text()
                .await
                .map_err(|e| format!("Failed to read response: {}", e))?;
            if let Some(code) = extract_access_code(&body) {
                return Ok(code);
            }
        }
    }

    Err("Failed to parse private server access code".to_string())
}

pub async fn resolve_share_server_link(
    security_token: &str,
    link_id: &str,
) -> Result<(Option<i64>, String), String> {
    let client = game_join_client();

    let normalized_link_id = extract_query_param_value_recursive(link_id, "code")
        .unwrap_or_else(|| decode_url_component(link_id.trim()).trim().to_string());

    if normalized_link_id.is_empty() {
        return Err("Missing share link code".to_string());
    }

    let response = crate::api::auth::send_authenticated(security_token, |csrf| {
        client
            .post("https://apis.roblox.com/sharelinks/v1/resolve-link")
            .header(COOKIE, cookie_header(security_token))
            .header("X-CSRF-TOKEN", csrf)
            .header("Content-Type", "application/json")
            .header("Origin", "https://www.roblox.com")
            .header("Referer", "https://www.roblox.com/share-links")
            .json(&serde_json::json!({
                "linkId": normalized_link_id,
                "linkType": "Server",
            }))
    })
    .await?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "Failed to resolve share link (status {}): {}",
            status,
            body.trim()
        ));
    }

    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let server_data = if body["privateServerInviteData"].is_object() {
        &body["privateServerInviteData"]
    } else {
        &body["serverData"]
    };

    let status = server_data["status"].as_str().unwrap_or_default().to_ascii_lowercase();

    let resolved_link_code = server_data["linkCode"]
        .as_str()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    if let Some(code) = resolved_link_code {
        let mut place_id = server_data["placeId"].as_i64();
        if place_id.is_none() {
            if let Some(universe_id) = server_data["universeId"].as_i64() {
                place_id = get_root_place_id_from_universe(security_token, universe_id).await?;
            }
        }

        return Ok((place_id, code));
    }

    if !status.is_empty() && status != "valid" && status != "expired" {
        return Err("Share link is not valid for server launch".to_string());
    }

    Err("Share link did not return a private server link code".to_string())
}

async fn get_root_place_id_from_universe(
    security_token: &str,
    universe_id: i64,
) -> Result<Option<i64>, String> {
    let client = game_join_client();
    let response = client
        .get(format!(
            "https://games.roblox.com/v1/games?universeIds={}",
            universe_id
        ))
        .header(COOKIE, cookie_header(security_token))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "Failed to resolve root place from universe (status {}): {}",
            status,
            body.trim()
        ));
    }

    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let root_place_id = body["data"]
        .as_array()
        .and_then(|items| items.first())
        .and_then(|item| item["rootPlaceId"].as_i64());

    Ok(root_place_id)
}

fn decode_url_component(value: &str) -> String {
    urlencoding::decode(value)
        .map(|v| v.into_owned())
        .unwrap_or_else(|_| value.to_string())
}

fn extract_query_param_value(input: &str, key: &str) -> Option<String> {
    for part in input.split(['?', '&']) {
        let pair = part.split('#').next().unwrap_or(part);
        let Some((k, v)) = pair.split_once('=') else {
            continue;
        };
        if !k.eq_ignore_ascii_case(key) {
            continue;
        }

        let decoded = decode_url_component(v.trim());
        let value = decoded.trim();
        if value.is_empty()
            || value.eq_ignore_ascii_case("null")
            || value.eq_ignore_ascii_case("undefined")
        {
            continue;
        }

        return Some(value.to_string());
    }
    None
}

fn extract_query_param_value_recursive(input: &str, key: &str) -> Option<String> {
    if let Some(value) = extract_query_param_value(input, key) {
        return Some(value);
    }

    let decoded = decode_url_component(input);
    if decoded != input {
        return extract_query_param_value(&decoded, key);
    }

    None
}

fn normalize_private_server_link_code(link_code: &str) -> String {
    let trimmed = link_code.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    if let Some(code) = extract_query_param_value_recursive(trimmed, "privateServerLinkCode") {
        return code;
    }

    if let Some(code) = extract_query_param_value_recursive(trimmed, "linkCode") {
        return code;
    }

    let lower = trimmed.to_ascii_lowercase();
    let starts_with_code = lower.starts_with("code=");
    if starts_with_code
        || lower.contains("/share?")
        || lower.contains("/share-links")
        || lower.contains("navigation/share_links")
        || lower.contains("type=server")
        || lower.contains("pid=server")
    {
        if let Some(code) = extract_query_param_value_recursive(trimmed, "code") {
            return code;
        }
    }

    if trimmed.len() >= 4
        && trimmed
            .get(..4)
            .map(|head| head.eq_ignore_ascii_case("vip:"))
            .unwrap_or(false)
    {
        if let Some(rest) = trimmed.get(4..) {
            let decoded = decode_url_component(rest.trim());
            let value = decoded.trim();
            if !value.is_empty() {
                return value.to_string();
            }
        }
    }

    decode_url_component(trimmed).trim().to_string()
}

fn sanitize_access_code(value: &str) -> Option<String> {
    let cleaned = value
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim();
    if cleaned.is_empty()
        || cleaned.eq_ignore_ascii_case("null")
        || cleaned.eq_ignore_ascii_case("undefined")
    {
        None
    } else {
        Some(cleaned.to_string())
    }
}

fn extract_between(html: &str, marker: &str, terminator: char) -> Option<String> {
    let start = html.find(marker)? + marker.len();
    let rest = &html[start..];
    let end = rest.find(terminator)?;
    sanitize_access_code(&rest[..end])
}

fn extract_quoted_value_after(html: &str, marker: &str) -> Option<String> {
    let start = html.find(marker)? + marker.len();
    let rest = &html[start..];
    let quote_idx = rest.find(|c| c == '\'' || c == '"')?;
    let quote = rest.as_bytes().get(quote_idx).copied()? as char;
    let payload = rest.get(quote_idx + 1..)?;
    let end = payload.find(quote)?;
    sanitize_access_code(&payload[..end])
}

fn extract_access_code(html: &str) -> Option<String> {
    let marker = "Roblox.GameLauncher.joinPrivateGame(";
    if let Some(code) = extract_quoted_value_after(html, marker) {
        return Some(code);
    }

    for (marker, terminator) in [
        ("\"accessCode\":\"", '"'),
        ("\\\"accessCode\\\":\\\"", '"'),
        ("accessCode=\"", '"'),
        ("accessCode='", '\''),
    ] {
        if let Some(code) = extract_between(html, marker, terminator) {
            return Some(code);
        }
    }

    None
}

