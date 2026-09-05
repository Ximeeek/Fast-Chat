pub mod config;
pub mod room;
pub mod state;
pub mod ws;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::Json,
    routing::{get, post},
    Router,
};
use chrono::Utc;
use config::Config;
use room::{start_sweeper_task, PasswordStatus, RoomCode};
use serde::{Deserialize, Serialize};
use state::AppState;
use std::net::SocketAddr;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;
use tracing::info;

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    service: &'static str,
    active_rooms: usize,
    max_participants_per_room: usize,
    timestamp: i64,
}

#[derive(Deserialize)]
struct CreateRoomRequest {
    owner_id: Option<String>,
    has_password: Option<bool>,
}

#[derive(Serialize)]
struct CreateRoomResponse {
    code: String,
    created_at: i64,
    expires_at: i64,
    state: room::RoomLifecycleState,
}

#[derive(Deserialize)]
struct PeerActionRequest {
    peer_id: String,
}

async fn health_check(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        service: "fastchat-signaling",
        active_rooms: state.room_manager.room_count(),
        max_participants_per_room: state.config.max_participants_per_room,
        timestamp: Utc::now().timestamp(),
    })
}

async fn create_room_handler(
    State(state): State<AppState>,
    body: Option<Json<CreateRoomRequest>>,
) -> Result<(StatusCode, Json<CreateRoomResponse>), (StatusCode, String)> {
    let (owner_id, has_password) = match body {
        Some(Json(req)) => (req.owner_id, req.has_password.unwrap_or(false)),
        None => (None, false),
    };

    let password_status = if has_password {
        PasswordStatus::with_random_salt()
    } else {
        PasswordStatus::none()
    };

    let code = state
        .room_manager
        .create_room(owner_id, password_status)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let room_snapshot = state
        .room_manager
        .get_room_state(&code)
        .ok_or_else(|| (StatusCode::INTERNAL_SERVER_ERROR, "Room not found after creation".to_string()))?;

    Ok((
        StatusCode::CREATED,
        Json(CreateRoomResponse {
            code: code.to_string(),
            created_at: room_snapshot.created_at,
            expires_at: room_snapshot.expires_at,
            state: room_snapshot.state,
        }),
    ))
}

async fn get_room_handler(
    State(state): State<AppState>,
    Path(code_str): Path<String>,
) -> Result<Json<room::RoomState>, (StatusCode, String)> {
    let code = RoomCode::new(code_str).map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    let room = state
        .room_manager
        .get_room_state(&code)
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Room not found".to_string()))?;

    Ok(Json(room))
}

async fn extend_room_handler(
    State(state): State<AppState>,
    Path(code_str): Path<String>,
    Json(req): Json<PeerActionRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    let code = RoomCode::new(code_str).map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    state
        .room_manager
        .extend_room(&code, &req.peer_id)
        .map_err(|e| match e {
            room::RoomError::Unauthorized => (StatusCode::FORBIDDEN, e.to_string()),
            room::RoomError::NotInExtendableWindow => (StatusCode::BAD_REQUEST, e.to_string()),
            room::RoomError::PeerNotFound(_) => (StatusCode::NOT_FOUND, e.to_string()),
            _ => (StatusCode::BAD_REQUEST, e.to_string()),
        })?;

    Ok(StatusCode::OK)
}

async fn close_room_handler(
    State(state): State<AppState>,
    Path(code_str): Path<String>,
    Json(req): Json<PeerActionRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    let code = RoomCode::new(code_str).map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    state
        .room_manager
        .close_room(&code, &req.peer_id)
        .map_err(|e| match e {
            room::RoomError::Unauthorized => (StatusCode::FORBIDDEN, e.to_string()),
            room::RoomError::PeerNotFound(_) => (StatusCode::NOT_FOUND, e.to_string()),
            _ => (StatusCode::BAD_REQUEST, e.to_string()),
        })?;

    Ok(StatusCode::OK)
}

pub fn create_router(app_state: AppState) -> Router {
    Router::new()
        .route("/health", get(health_check))
        .route("/ws", get(ws::ws_handler))
        .route("/api/rooms", post(create_room_handler))
        .route("/api/rooms/{code}", get(get_room_handler))
        .route("/api/rooms/{code}/extend", post(extend_room_handler))
        .route("/api/rooms/{code}/close", post(close_room_handler))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(app_state)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let config = Config::from_env();
    info!(
        max_participants = config.max_participants_per_room,
        initial_duration = config.initial_room_duration_secs,
        extendable_threshold = config.extendable_threshold_secs,
        extension_duration = config.extension_duration_secs,
        grace_period = config.closing_grace_period_secs,
        "Initializing FastChat Signaling Service"
    );

    let app_state = AppState::new(config.clone());

    // Spawn background sweeper task for enforcing room lifetime on the server
    start_sweeper_task(app_state.room_manager.clone());

    let app = create_router(app_state);

    let addr: SocketAddr = format!("{}:{}", config.server_host, config.server_port).parse()?;
    info!("Signaling server listening on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    info!("FastChat Signaling Service shutdown cleanly");
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("Failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("Failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}
