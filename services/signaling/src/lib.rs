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
    let now_ts = Utc::now().timestamp();
    let active_rooms = state.room_manager.count_active_rooms_by_owner(&rate_key, now_ts);
    if active_rooms >= state.config.max_active_rooms_per_ip {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            "You already have an active room. Close it before creating a new one.".to_string(),
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
        .create_room(owner_id, Some(rate_key), password_status)
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

async fn get_ice_servers_handler(
    client_ip: limiter::ClientIp,
    State(state): State<AppState>,
) -> Result<Json<turn::IceServersResponse>, (StatusCode, String)> {
    let rate_key = state.limiter.pepper.derive_key(&client_ip.0);
    if let Err(retry_after) = state.limiter.connection.check_and_record(&rate_key) {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            format!("Rate limit exceeded. Please retry in {retry_after} seconds."),
        ));
    }

    let default_stun = turn::IceServerConfig::default_cloudflare_stun();
    let mut servers = vec![default_stun];
    let mut quota_exhausted = false;
    let mut turn_issuance_limited = false;

    let is_issuance_limited = state.limiter.turn_issuance.is_limited(&rate_key);
    let is_bandwidth_limited = state.limiter.turn_bandwidth.is_limited(&rate_key);

    if is_issuance_limited || is_bandwidth_limited {
        turn_issuance_limited = true;
    } else if state.turn.client.is_configured() {
        match state.turn.issue_ice_servers(None).await {
            Ok(turn_servers) => {
                let has_turn = turn_servers.iter().any(|s| s.username.is_some());
                if has_turn {
                    state.limiter.turn_issuance.record_issuance(&rate_key);
                }
                servers.extend(turn_servers);
            }
            Err(turn::TurnError::QuotaExhausted(_)) => {
                quota_exhausted = true;
            }
            Err(e) => {
                tracing::warn!("Failed to fetch TURN credentials: {e}");
            }
        }
    } else if state.turn.governor.is_quota_exhausted() {
        quota_exhausted = true;
    }

    Ok(Json(turn::IceServersResponse::new(servers, quota_exhausted, turn_issuance_limited)))
}

/// Constructs the Axum application router with all routes and middleware configured.
pub fn create_router(app_state: AppState) -> Router {
    Router::new()
        .route("/health", get(health_check))
        .route("/ws", get(ws::ws_handler))
        .route("/api/ice-servers", get(get_ice_servers_handler))
        .route("/api/rooms", post(create_room_handler))
        .route("/api/rooms/{code}", get(get_room_handler))
        .route("/api/rooms/{code}/extend", post(extend_room_handler))
        .route("/api/rooms/{code}/close", post(close_room_handler))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(app_state)
}
