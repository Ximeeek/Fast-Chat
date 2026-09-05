use crate::config::Config;
use crate::room::broadcast::{LoggingBroadcaster, RoomBroadcaster};
use crate::room::code::{RoomCode, RoomCodeError};
use crate::room::state::{LifecycleAction, PasswordStatus, RoomError, RoomLifecycleState, RoomState};
use chrono::Utc;
use dashmap::DashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::task::JoinHandle;
use tracing::{debug, info};

/// In-memory manager orchestrating all room states without persistent storage.
/// FastChat guarantees zero disk footprint and zero database storage.
#[derive(Debug)]
pub struct RoomManager {
    /// Lock-free concurrent hash map storing all active room states.
    pub rooms: DashMap<RoomCode, RoomState>,
    /// Global application configuration.
    pub config: Config,
    /// Broadcaster interface to notify clients of lifecycle events.
    pub broadcaster: Arc<dyn RoomBroadcaster>,
}

impl RoomManager {
    /// Creates a new `RoomManager` with default logging broadcaster.
    pub fn new(config: Config) -> Self {
        Self {
            rooms: DashMap::new(),
            config,
            broadcaster: Arc::new(LoggingBroadcaster),
        }
    }

    /// Creates a new `RoomManager` with a custom broadcaster (useful for testing or mocks).
    pub fn with_broadcaster(config: Config, broadcaster: Arc<dyn RoomBroadcaster>) -> Self {
        Self {
            rooms: DashMap::new(),
            config,
            broadcaster,
        }
    }

    /// Creates a new ephemeral room with a unique 12-digit code.
    /// Sets initial expiration timer to `config.initial_room_duration_secs` (10m).
    pub fn create_room(
        &self,
        owner_peer_id: Option<String>,
        password_status: PasswordStatus,
    ) -> Result<RoomCode, RoomCodeError> {
        let code = RoomCode::generate_unique(&self.rooms)?;
        let now_ts = Utc::now().timestamp();
        let state = RoomState::new(
            code.clone(),
            owner_peer_id,
            password_status,
            &self.config,
            now_ts,
        );

        self.rooms.insert(code.clone(), state);
        info!(room = %code, "Created new ephemeral room in-memory");
        Ok(code)
    }

    /// Retrieves a cloned snapshot of the current state of a room, if it exists.
    pub fn get_room_state(&self, code: &RoomCode) -> Option<RoomState> {
        self.rooms.get(code).map(|r| r.value().clone())
    }

    /// Adds a peer to the specified room.
    pub fn join_room(
        &self,
        code: &RoomCode,
        peer_id: String,
        is_owner: bool,
    ) -> Result<(), RoomError> {
        let mut room = self
            .rooms
            .get_mut(code)
            .ok_or_else(|| RoomError::PeerNotFound(peer_id.clone()))?;

        let now_ts = Utc::now().timestamp();
        room.add_peer(peer_id, is_owner, now_ts, &self.config)
    }

    /// Extends a room's lifetime by 5 minutes.
    /// Must be invoked by the room owner while in `ExtendableWindow` (remaining <= 2m).
    pub fn extend_room(&self, code: &RoomCode, peer_id: &str) -> Result<(), RoomError> {
        let mut room = self
            .rooms
            .get_mut(code)
            .ok_or_else(|| RoomError::PeerNotFound(peer_id.to_string()))?;

        room.extend_by_owner(peer_id, &self.config)?;
        self.broadcaster
            .broadcast_state_changed(code, RoomLifecycleState::Active);
        info!(room = %code, peer = %peer_id, "Room lifetime extended by 5 minutes");
        Ok(())
    }

    /// Manually closes a room by its owner. Transitions to `Closing` with a 10s grace period.
    pub fn close_room(&self, code: &RoomCode, peer_id: &str) -> Result<(), RoomError> {
        let now_ts = Utc::now().timestamp();
        let mut room = self
            .rooms
            .get_mut(code)
            .ok_or_else(|| RoomError::PeerNotFound(peer_id.to_string()))?;

        room.close_by_owner(peer_id, now_ts, &self.config)?;
        self.broadcaster
            .broadcast_state_changed(code, RoomLifecycleState::Closing);
        info!(room = %code, peer = %peer_id, "Room manual closing initiated by owner");
        Ok(())
    }

    /// Evaluates lifecycle across all rooms at a specific timestamp.
    /// Acts as the single source of truth for expiration timers:
    /// - Advances states to ExtendableWindow or Closing
    /// - Purges Destroyed rooms from memory and triggers ROOM_CLOSED broadcast.
    pub fn tick_lifecycle(&self, now_ts: i64) -> Vec<(RoomCode, LifecycleAction)> {
        let mut actions = Vec::new();

        // Pass 1: Evaluate state under mutable reference and collect actions
        for mut entry in self.rooms.iter_mut() {
            let action = entry.value_mut().evaluate_lifecycle(now_ts, &self.config);
            if action != LifecycleAction::None {
                actions.push((entry.key().clone(), action));
            }
        }

        // Pass 2: Execute actions and notify broadcasters
        for (code, action) in &actions {
            match action {
                LifecycleAction::StateChanged(new_state) => {
                    self.broadcaster.broadcast_state_changed(code, *new_state);
                }
                LifecycleAction::Destroy => {
                    self.rooms.remove(code);
                    self.broadcaster
                        .broadcast_room_closed(code, "lifetime_or_grace_period_expired");
                    info!(room = %code, "Room purged from DashMap memory (destroyed)");
                }
                LifecycleAction::None => {}
            }
        }

        actions
    }

    /// Returns current number of active rooms stored in memory.
    pub fn room_count(&self) -> usize {
        self.rooms.len()
    }
}

/// Starts the periodic background sweeper task enforcing room lifecycles.
pub fn start_sweeper_task(manager: Arc<RoomManager>) -> JoinHandle<()> {
    let interval_secs = manager.config.sweeper_interval_secs;
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(interval_secs));
        debug!("Lifecycle sweeper task started with {interval_secs}s interval");

        loop {
            interval.tick().await;
            let now_ts = Utc::now().timestamp();
            let actions = manager.tick_lifecycle(now_ts);
            if !actions.is_empty() {
                debug!("Lifecycle sweeper evaluated {} room action(s)", actions.len());
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Debug, Default)]
    struct MockBroadcaster {
        closed_count: AtomicUsize,
        state_changes: AtomicUsize,
    }

    impl RoomBroadcaster for MockBroadcaster {
        fn broadcast_room_closed(&self, _code: &RoomCode, _reason: &str) {
            self.closed_count.fetch_add(1, Ordering::SeqCst);
        }

        fn broadcast_state_changed(&self, _code: &RoomCode, _new_state: RoomLifecycleState) {
            self.state_changes.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn test_manager_creation_and_lookup() {
        let config = Config::default();
        let manager = RoomManager::new(config);

        let code = manager
            .create_room(Some("alice".to_string()), PasswordStatus::none())
            .expect("Room creation failed");

        assert_eq!(manager.room_count(), 1);

        let state = manager.get_room_state(&code).expect("Room should exist");
        assert_eq!(state.code, code);
        assert_eq!(state.peers.len(), 1);
        assert_eq!(state.peers[0].id, "alice");
    }

    #[test]
    fn test_manager_sweeper_lifecycle_and_purge() {
        let config = Config {
            initial_room_duration_secs: 600,
            extendable_threshold_secs: 120,
            closing_grace_period_secs: 10,
            ..Default::default()
        };

        let broadcaster = Arc::new(MockBroadcaster::default());
        let manager = RoomManager::with_broadcaster(config, broadcaster.clone());

        let code = manager
            .create_room(Some("alice".to_string()), PasswordStatus::none())
            .unwrap();

        let initial_state = manager.get_room_state(&code).unwrap();
        let start_time = initial_state.created_at;

        // 1. Tick at +300s -> no change (still Creating/Active)
        manager.tick_lifecycle(start_time + 300);
        assert_eq!(manager.room_count(), 1);
        assert_eq!(broadcaster.state_changes.load(Ordering::SeqCst), 0);

        // 2. Tick at +480s (remaining 120s <= 120s) -> ExtendableWindow
        manager.tick_lifecycle(start_time + 480);
        assert_eq!(broadcaster.state_changes.load(Ordering::SeqCst), 1);
        let room = manager.get_room_state(&code).unwrap();
        assert_eq!(room.state, RoomLifecycleState::ExtendableWindow);

        // 3. Tick at +601s (past 600s) -> Closing
        manager.tick_lifecycle(start_time + 601);
        assert_eq!(broadcaster.state_changes.load(Ordering::SeqCst), 2);
        let room = manager.get_room_state(&code).unwrap();
        assert_eq!(room.state, RoomLifecycleState::Closing);

        // 4. Tick during grace period (+605s) -> still Closing, not destroyed
        manager.tick_lifecycle(start_time + 605);
        assert_eq!(manager.room_count(), 1);

        // 5. Tick after grace period (+612s) -> Destroyed, removed from DashMap
        manager.tick_lifecycle(start_time + 612);
        assert_eq!(manager.room_count(), 0);
        assert_eq!(broadcaster.closed_count.load(Ordering::SeqCst), 1);
    }
}
