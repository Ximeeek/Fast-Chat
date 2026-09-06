use crate::config::Config;
use crate::limiter::RateKey;
use crate::room::broadcast::{LoggingBroadcaster, RoomBroadcaster};
use crate::room::code::{RoomCode, RoomCodeError};
use crate::room::state::{LifecycleAction, PasswordStatus, RoomError, RoomLifecycleState, RoomState};
use chrono::Utc;
use dashmap::DashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::task::JoinHandle;
use tracing::{debug, info};

/// Outcome of a peer leaving a room.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerLeaveOutcome {
    pub was_owner: bool,
    pub new_owner_id: Option<String>,
    pub room_destroyed: bool,
}

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
        owner_rate_key: Option<RateKey>,
        password_status: PasswordStatus,
    ) -> Result<RoomCode, RoomCodeError> {
        let code = RoomCode::generate_unique(&self.rooms)?;
        let now_ts = Utc::now().timestamp();
        let state = RoomState::new(
            code.clone(),
            owner_peer_id,
            owner_rate_key,
            password_status,
            &self.config,
            now_ts,
        );

        self.rooms.insert(code.clone(), state);
        info!(room = %code, "Created new ephemeral room in-memory");
        Ok(code)
    }

    /// Counts active rooms owned by the specified rate key.
    pub fn count_active_rooms_by_owner(&self, key: &RateKey, now_ts: i64) -> usize {
        self.rooms
            .iter()
            .filter(|entry| {
                let room = entry.value();
                room.owner_rate_key.as_ref() == Some(key) && room.is_active(now_ts)
            })
            .count()
    }

    /// Backwards-compatible alias for counting active rooms by owner rate key.
    pub fn count_active_rooms_by_creator(&self, key: &RateKey, now_ts: i64) -> usize {
        self.count_active_rooms_by_owner(key, now_ts)
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
        rate_key: Option<RateKey>,
    ) -> Result<(), RoomError> {
        self.join_room_with_password(code, peer_id, is_owner, None, rate_key)
    }

    /// Adds a peer to the specified room with password verification.
    pub fn join_room_with_password(
        &self,
        code: &RoomCode,
        peer_id: String,
        is_owner: bool,
        password: Option<&str>,
        rate_key: Option<RateKey>,
    ) -> Result<(), RoomError> {
        let mut room = self
            .rooms
            .get_mut(code)
            .ok_or_else(|| RoomError::PeerNotFound(peer_id.clone()))?;

        let now_ts = Utc::now().timestamp();
        room.add_peer_with_password(peer_id, is_owner, password, now_ts, &self.config, rate_key)
    }

    /// Performs rekeying on an active room, configuring or updating password protection.
    pub fn rekey_room(
        &self,
        code: &RoomCode,
        peer_id: &str,
        password: &str,
        salt: Option<[u8; 16]>,
    ) -> Result<PasswordStatus, RoomError> {
        let mut room = self
            .rooms
            .get_mut(code)
            .ok_or_else(|| RoomError::PeerNotFound(peer_id.to_string()))?;

        room.rekey_by_owner(peer_id, password, salt)?;
        info!(room = %code, peer = %peer_id, "Room rekeyed by owner with password protection");
        Ok(room.password_status.clone())
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

    /// Checks atomically whether a peer is the registered owner of the room.
    pub fn is_owner(&self, code: &RoomCode, peer_id: &str) -> bool {
        self.rooms
            .get(code)
            .map(|r| r.is_owner(peer_id))
            .unwrap_or(false)
    }

    /// Evaluates whether a peer holds the specified permission within a room.
    pub fn has_permission(
        &self,
        code: &RoomCode,
        peer_id: &crate::room::permissions::PeerId,
        permission: crate::room::permissions::Permission,
    ) -> bool {
        self.rooms
            .get(code)
            .map(|r| r.has_permission(peer_id, permission))
            .unwrap_or(false)
    }

    /// Resolves the role assigned to a peer within a room, if the room exists.
    pub fn get_role(
        &self,
        code: &RoomCode,
        peer_id: &crate::room::permissions::PeerId,
    ) -> Option<crate::room::permissions::Role> {
        self.rooms.get(code).map(|r| r.get_role(peer_id))
    }

    /// Verifies whether the provided password matches the room's password requirement.
    pub fn verify_room_password(&self, code: &RoomCode, password: &str) -> bool {
        self.rooms
            .get(code)
            .map(|r| r.password_status.has_password && r.verify_password(Some(password)))
            .unwrap_or(false)
    }

    /// Kicks a peer from the room if the operator holds `Permission::KickPeer`.
    /// Kicked peer's rate key is added to the in-memory room blocklist.
    pub fn kick_peer(
        &self,
        code: &RoomCode,
        operator_peer_id: &str,
        target_peer_id: &str,
    ) -> Result<Option<RateKey>, RoomError> {
        let mut room = self
            .rooms
            .get_mut(code)
            .ok_or_else(|| RoomError::PeerNotFound(target_peer_id.to_string()))?;

        if !room.has_permission(operator_peer_id, crate::room::permissions::Permission::KickPeer) {
            return Err(RoomError::Unauthorized);
        }

        if operator_peer_id == target_peer_id {
            return Err(RoomError::Unauthorized);
        }

        let kicked_peer = room.kick_peer(target_peer_id)?;
        info!(
            room = %code,
            operator = %operator_peer_id,
            target = %target_peer_id,
            "Peer kicked from room and rate key recorded"
        );
        Ok(kicked_peer.rate_key)
    }

    /// Checks whether a given rate key was kicked from this room.
    pub fn is_rate_key_kicked(&self, code: &RoomCode, rate_key: &RateKey) -> bool {
        self.rooms
            .get(code)
            .map(|r| r.is_rate_key_kicked(rate_key))
            .unwrap_or(false)
    }

    /// Mutes a peer in the room if the operator holds `Permission::MutePeer`.
    pub fn mute_peer(
        &self,
        code: &RoomCode,
        operator_peer_id: &str,
        target_peer_id: &str,
        duration_secs: Option<u64>,
    ) -> Result<Option<i64>, RoomError> {
        let mut room = self
            .rooms
            .get_mut(code)
            .ok_or_else(|| RoomError::PeerNotFound(target_peer_id.to_string()))?;

        if !room.has_permission(operator_peer_id, crate::room::permissions::Permission::MutePeer) {
            return Err(RoomError::Unauthorized);
        }

        let now_ts = chrono::Utc::now().timestamp();
        let until = room.mute_peer(target_peer_id, duration_secs, now_ts)?;
        info!(
            room = %code,
            operator = %operator_peer_id,
            target = %target_peer_id,
            muted_until = ?until,
            "Peer muted in room"
        );
        Ok(until)
    }

    /// Unmutes a peer in the room if the operator holds `Permission::MutePeer`.
    pub fn unmute_peer(
        &self,
        code: &RoomCode,
        operator_peer_id: &str,
        target_peer_id: &str,
    ) -> Result<(), RoomError> {
        let mut room = self
            .rooms
            .get_mut(code)
            .ok_or_else(|| RoomError::PeerNotFound(target_peer_id.to_string()))?;

        if !room.has_permission(operator_peer_id, crate::room::permissions::Permission::MutePeer) {
            return Err(RoomError::Unauthorized);
        }

        room.unmute_peer(target_peer_id)?;
        info!(
            room = %code,
            operator = %operator_peer_id,
            target = %target_peer_id,
            "Peer unmuted in room"
        );
        Ok(())
    }

    /// Transfers room ownership to another connected peer if the operator holds `Permission::TransferOwnership`.
    pub fn transfer_ownership(
        &self,
        code: &RoomCode,
        operator_peer_id: &str,
        new_owner_peer_id: &str,
    ) -> Result<(), RoomError> {
        let mut room = self
            .rooms
            .get_mut(code)
            .ok_or_else(|| RoomError::PeerNotFound(new_owner_peer_id.to_string()))?;

        if !room.has_permission(operator_peer_id, crate::room::permissions::Permission::TransferOwnership) {
            return Err(RoomError::Unauthorized);
        }

        if operator_peer_id == new_owner_peer_id {
            return Err(RoomError::Unauthorized);
        }

        if !room.peers.iter().any(|p| p.id == new_owner_peer_id) {
            return Err(RoomError::PeerNotFound(new_owner_peer_id.to_string()));
        }

        if !room.set_owner(new_owner_peer_id) {
            return Err(RoomError::PeerNotFound(new_owner_peer_id.to_string()));
        }

        info!(
            room = %code,
            operator = %operator_peer_id,
            new_owner = %new_owner_peer_id,
            "Room ownership transferred to peer"
        );
        Ok(())
    }

    /// Sets the room lock status if the operator holds `Permission::LockRoom`.
    pub fn set_room_locked(
        &self,
        code: &RoomCode,
        operator_peer_id: &str,
        locked: bool,
    ) -> Result<(), RoomError> {
        let mut room = self
            .rooms
            .get_mut(code)
            .ok_or_else(|| RoomError::PeerNotFound(operator_peer_id.to_string()))?;

        if !room.has_permission(operator_peer_id, crate::room::permissions::Permission::LockRoom) {
            return Err(RoomError::Unauthorized);
        }

        room.set_locked(locked);
        info!(
            room = %code,
            operator = %operator_peer_id,
            locked = locked,
            "Room lock status updated"
        );
        Ok(())
    }

    /// Checks whether a room is currently locked to new participants.
    pub fn is_room_locked(&self, code: &RoomCode) -> bool {
        self.rooms.get(code).map(|r| r.is_locked).unwrap_or(false)
    }

    /// Handles peer departure from a room.
    ///
    /// - If the departing peer was the owner and other peers remain, ownership is
    ///   automatically transferred to the oldest remaining participant.
    /// - If the room has no remaining peers, it is immediately purged from memory.
    pub fn leave_room(&self, code: &RoomCode, peer_id: &str) -> Option<PeerLeaveOutcome> {
        let mut room_entry = self.rooms.get_mut(code)?;
        let removed_peer = room_entry.remove_peer(peer_id).ok()?;
        let was_owner = removed_peer.is_owner;

        if room_entry.peers.is_empty() {
            // Drop mutable reference before removing from DashMap
            drop(room_entry);
            self.rooms.remove(code);
            self.broadcaster.broadcast_room_closed(code, "room_empty");
            info!(room = %code, "Room emptied; automatically destroyed from memory");
            return Some(PeerLeaveOutcome {
                was_owner,
                new_owner_id: None,
                room_destroyed: true,
            });
        }

        let mut new_owner_id = None;
        if was_owner {
            // Reassign owner flag and owner_rate_key to the first remaining participant
            let assigned_owner = room_entry.peers[0].id.clone();
            room_entry.set_owner(&assigned_owner);
            info!(
                room = %code,
                previous_owner = %peer_id,
                new_owner = %assigned_owner,
                "Room owner departed; transferred ownership to next participant"
            );
            new_owner_id = Some(assigned_owner);
        }

        Some(PeerLeaveOutcome {
            was_owner,
            new_owner_id,
            room_destroyed: false,
        })
    }

    /// Evaluates lifecycle across all rooms at a specific timestamp.
    /// Acts as the single source of truth for expiration timers:
    /// - Advances states to ExtendableWindow or Closing
    /// - Purges Destroyed rooms from memory and triggers ROOM_CLOSED broadcast
    /// - Automatically expires temporary mutes and triggers PEER_UNMUTED broadcast.
    pub fn tick_lifecycle(&self, now_ts: i64) -> Vec<(RoomCode, LifecycleAction)> {
        let mut actions = Vec::new();
        let mut unmuted_peers = Vec::new();

        // Pass 1: Evaluate state under mutable reference and collect actions & expired mutes
        for mut entry in self.rooms.iter_mut() {
            let action = entry.value_mut().evaluate_lifecycle(now_ts, &self.config);
            if action != LifecycleAction::None {
                actions.push((entry.key().clone(), action));
            }

            let unmuted = entry.value_mut().check_expired_mutes(now_ts);
            for peer_id in unmuted {
                unmuted_peers.push((entry.key().clone(), peer_id));
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

        // Pass 3: Broadcast expired mutes
        for (code, peer_id) in unmuted_peers {
            self.broadcaster.broadcast_peer_unmuted(&code, &peer_id);
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
        unmuted_count: AtomicUsize,
    }

    impl RoomBroadcaster for MockBroadcaster {
        fn broadcast_room_closed(&self, _code: &RoomCode, _reason: &str) {
            self.closed_count.fetch_add(1, Ordering::SeqCst);
        }

        fn broadcast_state_changed(&self, _code: &RoomCode, _new_state: RoomLifecycleState) {
            self.state_changes.fetch_add(1, Ordering::SeqCst);
        }

        fn broadcast_peer_unmuted(&self, _code: &RoomCode, _peer_id: &str) {
            self.unmuted_count.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn test_manager_creation_and_lookup() {
        let config = Config::default();
        let manager = RoomManager::new(config);

        let code = manager
            .create_room(Some("alice".to_string()), None, PasswordStatus::none())
            .expect("Room creation failed");

        assert_eq!(manager.room_count(), 1);

        let state = manager.get_room_state(&code).expect("Room should exist");
        assert_eq!(state.code, code);
        assert_eq!(state.peers.len(), 1);
        assert_eq!(state.peers[0].id, "alice");
    }

    #[test]
    fn test_manager_count_active_rooms_by_owner() {
        let config = Config::default();
        let manager = RoomManager::new(config);
        let key_a = RateKey([1u8; 16]);
        let key_b = RateKey([2u8; 16]);
        let now = 1_000_000;

        assert_eq!(manager.count_active_rooms_by_owner(&key_a, now), 0);

        let code_a = manager
            .create_room(Some("alice".to_string()), Some(key_a), PasswordStatus::none())
            .unwrap();
        assert_eq!(manager.count_active_rooms_by_owner(&key_a, now), 1);
        assert_eq!(manager.count_active_rooms_by_owner(&key_b, now), 0);

        // Bob joins room
        manager
            .join_room(&code_a, "bob".to_string(), false, Some(key_b))
            .unwrap();
        assert_eq!(manager.count_active_rooms_by_owner(&key_a, now), 1);
        assert_eq!(manager.count_active_rooms_by_owner(&key_b, now), 0);

        // Alice (owner) leaves -> ownership transfers to Bob
        let outcome = manager.leave_room(&code_a, "alice").unwrap();
        assert_eq!(outcome.new_owner_id, Some("bob".to_string()));

        // Limiter now reflects Bob as owner, Alice is freed
        assert_eq!(manager.count_active_rooms_by_owner(&key_a, now), 0);
        assert_eq!(manager.count_active_rooms_by_owner(&key_b, now), 1);

        // Close room -> Bob is freed
        manager.close_room(&code_a, "bob").unwrap();
        assert_eq!(manager.count_active_rooms_by_owner(&key_b, now), 0);
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
            .create_room(Some("alice".to_string()), None, PasswordStatus::none())
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

    #[test]
    fn test_leave_room_ownership_transfer_and_empty_room_purge() {
        let config = Config::default();
        let broadcaster = Arc::new(MockBroadcaster::default());
        let manager = RoomManager::with_broadcaster(config, broadcaster.clone());
        let key_alice = RateKey([1u8; 16]);
        let key_bob = RateKey([2u8; 16]);
        let now = 1_000_000;

        let code = manager
            .create_room(Some("alice".to_string()), Some(key_alice), PasswordStatus::none())
            .unwrap();

        manager.join_room(&code, "bob".to_string(), false, Some(key_bob)).unwrap();
        manager.join_room(&code, "charlie".to_string(), false, None).unwrap();

        assert!(manager.is_owner(&code, "alice"));
        assert!(!manager.is_owner(&code, "bob"));
        assert!(!manager.is_owner(&code, "charlie"));
        assert_eq!(manager.count_active_rooms_by_owner(&key_alice, now), 1);
        assert_eq!(manager.count_active_rooms_by_owner(&key_bob, now), 0);

        // 1. Charlie (non-owner) leaves
        let outcome_c = manager.leave_room(&code, "charlie").unwrap();
        assert_eq!(
            outcome_c,
            PeerLeaveOutcome {
                was_owner: false,
                new_owner_id: None,
                room_destroyed: false,
            }
        );
        assert!(manager.is_owner(&code, "alice"));
        assert_eq!(manager.room_count(), 1);
        assert_eq!(manager.count_active_rooms_by_owner(&key_alice, now), 1);

        // 2. Alice (owner) leaves -> ownership transfers to bob
        let outcome_a = manager.leave_room(&code, "alice").unwrap();
        assert_eq!(
            outcome_a,
            PeerLeaveOutcome {
                was_owner: true,
                new_owner_id: Some("bob".to_string()),
                room_destroyed: false,
            }
        );
        assert!(manager.is_owner(&code, "bob"));
        assert!(!manager.is_owner(&code, "alice"));
        assert_eq!(manager.room_count(), 1);
        assert_eq!(manager.count_active_rooms_by_owner(&key_alice, now), 0);
        assert_eq!(manager.count_active_rooms_by_owner(&key_bob, now), 1);

        // 3. Bob leaves -> room empty -> auto destroyed immediately
        let outcome_b = manager.leave_room(&code, "bob").unwrap();
        assert_eq!(
            outcome_b,
            PeerLeaveOutcome {
                was_owner: true,
                new_owner_id: None,
                room_destroyed: true,
            }
        );
        assert_eq!(manager.room_count(), 0);
        assert_eq!(broadcaster.closed_count.load(Ordering::SeqCst), 1);
        assert_eq!(manager.count_active_rooms_by_owner(&key_bob, now), 0);
    }
}
