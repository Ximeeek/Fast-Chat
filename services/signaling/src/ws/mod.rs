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
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

/// Generates an 8-byte (16-char hex) random peer ID if not provided by client.
fn generate_peer_id() -> String {
    let mut rng = rand::thread_rng();
    let mut bytes = [0u8; 8];
    rng.fill(&mut bytes);
    format_hex(&bytes)
}

/// Main socket loop handling inbound frames and outbound channel dispatches.
pub async fn handle_socket(mut socket: WebSocket, state: AppState) {
    debug!("Incoming WebSocket connection accepted");

    let (tx, mut rx) = mpsc::unbounded_channel::<ServerMessage>();
    let mut current_session: Option<(RoomCode, String, bool)> = None;

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
                        handle_client_message(&text, &mut current_session, &tx, &state).await;
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

            let code = match RoomCode::new(code_str.trim()) {
                Ok(c) => c,
                Err(_) => {
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
                    let _ = tx.send(ServerMessage::error("ROOM_NOT_FOUND", "Room does not exist"));
                    return;
                }
            };

            if matches!(
                room_snapshot.state,
                RoomLifecycleState::Closing | RoomLifecycleState::Destroyed
            ) {
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
        ClientMessage::Rekey { .. } => {
            // Rekey handler in next step
            let _ = tx.send(ServerMessage::error("UNIMPLEMENTED", "Rekey handler pending"));
        }
    }
}
