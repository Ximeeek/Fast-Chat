use crate::turn::IceServerConfig;
use serde::{Deserialize, Serialize};

/// Formats a byte slice into a lowercase hexadecimal string.
pub fn format_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(s, "{:02x}", b);
    }
    s
}

/// Parses a hexadecimal string into a byte vector.
pub fn parse_hex(hex: &str) -> Result<Vec<u8>, String> {
    if hex.len() % 2 != 0 {
        return Err("Hex string must have an even length".to_string());
    }

    (0..hex.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(&hex[i..i + 2], 16)
                .map_err(|e| format!("Invalid hex digit at position {i}: {e}"))
        })
        .collect()
}

/// Incoming client signaling messages sent over WebSocket.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ClientMessage {
    /// Request to create a new room.
    CreateRoom {
        #[serde(default, alias = "peerId")]
        peer_id: Option<String>,
        #[serde(default, alias = "hasPassword")]
        has_password: Option<bool>,
        #[serde(default)]
        password: Option<String>,
    },

    /// Request to join an existing room.
    JoinRoom {
        #[serde(alias = "roomCode", alias = "room_code")]
        code: String,
        #[serde(default, alias = "peerId")]
        peer_id: Option<String>,
        #[serde(default, alias = "passwordHash")]
        password: Option<String>,
    },

    /// Transparent WebRTC SDP offer relay intended for a specific peer.
    SdpOffer {
        #[serde(alias = "targetPeerId", alias = "target", alias = "to")]
        target_peer_id: String,
        sdp: serde_json::Value,
    },

    /// Transparent WebRTC SDP answer relay intended for a specific peer.
    SdpAnswer {
        #[serde(alias = "targetPeerId", alias = "target", alias = "to")]
        target_peer_id: String,
        sdp: serde_json::Value,
    },

    /// Transparent WebRTC ICE candidate(s) relay intended for a specific peer.
    #[serde(alias = "ICE_CANDIDATE")]
    IceCandidates {
        #[serde(alias = "targetPeerId", alias = "target", alias = "to")]
        target_peer_id: String,
        #[serde(default)]
        candidates: Option<serde_json::Value>,
        #[serde(default)]
        candidate: Option<serde_json::Value>,
    },

    /// Request by room owner to configure or update password protection.
    Rekey {
        #[serde(alias = "passwordHash")]
        password: String,
        #[serde(default)]
        salt: Option<String>,
    },

    /// Request ICE servers configuration (STUN/TURN) for WebRTC peer connection.
    #[serde(alias = "GET_ICE_SERVERS")]
    RequestIceServers,

    /// Application-level heartbeat ping.
    Ping,
}

/// Outgoing server signaling messages sent to WebSocket peers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ServerMessage {
    /// Room created acknowledgment returned exclusively to creator.
    RoomCreated {
        code: String,
        peer_id: String,
        #[serde(rename = "peerId")]
        peer_id_camel: String,
        salt: String,
        crypto_salt: String,
        expires_at: i64,
        #[serde(rename = "expiresAt")]
        expires_at_camel: i64,
    },

    /// Room joined confirmation returned to joining peer.
    JoinOk {
        status: String,
        code: String,
        peer_id: String,
        #[serde(rename = "peerId")]
        peer_id_camel: String,
        is_owner: bool,
        salt: String,
        expires_at: i64,
        #[serde(rename = "expiresAt")]
        expires_at_camel: i64,
        peers: Vec<String>,
    },

    /// Broadcast notification informing active participants that a new peer joined.
    PeerJoined {
        peer_id: String,
        #[serde(rename = "peerId")]
        peer_id_camel: String,
    },

    /// Broadcast notification informing active participants that a peer disconnected.
    PeerLeft {
        peer_id: String,
        #[serde(rename = "peerId")]
        peer_id_camel: String,
    },

    /// Relayed SDP offer payload annotated with sender identity.
    SdpOffer {
        sender_peer_id: String,
        #[serde(rename = "senderPeerId")]
        sender_peer_id_camel: String,
        sdp: serde_json::Value,
    },

    /// Relayed SDP answer payload annotated with sender identity.
    SdpAnswer {
        sender_peer_id: String,
        #[serde(rename = "senderPeerId")]
        sender_peer_id_camel: String,
        sdp: serde_json::Value,
    },

    /// Relayed ICE candidate(s) annotated with sender identity.
    IceCandidates {
        sender_peer_id: String,
        #[serde(rename = "senderPeerId")]
        sender_peer_id_camel: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        candidates: Option<serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        candidate: Option<serde_json::Value>,
    },

    /// Broadcast notification that the room has transitioned to password protection.
    /// Notice: Only the public salt and room code are broadcast; keys are never transmitted.
    Rekey {
        room_code: String,
        salt: String,
    },

    /// Broadcast notification that room lifetime has expired and grace period started.
    RoomClosing {
        room_code: String,
        closing_deadline: i64,
        #[serde(rename = "closingDeadline")]
        closing_deadline_camel: i64,
        expires_at: i64,
        #[serde(rename = "expiresAt")]
        expires_at_camel: i64,
    },

    /// Broadcast notification that room grace period expired and room state is destroyed.
    RoomClosed {
        room_code: String,
        reason: String,
    },

    /// Application-level heartbeat pong.
    Pong,

    /// Signaling error event detailing failure reason.
    Error {
        code: String,
        message: String,
    },

    /// Response containing ICE servers configuration and quota status.
    IceServers {
        ice_servers: Vec<IceServerConfig>,
        #[serde(rename = "iceServers")]
        ice_servers_camel: Vec<IceServerConfig>,
        quota_exhausted: bool,
        #[serde(rename = "quotaExhausted")]
        quota_exhausted_camel: bool,
        turn_issuance_limited: bool,
        #[serde(rename = "turnIssuanceLimited")]
        turn_issuance_limited_camel: bool,
    },
}

impl ServerMessage {
    pub fn room_created(code: impl Into<String>, peer_id: impl Into<String>, salt_hex: impl Into<String>, expires_at: i64) -> Self {
        let code_str = code.into();
        let peer_str = peer_id.into();
        let salt_str = salt_hex.into();
        Self::RoomCreated {
            code: code_str,
            peer_id: peer_str.clone(),
            peer_id_camel: peer_str,
            salt: salt_str.clone(),
            crypto_salt: salt_str,
            expires_at,
            expires_at_camel: expires_at,
        }
    }

    pub fn join_ok(
        code: impl Into<String>,
        peer_id: impl Into<String>,
        is_owner: bool,
        salt_hex: impl Into<String>,
        expires_at: i64,
        peers: Vec<String>,
    ) -> Self {
        let code_str = code.into();
        let peer_str = peer_id.into();
        Self::JoinOk {
            status: "OK".to_string(),
            code: code_str,
            peer_id: peer_str.clone(),
            peer_id_camel: peer_str,
            is_owner,
            salt: salt_hex.into(),
            expires_at,
            expires_at_camel: expires_at,
            peers,
        }
    }

    pub fn peer_joined(peer_id: impl Into<String>) -> Self {
        let id = peer_id.into();
        Self::PeerJoined {
            peer_id: id.clone(),
            peer_id_camel: id,
        }
    }

    pub fn peer_left(peer_id: impl Into<String>) -> Self {
        let id = peer_id.into();
        Self::PeerLeft {
            peer_id: id.clone(),
            peer_id_camel: id,
        }
    }

    pub fn sdp_offer(sender_peer_id: impl Into<String>, sdp: serde_json::Value) -> Self {
        let id = sender_peer_id.into();
        Self::SdpOffer {
            sender_peer_id: id.clone(),
            sender_peer_id_camel: id,
            sdp,
        }
    }

    pub fn sdp_answer(sender_peer_id: impl Into<String>, sdp: serde_json::Value) -> Self {
        let id = sender_peer_id.into();
        Self::SdpAnswer {
            sender_peer_id: id.clone(),
            sender_peer_id_camel: id,
            sdp,
        }
    }

    pub fn ice_candidates(
        sender_peer_id: impl Into<String>,
        candidates: Option<serde_json::Value>,
        candidate: Option<serde_json::Value>,
    ) -> Self {
        let id = sender_peer_id.into();
        Self::IceCandidates {
            sender_peer_id: id.clone(),
            sender_peer_id_camel: id,
            candidates,
            candidate,
        }
    }

    pub fn rekey(room_code: impl Into<String>, salt_hex: impl Into<String>) -> Self {
        Self::Rekey {
            room_code: room_code.into(),
            salt: salt_hex.into(),
        }
    }

    pub fn room_closing(room_code: impl Into<String>, closing_deadline: i64, expires_at: i64) -> Self {
        Self::RoomClosing {
            room_code: room_code.into(),
            closing_deadline,
            closing_deadline_camel: closing_deadline,
            expires_at,
            expires_at_camel: expires_at,
        }
    }

    pub fn room_closed(room_code: impl Into<String>, reason: impl Into<String>) -> Self {
        Self::RoomClosed {
            room_code: room_code.into(),
            reason: reason.into(),
        }
    }

    pub fn error(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Error {
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn ice_servers(
        ice_servers: Vec<IceServerConfig>,
        quota_exhausted: bool,
        turn_issuance_limited: bool,
    ) -> Self {
        Self::IceServers {
            ice_servers: ice_servers.clone(),
            ice_servers_camel: ice_servers,
            quota_exhausted,
            quota_exhausted_camel: quota_exhausted,
            turn_issuance_limited,
            turn_issuance_limited_camel: turn_issuance_limited,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_and_parse_hex() {
        let bytes = [0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef];
        let hex = format_hex(&bytes);
        assert_eq!(hex, "0123456789abcdef");

        let parsed = parse_hex(&hex).expect("Parsing hex should succeed");
        assert_eq!(parsed, bytes);

        assert!(parse_hex("123").is_err()); // Odd length
        assert!(parse_hex("12zz").is_err()); // Invalid character
    }

    #[test]
    fn test_client_message_create_room_deserialization() {
        let json_data = r#"{"type":"CREATE_ROOM","peer_id":"alice"}"#;
        let msg: ClientMessage = serde_json::from_str(json_data).unwrap();
        assert_eq!(
            msg,
            ClientMessage::CreateRoom {
                peer_id: Some("alice".to_string()),
                has_password: None,
                password: None,
            }
        );

        let json_camel = r#"{"type":"CREATE_ROOM","peerId":"alice","hasPassword":true,"password":"secret"}"#;
        let msg_camel: ClientMessage = serde_json::from_str(json_camel).unwrap();
        assert_eq!(
            msg_camel,
            ClientMessage::CreateRoom {
                peer_id: Some("alice".to_string()),
                has_password: Some(true),
                password: Some("secret".to_string()),
            }
        );
    }

    #[test]
    fn test_client_message_join_room_deserialization() {
        let json_data = r#"{"type":"JOIN_ROOM","code":"1234-5678-9012","peerId":"bob","password":"pass"}"#;
        let msg: ClientMessage = serde_json::from_str(json_data).unwrap();
        assert_eq!(
            msg,
            ClientMessage::JoinRoom {
                code: "1234-5678-9012".to_string(),
                peer_id: Some("bob".to_string()),
                password: Some("pass".to_string()),
            }
        );
    }

    #[test]
    fn test_client_message_sdp_offer_and_answer() {
        let offer_json = r#"{"type":"SDP_OFFER","target":"bob","sdp":{"type":"offer","sdp":"v=0..."}}"#;
        let offer_msg: ClientMessage = serde_json::from_str(offer_json).unwrap();
        match offer_msg {
            ClientMessage::SdpOffer { target_peer_id, sdp } => {
                assert_eq!(target_peer_id, "bob");
                assert_eq!(sdp["type"], "offer");
            }
            _ => panic!("Expected SdpOffer"),
        }

        let answer_json = r#"{"type":"SDP_ANSWER","target_peer_id":"alice","sdp":{"type":"answer","sdp":"v=0..."}}"#;
        let answer_msg: ClientMessage = serde_json::from_str(answer_json).unwrap();
        match answer_msg {
            ClientMessage::SdpAnswer { target_peer_id, sdp } => {
                assert_eq!(target_peer_id, "alice");
                assert_eq!(sdp["type"], "answer");
            }
            _ => panic!("Expected SdpAnswer"),
        }
    }

    #[test]
    fn test_client_message_ice_candidates_alias() {
        let ice_json = r#"{"type":"ICE_CANDIDATE","target":"bob","candidate":{"candidate":"cand..."}}"#;
        let ice_msg: ClientMessage = serde_json::from_str(ice_json).unwrap();
        match ice_msg {
            ClientMessage::IceCandidates { target_peer_id, candidate, .. } => {
                assert_eq!(target_peer_id, "bob");
                assert!(candidate.is_some());
            }
            _ => panic!("Expected IceCandidates"),
        }
    }

    #[test]
    fn test_client_message_rekey() {
        let rekey_json = r#"{"type":"REKEY","password":"new_password"}"#;
        let rekey_msg: ClientMessage = serde_json::from_str(rekey_json).unwrap();
        assert_eq!(
            rekey_msg,
            ClientMessage::Rekey {
                password: "new_password".to_string(),
                salt: None,
            }
        );
    }

    #[test]
    fn test_server_message_serialization() {
        let room_created = ServerMessage::room_created("1234-5678-9012", "alice", "001122", 1000);
        let serialized = serde_json::to_string(&room_created).unwrap();
        assert!(serialized.contains(r#""type":"ROOM_CREATED""#));
        assert!(serialized.contains(r#""code":"1234-5678-9012""#));
        assert!(serialized.contains(r#""peer_id":"alice""#));
        assert!(serialized.contains(r#""peerId":"alice""#));
        assert!(serialized.contains(r#""salt":"001122""#));
        assert!(serialized.contains(r#""expiresAt":1000"#));
        assert!(serialized.contains(r#""expires_at":1000"#));

        let join_ok = ServerMessage::join_ok("1234-5678-9012", "bob", false, "001122", 1000, vec!["alice".to_string()]);
        let join_serialized = serde_json::to_string(&join_ok).unwrap();
        assert!(join_serialized.contains(r#""type":"JOIN_OK""#));
        assert!(join_serialized.contains(r#""status":"OK""#));
        assert!(join_serialized.contains(r#""expiresAt":1000"#));
        assert!(join_serialized.contains(r#""peers":["alice"]"#));

        let sdp_relay = ServerMessage::sdp_offer("alice", serde_json::json!({"type": "offer", "sdp": "data"}));
        let sdp_serialized = serde_json::to_string(&sdp_relay).unwrap();
        assert!(sdp_serialized.contains(r#""sender_peer_id":"alice""#));
        assert!(sdp_serialized.contains(r#""senderPeerId":"alice""#));
        assert!(sdp_serialized.contains(r#""sdp":{"sdp":"data","type":"offer"}"#));

        let stun = IceServerConfig::default_cloudflare_stun();
        let ice_msg = ServerMessage::ice_servers(vec![stun], false, true);
        let ice_serialized = serde_json::to_string(&ice_msg).unwrap();
        assert!(ice_serialized.contains(r#""type":"ICE_SERVERS""#));
        assert!(ice_serialized.contains(r#""quota_exhausted":false"#));
        assert!(ice_serialized.contains(r#""quotaExhausted":false"#));
        assert!(ice_serialized.contains(r#""turn_issuance_limited":true"#));
        assert!(ice_serialized.contains(r#""turnIssuanceLimited":true"#));
        assert!(ice_serialized.contains(r#""ice_servers":[{"#));
        assert!(ice_serialized.contains(r#""iceServers":[{"#));
    }

    #[test]
    fn test_client_message_request_ice_servers_deserialization() {
        let json_data = r#"{"type":"REQUEST_ICE_SERVERS"}"#;
        let msg: ClientMessage = serde_json::from_str(json_data).unwrap();
        assert_eq!(msg, ClientMessage::RequestIceServers);

        let json_alias = r#"{"type":"GET_ICE_SERVERS"}"#;
        let msg_alias: ClientMessage = serde_json::from_str(json_alias).unwrap();
        assert_eq!(msg_alias, ClientMessage::RequestIceServers);
    }
}
