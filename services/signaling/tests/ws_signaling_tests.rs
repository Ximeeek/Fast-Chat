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
