use serde::{Deserialize, Deserializer, Serialize};

/// Represents an individual STUN/TURN ICE server configuration passed to RTCPeerConnection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IceServerConfig {
    #[serde(deserialize_with = "deserialize_urls")]
    pub urls: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
}

impl IceServerConfig {
    /// Creates a STUN server entry without credentials.
    pub fn stun(urls: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self {
            urls: urls.into_iter().map(Into::into).collect(),
            username: None,
            credential: None,
        }
    }

    /// Creates a TURN/TURNS server entry with authentication credentials.
    pub fn turn(
        urls: impl IntoIterator<Item = impl Into<String>>,
        username: impl Into<String>,
        credential: impl Into<String>,
    ) -> Self {
        Self {
            urls: urls.into_iter().map(Into::into).collect(),
            username: Some(username.into()),
            credential: Some(credential.into()),
        }
    }

    /// Default free and unlimited Cloudflare STUN server configuration.
    pub fn default_cloudflare_stun() -> Self {
        Self::stun(["stun:stun.cloudflare.com:3478"])
    }
}

/// Deserializes `urls` from either a single string or an array of strings.
fn deserialize_urls<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum UrlsHelper {
        Single(String),
        Multiple(Vec<String>),
    }
    match UrlsHelper::deserialize(deserializer)? {
        UrlsHelper::Single(s) => Ok(vec![s]),
        UrlsHelper::Multiple(v) => Ok(v),
    }
}

/// Request payload sent to Cloudflare Realtime TURN credentials generation endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudflareCredentialsRequest {
    pub ttl: u64,
}

/// Direct JSON response received from Cloudflare Realtime TURN `generate-ice-servers` endpoint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CloudflareIceServersResponse {
    #[serde(rename = "iceServers")]
    pub ice_servers: Vec<IceServerConfig>,
}

/// API and protocol response structure returned to FastChat clients.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IceServersResponse {
    pub ice_servers: Vec<IceServerConfig>,
    #[serde(rename = "iceServers")]
    pub ice_servers_camel: Vec<IceServerConfig>,
    pub quota_exhausted: bool,
    #[serde(rename = "quotaExhausted")]
    pub quota_exhausted_camel: bool,
}

impl IceServersResponse {
    pub fn new(ice_servers: Vec<IceServerConfig>, quota_exhausted: bool) -> Self {
        Self {
            ice_servers: ice_servers.clone(),
            ice_servers_camel: ice_servers,
            quota_exhausted,
            quota_exhausted_camel: quota_exhausted,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_deserialize_single_and_array_urls() {
        let single_json = r#"{"urls":"stun:stun.cloudflare.com:3478"}"#;
        let server_single: IceServerConfig = serde_json::from_str(single_json).unwrap();
        assert_eq!(server_single.urls, vec!["stun:stun.cloudflare.com:3478"]);
        assert_eq!(server_single.username, None);
        assert_eq!(server_single.credential, None);

        let array_json = r#"{"urls":["stun:stun.cloudflare.com:3478","stun:stun.cloudflare.com:53"]}"#;
        let server_array: IceServerConfig = serde_json::from_str(array_json).unwrap();
        assert_eq!(server_array.urls.len(), 2);
    }

    #[test]
    fn test_cloudflare_response_deserialization() {
        let json_payload = r#"{
            "iceServers": [
                {
                    "urls": ["stun:stun.cloudflare.com:3478"]
                },
                {
                    "urls": ["turn:turn.cloudflare.com:3478?transport=udp"],
                    "username": "user123",
                    "credential": "pass123"
                }
            ]
        }"#;

        let res: CloudflareIceServersResponse = serde_json::from_str(json_payload).unwrap();
        assert_eq!(res.ice_servers.len(), 2);
        assert_eq!(res.ice_servers[0].username, None);
        assert_eq!(res.ice_servers[1].username.as_deref(), Some("user123"));
        assert_eq!(res.ice_servers[1].credential.as_deref(), Some("pass123"));
    }

    #[test]
    fn test_ice_servers_response_serialization() {
        let stun = IceServerConfig::default_cloudflare_stun();
        let res = IceServersResponse::new(vec![stun], false);
        let serialized = serde_json::to_string(&res).unwrap();

        assert!(serialized.contains(r#""quota_exhausted":false"#));
        assert!(serialized.contains(r#""quotaExhausted":false"#));
        assert!(serialized.contains(r#""ice_servers":[{"#));
        assert!(serialized.contains(r#""iceServers":[{"#));
    }
}
