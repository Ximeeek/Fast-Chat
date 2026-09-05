use crate::room::code::RoomCode;
use crate::room::state::RoomLifecycleState;
use std::fmt::Debug;
use tracing::info;

/// Interface for broadcasting room-level signaling events to connected peers.
/// Full WebSocket packet framing is implemented in Phase 3;
/// this trait serves as the decoupled broadcast interface required for Phase 2.
pub trait RoomBroadcaster: Send + Sync + Debug {
    /// Broadcast that the room has been permanently closed and destroyed.
    fn broadcast_room_closed(&self, code: &RoomCode, reason: &str);

    /// Broadcast a room lifecycle state change (e.g. entering ExtendableWindow or Closing).
    fn broadcast_state_changed(&self, code: &RoomCode, new_state: RoomLifecycleState);
}

/// Default logger-backed broadcaster for standard runtime operation.
#[derive(Debug, Default)]
pub struct LoggingBroadcaster;

impl RoomBroadcaster for LoggingBroadcaster {
    fn broadcast_room_closed(&self, code: &RoomCode, reason: &str) {
        info!(
            room = %code,
            reason = %reason,
            event = "ROOM_CLOSED",
            "Broadcasting ROOM_CLOSED event to room participants"
        );
    }

    fn broadcast_state_changed(&self, code: &RoomCode, new_state: RoomLifecycleState) {
        info!(
            room = %code,
            new_state = ?new_state,
            event = "ROOM_STATE_CHANGED",
            "Broadcasting room lifecycle state change"
        );
    }
}
