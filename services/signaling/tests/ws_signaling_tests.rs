use fastchat_signaling::{
    config::Config,
    create_router,
    state::AppState,
    ws::protocol::{ClientMessage, ServerMessage},
};
use futures_util::{SinkExt, StreamExt};
use std::net::SocketAddr;
use tokio::net::TcpListener;
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};

async fn spawn_test_server(config: Config) -> (SocketAddr, AppState) {
    let app_state = AppState::new(config);
    let app = create_router(app_state.clone());

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    (addr, app_state)
}

#[tokio::test]
async fn test_ws_create_and_join_room_flow() {
    let config = Config {
        max_participants_per_room: 2,
        ..Default::default()
    };
    let (addr, _state) = spawn_test_server(config).await;
    let ws_url = format!("ws://{addr}/ws");

    // 1. Peer A connects and sends CREATE_ROOM
    let (mut ws_a, _) = connect_async(&ws_url).await.expect("Failed to connect peer A");

    let create_msg = ClientMessage::CreateRoom {
        peer_id: Some("alice".to_string()),
        has_password: None,
        password: None,
    };
    ws_a.send(Message::Text(serde_json::to_string(&create_msg).unwrap().into()))
        .await
        .unwrap();

    let resp_a_raw = ws_a.next().await.unwrap().unwrap().into_text().unwrap();
    let resp_a: ServerMessage = serde_json::from_str(&resp_a_raw).unwrap();

    let room_code = match resp_a {
        ServerMessage::RoomCreated {
            code,
            peer_id,
            salt,
            expires_at,
            expires_at_camel,
            ..
        } => {
            assert_eq!(peer_id, "alice");
            assert_eq!(code.len(), 14);
            assert_eq!(salt.len(), 64); // 32 bytes in hex = 64 characters
            assert!(expires_at > 0);
            assert_eq!(expires_at, expires_at_camel);
            code
        }
        _ => panic!("Expected RoomCreated response for peer A, got {resp_a:?}"),
    };

    // 2. Peer B connects and sends JOIN_ROOM
    let (mut ws_b, _) = connect_async(&ws_url).await.expect("Failed to connect peer B");

    let join_msg = ClientMessage::JoinRoom {
        code: room_code.clone(),
        peer_id: Some("bob".to_string()),
        password: None,
    };
    ws_b.send(Message::Text(serde_json::to_string(&join_msg).unwrap().into()))
        .await
        .unwrap();

    // Bob receives JOIN_OK
    let resp_b_raw = ws_b.next().await.unwrap().unwrap().into_text().unwrap();
    let resp_b: ServerMessage = serde_json::from_str(&resp_b_raw).unwrap();

    match resp_b {
        ServerMessage::JoinOk {
            status,
            code,
            peer_id,
            is_owner,
            peers,
            expires_at,
            ..
        } => {
            assert_eq!(status, "OK");
            assert_eq!(code, room_code);
            assert_eq!(peer_id, "bob");
            assert!(!is_owner);
            assert_eq!(peers, vec!["alice".to_string()]);
            assert!(expires_at > 0);
        }
        _ => panic!("Expected JoinOk response for peer B, got {resp_b:?}"),
    }

    // Alice receives PEER_JOINED for Bob
    let alice_notif_raw = ws_a.next().await.unwrap().unwrap().into_text().unwrap();
    let alice_notif: ServerMessage = serde_json::from_str(&alice_notif_raw).unwrap();

    match alice_notif {
        ServerMessage::PeerJoined { peer_id, .. } => {
            assert_eq!(peer_id, "bob");
        }
        _ => panic!("Expected PeerJoined notification for peer A, got {alice_notif:?}"),
    }

    // 3. Peer C connects and tries to join (room capacity = 2, so it must be rejected with ROOM_FULL)
    let (mut ws_c, _) = connect_async(&ws_url).await.expect("Failed to connect peer C");

    let join_c = ClientMessage::JoinRoom {
        code: room_code.clone(),
        peer_id: Some("charlie".to_string()),
        password: None,
    };
    ws_c.send(Message::Text(serde_json::to_string(&join_c).unwrap().into()))
        .await
        .unwrap();

    let resp_c_raw = ws_c.next().await.unwrap().unwrap().into_text().unwrap();
    let resp_c: ServerMessage = serde_json::from_str(&resp_c_raw).unwrap();

    match resp_c {
        ServerMessage::Error { code, message } => {
            assert_eq!(code, "ROOM_FULL");
            assert!(message.contains("maximum of 2 participants allowed"));
        }
        _ => panic!("Expected Error(ROOM_FULL) for peer C, got {resp_c:?}"),
    }

    // 4. Bob disconnects; Alice receives PEER_LEFT
    drop(ws_b);
    let alice_left_raw = ws_a.next().await.unwrap().unwrap().into_text().unwrap();
    let alice_left: ServerMessage = serde_json::from_str(&alice_left_raw).unwrap();

    match alice_left {
        ServerMessage::PeerLeft { peer_id, .. } => {
            assert_eq!(peer_id, "bob");
        }
        _ => panic!("Expected PeerLeft notification for peer A, got {alice_left:?}"),
    }
}

#[tokio::test]
async fn test_ws_sdp_and_ice_relay_flow() {
    let config = Config::default();
    let (addr, _state) = spawn_test_server(config).await;
    let ws_url = format!("ws://{addr}/ws");

    // 1. Peer A creates room
    let (mut ws_a, _) = connect_async(&ws_url).await.unwrap();
    let create_msg = ClientMessage::CreateRoom {
        peer_id: Some("alice".to_string()),
        has_password: None,
        password: None,
    };
    ws_a.send(Message::Text(serde_json::to_string(&create_msg).unwrap().into()))
        .await
        .unwrap();

    let resp_a_raw = ws_a.next().await.unwrap().unwrap().into_text().unwrap();
    let resp_a: ServerMessage = serde_json::from_str(&resp_a_raw).unwrap();
    let room_code = match resp_a {
        ServerMessage::RoomCreated { code, .. } => code,
        _ => panic!("Expected RoomCreated"),
    };

    // 2. Peer B joins room
    let (mut ws_b, _) = connect_async(&ws_url).await.unwrap();
    let join_msg = ClientMessage::JoinRoom {
        code: room_code.clone(),
        peer_id: Some("bob".to_string()),
        password: None,
    };
    ws_b.send(Message::Text(serde_json::to_string(&join_msg).unwrap().into()))
        .await
        .unwrap();

    let _join_ok = ws_b.next().await.unwrap().unwrap();
    let _peer_joined = ws_a.next().await.unwrap().unwrap();

    // 3. Alice relays SDP_OFFER to Bob
    let original_sdp = serde_json::json!({
        "type": "offer",
        "sdp": "v=0\r\no=- 42 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=sendrecv"
    });
    let offer_req = ClientMessage::SdpOffer {
        target_peer_id: "bob".to_string(),
        sdp: original_sdp.clone(),
    };
    ws_a.send(Message::Text(serde_json::to_string(&offer_req).unwrap().into()))
        .await
        .unwrap();

    let bob_offer_raw = ws_b.next().await.unwrap().unwrap().into_text().unwrap();
    let bob_offer: ServerMessage = serde_json::from_str(&bob_offer_raw).unwrap();

    match bob_offer {
        ServerMessage::SdpOffer {
            sender_peer_id,
            sender_peer_id_camel,
            sdp,
        } => {
            assert_eq!(sender_peer_id, "alice");
            assert_eq!(sender_peer_id_camel, "alice");
            assert_eq!(sdp, original_sdp, "SDP offer must be relayed verbatim without modification");
        }
        _ => panic!("Expected SdpOffer received by Bob, got {bob_offer:?}"),
    }

    // 4. Bob relays SDP_ANSWER to Alice
    let original_answer = serde_json::json!({
        "type": "answer",
        "sdp": "v=0\r\no=- 84 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=recvonly"
    });
    let answer_req = ClientMessage::SdpAnswer {
        target_peer_id: "alice".to_string(),
        sdp: original_answer.clone(),
    };
    ws_b.send(Message::Text(serde_json::to_string(&answer_req).unwrap().into()))
        .await
        .unwrap();

    let alice_answer_raw = ws_a.next().await.unwrap().unwrap().into_text().unwrap();
    let alice_answer: ServerMessage = serde_json::from_str(&alice_answer_raw).unwrap();

    match alice_answer {
        ServerMessage::SdpAnswer {
            sender_peer_id,
            sdp,
            ..
        } => {
            assert_eq!(sender_peer_id, "bob");
            assert_eq!(sdp, original_answer, "SDP answer must be relayed verbatim without modification");
        }
        _ => panic!("Expected SdpAnswer received by Alice, got {alice_answer:?}"),
    }

    // 5. Alice relays ICE_CANDIDATES to Bob
    let candidates_payload = serde_json::json!([
        {
            "candidate": "candidate:1 1 UDP 2130706431 192.168.1.1 50000 typ host",
            "sdpMLineIndex": 0,
            "sdpMid": "0"
        }
    ]);
    let ice_req = ClientMessage::IceCandidates {
        target_peer_id: "bob".to_string(),
        candidates: Some(candidates_payload.clone()),
        candidate: None,
    };
    ws_a.send(Message::Text(serde_json::to_string(&ice_req).unwrap().into()))
        .await
        .unwrap();

    let bob_ice_raw = ws_b.next().await.unwrap().unwrap().into_text().unwrap();
    let bob_ice: ServerMessage = serde_json::from_str(&bob_ice_raw).unwrap();

    match bob_ice {
        ServerMessage::IceCandidates {
            sender_peer_id,
            candidates,
            ..
        } => {
            assert_eq!(sender_peer_id, "alice");
            assert_eq!(candidates, Some(candidates_payload), "ICE candidates must be relayed verbatim without modification");
        }
        _ => panic!("Expected IceCandidates received by Bob, got {bob_ice:?}"),
    }

    // 6. Relay to non-existent peer returns PEER_NOT_FOUND error
    let invalid_target = ClientMessage::SdpOffer {
        target_peer_id: "nonexistent".to_string(),
        sdp: serde_json::json!({"type": "offer"}),
    };
    ws_a.send(Message::Text(serde_json::to_string(&invalid_target).unwrap().into()))
        .await
        .unwrap();

    let err_raw = ws_a.next().await.unwrap().unwrap().into_text().unwrap();
    let err_msg: ServerMessage = serde_json::from_str(&err_raw).unwrap();

    match err_msg {
        ServerMessage::Error { code, message } => {
            assert_eq!(code, "PEER_NOT_FOUND");
            assert!(message.contains("nonexistent"));
        }
        _ => panic!("Expected Error(PEER_NOT_FOUND), got {err_msg:?}"),
    }
}

#[tokio::test]
async fn test_ws_rekey_and_password_protection_flow() {
    let config = Config {
        max_participants_per_room: 4,
        ..Default::default()
    };
    let (addr, _state) = spawn_test_server(config).await;
    let ws_url = format!("ws://{addr}/ws");

    // 1. Peer A (owner) creates room without initial password
    let (mut ws_a, _) = connect_async(&ws_url).await.unwrap();
    let create_msg = ClientMessage::CreateRoom {
        peer_id: Some("alice".to_string()),
        has_password: None,
        password: None,
    };
    ws_a.send(Message::Text(serde_json::to_string(&create_msg).unwrap().into()))
        .await
        .unwrap();

    let resp_a_raw = ws_a.next().await.unwrap().unwrap().into_text().unwrap();
    let resp_a: ServerMessage = serde_json::from_str(&resp_a_raw).unwrap();
    let room_code = match resp_a {
        ServerMessage::RoomCreated { code, .. } => code,
        _ => panic!("Expected RoomCreated"),
    };

    // 2. Peer B joins without password -> succeeds
    let (mut ws_b, _) = connect_async(&ws_url).await.unwrap();
    let join_b = ClientMessage::JoinRoom {
        code: room_code.clone(),
        peer_id: Some("bob".to_string()),
        password: None,
    };
    ws_b.send(Message::Text(serde_json::to_string(&join_b).unwrap().into()))
        .await
        .unwrap();

    let resp_b_raw = ws_b.next().await.unwrap().unwrap().into_text().unwrap();
    let resp_b: ServerMessage = serde_json::from_str(&resp_b_raw).unwrap();
    assert!(matches!(resp_b, ServerMessage::JoinOk { .. }));
    let _ = ws_a.next().await.unwrap(); // consume PEER_JOINED(bob) on Alice

    // 3. Peer B (non-owner) attempts to REKEY -> rejected with UNAUTHORIZED
    let rogue_rekey = ClientMessage::Rekey {
        password: "rogue-password".to_string(),
        salt: None,
    };
    ws_b.send(Message::Text(serde_json::to_string(&rogue_rekey).unwrap().into()))
        .await
        .unwrap();

    let b_err_raw = ws_b.next().await.unwrap().unwrap().into_text().unwrap();
    let b_err: ServerMessage = serde_json::from_str(&b_err_raw).unwrap();
    match b_err {
        ServerMessage::Error { code, .. } => assert_eq!(code, "UNAUTHORIZED"),
        _ => panic!("Expected Error(UNAUTHORIZED) for non-owner rekey"),
    }

    // 4. Peer A (owner) initiates REKEY with password "room-secret-999"
    let owner_rekey = ClientMessage::Rekey {
        password: "room-secret-999".to_string(),
        salt: None,
    };
    ws_a.send(Message::Text(serde_json::to_string(&owner_rekey).unwrap().into()))
        .await
        .unwrap();

    // Alice and Bob both receive REKEY broadcast
    let a_rekey_raw = ws_a.next().await.unwrap().unwrap().into_text().unwrap();
    let a_rekey: ServerMessage = serde_json::from_str(&a_rekey_raw).unwrap();
    match a_rekey {
        ServerMessage::Rekey { room_code: c, salt } => {
            assert_eq!(c, room_code);
            assert_eq!(salt.len(), 32); // 16-byte random salt = 32 hex chars
        }
        _ => panic!("Expected Rekey broadcast on Alice, got {a_rekey:?}"),
    }

    let b_rekey_raw = ws_b.next().await.unwrap().unwrap().into_text().unwrap();
    let b_rekey: ServerMessage = serde_json::from_str(&b_rekey_raw).unwrap();
    match b_rekey {
        ServerMessage::Rekey { room_code: c, salt } => {
            assert_eq!(c, room_code);
            assert_eq!(salt.len(), 32);
        }
        _ => panic!("Expected Rekey broadcast on Bob, got {b_rekey:?}"),
    }

    // 5. Peer C attempts to join WITHOUT password -> rejected with INVALID_PASSWORD
    let (mut ws_c, _) = connect_async(&ws_url).await.unwrap();
    let join_c_no_pw = ClientMessage::JoinRoom {
        code: room_code.clone(),
        peer_id: Some("charlie".to_string()),
        password: None,
    };
    ws_c.send(Message::Text(serde_json::to_string(&join_c_no_pw).unwrap().into()))
        .await
        .unwrap();

    let c_err1_raw = ws_c.next().await.unwrap().unwrap().into_text().unwrap();
    let c_err1: ServerMessage = serde_json::from_str(&c_err1_raw).unwrap();
    match c_err1 {
        ServerMessage::Error { code, .. } => assert_eq!(code, "INVALID_PASSWORD"),
        _ => panic!("Expected Error(INVALID_PASSWORD) for missing password"),
    }

    // 6. Peer C attempts to join with WRONG password -> rejected with INVALID_PASSWORD
    let join_c_wrong = ClientMessage::JoinRoom {
        code: room_code.clone(),
        peer_id: Some("charlie".to_string()),
        password: Some("incorrect-pass".to_string()),
    };
    ws_c.send(Message::Text(serde_json::to_string(&join_c_wrong).unwrap().into()))
        .await
        .unwrap();

    let c_err2_raw = ws_c.next().await.unwrap().unwrap().into_text().unwrap();
    let c_err2: ServerMessage = serde_json::from_str(&c_err2_raw).unwrap();
    match c_err2 {
        ServerMessage::Error { code, .. } => assert_eq!(code, "INVALID_PASSWORD"),
        _ => panic!("Expected Error(INVALID_PASSWORD) for wrong password"),
    }

    // 7. Peer C joins with CORRECT password -> succeeds
    let join_c_correct = ClientMessage::JoinRoom {
        code: room_code.clone(),
        peer_id: Some("charlie".to_string()),
        password: Some("room-secret-999".to_string()),
    };
    ws_c.send(Message::Text(serde_json::to_string(&join_c_correct).unwrap().into()))
        .await
        .unwrap();

    let c_ok_raw = ws_c.next().await.unwrap().unwrap().into_text().unwrap();
    let c_ok: ServerMessage = serde_json::from_str(&c_ok_raw).unwrap();
    match c_ok {
        ServerMessage::JoinOk {
            status,
            peer_id,
            peers,
            ..
        } => {
            assert_eq!(status, "OK");
            assert_eq!(peer_id, "charlie");
            assert!(peers.contains(&"alice".to_string()));
            assert!(peers.contains(&"bob".to_string()));
        }
        _ => panic!("Expected JoinOk for Charlie with correct password"),
    }
}

#[tokio::test]
async fn test_ws_lifecycle_closing_and_closed_broadcast_flow() {
    let config = Config {
        initial_room_duration_secs: 10,
        closing_grace_period_secs: 2,
        extendable_threshold_secs: 2,
        ..Default::default()
    };
    let (addr, state) = spawn_test_server(config).await;
    let ws_url = format!("ws://{addr}/ws");

    // 1. Alice creates room
    let (mut ws_a, _) = connect_async(&ws_url).await.unwrap();
    let create_msg = ClientMessage::CreateRoom {
        peer_id: Some("alice".to_string()),
        has_password: None,
        password: None,
    };
    ws_a.send(Message::Text(serde_json::to_string(&create_msg).unwrap().into()))
        .await
        .unwrap();

    let resp_a_raw = ws_a.next().await.unwrap().unwrap().into_text().unwrap();
    let resp_a: ServerMessage = serde_json::from_str(&resp_a_raw).unwrap();
    let (room_code_str, start_ts) = match resp_a {
        ServerMessage::RoomCreated { code, expires_at, .. } => (code, expires_at - 10),
        _ => panic!("Expected RoomCreated"),
    };

    // 2. Bob joins room
    let (mut ws_b, _) = connect_async(&ws_url).await.unwrap();
    let join_b = ClientMessage::JoinRoom {
        code: room_code_str.clone(),
        peer_id: Some("bob".to_string()),
        password: None,
    };
    ws_b.send(Message::Text(serde_json::to_string(&join_b).unwrap().into()))
        .await
        .unwrap();

    let _join_b = ws_b.next().await.unwrap().unwrap();
    let _peer_joined_a = ws_a.next().await.unwrap().unwrap();

    // 3. Drive ticker past expiration -> triggers Closing transition
    let actions = state.room_manager.tick_lifecycle(start_ts + 11);
    assert!(!actions.is_empty());

    // Both Alice and Bob receive ROOM_CLOSING
    let a_closing_raw = ws_a.next().await.unwrap().unwrap().into_text().unwrap();
    let a_closing: ServerMessage = serde_json::from_str(&a_closing_raw).unwrap();
    match a_closing {
        ServerMessage::RoomClosing { room_code, closing_deadline, .. } => {
            assert_eq!(room_code, room_code_str);
            assert!(closing_deadline > 0);
        }
        _ => panic!("Expected RoomClosing for Alice, got {a_closing:?}"),
    }

    let b_closing_raw = ws_b.next().await.unwrap().unwrap().into_text().unwrap();
    let b_closing: ServerMessage = serde_json::from_str(&b_closing_raw).unwrap();
    match b_closing {
        ServerMessage::RoomClosing { room_code, .. } => {
            assert_eq!(room_code, room_code_str);
        }
        _ => panic!("Expected RoomClosing for Bob, got {b_closing:?}"),
    }

    // 4. Drive ticker past grace period -> triggers Destroyed & ROOM_CLOSED broadcast
    let destroy_actions = state.room_manager.tick_lifecycle(start_ts + 25);
    assert!(!destroy_actions.is_empty());

    // Both Alice and Bob receive ROOM_CLOSED
    let a_closed_raw = ws_a.next().await.unwrap().unwrap().into_text().unwrap();
    let a_closed: ServerMessage = serde_json::from_str(&a_closed_raw).unwrap();
    match a_closed {
        ServerMessage::RoomClosed { room_code, reason } => {
            assert_eq!(room_code, room_code_str);
            assert_eq!(reason, "lifetime_or_grace_period_expired");
        }
        _ => panic!("Expected RoomClosed for Alice, got {a_closed:?}"),
    }

    let b_closed_raw = ws_b.next().await.unwrap().unwrap().into_text().unwrap();
    let b_closed: ServerMessage = serde_json::from_str(&b_closed_raw).unwrap();
    match b_closed {
        ServerMessage::RoomClosed { room_code, reason } => {
            assert_eq!(room_code, room_code_str);
            assert_eq!(reason, "lifetime_or_grace_period_expired");
        }
        _ => panic!("Expected RoomClosed for Bob, got {b_closed:?}"),
    }

    // Socket closure after ROOM_CLOSED
    let next_a = ws_a.next().await;
    assert!(next_a.is_none() || matches!(next_a.unwrap(), Ok(Message::Close(_))));

    // 5. Client trying to join destroyed room receives ROOM_NOT_FOUND
    let (mut ws_d, _) = connect_async(&ws_url).await.unwrap();
    let join_d = ClientMessage::JoinRoom {
        code: room_code_str,
        peer_id: Some("dave".to_string()),
        password: None,
    };
    ws_d.send(Message::Text(serde_json::to_string(&join_d).unwrap().into()))
        .await
        .unwrap();

    let d_err_raw = ws_d.next().await.unwrap().unwrap().into_text().unwrap();
    let d_err: ServerMessage = serde_json::from_str(&d_err_raw).unwrap();
    match d_err {
        ServerMessage::Error { code, .. } => assert_eq!(code, "ROOM_NOT_FOUND"),
        _ => panic!("Expected Error(ROOM_NOT_FOUND) for destroyed room"),
    }
}

#[tokio::test]
async fn test_ws_request_ice_servers_flow() {
    let config = Config::default();
    let (addr, state) = spawn_test_server(config).await;
    let ws_url = format!("ws://{addr}/ws");

    let (mut ws, _) = connect_async(&ws_url).await.unwrap();

    // Send REQUEST_ICE_SERVERS
    let msg = ClientMessage::RequestIceServers;
    ws.send(Message::Text(serde_json::to_string(&msg).unwrap().into()))
        .await
        .unwrap();

    let resp_raw = ws.next().await.unwrap().unwrap().into_text().unwrap();
    let resp: ServerMessage = serde_json::from_str(&resp_raw).unwrap();

    match resp {
        ServerMessage::IceServers {
            ice_servers,
            quota_exhausted,
            ..
        } => {
            assert!(!quota_exhausted);
            assert_eq!(ice_servers.len(), 1);
            assert_eq!(ice_servers[0].urls[0], "stun:stun.cloudflare.com:3478");
        }
        other => panic!("Expected IceServers message, got {other:?}"),
    }

    // Now trip quota on governor in state
    state
        .turn
        .governor
        .set_usage(state.config.turn_max_monthly_bytes + 100);

    // Send another REQUEST_ICE_SERVERS
    ws.send(Message::Text(serde_json::to_string(&msg).unwrap().into()))
        .await
        .unwrap();

    let resp2_raw = ws.next().await.unwrap().unwrap().into_text().unwrap();
    let resp2: ServerMessage = serde_json::from_str(&resp2_raw).unwrap();

    match resp2 {
        ServerMessage::IceServers {
            ice_servers,
            quota_exhausted,
            ..
        } => {
            assert!(quota_exhausted);
            assert_eq!(ice_servers.len(), 1);
            assert_eq!(ice_servers[0].urls[0], "stun:stun.cloudflare.com:3478");
        }
        other => panic!("Expected IceServers message with quota_exhausted, got {other:?}"),
    }
}

#[tokio::test]
async fn test_two_independent_connections_same_ip_same_room_success() {
    let config = Config {
        max_participants_per_room: 5,
        ..Default::default()
    };
    let (addr, _state) = spawn_test_server(config).await;
    let ws_url = format!("ws://{addr}/ws");

    // Peer A connects from 127.0.0.1 and creates a room
    let (mut ws_a, _) = connect_async(&ws_url).await.expect("Failed to connect peer A");
    let create_msg = ClientMessage::CreateRoom {
        peer_id: Some("alice".to_string()),
        has_password: None,
        password: None,
    };
    ws_a.send(Message::Text(serde_json::to_string(&create_msg).unwrap().into()))
        .await
        .unwrap();

    let resp_a_raw = ws_a.next().await.unwrap().unwrap().into_text().unwrap();
    let resp_a: ServerMessage = serde_json::from_str(&resp_a_raw).unwrap();
    let room_code = match resp_a {
        ServerMessage::RoomCreated { code, .. } => code,
        other => panic!("Expected RoomCreated for peer A, got {other:?}"),
    };

    // Peer B connects from the exact same IP (127.0.0.1) and joins the same room
    let (mut ws_b, _) = connect_async(&ws_url).await.expect("Failed to connect peer B");
    let join_b = ClientMessage::JoinRoom {
        code: room_code.clone(),
        peer_id: Some("bob".to_string()),
        password: None,
    };
    ws_b.send(Message::Text(serde_json::to_string(&join_b).unwrap().into()))
        .await
        .unwrap();

    let resp_b_raw = ws_b.next().await.unwrap().unwrap().into_text().unwrap();
    let resp_b: ServerMessage = serde_json::from_str(&resp_b_raw).unwrap();

    // Verify Bob successfully joined and was NOT rejected with ALREADY_IN_ROOM
    match resp_b {
        ServerMessage::JoinOk { status, code, peer_id, .. } => {
            assert_eq!(status, "OK");
            assert_eq!(code, room_code);
            assert_eq!(peer_id, "bob");
        }
        ServerMessage::Error { code, message } => {
            panic!("Peer B was unexpectedly rejected with error [{code}]: {message}");
        }
        other => panic!("Expected JoinOk for peer B, got {other:?}"),
    }

    // Alice receives PEER_JOINED for Bob
    let notif_raw = ws_a.next().await.unwrap().unwrap().into_text().unwrap();
    let notif: ServerMessage = serde_json::from_str(&notif_raw).unwrap();
    match notif {
        ServerMessage::PeerJoined { peer_id, .. } => assert_eq!(peer_id, "bob"),
        other => panic!("Expected PeerJoined for Alice, got {other:?}"),
    }
}

#[tokio::test]
async fn test_two_independent_connections_same_ip_different_rooms_success() {
    let config = Config {
        max_active_rooms_per_ip: 2,
        ..Default::default()
    };
    let (addr, _state) = spawn_test_server(config).await;
    let ws_url = format!("ws://{addr}/ws");

    // Peer 1 connects from 127.0.0.1 and creates Room 1
    let (mut ws_1, _) = connect_async(&ws_url).await.expect("Failed to connect peer 1");
    let create_1 = ClientMessage::CreateRoom {
        peer_id: Some("peer_1".to_string()),
        has_password: None,
        password: None,
    };
    ws_1.send(Message::Text(serde_json::to_string(&create_1).unwrap().into()))
        .await
        .unwrap();
    let resp_1_raw = ws_1.next().await.unwrap().unwrap().into_text().unwrap();
    let resp_1: ServerMessage = serde_json::from_str(&resp_1_raw).unwrap();
    let room_code_1 = match resp_1 {
        ServerMessage::RoomCreated { code, .. } => code,
        other => panic!("Expected RoomCreated for peer 1, got {other:?}"),
    };

    // Peer 2 connects from the same IP (127.0.0.1) and creates Room 2
    let (mut ws_2, _) = connect_async(&ws_url).await.expect("Failed to connect peer 2");
    let create_2 = ClientMessage::CreateRoom {
        peer_id: Some("peer_2".to_string()),
        has_password: None,
        password: None,
    };
    ws_2.send(Message::Text(serde_json::to_string(&create_2).unwrap().into()))
        .await
        .unwrap();
    let resp_2_raw = ws_2.next().await.unwrap().unwrap().into_text().unwrap();
    let resp_2: ServerMessage = serde_json::from_str(&resp_2_raw).unwrap();
    let room_code_2 = match resp_2 {
        ServerMessage::RoomCreated { code, .. } => code,
        other => panic!("Expected RoomCreated for peer 2, got {other:?}"),
    };

    assert_ne!(room_code_1, room_code_2);
}

#[tokio::test]
async fn test_same_connection_double_join_rejected_with_already_in_room() {
    let config = Config::default();
    let (addr, _state) = spawn_test_server(config).await;
    let ws_url = format!("ws://{addr}/ws");

    // Peer A creates room
    let (mut ws_a, _) = connect_async(&ws_url).await.expect("Failed to connect peer A");
    let create_a = ClientMessage::CreateRoom {
        peer_id: Some("alice".to_string()),
        has_password: None,
        password: None,
    };
    ws_a.send(Message::Text(serde_json::to_string(&create_a).unwrap().into()))
        .await
        .unwrap();
    let resp_a_raw = ws_a.next().await.unwrap().unwrap().into_text().unwrap();
    let resp_a: ServerMessage = serde_json::from_str(&resp_a_raw).unwrap();
    let room_code = match resp_a {
        ServerMessage::RoomCreated { code, .. } => code,
        other => panic!("Expected RoomCreated for peer A, got {other:?}"),
    };

    // Peer B joins room on WebSocket handle B
    let (mut ws_b, _) = connect_async(&ws_url).await.expect("Failed to connect peer B");
    let join_b = ClientMessage::JoinRoom {
        code: room_code.clone(),
        peer_id: Some("bob".to_string()),
        password: None,
    };
    ws_b.send(Message::Text(serde_json::to_string(&join_b).unwrap().into()))
        .await
        .unwrap();

    let resp_b_raw = ws_b.next().await.unwrap().unwrap().into_text().unwrap();
    let resp_b: ServerMessage = serde_json::from_str(&resp_b_raw).unwrap();
    assert!(matches!(resp_b, ServerMessage::JoinOk { .. }));

    // Peer B sends a second JOIN_ROOM on the same WebSocket handle without disconnecting
    let second_join = ClientMessage::JoinRoom {
        code: room_code.clone(),
        peer_id: Some("bob".to_string()),
        password: None,
    };
    ws_b.send(Message::Text(serde_json::to_string(&second_join).unwrap().into()))
        .await
        .unwrap();

    let resp_b2_raw = ws_b.next().await.unwrap().unwrap().into_text().unwrap();
    let resp_b2: ServerMessage = serde_json::from_str(&resp_b2_raw).unwrap();

    // Verify the second join is strictly rejected with ALREADY_IN_ROOM
    match resp_b2 {
        ServerMessage::Error { code, message } => {
            assert_eq!(code, "ALREADY_IN_ROOM");
            assert_eq!(message, "Socket is already registered in a room");
        }
        other => panic!("Expected Error(ALREADY_IN_ROOM) for duplicate join on same socket, got {other:?}"),
    }
}

#[tokio::test]
async fn test_connection_disconnect_cleans_up_room_registration_allows_rejoin() {
    let config = Config::default();
    let (addr, _state) = spawn_test_server(config).await;
    let ws_url = format!("ws://{addr}/ws");

    // Peer A creates room
    let (mut ws_a, _) = connect_async(&ws_url).await.expect("Failed to connect peer A");
    let create_a = ClientMessage::CreateRoom {
        peer_id: Some("alice".to_string()),
        has_password: None,
        password: None,
    };
    ws_a.send(Message::Text(serde_json::to_string(&create_a).unwrap().into()))
        .await
        .unwrap();
    let resp_a_raw = ws_a.next().await.unwrap().unwrap().into_text().unwrap();
    let resp_a: ServerMessage = serde_json::from_str(&resp_a_raw).unwrap();
    let room_code = match resp_a {
        ServerMessage::RoomCreated { code, .. } => code,
        other => panic!("Expected RoomCreated, got {other:?}"),
    };

    // Peer B connects, joins room, and then disconnects
    let (mut ws_b, _) = connect_async(&ws_url).await.expect("Failed to connect peer B");
    let join_b = ClientMessage::JoinRoom {
        code: room_code.clone(),
        peer_id: Some("bob".to_string()),
        password: None,
    };
    ws_b.send(Message::Text(serde_json::to_string(&join_b).unwrap().into()))
        .await
        .unwrap();
    let resp_b_raw = ws_b.next().await.unwrap().unwrap().into_text().unwrap();
    assert!(matches!(serde_json::from_str::<ServerMessage>(&resp_b_raw).unwrap(), ServerMessage::JoinOk { .. }));

    // Disconnect peer B
    drop(ws_b);

    // Alice observes PEER_LEFT
    let mut alice_saw_bob_left = false;
    while let Some(Ok(msg)) = ws_a.next().await {
        if let Ok(server_msg) = serde_json::from_str::<ServerMessage>(&msg.into_text().unwrap()) {
            if let ServerMessage::PeerLeft { peer_id, .. } = server_msg {
                if peer_id == "bob" {
                    alice_saw_bob_left = true;
                    break;
                }
            }
        }
    }
    assert!(alice_saw_bob_left, "Alice should observe PeerLeft when Bob disconnects");

    // A new connection from the same IP connects and rejoins the room as Bob
    let (mut ws_b2, _) = connect_async(&ws_url).await.expect("Failed to connect new peer B");
    let rejoin_b = ClientMessage::JoinRoom {
        code: room_code.clone(),
        peer_id: Some("bob".to_string()),
        password: None,
    };
    ws_b2.send(Message::Text(serde_json::to_string(&rejoin_b).unwrap().into()))
        .await
        .unwrap();

    let resp_b2_raw = ws_b2.next().await.unwrap().unwrap().into_text().unwrap();
    let resp_b2: ServerMessage = serde_json::from_str(&resp_b2_raw).unwrap();

    // Verify rejoin succeeds without any ALREADY_IN_ROOM or PEER_ALREADY_EXISTS error
    match resp_b2 {
        ServerMessage::JoinOk { status, peer_id, .. } => {
            assert_eq!(status, "OK");
            assert_eq!(peer_id, "bob");
        }
        ServerMessage::Error { code, message } => {
            panic!("Rejoin failed with [{code}]: {message}");
        }
        other => panic!("Expected JoinOk for rejoin, got {other:?}"),
    }
}

#[tokio::test]
async fn test_ws_owner_departure_transfers_ownership_and_empty_room_auto_destroyed() {
    let config = Config::default();
    let (addr, state) = spawn_test_server(config).await;
    let ws_url = format!("ws://{addr}/ws");

    // 1. Alice creates room
    let (mut ws_a, _) = connect_async(&ws_url).await.expect("Failed to connect peer A");
    let create_a = ClientMessage::CreateRoom {
        peer_id: Some("alice".to_string()),
        has_password: None,
        password: None,
    };
    ws_a.send(Message::Text(serde_json::to_string(&create_a).unwrap().into()))
        .await
        .unwrap();

    let resp_a_raw = ws_a.next().await.unwrap().unwrap().into_text().unwrap();
    let resp_a: ServerMessage = serde_json::from_str(&resp_a_raw).unwrap();
    let room_code = match resp_a {
        ServerMessage::RoomCreated { code, peer_id, .. } => {
            assert_eq!(peer_id, "alice");
            code
        }
        other => panic!("Expected RoomCreated, got {other:?}"),
    };

    // 2. Bob joins room and gets JoinOk with owner_peer_id: "alice"
    let (mut ws_b, _) = connect_async(&ws_url).await.expect("Failed to connect peer B");
    let join_b = ClientMessage::JoinRoom {
        code: room_code.clone(),
        peer_id: Some("bob".to_string()),
        password: None,
    };
    ws_b.send(Message::Text(serde_json::to_string(&join_b).unwrap().into()))
        .await
        .unwrap();

    let resp_b_raw = ws_b.next().await.unwrap().unwrap().into_text().unwrap();
    let resp_b: ServerMessage = serde_json::from_str(&resp_b_raw).unwrap();
    match resp_b {
        ServerMessage::JoinOk {
            status,
            code,
            peer_id,
            is_owner,
            owner_peer_id,
            ..
        } => {
            assert_eq!(status, "OK");
            assert_eq!(code, room_code);
            assert_eq!(peer_id, "bob");
            assert!(!is_owner);
            assert_eq!(owner_peer_id, Some("alice".to_string()));
        }
        other => panic!("Expected JoinOk for Bob, got {other:?}"),
    }

    // Drain Alice's PEER_JOINED for Bob
    let _ = ws_a.next().await.unwrap().unwrap();

    // 3. Charlie joins room
    let (mut ws_c, _) = connect_async(&ws_url).await.expect("Failed to connect peer C");
    let join_c = ClientMessage::JoinRoom {
        code: room_code.clone(),
        peer_id: Some("charlie".to_string()),
        password: None,
    };
    ws_c.send(Message::Text(serde_json::to_string(&join_c).unwrap().into()))
        .await
        .unwrap();

    let resp_c_raw = ws_c.next().await.unwrap().unwrap().into_text().unwrap();
    let resp_c: ServerMessage = serde_json::from_str(&resp_c_raw).unwrap();
    assert!(matches!(resp_c, ServerMessage::JoinOk { .. }));

    // Drain PEER_JOINED notifications from Alice and Bob
    let _ = ws_a.next().await.unwrap().unwrap();
    let _ = ws_b.next().await.unwrap().unwrap();

    // 4. Alice (owner) disconnects
    drop(ws_a);

    // 5. Bob receives PeerLeft(alice) and RoomOwnerChanged(bob)
    let mut bob_saw_alice_left = false;
    let mut bob_saw_owner_changed_to_bob = false;

    for _ in 0..2 {
        let msg_raw = ws_b.next().await.unwrap().unwrap().into_text().unwrap();
        let msg: ServerMessage = serde_json::from_str(&msg_raw).unwrap();
        match msg {
            ServerMessage::PeerLeft { peer_id, .. } => {
                if peer_id == "alice" {
                    bob_saw_alice_left = true;
                }
            }
            ServerMessage::RoomOwnerChanged { owner_peer_id, .. } => {
                if owner_peer_id == "bob" {
                    bob_saw_owner_changed_to_bob = true;
                }
            }
            other => panic!("Unexpected message for Bob: {other:?}"),
        }
    }
    assert!(bob_saw_alice_left);
    assert!(bob_saw_owner_changed_to_bob);

    // 6. Charlie also receives PeerLeft(alice) and RoomOwnerChanged(bob)
    let mut charlie_saw_alice_left = false;
    let mut charlie_saw_owner_changed_to_bob = false;

    for _ in 0..2 {
        let msg_raw = ws_c.next().await.unwrap().unwrap().into_text().unwrap();
        let msg: ServerMessage = serde_json::from_str(&msg_raw).unwrap();
        match msg {
            ServerMessage::PeerLeft { peer_id, .. } => {
                if peer_id == "alice" {
                    charlie_saw_alice_left = true;
                }
            }
            ServerMessage::RoomOwnerChanged { owner_peer_id, .. } => {
                if owner_peer_id == "bob" {
                    charlie_saw_owner_changed_to_bob = true;
                }
            }
            other => panic!("Unexpected message for Charlie: {other:?}"),
        }
    }
    assert!(charlie_saw_alice_left);
    assert!(charlie_saw_owner_changed_to_bob);

    // 7. Charlie attempts to Rekey -> rejected UNAUTHORIZED
    let charlie_rekey = ClientMessage::Rekey {
        password: "charlie-pass".to_string(),
        salt: None,
    };
    ws_c.send(Message::Text(serde_json::to_string(&charlie_rekey).unwrap().into()))
        .await
        .unwrap();
    let charlie_err_raw = ws_c.next().await.unwrap().unwrap().into_text().unwrap();
    let charlie_err: ServerMessage = serde_json::from_str(&charlie_err_raw).unwrap();
    match charlie_err {
        ServerMessage::Error { code, .. } => {
            assert_eq!(code, "UNAUTHORIZED");
        }
        other => panic!("Expected UNAUTHORIZED for Charlie rekey, got {other:?}"),
    }

    // 8. Bob (new owner) initiates Rekey -> succeeds and broadcasts Rekey
    let bob_rekey = ClientMessage::Rekey {
        password: "bob-pass-123".to_string(),
        salt: None,
    };
    ws_b.send(Message::Text(serde_json::to_string(&bob_rekey).unwrap().into()))
        .await
        .unwrap();

    let bob_rekey_resp_raw = ws_b.next().await.unwrap().unwrap().into_text().unwrap();
    let bob_rekey_resp: ServerMessage = serde_json::from_str(&bob_rekey_resp_raw).unwrap();
    assert!(matches!(bob_rekey_resp, ServerMessage::Rekey { .. }));

    // Charlie also receives Rekey broadcast
    let charlie_rekey_notif_raw = ws_c.next().await.unwrap().unwrap().into_text().unwrap();
    let charlie_rekey_notif: ServerMessage = serde_json::from_str(&charlie_rekey_notif_raw).unwrap();
    assert!(matches!(charlie_rekey_notif, ServerMessage::Rekey { .. }));

    // 9. Charlie disconnects
    drop(ws_c);
    let bob_saw_charlie_left_raw = ws_b.next().await.unwrap().unwrap().into_text().unwrap();
    assert!(matches!(
        serde_json::from_str::<ServerMessage>(&bob_saw_charlie_left_raw).unwrap(),
        ServerMessage::PeerLeft { peer_id, .. } if peer_id == "charlie"
    ));

    // Room still exists with Bob
    assert_eq!(state.room_manager.room_count(), 1);

    // 10. Bob disconnects -> room becomes empty
    drop(ws_b);

    // Give asynchronous disconnect a moment to process
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    // Room is automatically destroyed from memory
    assert_eq!(state.room_manager.room_count(), 0);

    // 11. Attempting to join the emptied room fails with ROOM_NOT_FOUND
    let (mut ws_d, _) = connect_async(&ws_url).await.expect("Failed to connect peer D");
    let join_d = ClientMessage::JoinRoom {
        code: room_code.clone(),
        peer_id: Some("david".to_string()),
        password: None,
    };
    ws_d.send(Message::Text(serde_json::to_string(&join_d).unwrap().into()))
        .await
        .unwrap();

    let resp_d_raw = ws_d.next().await.unwrap().unwrap().into_text().unwrap();
    let resp_d: ServerMessage = serde_json::from_str(&resp_d_raw).unwrap();
    match resp_d {
        ServerMessage::Error { code, .. } => {
            assert_eq!(code, "ROOM_NOT_FOUND");
        }
        other => panic!("Expected ROOM_NOT_FOUND, got {other:?}"),
    }
}

