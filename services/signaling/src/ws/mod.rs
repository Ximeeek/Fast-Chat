pub mod protocol;

use crate::state::AppState;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::IntoResponse,
};
use tracing::debug;

/// WebSocket upgrade handler stub.
/// Full protocol framing (CREATE_ROOM, JOIN_ROOM, SDP/ICE relay, REKEY)
/// is out of scope for Phase 2 and will be implemented in Phase 3.
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(mut socket: WebSocket, _state: AppState) {
    debug!("Incoming WebSocket connection accepted (Phase 2 stub)");

    while let Some(Ok(msg)) = socket.recv().await {
        match msg {
            Message::Close(_) => {
                debug!("WebSocket peer disconnected cleanly");
                break;
            }
            Message::Ping(payload) => {
                if socket.send(Message::Pong(payload)).await.is_err() {
                    break;
                }
            }
            _ => {
                // Signaling messages will be processed in Phase 3
            }
        }
    }
}
