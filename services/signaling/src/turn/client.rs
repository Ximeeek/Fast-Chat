use crate::config::Config;
use crate::turn::models::{CloudflareCredentialsRequest, CloudflareIceServersResponse, IceServerConfig};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use std::time::Duration;
use thiserror::Error;
use tracing::{debug, warn};

/// Errors that can occur when requesting TURN credentials or checking limits.
#[derive(Debug, Error)]
pub enum TurnError {
    #[error("TURN service is not configured (missing token or key ID)")]
    NotConfigured,

    #[error("TURN monthly quota exhausted ({0} bytes used)")]
    QuotaExhausted(u64),

    #[error("Cloudflare TURN HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("Cloudflare TURN API error (status {0}): {1}")]
    Api(u16, String),

    #[error("Failed to parse Cloudflare TURN response: {0}")]
    Parse(String),
}

/// HTTP client for Cloudflare Realtime TURN credential generation.
#[derive(Clone, Debug)]
pub struct CloudflareTurnClient {
    client: reqwest::Client,
    base_url: String,
    api_token: Option<String>,
    key_id: Option<String>,
    default_ttl_secs: u64,
}

impl CloudflareTurnClient {
    /// Creates a new CloudflareTurnClient from application configuration.
    pub fn new(config: &Config) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap_or_default();

        Self {
            client,
            base_url: config.turn_api_base_url.trim_end_matches('/').to_string(),
            api_token: config.cloudflare_turn_api_token.clone(),
            key_id: config.cloudflare_turn_key_id.clone(),
            default_ttl_secs: config.turn_credential_ttl_secs,
        }
    }

    /// Creates a custom configured client (useful for integration testing and mocking).
    pub fn with_custom_endpoint(
        base_url: impl Into<String>,
        api_token: Option<String>,
        key_id: Option<String>,
        default_ttl_secs: u64,
    ) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap_or_default();

        Self {
            client,
            base_url: base_url.into().trim_end_matches('/').to_string(),
            api_token,
            key_id,
            default_ttl_secs,
        }
    }

    /// Returns whether both the Cloudflare API token and TURN key ID are configured.
    pub fn is_configured(&self) -> bool {
        self.api_token.is_some() && self.key_id.is_some()
    }

    /// Issues short-lived, single-session TURN credentials from Cloudflare Realtime TURN API.
    ///
    /// The API token is attached via Authorization Bearer header with sensitive marking
    /// and is never logged in logs or trace statements.
    pub async fn generate_ice_servers(
        &self,
        ttl_secs: Option<u64>,
    ) -> Result<Vec<IceServerConfig>, TurnError> {
        let (token, key_id) = match (&self.api_token, &self.key_id) {
            (Some(token), Some(key_id)) => (token, key_id),
            _ => return Err(TurnError::NotConfigured),
        };

        let ttl = ttl_secs.unwrap_or(self.default_ttl_secs);
        let url = format!(
            "{}/v1/turn/keys/{}/credentials/generate-ice-servers",
            self.base_url, key_id
        );

        debug!(url = %url, ttl = ttl, "Requesting short-lived TURN credentials from Cloudflare");

        let mut headers = HeaderMap::new();
        let mut auth_val = HeaderValue::from_str(&format!("Bearer {}", token))
            .map_err(|e| TurnError::Parse(format!("Invalid authorization header value: {e}")))?;
        auth_val.set_sensitive(true);
        headers.insert(AUTHORIZATION, auth_val);
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

        let req_body = CloudflareCredentialsRequest { ttl };

        let response = self
            .client
            .post(&url)
            .headers(headers)
            .json(&req_body)
            .send()
            .await?;

        let status = response.status();
        if !status.is_success() {
            let error_text = response.text().await.unwrap_or_else(|_| "<empty>".to_string());
            warn!(status = %status, "Cloudflare TURN API responded with non-2xx status");
            return Err(TurnError::Api(status.as_u16(), error_text));
        }

        let parsed: CloudflareIceServersResponse = response
            .json()
            .await
            .map_err(|e| TurnError::Parse(e.to_string()))?;

        Ok(parsed.ice_servers)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_unconfigured_client_returns_not_configured() {
        let config = Config::default();
        let client = CloudflareTurnClient::new(&config);
        assert!(!client.is_configured());

        let result = client.generate_ice_servers(None).await;
        assert!(matches!(result, Err(TurnError::NotConfigured)));
    }

    #[tokio::test]
    async fn test_configured_check() {
        let client = CloudflareTurnClient::with_custom_endpoint(
            "http://localhost:12345",
            Some("token".to_string()),
            Some("key_id".to_string()),
            86400,
        );
        assert!(client.is_configured());

        let missing_key = CloudflareTurnClient::with_custom_endpoint(
            "http://localhost:12345",
            Some("token".to_string()),
            None,
            86400,
        );
        assert!(!missing_key.is_configured());
    }

    #[tokio::test]
    async fn test_client_generate_ice_servers_mock_server() {
        use axum::{routing::post, Json, Router};
        use serde_json::json;

        let app = Router::new().route(
            "/v1/turn/keys/test-key-123/credentials/generate-ice-servers",
            post(|| async {
                Json(json!({
                    "iceServers": [
                        {
                            "urls": ["stun:stun.cloudflare.com:3478"]
                        },
                        {
                            "urls": ["turn:turn.cloudflare.com:3478?transport=udp"],
                            "username": "test_user",
                            "credential": "test_credential"
                        }
                    ]
                }))
            }),
        );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let client = CloudflareTurnClient::with_custom_endpoint(
            format!("http://127.0.0.1:{port}"),
            Some("test_api_token".to_string()),
            Some("test-key-123".to_string()),
            3600,
        );

        let servers = client.generate_ice_servers(Some(1800)).await.expect("Must succeed");
        assert_eq!(servers.len(), 2);
        assert_eq!(servers[0].urls, vec!["stun:stun.cloudflare.com:3478"]);
        assert_eq!(servers[1].username.as_deref(), Some("test_user"));
        assert_eq!(servers[1].credential.as_deref(), Some("test_credential"));
    }

    #[tokio::test]
    async fn test_client_handles_api_error() {
        use axum::{http::StatusCode, routing::post, Router};

        let app = Router::new().route(
            "/v1/turn/keys/err-key/credentials/generate-ice-servers",
            post(|| async {
                (StatusCode::UNAUTHORIZED, "Invalid authentication token")
            }),
        );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let client = CloudflareTurnClient::with_custom_endpoint(
            format!("http://127.0.0.1:{port}"),
            Some("invalid_token".to_string()),
            Some("err-key".to_string()),
            3600,
        );

        let err = client.generate_ice_servers(None).await.unwrap_err();
        match err {
            TurnError::Api(401, msg) => {
                assert!(msg.contains("Invalid authentication token"));
            }
            other => panic!("Expected TurnError::Api(401), got {other:?}"),
        }
    }
}
