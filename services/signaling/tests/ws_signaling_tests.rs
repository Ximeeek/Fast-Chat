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
