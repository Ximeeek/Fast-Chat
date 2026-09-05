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
