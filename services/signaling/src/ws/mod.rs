pub mod protocol;
pub mod session;

use crate::room::code::RoomCode;
use crate::room::state::{PasswordStatus, RoomError, RoomLifecycleState};
use crate::state::AppState;
use crate::ws::protocol::{format_hex, ClientMessage, ServerMessage};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::IntoResponse,
};
use rand::Rng;
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

/// Axum WebSocket upgrade endpoint handler.
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    client_ip: crate::limiter::ClientIp,
    State(state): State<AppState>,
) -> axum::response::Response {
    // 1. Check global concurrent connection ceiling
    let connection_guard = match state.limiter.ceiling.acquire_connection() {
        Ok(guard) => guard,
        Err(msg) => {
            return (
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                [
                    (axum::http::header::CONTENT_TYPE, "application/json".to_string()),
                    (axum::http::header::RETRY_AFTER, "30".to_string()),
                ],
                format!(r#"{{"error":"SERVER_BUSY","message":"{msg}"}}"#),
            )
                .into_response();
        }
    };

    // 2. Check connection attempt rate limit and exponential backoff
    let rate_key = state.limiter.pepper.derive_key(&client_ip.0);
    if let Err(retry_after) = state.limiter.connection.check_and_record(&rate_key) {
        return (
            axum::http::StatusCode::TOO_MANY_REQUESTS,
            [
                (axum::http::header::RETRY_AFTER, retry_after.to_string()),
                (axum::http::header::CONTENT_TYPE, "application/json".to_string()),
            ],
            format!(
                r#"{{"error":"RATE_LIMIT_EXCEEDED","message":"WebSocket connection rate limit exceeded. Exponential backoff active. Retry after {} seconds."}}"#,
                retry_after
            ),
        )
            .into_response();
    }
    ws.on_upgrade(move |socket| handle_socket(socket, state, rate_key, connection_guard))
        .into_response()
}

/// Generates an 8-byte (16-char hex) random peer ID if not provided by client.
fn generate_peer_id() -> String {
    let mut rng = rand::thread_rng();
    let mut bytes = [0u8; 8];
    rng.fill(&mut bytes);
    format_hex(&bytes)
}

/// Main socket loop handling inbound frames and outbound channel dispatches.
pub async fn handle_socket(
    mut socket: WebSocket,
    state: AppState,
    rate_key: crate::limiter::RateKey,
    _connection_guard: crate::limiter::ConnectionGuard,
) {
    debug!("Incoming WebSocket connection accepted");

    let (tx, mut rx) = mpsc::unbounded_channel::<ServerMessage>();
    let mut current_session: Option<(RoomCode, String, bool)> = None;
    let mut flood_bucket = crate::limiter::TokenBucket::new(
        state.config.flood_bucket_capacity,
        state.config.flood_refill_per_sec,
    );

    loop {
        tokio::select! {
            Some(server_msg) = rx.recv() => {
                let is_room_closed = matches!(server_msg, ServerMessage::RoomClosed { .. });
                let json = match serde_json::to_string(&server_msg) {
                    Ok(s) => s,
                    Err(e) => {
                        warn!("Failed to serialize server message: {e}");
                        continue;
                    }
                };

                if socket.send(Message::Text(json.into())).await.is_err() {
                    break;
                }

                if is_room_closed {
                    let _ = socket.send(Message::Close(None)).await;
                    break;
                }
            }
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        if !flood_bucket.try_acquire(1.0) {
                            let _ = tx.send(ServerMessage::error(
                                "FLOOD_CONTROL_EXCEEDED",
                                "Signaling message rate limit exceeded. Slow down.",
                            ));
                        } else {
                            handle_client_message(&text, &mut current_session, &tx, &state, &rate_key).await;
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        if socket.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => {
                        break;
                    }
                    _ => {}
                }
            }
        }
    }

    // Unregister session and notify remaining room participants on disconnect
    if let Some((code, peer_id, _)) = current_session {
        debug!(room = %code, peer = %peer_id, "WebSocket peer disconnected; cleaning up session");
        state.sessions.unregister(&code, &peer_id);
        if let Some(mut room_entry) = state.room_manager.rooms.get_mut(&code) {
            let _ = room_entry.remove_peer(&peer_id);
        }
        state.sessions.broadcast(
            &code,
            ServerMessage::peer_left(peer_id),
            None,
        );
    }
}

/// Dispatches decoded client messages to corresponding protocol handlers.
async fn handle_client_message(
    raw_text: &str,
    current_session: &mut Option<(RoomCode, String, bool)>,
    tx: &mpsc::UnboundedSender<ServerMessage>,
    state: &AppState,
    rate_key: &crate::limiter::RateKey,
) {
    let msg: ClientMessage = match serde_json::from_str(raw_text) {
        Ok(m) => m,
        Err(e) => {
            let _ = tx.send(ServerMessage::error(
                "INVALID_MESSAGE_FORMAT",
                format!("Failed to parse message: {e}"),
            ));
            return;
        }
    };

    match msg {
        ClientMessage::Ping => {
            let _ = tx.send(ServerMessage::Pong);
        }
        ClientMessage::CreateRoom {
            peer_id,
            has_password,
            password,
        } => {
            if current_session.is_some() {
                let _ = tx.send(ServerMessage::error(
                    "ALREADY_IN_ROOM",
                    "Socket is already registered in a room",
                ));
                return;
            }

            let current_rooms = state.room_manager.room_count();
            if let Err(msg) = state.limiter.ceiling.check_room_capacity(current_rooms) {
                let _ = tx.send(ServerMessage::error("SERVER_BUSY", msg));
                return;
            }

            if let Err(_) = state.limiter.room_creation.check_and_record(rate_key) {
                let _ = tx.send(ServerMessage::error(
                    "RATE_LIMIT_EXCEEDED",
                    format!(
                        "Room creation limit reached (maximum {} per hour). Please wait before trying again.",
                        state.config.rate_limit_room_creations_per_hour
                    ),
                ));
                return;
            }

            let assigned_peer_id = peer_id
                .map(|p| p.trim().to_string())
                .filter(|p| !p.is_empty())
                .unwrap_or_else(generate_peer_id);

            let password_status = if let Some(p) = password {
                PasswordStatus::with_password(p)
            } else if has_password.unwrap_or(false) {
                PasswordStatus::with_random_salt()
            } else {
                PasswordStatus::none()
            };

            let code = match state
                .room_manager
                .create_room(Some(assigned_peer_id.clone()), password_status)
            {
                Ok(c) => c,
                Err(e) => {
                    let _ = tx.send(ServerMessage::error("CREATION_FAILED", e.to_string()));
                    return;
                }
            };

            let room_snapshot = match state.room_manager.get_room_state(&code) {
                Some(r) => r,
                None => {
                    let _ = tx.send(ServerMessage::error(
                        "ROOM_NOT_FOUND",
                        "Failed to retrieve newly created room",
                    ));
                    return;
                }
            };

            let salt_hex = format_hex(&room_snapshot.crypto_salt);
            state
                .sessions
                .register(&code, assigned_peer_id.clone(), tx.clone());
            *current_session = Some((code.clone(), assigned_peer_id.clone(), true));

            info!(
                room = %code,
                peer = %assigned_peer_id,
                "Room created and owner session registered"
            );

            let _ = tx.send(ServerMessage::room_created(
                code.to_string(),
                assigned_peer_id,
                salt_hex,
                room_snapshot.expires_at,
            ));
        }
        ClientMessage::JoinRoom {
            code: code_str,
            peer_id,
            password,
        } => {
            if current_session.is_some() {
                let _ = tx.send(ServerMessage::error(
                    "ALREADY_IN_ROOM",
                    "Socket is already registered in a room",
                ));
                return;
            }

            match state.limiter.join.check_join_permitted(rate_key) {
                Ok(()) => {}
                Err(crate::limiter::JoinCheckError::LockedOut { retry_after_secs }) => {
                    let _ = tx.send(ServerMessage::error(
                        "JOIN_LOCKED_OUT",
                        format!(
                            "Too many failed join attempts. Temporary lockout in effect. Please try again in {retry_after_secs} seconds."
                        ),
                    ));
                    return;
                }
                Err(crate::limiter::JoinCheckError::RateLimited { retry_after_secs }) => {
                    let _ = tx.send(ServerMessage::error(
                        "JOIN_RATE_LIMITED",
                        format!(
                            "Join attempt rate limit exceeded. Please wait {retry_after_secs} seconds before retrying."
                        ),
                    ));
                    return;
                }
            }

            let code = match RoomCode::new(code_str.trim()) {
                Ok(c) => c,
                Err(_) => {
                    state.limiter.join.record_failure(rate_key);
                    let _ = tx.send(ServerMessage::error(
                        "INVALID_ROOM_CODE",
                        "Invalid room code format (expected 0000-0000-0000)",
                    ));
                    return;
                }
            };

            let room_snapshot = match state.room_manager.get_room_state(&code) {
                Some(r) => r,
                None => {
                    state.limiter.join.record_failure(rate_key);
                    let _ = tx.send(ServerMessage::error("ROOM_NOT_FOUND", "Room does not exist"));
                    return;
                }
            };

            if matches!(
                room_snapshot.state,
                RoomLifecycleState::Closing | RoomLifecycleState::Destroyed
            ) {
                state.limiter.join.record_failure(rate_key);
                let _ = tx.send(ServerMessage::error(
                    "ROOM_TERMINATED",
                    "Room has closed or expired",
                ));
                return;
            }

            let assigned_peer_id = peer_id
                .map(|p| p.trim().to_string())
                .filter(|p| !p.is_empty())
                .unwrap_or_else(generate_peer_id);

            let existing_peers: Vec<String> =
                room_snapshot.peers.iter().map(|p| p.id.clone()).collect();

            let join_res = state.room_manager.join_room_with_password(
                &code,
                assigned_peer_id.clone(),
                false,
                password.as_deref(),
            );

            match join_res {
                Ok(()) => {
                    state.limiter.join.record_success(rate_key);
                    let salt_hex = format_hex(&room_snapshot.crypto_salt);
                    state
                        .sessions
                        .register(&code, assigned_peer_id.clone(), tx.clone());
                    *current_session = Some((code.clone(), assigned_peer_id.clone(), false));

                    info!(
                        room = %code,
                        peer = %assigned_peer_id,
                        "Peer joined room successfully"
                    );

                    // Send JOIN_OK to joining peer
                    let _ = tx.send(ServerMessage::join_ok(
                        code.to_string(),
                        assigned_peer_id.clone(),
                        false,
                        salt_hex,
                        room_snapshot.expires_at,
                        existing_peers,
                    ));

                    // Broadcast PEER_JOINED to existing peers
                    state.sessions.broadcast(
                        &code,
                        ServerMessage::peer_joined(assigned_peer_id.clone()),
                        Some(&assigned_peer_id),
                    );
                }
                Err(RoomError::InvalidPassword) => {
                    state.limiter.join.record_failure(rate_key);
                    let _ = tx.send(ServerMessage::error(
                        "INVALID_PASSWORD",
                        "Invalid or missing password for this room",
                    ));
                }
                Err(RoomError::RoomFull(max)) => {
                    let _ = tx.send(ServerMessage::error(
                        "ROOM_FULL",
                        format!("Room capacity reached: maximum of {max} participants allowed"),
                    ));
                }
                Err(RoomError::PeerAlreadyExists(p)) => {
                    let _ = tx.send(ServerMessage::error(
                        "PEER_ALREADY_EXISTS",
                        format!("Peer '{p}' is already present in this room"),
                    ));
                }
                Err(e) => {
                    let _ = tx.send(ServerMessage::error("JOIN_FAILED", e.to_string()));
                }
            }
        }
        ClientMessage::SdpOffer { target_peer_id, sdp } => {
            let (code, sender_id, _) = match current_session {
                Some(s) => s,
                None => {
                    let _ = tx.send(ServerMessage::error(
                        "NOT_IN_ROOM",
                        "Must join a room before sending signaling messages",
                    ));
                    return;
                }
            };

            debug!(
                room = %code,
                from = %sender_id,
                to = %target_peer_id,
                event = "SDP_OFFER_RELAY",
                "Relaying SDP offer transparently to target peer"
            );

            let sent = state.sessions.send_to_peer(
                code,
                &target_peer_id,
                ServerMessage::sdp_offer(sender_id.clone(), sdp),
            );

            if !sent {
                let _ = tx.send(ServerMessage::error(
                    "PEER_NOT_FOUND",
                    format!("Target peer '{target_peer_id}' not found in room"),
                ));
            }
        }
        ClientMessage::SdpAnswer { target_peer_id, sdp } => {
            let (code, sender_id, _) = match current_session {
                Some(s) => s,
                None => {
                    let _ = tx.send(ServerMessage::error(
                        "NOT_IN_ROOM",
                        "Must join a room before sending signaling messages",
                    ));
                    return;
                }
            };

            debug!(
                room = %code,
                from = %sender_id,
                to = %target_peer_id,
                event = "SDP_ANSWER_RELAY",
                "Relaying SDP answer transparently to target peer"
            );

            let sent = state.sessions.send_to_peer(
                code,
                &target_peer_id,
                ServerMessage::sdp_answer(sender_id.clone(), sdp),
            );

            if !sent {
                let _ = tx.send(ServerMessage::error(
                    "PEER_NOT_FOUND",
                    format!("Target peer '{target_peer_id}' not found in room"),
                ));
            }
        }
        ClientMessage::IceCandidates {
            target_peer_id,
            candidates,
            candidate,
        } => {
            let (code, sender_id, _) = match current_session {
                Some(s) => s,
                None => {
                    let _ = tx.send(ServerMessage::error(
                        "NOT_IN_ROOM",
                        "Must join a room before sending signaling messages",
                    ));
                    return;
                }
            };

            debug!(
                room = %code,
                from = %sender_id,
                to = %target_peer_id,
                event = "ICE_CANDIDATES_RELAY",
                "Relaying ICE candidate(s) transparently to target peer"
            );

            let sent = state.sessions.send_to_peer(
                code,
                &target_peer_id,
                ServerMessage::ice_candidates(sender_id.clone(), candidates, candidate),
            );

            if !sent {
                let _ = tx.send(ServerMessage::error(
                    "PEER_NOT_FOUND",
                    format!("Target peer '{target_peer_id}' not found in room"),
                ));
            }
        }
        ClientMessage::Rekey { password, salt } => {
            let (code, sender_id, is_owner) = match current_session {
                Some(s) => s,
                None => {
                    let _ = tx.send(ServerMessage::error(
                        "NOT_IN_ROOM",
                        "Must join a room before rekeying",
                    ));
                    return;
                }
            };

            if !*is_owner {
                let _ = tx.send(ServerMessage::error(
                    "UNAUTHORIZED",
                    "Only the room owner can initiate a REKEY",
                ));
                return;
            }

            let salt_bytes = if let Some(s) = salt {
                match crate::ws::protocol::parse_hex(&s) {
                    Ok(b) if b.len() == 16 => {
                        let mut arr = [0u8; 16];
                        arr.copy_from_slice(&b);
                        Some(arr)
                    }
                    _ => {
                        let _ = tx.send(ServerMessage::error(
                            "INVALID_SALT",
                            "Custom salt must be a 32-character (16 bytes) hex string",
                        ));
                        return;
                    }
                }
            } else {
                None
            };

            match state.room_manager.rekey_room(code, sender_id, &password, salt_bytes) {
                Ok(status) => {
                    let salt_hex = status.salt.map(|s| format_hex(&s)).unwrap_or_default();
                    info!(
                        room = %code,
                        peer = %sender_id,
                        event = "REKEY",
                        "Broadcasting REKEY event with public salt to all room participants"
                    );

                    state.sessions.broadcast(
                        code,
                        ServerMessage::rekey(code.to_string(), salt_hex),
                        None,
                    );
                }
                Err(RoomError::Unauthorized) => {
                    let _ = tx.send(ServerMessage::error(
                        "UNAUTHORIZED",
                        "Only the room owner can initiate a REKEY",
                    ));
                }
                Err(RoomError::RoomTerminated) => {
                    let _ = tx.send(ServerMessage::error(
                        "ROOM_TERMINATED",
                        "Cannot rekey a closing or destroyed room",
                    ));
                }
                Err(e) => {
                    let _ = tx.send(ServerMessage::error("REKEY_FAILED", e.to_string()));
                }
            }
        }
    }
}
