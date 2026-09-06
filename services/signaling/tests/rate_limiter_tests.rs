use axum::{
    body::Body,
    http::{Request, StatusCode},
};
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
use tower::ServiceExt;

async fn spawn_limiter_test_server(config: Config) -> (SocketAddr, AppState) {
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
async fn test_pepper_rotation_forgets_rate_limits_for_same_ip() {
    let config = Config {
        max_active_rooms_per_ip: 1,
        ..Default::default()
    };
    let app_state = AppState::new(config);
    let app = create_router(app_state.clone());

    // 1. Send 1st creation request from IP (198.51.100.22)
    let req1 = Request::builder()
        .method("POST")
        .uri("/api/rooms")
        .header("Content-Type", "application/json")
        .header("x-forwarded-for", "198.51.100.22")
        .body(Body::from(r#"{"owner_id":"alice"}"#))
        .unwrap();

    let resp1 = app.clone().oneshot(req1).await.unwrap();
    assert_eq!(resp1.status(), StatusCode::CREATED);

    // 2. 2nd attempt from same IP while 1st room is active is rejected
    let req2 = Request::builder()
        .method("POST")
        .uri("/api/rooms")
        .header("Content-Type", "application/json")
        .header("x-forwarded-for", "198.51.100.22")
        .body(Body::from(r#"{"owner_id":"alice"}"#))
        .unwrap();

    let resp2 = app.clone().oneshot(req2).await.unwrap();
    assert_eq!(resp2.status(), StatusCode::TOO_MANY_REQUESTS);

    // 3. Rotate daily pepper in RAM (simulating 24h rotation)
    app_state.limiter.pepper.rotate();

    // 4. Client from exact same IP now derives a fresh rateKey with clean quota
    let req3 = Request::builder()
        .method("POST")
        .uri("/api/rooms")
        .header("Content-Type", "application/json")
        .header("x-forwarded-for", "198.51.100.22")
        .body(Body::from(r#"{"owner_id":"alice"}"#))
        .unwrap();

    let resp3 = app.clone().oneshot(req3).await.unwrap();
    assert_eq!(resp3.status(), StatusCode::CREATED);
}

#[tokio::test]
async fn test_room_creation_rate_limiting_ws() {
    let config = Config {
        max_active_rooms_per_ip: 1,
        ..Default::default()
    };
    let (addr, state) = spawn_limiter_test_server(config).await;
    let ws_url = format!("ws://{addr}/ws");

    let (mut ws, _) = connect_async(&ws_url).await.unwrap();

    // 1st room creation succeeds
    let create1 = ClientMessage::CreateRoom {
        peer_id: Some("owner1".to_string()),
        has_password: None,
        password: None,
    };
    ws.send(Message::Text(serde_json::to_string(&create1).unwrap().into()))
        .await
        .unwrap();

    let resp1: ServerMessage = serde_json::from_str(&ws.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
    let room_code = match &resp1 {
        ServerMessage::RoomCreated { code, .. } => code.clone(),
        other => panic!("Expected RoomCreated, got {other:?}"),
    };

    // Second connection from same IP attempting room creation is rejected
    let (mut ws2, _) = connect_async(&ws_url).await.unwrap();
    let create2 = ClientMessage::CreateRoom {
        peer_id: Some("owner2".to_string()),
        has_password: None,
        password: None,
    };
    ws2.send(Message::Text(serde_json::to_string(&create2).unwrap().into()))
        .await
        .unwrap();

    let resp2: ServerMessage = serde_json::from_str(&ws2.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
    match resp2 {
        ServerMessage::Error { code, message } => {
            assert_eq!(code, "ACTIVE_ROOM_LIMIT_EXCEEDED");
            assert!(message.contains("You already have an active room"));
        }
        other => panic!("Expected Error with ACTIVE_ROOM_LIMIT_EXCEEDED, got {other:?}"),
    }

    // Joining existing room from same IP is NOT blocked
    let join_msg = ClientMessage::JoinRoom {
        code: room_code.clone(),
        peer_id: Some("joiner_same_ip".to_string()),
        password: None,
    };
    ws2.send(Message::Text(serde_json::to_string(&join_msg).unwrap().into()))
        .await
        .unwrap();
    let join_resp: ServerMessage = serde_json::from_str(&ws2.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
    assert!(matches!(join_resp, ServerMessage::JoinOk { .. }));

    // Now close room 1
    let parsed_code = fastchat_signaling::room::RoomCode::new(&room_code).unwrap();
    state.room_manager.close_room(&parsed_code, "owner1").unwrap();

    // After closing first room, creating a new room from same IP immediately succeeds
    let (mut ws3, _) = connect_async(&ws_url).await.unwrap();
    let create3 = ClientMessage::CreateRoom {
        peer_id: Some("owner3".to_string()),
        has_password: None,
        password: None,
    };
    ws3.send(Message::Text(serde_json::to_string(&create3).unwrap().into()))
        .await
        .unwrap();
    let resp3: ServerMessage = serde_json::from_str(&ws3.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
    assert!(matches!(resp3, ServerMessage::RoomCreated { .. }));
}

#[tokio::test]
async fn test_ws_connection_rate_limiting_and_backoff() {
    let config = Config {
        rate_limit_ws_connections_per_min: 2,
        rate_limit_ws_base_backoff_secs: 2,
        ..Default::default()
    };
    let (addr, _state) = spawn_limiter_test_server(config).await;
    let ws_url = format!("ws://{addr}/ws");

    // Connection 1: succeeds
    let res1 = connect_async(&ws_url).await;
    assert!(res1.is_ok(), "1st connection should succeed");

    // Connection 2: succeeds
    let res2 = connect_async(&ws_url).await;
    assert!(res2.is_ok(), "2nd connection should succeed");

    // Connection 3: rate limit exceeded -> server rejects with HTTP 429
    let res3 = connect_async(&ws_url).await;
    assert!(res3.is_err(), "3rd connection should be rejected with 429");
    match res3.unwrap_err() {
        tokio_tungstenite::tungstenite::Error::Http(resp) => {
            assert_eq!(resp.status(), StatusCode::TOO_MANY_REQUESTS);
            assert!(resp.headers().contains_key("retry-after"));
        }
        other => panic!("Expected Http 429 response, got {other:?}"),
    }
}

#[tokio::test]
async fn test_join_room_lockout_after_consecutive_failures() {
    let config = Config {
        rate_limit_failed_joins_threshold: 3,
        rate_limit_failed_joins_window_secs: 300,
        rate_limit_join_lockout_secs: 60,
        ..Default::default()
    };
    let (addr, _state) = spawn_limiter_test_server(config).await;
    let ws_url = format!("ws://{addr}/ws");
    let (mut ws, _) = connect_async(&ws_url).await.unwrap();

    // 3 failed join attempts with non-existent rooms
    for _ in 0..3 {
        let bad_join = ClientMessage::JoinRoom {
            code: "9999-9999-9999".to_string(),
            peer_id: Some("attacker".to_string()),
            password: None,
        };
        ws.send(Message::Text(serde_json::to_string(&bad_join).unwrap().into()))
            .await
            .unwrap();

        let resp: ServerMessage = serde_json::from_str(&ws.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
        assert!(matches!(resp, ServerMessage::Error { ref code, .. } if code == "ROOM_NOT_FOUND"));
    }

    // 4th join attempt must be locked out
    let join_attempt = ClientMessage::JoinRoom {
        code: "9999-9999-9999".to_string(),
        peer_id: Some("attacker".to_string()),
        password: None,
    };
    ws.send(Message::Text(serde_json::to_string(&join_attempt).unwrap().into()))
        .await
        .unwrap();

    let resp: ServerMessage = serde_json::from_str(&ws.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
    match resp {
        ServerMessage::Error { code, message } => {
            assert_eq!(code, "JOIN_LOCKED_OUT");
            assert!(message.contains("Temporary lockout in effect"));
        }
        other => panic!("Expected JOIN_LOCKED_OUT error, got {other:?}"),
    }
}

#[tokio::test]
async fn test_signaling_flood_control_token_bucket() {
    let config = Config {
        flood_bucket_capacity: 2,
        flood_refill_per_sec: 1,
        ..Default::default()
    };
    let (addr, _state) = spawn_limiter_test_server(config).await;
    let ws_url = format!("ws://{addr}/ws");
    let (mut ws, _) = connect_async(&ws_url).await.unwrap();

    // 1. Consume tokens via PING
    ws.send(Message::Text(serde_json::to_string(&ClientMessage::Ping).unwrap().into()))
        .await
        .unwrap();
    let _ = ws.next().await.unwrap().unwrap();

    ws.send(Message::Text(serde_json::to_string(&ClientMessage::Ping).unwrap().into()))
        .await
        .unwrap();
    let _ = ws.next().await.unwrap().unwrap();

    // 2. 3rd rapid message triggers flood control
    ws.send(Message::Text(serde_json::to_string(&ClientMessage::Ping).unwrap().into()))
        .await
        .unwrap();

    let flood_resp: ServerMessage = serde_json::from_str(&ws.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
    match flood_resp {
        ServerMessage::Error { code, message } => {
            assert_eq!(code, "FLOOD_CONTROL_EXCEEDED");
            assert!(message.contains("Slow down"));
        }
        other => panic!("Expected FLOOD_CONTROL_EXCEEDED error, got {other:?}"),
    }
}

#[tokio::test]
async fn test_global_room_and_connection_ceiling() {
    let config = Config {
        max_total_rooms: 1,
        max_total_connections: 1,
        ..Default::default()
    };
    let (addr, state) = spawn_limiter_test_server(config).await;

    // 1. Connection 1 occupies the connection ceiling
    let ws_url = format!("ws://{addr}/ws");
    let (mut ws1, _) = connect_async(&ws_url).await.unwrap();

    // Create room 1 (occupies room ceiling)
    let create_msg = ClientMessage::CreateRoom {
        peer_id: Some("owner".to_string()),
        has_password: None,
        password: None,
    };
    ws1.send(Message::Text(serde_json::to_string(&create_msg).unwrap().into()))
        .await
        .unwrap();
    let resp1: ServerMessage = serde_json::from_str(&ws1.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
    assert!(matches!(resp1, ServerMessage::RoomCreated { .. }));

    // 2. Attempting to connect a second WebSocket connection hits connection ceiling (HTTP 503)
    let connect_res2 = connect_async(&ws_url).await;
    assert!(connect_res2.is_err(), "2nd connection should be rejected when capacity reached");

    // 3. Attempting to create a second room via HTTP hits room ceiling (HTTP 503)
    let app = create_router(state);
    let req = Request::builder()
        .method("POST")
        .uri("/api/rooms")
        .header("Content-Type", "application/json")
        .header("x-forwarded-for", "10.10.10.10")
        .body(Body::from(r#"{"owner_id":"bob"}"#))
        .unwrap();

    let http_resp = app.oneshot(req).await.unwrap();
    assert_eq!(http_resp.status(), StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn test_turn_bandwidth_limiter_and_usage_reports() {
    use axum::{routing::post, Json, Router};
    use fastchat_signaling::turn::{CloudflareTurnClient, TurnService};
    use serde_json::json;
    use std::sync::Arc;

    // 1. Mock upstream Cloudflare TURN server
    let mock_app = Router::new().route(
        "/v1/turn/keys/cf-key-bandwidth/credentials/generate-ice-servers",
        post(|| async {
            Json(json!({
                "iceServers": [
                    {
                        "urls": ["stun:stun.cloudflare.com:3478"]
                    },
                    {
                        "urls": ["turn:turn.cloudflare.com:3478?transport=udp"],
                        "username": "ephemeral_user",
                        "credential": "ephemeral_pass"
                    }
                ]
            }))
        }),
    );

    let mock_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mock_port = mock_listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = axum::serve(mock_listener, mock_app).await;
    });

    // 2. Set up signaling app with a small 1,000 bytes hourly TURN limit
    let config = Config {
        cloudflare_turn_api_token: Some("cf-token-secret".to_string()),
        cloudflare_turn_key_id: Some("cf-key-bandwidth".to_string()),
        turn_api_base_url: format!("http://127.0.0.1:{mock_port}"),
        rate_limit_turn_max_hourly_bytes_per_ip: 1000,
        rate_limit_ws_connections_per_min: 100,
        ..Default::default()
    };

    let client = CloudflareTurnClient::new(&config);
    let governor = Arc::new(fastchat_signaling::turn::TurnCostGovernor::new(&config));
    let turn = Arc::new(TurnService::with_custom(client, governor));

    let app_state = AppState::new(config).with_turn_service(turn);
    let app = create_router(app_state.clone());

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let ws_url = format!("ws://{addr}/ws");
    let (mut ws, _) = connect_async(&ws_url).await.unwrap();

    // 3. Initial REQUEST_ICE_SERVERS within budget -> returns STUN + TURN
    let req_ice = ClientMessage::RequestIceServers;
    ws.send(Message::Text(serde_json::to_string(&req_ice).unwrap().into())).await.unwrap();

    let resp_raw = ws.next().await.unwrap().unwrap().into_text().unwrap();
    let resp: ServerMessage = serde_json::from_str(&resp_raw).unwrap();
    match resp {
        ServerMessage::IceServers {
            ice_servers,
            turn_issuance_limited,
            ..
        } => {
            assert!(!turn_issuance_limited);
            assert!(ice_servers.iter().any(|s| s.username.is_some()));
        }
        other => panic!("Expected IceServers message, got {other:?}"),
    }

    // 4. Client reports 600 bytes relayed usage (within 1,000 budget)
    let report1 = ClientMessage::TurnUsageReport { bytes: 600 };
    ws.send(Message::Text(serde_json::to_string(&report1).unwrap().into())).await.unwrap();

    // Short yield for message processing
    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

    // 5. Client reports another 500 bytes relayed usage -> total 1,100 bytes (exceeds 1,000 budget!)
    let report2 = ClientMessage::TurnUsageReport { bytes: 500 };
    ws.send(Message::Text(serde_json::to_string(&report2).unwrap().into())).await.unwrap();

    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

    // 6. Subsequent REQUEST_ICE_SERVERS should now be denied TURN credentials and receive STUN only
    ws.send(Message::Text(serde_json::to_string(&req_ice).unwrap().into())).await.unwrap();

    let resp2_raw = ws.next().await.unwrap().unwrap().into_text().unwrap();
    let resp2: ServerMessage = serde_json::from_str(&resp2_raw).unwrap();
    match resp2 {
        ServerMessage::IceServers {
            ice_servers,
            turn_issuance_limited,
            turn_issuance_limited_camel,
            ..
        } => {
            assert!(turn_issuance_limited);
            assert!(turn_issuance_limited_camel);
            assert_eq!(ice_servers.len(), 1);
            assert_eq!(ice_servers[0].urls[0], "stun:stun.cloudflare.com:3478");
        }
        other => panic!("Expected IceServers message with turn_issuance_limited=true, got {other:?}"),
    }

    // 7. Active session is NOT terminated; socket remains alive and handles messages (e.g. Ping)
    ws.send(Message::Text(serde_json::to_string(&ClientMessage::Ping).unwrap().into())).await.unwrap();
    let pong_raw = ws.next().await.unwrap().unwrap().into_text().unwrap();
    let pong: ServerMessage = serde_json::from_str(&pong_raw).unwrap();
    assert_eq!(pong, ServerMessage::Pong);
}

#[tokio::test]
async fn test_join_room_escalating_lockout_and_success_counter_reset() {
    let config = Config::default(); // Uses default threshold = 4
    let (addr, state) = spawn_limiter_test_server(config).await;
    let ws_url = format!("ws://{addr}/ws");

    // 1. Create a legitimate room to join
    let legitimate_code = state
        .room_manager
        .create_room(Some("owner_alice".to_string()), None, fastchat_signaling::room::PasswordStatus::none())
        .unwrap();

    let (mut ws, _) = connect_async(&ws_url).await.unwrap();

    // 2. Send 2 failed join attempts (non-existent code)
    for _ in 0..2 {
        let bad_join = ClientMessage::JoinRoom {
            code: "0000-0000-0000".to_string(),
            peer_id: Some("attacker".to_string()),
            password: None,
        };
        ws.send(Message::Text(serde_json::to_string(&bad_join).unwrap().into()))
            .await
            .unwrap();
        let resp: ServerMessage = serde_json::from_str(&ws.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
        assert!(matches!(resp, ServerMessage::Error { ref code, .. } if code == "ROOM_NOT_FOUND"));
    }

    // 3. Perform a successful join -> resets the consecutive failure counter
    let good_join = ClientMessage::JoinRoom {
        code: legitimate_code.to_string(),
        peer_id: Some("joiner_bob".to_string()),
        password: None,
    };
    ws.send(Message::Text(serde_json::to_string(&good_join).unwrap().into()))
        .await
        .unwrap();
    let join_ok: ServerMessage = serde_json::from_str(&ws.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
    assert!(matches!(join_ok, ServerMessage::JoinOk { .. }));

    // 4. Drop socket connection to disconnect peer from room
    drop(ws);
    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

    // Connect second WebSocket from exact same IP
    let (mut ws2, _) = connect_async(&ws_url).await.unwrap();

    // 5. Send 2 more failed attempts (total 4 failed across session, but failure counter was reset)
    for _ in 0..2 {
        let bad_join = ClientMessage::JoinRoom {
            code: "0000-0000-0000".to_string(),
            peer_id: Some("attacker".to_string()),
            password: None,
        };
        ws2.send(Message::Text(serde_json::to_string(&bad_join).unwrap().into()))
            .await
            .unwrap();
        let resp: ServerMessage = serde_json::from_str(&ws2.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
        assert!(matches!(resp, ServerMessage::Error { ref code, .. } if code == "ROOM_NOT_FOUND"));
    }

    // Client is NOT locked out yet (current window has only 2 failures)
    // 6. Send 2 more failures to reach threshold (4 in current window)
    for _ in 0..2 {
        let bad_join = ClientMessage::JoinRoom {
            code: "0000-0000-0000".to_string(),
            peer_id: Some("attacker".to_string()),
            password: None,
        };
        ws2.send(Message::Text(serde_json::to_string(&bad_join).unwrap().into()))
            .await
            .unwrap();
        let resp: ServerMessage = serde_json::from_str(&ws2.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
        assert!(matches!(resp, ServerMessage::Error { ref code, .. } if code == "ROOM_NOT_FOUND"));
    }

    // 7. 5th attempt in window must be rejected immediately with JOIN_LOCKED_OUT
    let locked_attempt = ClientMessage::JoinRoom {
        code: legitimate_code.to_string(),
        peer_id: Some("attacker".to_string()),
        password: None,
    };
    ws2.send(Message::Text(serde_json::to_string(&locked_attempt).unwrap().into()))
        .await
        .unwrap();

    let locked_resp: ServerMessage = serde_json::from_str(&ws2.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
    match locked_resp {
        ServerMessage::Error { code, message } => {
            assert_eq!(code, "JOIN_LOCKED_OUT");
            assert!(message.contains("Temporary lockout in effect"));
            assert!(message.contains("300 seconds") || message.contains("299 seconds"));
        }
        other => panic!("Expected JOIN_LOCKED_OUT, got {other:?}"),
    }
}

#[tokio::test]
async fn test_ownership_transfer_updates_active_room_limiter_for_both_parties() {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    let config = Config {
        max_active_rooms_per_ip: 1,
        ..Default::default()
    };
    let (addr, state) = spawn_limiter_test_server(config).await;
    let ws_url = format!("ws://{addr}/ws");

    let ip_a = "198.51.100.10";
    let ip_b = "198.51.100.20";

    // 1. Person A connects from IP A and creates room
    let mut req_a = ws_url.clone().into_client_request().unwrap();
    req_a.headers_mut().insert("x-forwarded-for", ip_a.parse().unwrap());
    let (mut ws_a, _) = connect_async(req_a).await.unwrap();

    let create_a = ClientMessage::CreateRoom {
        peer_id: Some("alice".to_string()),
        has_password: None,
        password: None,
    };
    ws_a.send(Message::Text(serde_json::to_string(&create_a).unwrap().into()))
        .await
        .unwrap();

    let resp_a: ServerMessage = serde_json::from_str(&ws_a.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
    let room_code = match resp_a {
        ServerMessage::RoomCreated { code, peer_id, .. } => {
            assert_eq!(peer_id, "alice");
            code
        }
        other => panic!("Expected RoomCreated, got {other:?}"),
    };

    // Verify Person A cannot create a second room while owning the first room
    let mut req_a_second = ws_url.clone().into_client_request().unwrap();
    req_a_second.headers_mut().insert("x-forwarded-for", ip_a.parse().unwrap());
    let (mut ws_a_second, _) = connect_async(req_a_second).await.unwrap();

    let create_a_second = ClientMessage::CreateRoom {
        peer_id: Some("alice2".to_string()),
        has_password: None,
        password: None,
    };
    ws_a_second.send(Message::Text(serde_json::to_string(&create_a_second).unwrap().into()))
        .await
        .unwrap();
    let resp_a_second: ServerMessage = serde_json::from_str(&ws_a_second.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
    assert!(matches!(resp_a_second, ServerMessage::Error { ref code, .. } if code == "ACTIVE_ROOM_LIMIT_EXCEEDED"));
    drop(ws_a_second);

    // 2. Person B connects from IP B and joins the room
    let mut req_b = ws_url.clone().into_client_request().unwrap();
    req_b.headers_mut().insert("x-forwarded-for", ip_b.parse().unwrap());
    let (mut ws_b, _) = connect_async(req_b).await.unwrap();

    let join_b = ClientMessage::JoinRoom {
        code: room_code.clone(),
        peer_id: Some("bob".to_string()),
        password: None,
    };
    ws_b.send(Message::Text(serde_json::to_string(&join_b).unwrap().into()))
        .await
        .unwrap();

    let resp_b: ServerMessage = serde_json::from_str(&ws_b.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
    assert!(matches!(resp_b, ServerMessage::JoinOk { ref peer_id, is_owner: false, .. } if peer_id == "bob"));

    // Drain Alice's PEER_JOINED notification
    let _ = ws_a.next().await.unwrap().unwrap();

    // 3. Person A disconnects (leaves room) -> ownership transfers to Person B
    drop(ws_a);

    // Person B receives PeerLeft(alice) and RoomOwnerChanged(bob)
    let mut bob_saw_owner_transferred = false;
    for _ in 0..2 {
        let msg: ServerMessage = serde_json::from_str(&ws_b.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
        if let ServerMessage::RoomOwnerChanged { owner_peer_id, .. } = msg {
            if owner_peer_id == "bob" {
                bob_saw_owner_transferred = true;
            }
        }
    }
    assert!(bob_saw_owner_transferred);

    // Room still exists with Bob as the sole occupant and owner
    assert_eq!(state.room_manager.room_count(), 1);

    // 4. Person A (original creator, now departed) connects again from IP A -> can immediately create a new room!
    let mut req_a_new = ws_url.clone().into_client_request().unwrap();
    req_a_new.headers_mut().insert("x-forwarded-for", ip_a.parse().unwrap());
    let (mut ws_a_new, _) = connect_async(req_a_new).await.unwrap();

    let create_a_new = ClientMessage::CreateRoom {
        peer_id: Some("alice_new".to_string()),
        has_password: None,
        password: None,
    };
    ws_a_new.send(Message::Text(serde_json::to_string(&create_a_new).unwrap().into()))
        .await
        .unwrap();

    let resp_a_new: ServerMessage = serde_json::from_str(&ws_a_new.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
    assert!(
        matches!(resp_a_new, ServerMessage::RoomCreated { .. }),
        "Person A must be able to create a new room immediately after ownership transfer, but got: {resp_a_new:?}"
    );

    // 5. Person B (now owner of active transferred room) attempts to create a second room from IP B -> BLOCKED by limiter
    let mut req_b_second = ws_url.clone().into_client_request().unwrap();
    req_b_second.headers_mut().insert("x-forwarded-for", ip_b.parse().unwrap());
    let (mut ws_b_second, _) = connect_async(req_b_second).await.unwrap();

    let create_b_second = ClientMessage::CreateRoom {
        peer_id: Some("bob_second".to_string()),
        has_password: None,
        password: None,
    };
    ws_b_second.send(Message::Text(serde_json::to_string(&create_b_second).unwrap().into()))
        .await
        .unwrap();

    let resp_b_second: ServerMessage = serde_json::from_str(&ws_b_second.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
    match resp_b_second {
        ServerMessage::Error { code, message } => {
            assert_eq!(code, "ACTIVE_ROOM_LIMIT_EXCEEDED");
            assert!(message.contains("You already have an active room"));
        }
        other => panic!("Expected ACTIVE_ROOM_LIMIT_EXCEEDED for Person B, got {other:?}"),
    }
    drop(ws_b_second);

    // 6. Person B leaves/closes their room -> room is destroyed -> Person B can now create a room
    drop(ws_b);

    // Short wait for socket disconnect cleanup
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    let mut req_b_new = ws_url.clone().into_client_request().unwrap();
    req_b_new.headers_mut().insert("x-forwarded-for", ip_b.parse().unwrap());
    let (mut ws_b_new, _) = connect_async(req_b_new).await.unwrap();

    let create_b_new = ClientMessage::CreateRoom {
        peer_id: Some("bob_new".to_string()),
        has_password: None,
        password: None,
    };
    ws_b_new.send(Message::Text(serde_json::to_string(&create_b_new).unwrap().into()))
        .await
        .unwrap();

    let resp_b_new: ServerMessage = serde_json::from_str(&ws_b_new.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
    assert!(
        matches!(resp_b_new, ServerMessage::RoomCreated { .. }),
        "Person B must be able to create a room once the transferred room is closed, but got: {resp_b_new:?}"
    );
}

