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
        rate_limit_room_creations_per_hour: 2,
        ..Default::default()
    };
    let app_state = AppState::new(config);
    let app = create_router(app_state.clone());

    // 1. Send 2 creation requests from same IP (198.51.100.22)
    for _ in 0..2 {
        let req = Request::builder()
            .method("POST")
            .uri("/api/rooms")
            .header("Content-Type", "application/json")
            .header("x-forwarded-for", "198.51.100.22")
            .body(Body::from(r#"{"owner_id":"alice"}"#))
            .unwrap();

        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
    }

    // 2. 3rd attempt from same IP is rate limited
    let req3 = Request::builder()
        .method("POST")
        .uri("/api/rooms")
        .header("Content-Type", "application/json")
        .header("x-forwarded-for", "198.51.100.22")
        .body(Body::from(r#"{"owner_id":"alice"}"#))
        .unwrap();

    let resp3 = app.clone().oneshot(req3).await.unwrap();
    assert_eq!(resp3.status(), StatusCode::TOO_MANY_REQUESTS);

    // 3. Rotate daily pepper in RAM (simulating 24h rotation)
    app_state.limiter.pepper.rotate();

    // 4. Client from exact same IP now derives a fresh rateKey with clean quota
    let req4 = Request::builder()
        .method("POST")
        .uri("/api/rooms")
        .header("Content-Type", "application/json")
        .header("x-forwarded-for", "198.51.100.22")
        .body(Body::from(r#"{"owner_id":"alice"}"#))
        .unwrap();

    let resp4 = app.clone().oneshot(req4).await.unwrap();
    assert_eq!(resp4.status(), StatusCode::CREATED);
}

#[tokio::test]
async fn test_room_creation_rate_limiting_ws() {
    let config = Config {
        rate_limit_room_creations_per_hour: 1,
        ..Default::default()
    };
    let (addr, _state) = spawn_limiter_test_server(config).await;
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
    assert!(matches!(resp1, ServerMessage::RoomCreated { .. }));

    // Second connection from same IP attempting room creation
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
            assert_eq!(code, "RATE_LIMIT_EXCEEDED");
            assert!(message.contains("Room creation limit reached"));
        }
        other => panic!("Expected Error with RATE_LIMIT_EXCEEDED, got {other:?}"),
    }
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
