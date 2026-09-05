pub mod config;
pub mod limiter;
pub mod room;
pub mod state;
pub mod turn;
pub mod ws;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::Json,
    routing::{get, post},
    Router,
};
use chrono::Utc;
use room::{PasswordStatus, RoomCode};
use serde::{Deserialize, Serialize};
use state::AppState;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

#[derive(Serialize, Deserialize, Debug, PartialEq, Eq)]
pub struct HealthResponse {
    pub status: String,
    pub service: String,
    pub active_rooms: usize,
    pub max_participants_per_room: usize,
    pub timestamp: i64,
}

#[derive(Deserialize, Serialize, Debug)]
pub struct CreateRoomRequest {
    pub owner_id: Option<String>,
    pub has_password: Option<bool>,
}

#[derive(Serialize, Deserialize, Debug, PartialEq, Eq)]
pub struct CreateRoomResponse {
    pub code: String,
    pub created_at: i64,
    pub expires_at: i64,
    pub state: room::RoomLifecycleState,
}

#[derive(Deserialize, Serialize, Debug)]
pub struct PeerActionRequest {
    pub peer_id: String,
}

async fn health_check(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok".to_string(),
        service: "fastchat-signaling".to_string(),
        active_rooms: state.room_manager.room_count(),
        max_participants_per_room: state.config.max_participants_per_room,
        timestamp: Utc::now().timestamp(),
    })
}

async fn create_room_handler(
    client_ip: limiter::ClientIp,
    State(state): State<AppState>,
    body: Option<Json<CreateRoomRequest>>,
) -> Result<(StatusCode, Json<CreateRoomResponse>), (StatusCode, String)> {
    let current_rooms = state.room_manager.room_count();
    if let Err(msg) = state.limiter.ceiling.check_room_capacity(current_rooms) {
        return Err((StatusCode::SERVICE_UNAVAILABLE, msg.to_string()));
    }

    let rate_key = state.limiter.pepper.derive_key(&client_ip.0);
    if let Err(retry_after) = state.limiter.room_creation.check_and_record(&rate_key) {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            format!(
                "Room creation limit reached (maximum {} per hour). Please retry in {} seconds.",
                state.config.rate_limit_room_creations_per_hour, retry_after
            ),
        ));
    }

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

/// Constructs the Axum application router with all routes and middleware configured.
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
