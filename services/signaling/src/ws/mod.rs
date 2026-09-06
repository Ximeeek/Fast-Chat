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
    let connection_id = session::ConnectionId::generate();
    info!(
        event = "WS_CONNECT_ATTEMPT",
        connection_id = %connection_id,
        client_ip = %client_ip.0,
        "Incoming WebSocket connection attempt"
    );

    // 1. Check global concurrent connection ceiling
    let connection_guard = match state.limiter.ceiling.acquire_connection() {
        Ok(guard) => guard,
        Err(msg) => {
            warn!(
                event = "LIMITER_REJECTED",
                connection_id = %connection_id,
                limiter = "ceiling_connection",
                message = %msg,
                "WebSocket connection rejected by global ceiling"
            );
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
        warn!(
            event = "LIMITER_REJECTED",
            connection_id = %connection_id,
            limiter = "connection_rate_limit",
            retry_after = retry_after,
            "WebSocket connection rejected by connection rate limiter"
        );
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
    ws.on_upgrade(move |socket| handle_socket(socket, state, rate_key, connection_id, connection_guard))
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
    connection_id: session::ConnectionId,
    _connection_guard: crate::limiter::ConnectionGuard,
) {
    debug!(connection_id = %connection_id, "Incoming WebSocket connection accepted");

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
                            warn!(
                                event = "LIMITER_REJECTED",
                                connection_id = %connection_id,
                                limiter = "flood_control",
                                "Signaling message rate limit exceeded by flood control"
                            );
                            let _ = tx.send(ServerMessage::error(
                                "FLOOD_CONTROL_EXCEEDED",
                                "Signaling message rate limit exceeded. Slow down.",
                            ));
                        } else {
                            handle_client_message(
                                &text,
                                &mut current_session,
                                &connection_id,
                                &tx,
                                &state,
                                &rate_key,
                            ).await;
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
    let unreg_result = state.sessions.unregister_connection(&connection_id);
    let session_to_cleanup = current_session
        .map(|(code, peer, _)| (code, peer))
        .or_else(|| unreg_result.map(|(code, peer, _)| (code, peer)));

    if let Some((code, peer_id)) = session_to_cleanup {
        debug!(
            connection_id = %connection_id,
            room = %code,
            peer = %peer_id,
            "WebSocket peer disconnected; cleaning up session"
        );

        if let Some(outcome) = state.room_manager.leave_room(&code, &peer_id) {
            if outcome.room_destroyed {
                info!(
                    room = %code,
                    peer = %peer_id,
                    "Last peer disconnected; room automatically destroyed"
                );
                state.sessions.broadcast(
                    &code,
                    ServerMessage::room_closed(code.to_string(), "room_empty"),
                    None,
                );
            } else {
                state.sessions.broadcast(
                    &code,
                    ServerMessage::peer_left(peer_id.clone()),
                    None,
                );

                if let Some(new_owner) = outcome.new_owner_id {
                    info!(
                        room = %code,
                        previous_owner = %peer_id,
                        new_owner = %new_owner,
                        "Broadcasting ROOM_OWNER_CHANGED to remaining participants"
                    );
                    state.sessions.broadcast(
                        &code,
                        ServerMessage::room_owner_changed(code.to_string(), new_owner),
                        None,
                    );
                }
            }
        }
    }
}

/// Dispatches decoded client messages to corresponding protocol handlers.
async fn handle_client_message(
    raw_text: &str,
    current_session: &mut Option<(RoomCode, String, bool)>,
    connection_id: &session::ConnectionId,
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
            info!(
                event = "CREATE_ROOM",
                connection_id = %connection_id,
                peer = ?peer_id,
                "Received CREATE_ROOM message"
            );

            if current_session.is_some() || state.sessions.is_connection_in_room(connection_id) {
                warn!(
                    event = "ALREADY_IN_ROOM",
                    connection_id = %connection_id,
                    "Socket connection is already registered in a room"
                );
                let _ = tx.send(ServerMessage::error(
                    "ALREADY_IN_ROOM",
                    "Socket is already registered in a room",
                ));
                return;
            }

            let current_rooms = state.room_manager.room_count();
            if let Err(msg) = state.limiter.ceiling.check_room_capacity(current_rooms) {
                warn!(
                    event = "LIMITER_REJECTED",
                    connection_id = %connection_id,
                    limiter = "ceiling_room",
                    current_rooms = current_rooms,
                    message = %msg,
                    "Room creation rejected by room ceiling"
                );
                let _ = tx.send(ServerMessage::error("SERVER_BUSY", msg));
                return;
            }

            let now_ts = chrono::Utc::now().timestamp();
            let active_rooms = state.room_manager.count_active_rooms_by_owner(rate_key, now_ts);
            if active_rooms >= state.config.max_active_rooms_per_ip {
                warn!(
                    event = "LIMITER_REJECTED",
                    connection_id = %connection_id,
                    limiter = "active_rooms_per_ip",
                    active_rooms = active_rooms,
                    max_allowed = state.config.max_active_rooms_per_ip,
                    "Room creation rejected: owner already has an active room"
                );
                let _ = tx.send(ServerMessage::error(
                    "ACTIVE_ROOM_LIMIT_EXCEEDED",
                    "You already have an active room. Close it before creating a new one.",
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
                .create_room(Some(assigned_peer_id.clone()), Some(*rate_key), password_status)
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
                .register_connection(connection_id.clone(), code.clone(), assigned_peer_id.clone(), tx.clone());
            *current_session = Some((code.clone(), assigned_peer_id.clone(), true));

            info!(
                connection_id = %connection_id,
                room = %code,
                peer = %assigned_peer_id,
                event = "ROOM_CREATED",
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
            info!(
                connection_id = %connection_id,
                room = %code_str,
                peer = ?peer_id,
                event = "JOIN_ROOM",
                "Received JOIN_ROOM message"
            );

            if current_session.is_some() || state.sessions.is_connection_in_room(connection_id) {
                warn!(
                    event = "ALREADY_IN_ROOM",
                    connection_id = %connection_id,
                    "Socket connection is already registered in a room"
                );
                let _ = tx.send(ServerMessage::error(
                    "ALREADY_IN_ROOM",
                    "Socket is already registered in a room",
                ));
                return;
            }

            match state.limiter.join.check_join_permitted(rate_key) {
                Ok(()) => {}
                Err(ref err) => {
                    warn!(
                        event = "LIMITER_REJECTED",
                        connection_id = %connection_id,
                        limiter = "join_limiter",
                        reason = ?err,
                        "Join attempt rejected by join limiter"
                    );
                    match err {
                        crate::limiter::JoinCheckError::LockedOut { retry_after_secs } => {
                            let _ = tx.send(ServerMessage::error(
                                "JOIN_LOCKED_OUT",
                                format!(
                                    "Too many failed join attempts. Temporary lockout in effect. Please try again in {retry_after_secs} seconds."
                                ),
                            ));
                            return;
                        }
                        crate::limiter::JoinCheckError::RateLimited { retry_after_secs } => {
                            let _ = tx.send(ServerMessage::error(
                                "JOIN_RATE_LIMITED",
                                format!(
                                    "Join attempt rate limit exceeded. Please wait {retry_after_secs} seconds before retrying."
                                ),
                            ));
                            return;
                        }
                    }
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
                Some(*rate_key),
            );

            match join_res {
                Ok(()) => {
                    state.limiter.join.record_success(rate_key);
                    let salt_hex = format_hex(&room_snapshot.crypto_salt);
                    state
                        .sessions
                        .register_connection(connection_id.clone(), code.clone(), assigned_peer_id.clone(), tx.clone());
                    *current_session = Some((code.clone(), assigned_peer_id.clone(), false));

                    info!(
                        connection_id = %connection_id,
                        room = %code,
                        peer = %assigned_peer_id,
                        event = "JOIN_OK",
                        "Peer joined room successfully"
                    );

                    // Send JOIN_OK to joining peer
                    let owner_id = room_snapshot.get_owner_id();
                    let _ = tx.send(ServerMessage::join_ok(
                        code.to_string(),
                        assigned_peer_id.clone(),
                        false,
                        owner_id,
                        salt_hex,
                        room_snapshot.expires_at,
                        existing_peers,
                    ));

                    // Broadcast PEER_JOINED to existing peers
                    info!(
                        connection_id = %connection_id,
                        room = %code,
                        peer = %assigned_peer_id,
                        event = "PEER_JOINED",
                        "Broadcasting PEER_JOINED to existing peers"
                    );
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

            info!(
                connection_id = %connection_id,
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

            info!(
                connection_id = %connection_id,
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

            info!(
                connection_id = %connection_id,
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
            let (code, sender_id, _) = match current_session {
                Some(s) => s,
                None => {
                    let _ = tx.send(ServerMessage::error(
                        "NOT_IN_ROOM",
                        "Must join a room before rekeying",
                    ));
                    return;
                }
            };

            let is_owner = state.room_manager.is_owner(code, sender_id);
            if !is_owner {
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
                        connection_id = %connection_id,
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
        ClientMessage::SetRoomPassword { password } => {
            let (code, sender_id, _) = match current_session {
                Some(s) => s,
                None => {
                    let _ = tx.send(ServerMessage::error(
                        "NOT_IN_ROOM",
                        "Must join a room before setting room password",
                    ));
                    return;
                }
            };

            if !state
                .room_manager
                .has_permission(code, sender_id, crate::room::Permission::SetRoomPassword)
            {
                let _ = tx.send(ServerMessage::error(
                    "NOT_ROOM_OWNER",
                    "Only the room owner can set or change the room password",
                ));
                return;
            }

            if password.trim().is_empty() {
                let _ = tx.send(ServerMessage::error(
                    "INVALID_PASSWORD",
                    "Password cannot be empty",
                ));
                return;
            }

            match state.room_manager.rekey_room(code, sender_id, &password, None) {
                Ok(status) => {
                    let salt_hex = status.salt.map(|s| format_hex(&s)).unwrap_or_default();
                    info!(
                        connection_id = %connection_id,
                        room = %code,
                        peer = %sender_id,
                        event = "SET_ROOM_PASSWORD",
                        "Room password configured by owner; broadcasting REKEY event"
                    );

                    state.sessions.broadcast(
                        code,
                        ServerMessage::rekey(code.to_string(), salt_hex),
                        None,
                    );
                }
                Err(RoomError::Unauthorized) => {
                    let _ = tx.send(ServerMessage::error(
                        "NOT_ROOM_OWNER",
                        "Only the room owner can set or change the room password",
                    ));
                }
                Err(RoomError::RoomTerminated) => {
                    let _ = tx.send(ServerMessage::error(
                        "ROOM_TERMINATED",
                        "Cannot set password on a closing or destroyed room",
                    ));
                }
                Err(e) => {
                    let _ = tx.send(ServerMessage::error("SET_PASSWORD_FAILED", e.to_string()));
                }
            }
        }
        ClientMessage::VerifyPassword { password } => {
            let (code, _, _) = match current_session {
                Some(s) => s,
                None => {
                    let _ = tx.send(ServerMessage::error(
                        "NOT_IN_ROOM",
                        "Must join a room before verifying password",
                    ));
                    return;
                }
            };

            let is_valid = state.room_manager.verify_room_password(code, &password);
            let _ = tx.send(ServerMessage::password_verified(is_valid));
        }
        ClientMessage::RequestIceServers => {
            let default_stun = crate::turn::IceServerConfig::default_cloudflare_stun();
            let mut servers = vec![default_stun];
            let mut quota_exhausted = false;
            let mut turn_issuance_limited = false;

            let is_issuance_limited = state.limiter.turn_issuance.is_limited(rate_key);
            let is_bandwidth_limited = state.limiter.turn_bandwidth.is_limited(rate_key);

            if is_issuance_limited || is_bandwidth_limited {
                turn_issuance_limited = true;
            } else if state.turn.client.is_configured() {
                match state.turn.issue_ice_servers(None).await {
                    Ok(turn_servers) => {
                        let has_turn = turn_servers.iter().any(|s| s.username.is_some());
                        if has_turn {
                            state.limiter.turn_issuance.record_issuance(rate_key);
                        }
                        servers.extend(turn_servers);
                    }
                    Err(crate::turn::TurnError::QuotaExhausted(_)) => {
                        quota_exhausted = true;
                    }
                    Err(e) => {
                        warn!("Failed to fetch TURN credentials over WS: {e}");
                    }
                }
            } else if state.turn.governor.is_quota_exhausted() {
                quota_exhausted = true;
            }

            let _ = tx.send(ServerMessage::ice_servers(
                servers,
                quota_exhausted,
                turn_issuance_limited,
            ));
        }
        ClientMessage::TurnUsageReport { bytes } => {
            debug!(
                event = "TURN_USAGE_REPORT",
                connection_id = %connection_id,
                bytes = bytes,
                "Received client TURN usage report"
            );
            state.limiter.turn_bandwidth.record_usage(rate_key, bytes);
        }
    }
}
