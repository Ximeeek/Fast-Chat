use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use fastchat_signaling::{
    config::Config, create_router, state::AppState, CreateRoomResponse, HealthResponse,
};
use http_body_util::BodyExt;
use tower::ServiceExt;

#[tokio::test]
async fn test_health_check_endpoint() {
    let config = Config {
        max_participants_per_room: 6,
        ..Default::default()
    };
    let app_state = AppState::new(config);
    let app = create_router(app_state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let body = response.into_body().collect().await.unwrap().to_bytes();
    let health: HealthResponse = serde_json::from_slice(&body).unwrap();

    assert_eq!(health.status, "ok");
    assert_eq!(health.service, "fastchat-signaling");
    assert_eq!(health.active_rooms, 0);
    assert_eq!(health.max_participants_per_room, 6);
}

#[tokio::test]
async fn test_room_creation_and_retrieval_api() {
    let config = Config::default();
    let app_state = AppState::new(config);
    let app = create_router(app_state);

    // 1. Create room via POST /api/rooms
    let create_req = Request::builder()
        .method("POST")
        .uri("/api/rooms")
        .header("Content-Type", "application/json")
        .body(Body::from(r#"{"owner_id":"alice","has_password":false}"#))
        .unwrap();

    let response = app.clone().oneshot(create_req).await.unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);

    let body = response.into_body().collect().await.unwrap().to_bytes();
    let created: CreateRoomResponse = serde_json::from_slice(&body).unwrap();
    assert_eq!(created.code.len(), 14);

    // 2. Fetch room via GET /api/rooms/{code}
    let get_req = Request::builder()
        .uri(format!("/api/rooms/{}", created.code))
        .body(Body::empty())
        .unwrap();

    let response = app.oneshot(get_req).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn test_get_ice_servers_endpoint_default_stun_when_unconfigured() {
    let config = Config::default();
    let app_state = AppState::new(config);
    let app = create_router(app_state);

    let req = Request::builder()
        .uri("/api/ice-servers")
        .body(Body::empty())
        .unwrap();

    let response = app.oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let body = response.into_body().collect().await.unwrap().to_bytes();
    let res: fastchat_signaling::turn::IceServersResponse = serde_json::from_slice(&body).unwrap();

    assert!(!res.quota_exhausted);
    assert_eq!(res.ice_servers.len(), 1);
    assert_eq!(
        res.ice_servers[0].urls,
        vec!["stun:stun.cloudflare.com:3478".to_string()]
    );
    assert!(res.ice_servers[0].username.is_none());
}

#[tokio::test]
async fn test_get_ice_servers_endpoint_quota_exhausted_flag() {
    let config = Config::default();
    let app_state = AppState::new(config);

    // Force quota exhaustion in RAM
    app_state
        .turn
        .governor
        .set_usage(app_state.config.turn_max_monthly_bytes + 1000);

    let app = create_router(app_state);

    let req = Request::builder()
        .uri("/api/ice-servers")
        .body(Body::empty())
        .unwrap();

    let response = app.oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let body = response.into_body().collect().await.unwrap().to_bytes();
    let res: fastchat_signaling::turn::IceServersResponse = serde_json::from_slice(&body).unwrap();

    assert!(res.quota_exhausted);
    assert_eq!(res.ice_servers.len(), 1);
    assert_eq!(
        res.ice_servers[0].urls[0],
        "stun:stun.cloudflare.com:3478"
    );
}

#[tokio::test]
async fn test_get_ice_servers_rate_limiting() {
    let config = Config {
        rate_limit_ws_connections_per_min: 2,
        rate_limit_ws_base_backoff_secs: 5,
        ..Default::default()
    };
    let app_state = AppState::new(config);
    let app = create_router(app_state);

    for _ in 0..2 {
        let req = Request::builder()
            .uri("/api/ice-servers")
            .header("X-Forwarded-For", "203.0.113.50")
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    // 3rd attempt from same IP triggers 429 Too Many Requests
    let req = Request::builder()
        .uri("/api/ice-servers")
        .header("X-Forwarded-For", "203.0.113.50")
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn test_get_ice_servers_with_mock_cloudflare_and_governor() {
    use axum::{routing::post, Json, Router};
    use fastchat_signaling::turn::{CloudflareTurnClient, TurnService};
    use serde_json::json;
    use std::sync::Arc;

    // 1. Start mock Cloudflare TURN API
    let mock_app = Router::new().route(
        "/v1/turn/keys/cf-key-99/credentials/generate-ice-servers",
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

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, mock_app).await;
    });

    // 2. Setup signaling AppState pointing to mock Cloudflare endpoint
    let config = Config {
        cloudflare_turn_api_token: Some("cf-token-secret".to_string()),
        cloudflare_turn_key_id: Some("cf-key-99".to_string()),
        turn_api_base_url: format!("http://127.0.0.1:{port}"),
        turn_max_monthly_bytes: 5000,
        ..Default::default()
    };

    let client = CloudflareTurnClient::new(&config);
    let governor = Arc::new(fastchat_signaling::turn::TurnCostGovernor::new(&config));
    let turn = Arc::new(TurnService::with_custom(client, governor.clone()));

    let app_state = AppState::new(config).with_turn_service(turn);
    let app = create_router(app_state);

    // 3. First request: within quota, should return STUN + TURN credentials
    let req = Request::builder()
        .uri("/api/ice-servers")
        .body(Body::empty())
        .unwrap();

    let response = app.clone().oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let body = response.into_body().collect().await.unwrap().to_bytes();
    let res: fastchat_signaling::turn::IceServersResponse = serde_json::from_slice(&body).unwrap();
    assert!(!res.quota_exhausted);
    // STUN default + 2 from Cloudflare = 3 servers (including TURN)
    assert!(res.ice_servers.iter().any(|s| s.username.as_deref() == Some("ephemeral_user")));

    // 4. Record usage to trip governor over threshold
    governor.record_usage(6000);

    // 5. Subsequent request: quota exhausted, must block TURN and return only STUN
    let req2 = Request::builder()
        .uri("/api/ice-servers")
        .body(Body::empty())
        .unwrap();

    let response2 = app.oneshot(req2).await.unwrap();
    assert_eq!(response2.status(), StatusCode::OK);

    let body2 = response2.into_body().collect().await.unwrap().to_bytes();
    let res2: fastchat_signaling::turn::IceServersResponse = serde_json::from_slice(&body2).unwrap();
    assert!(res2.quota_exhausted);
    assert_eq!(res2.ice_servers.len(), 1);
    assert_eq!(res2.ice_servers[0].urls[0], "stun:stun.cloudflare.com:3478");
}

#[tokio::test]
async fn test_get_ice_servers_turn_issuance_hourly_rate_limit() {
    use axum::{routing::post, Json, Router};
    use fastchat_signaling::turn::{CloudflareTurnClient, TurnService};
    use serde_json::json;
    use std::sync::Arc;

    let mock_app = Router::new().route(
        "/v1/turn/keys/cf-key-issuance/credentials/generate-ice-servers",
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

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, mock_app).await;
    });

    let config = Config {
        cloudflare_turn_api_token: Some("cf-token-secret".to_string()),
        cloudflare_turn_key_id: Some("cf-key-issuance".to_string()),
        turn_api_base_url: format!("http://127.0.0.1:{port}"),
        rate_limit_turn_issuances_per_hour: 5,
        rate_limit_ws_connections_per_min: 100,
        ..Default::default()
    };

    let client = CloudflareTurnClient::new(&config);
    let governor = Arc::new(fastchat_signaling::turn::TurnCostGovernor::new(&config));
    let turn = Arc::new(TurnService::with_custom(client, governor));

    let app_state = AppState::new(config).with_turn_service(turn);
    let app = create_router(app_state);

    let client_ip = "198.51.100.10";

    // 1. First 5 requests from the same IP succeed and return TURN credentials
    for _ in 1..=5 {
        let req = Request::builder()
            .uri("/api/ice-servers")
            .header("X-Forwarded-For", client_ip)
            .body(Body::empty())
            .unwrap();

        let response = app.clone().oneshot(req).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let body = response.into_body().collect().await.unwrap().to_bytes();
        let res: fastchat_signaling::turn::IceServersResponse = serde_json::from_slice(&body).unwrap();
        assert!(!res.turn_issuance_limited);
        assert!(!res.turn_issuance_limited_camel);
        assert!(res.ice_servers.iter().any(|s| s.username.as_deref() == Some("ephemeral_user")));
    }

    // 2. 6th request from the same IP must be limited: returns only STUN with turnIssuanceLimited: true
    let req6 = Request::builder()
        .uri("/api/ice-servers")
        .header("X-Forwarded-For", client_ip)
        .body(Body::empty())
        .unwrap();

    let response6 = app.clone().oneshot(req6).await.unwrap();
    assert_eq!(response6.status(), StatusCode::OK);

    let body6 = response6.into_body().collect().await.unwrap().to_bytes();
    let raw_json = String::from_utf8(body6.to_vec()).unwrap();
    assert!(raw_json.contains(r#""turn_issuance_limited":true"#));
    assert!(raw_json.contains(r#""turnIssuanceLimited":true"#));

    let res6: fastchat_signaling::turn::IceServersResponse = serde_json::from_slice(&body6).unwrap();
    assert!(res6.turn_issuance_limited);
    assert!(res6.turn_issuance_limited_camel);
    assert_eq!(res6.ice_servers.len(), 1);
    assert_eq!(res6.ice_servers[0].urls[0], "stun:stun.cloudflare.com:3478");

    // 3. A distinct IP should NOT be affected by the first IP's rate limit
    let req_other = Request::builder()
        .uri("/api/ice-servers")
        .header("X-Forwarded-For", "198.51.100.20")
        .body(Body::empty())
        .unwrap();

    let response_other = app.oneshot(req_other).await.unwrap();
    assert_eq!(response_other.status(), StatusCode::OK);

    let body_other = response_other.into_body().collect().await.unwrap().to_bytes();
    let res_other: fastchat_signaling::turn::IceServersResponse = serde_json::from_slice(&body_other).unwrap();
    assert!(!res_other.turn_issuance_limited);
    assert!(res_other.ice_servers.iter().any(|s| s.username.as_deref() == Some("ephemeral_user")));
}

