use crate::room::code::RoomCode;
use crate::room::id::RoomId;
use crate::room::state::RoomLifecycleState;
use crate::ws::protocol::ServerMessage;
use crate::ws::session::PeerSessionRegistry;
use chrono::Utc;
use std::fmt::Debug;
use tracing::info;

/// Interface for broadcasting room-level signaling events to connected peers.
pub trait RoomBroadcaster: Send + Sync + Debug {
    /// Broadcast that the room has been permanently closed and destroyed.
    fn broadcast_room_closed(&self, id: &RoomId, code: &RoomCode, reason: &str);

    /// Broadcast that the room has been immediately detonated and destroyed by the owner.
    fn broadcast_room_detonated(&self, id: &RoomId, code: &RoomCode);

    /// Broadcast a room lifecycle state change (e.g. entering ExtendableWindow or Closing).
    fn broadcast_state_changed(&self, id: &RoomId, code: &RoomCode, new_state: RoomLifecycleState);

    /// Broadcast that a peer's mute has expired or been lifted.
    fn broadcast_peer_unmuted(&self, _id: &RoomId, _peer_id: &str) {}
}

/// WebSocket-aware broadcaster dispatching structured events to active sessions.
#[derive(Debug, Clone)]
pub struct WebSocketBroadcaster {
    sessions: PeerSessionRegistry,
}

impl WebSocketBroadcaster {
    pub fn new(sessions: PeerSessionRegistry) -> Self {
        Self { sessions }
    }
}

impl RoomBroadcaster for WebSocketBroadcaster {
    fn broadcast_room_closed(&self, id: &RoomId, code: &RoomCode, reason: &str) {
        info!(
            room_id = %id,
            room = %code,
            reason = %reason,
            event = "ROOM_CLOSED",
            "Broadcasting ROOM_CLOSED event to room participants over WebSocket"
        );
        let msg = ServerMessage::room_closed(code.to_string(), reason);
        self.sessions.broadcast(id, msg, None);
        self.sessions.remove_room(id);
    }

    fn broadcast_room_detonated(&self, id: &RoomId, code: &RoomCode) {
        info!(
            room_id = %id,
            room = %code,
            event = "ROOM_DETONATED",
            "Broadcasting ROOM_DETONATED event to room participants over WebSocket"
        );
        let msg = ServerMessage::room_detonated(code.to_string());
        self.sessions.broadcast(id, msg, None);
        self.sessions.remove_room(id);
    }

    fn broadcast_state_changed(&self, id: &RoomId, code: &RoomCode, new_state: RoomLifecycleState) {
        info!(
            room_id = %id,
            room = %code,
            new_state = ?new_state,
            event = "ROOM_STATE_CHANGED",
            "Broadcasting room lifecycle state change over WebSocket"
        );

        if new_state == RoomLifecycleState::Closing {
            let now_ts = Utc::now().timestamp();
            let closing_deadline = now_ts + 10;
            let msg = ServerMessage::room_closing(code.to_string(), closing_deadline, now_ts);
            self.sessions.broadcast(id, msg, None);
        }
    }

    fn broadcast_peer_unmuted(&self, id: &RoomId, peer_id: &str) {
        info!(
            room_id = %id,
            peer = %peer_id,
            event = "PEER_UNMUTED",
            "Broadcasting PEER_UNMUTED event to room participants over WebSocket"
        );
        let msg = ServerMessage::peer_unmuted(peer_id);
        self.sessions.broadcast(id, msg, None);
    }
}

/// Default logger-backed broadcaster for standard runtime operation.
#[derive(Debug, Default)]
pub struct LoggingBroadcaster;

impl RoomBroadcaster for LoggingBroadcaster {
    fn broadcast_room_closed(&self, id: &RoomId, code: &RoomCode, reason: &str) {
        info!(
            room_id = %id,
            room = %code,
            reason = %reason,
            event = "ROOM_CLOSED",
            "Broadcasting ROOM_CLOSED event to room participants"
        );
    }

    fn broadcast_room_detonated(&self, id: &RoomId, code: &RoomCode) {
        info!(
            room_id = %id,
            room = %code,
            event = "ROOM_DETONATED",
            "Broadcasting ROOM_DETONATED event to room participants"
        );
    }

    fn broadcast_state_changed(&self, id: &RoomId, code: &RoomCode, new_state: RoomLifecycleState) {
        info!(
            room_id = %id,
            room = %code,
            new_state = ?new_state,
            event = "ROOM_STATE_CHANGED",
            "Broadcasting room lifecycle state change"
        );
    }

    fn broadcast_peer_unmuted(&self, id: &RoomId, peer_id: &str) {
        info!(
            room_id = %id,
            peer = %peer_id,
            event = "PEER_UNMUTED",
            "Broadcasting PEER_UNMUTED event"
        );
    }
}
