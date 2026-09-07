use crate::config::Config;
use crate::limiter::RateKey;
use crate::room::broadcast::{LoggingBroadcaster, RoomBroadcaster};
use crate::room::code::{RoomCode, RoomCodeError};
use crate::room::id::RoomId;
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
    pub current_code: RoomCode,
}

/// In-memory manager orchestrating all room states without persistent storage.
/// FastChat guarantees zero disk footprint and zero database storage.
///
/// Room state storage is partitioned into two concurrent data structures:
/// - `rooms`: Primary map indexed by immutable `RoomId` (UUID v4), preserved across all code rotations.
/// - `code_to_id`: Secondary auxiliary index mapping public 12-digit `RoomCode` to `RoomId`,
///   used exclusively for peer discovery during `JOIN_ROOM`.
#[derive(Debug)]
pub struct RoomManager {
    /// Lock-free concurrent hash map storing all active room states keyed by immutable RoomId.
    pub rooms: DashMap<RoomId, RoomState>,
    /// Auxiliary lookup mapping public RoomCode to RoomId for JOIN_ROOM discovery.
    pub code_to_id: DashMap<RoomCode, RoomId>,
    /// Serialized rotation locks per room ID ensuring rotations do not race.
    pub rotation_locks: DashMap<RoomId, Arc<std::sync::Mutex<()>>>,
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
            code_to_id: DashMap::new(),
            rotation_locks: DashMap::new(),
            config,
            broadcaster: Arc::new(LoggingBroadcaster),
        }
    }

    /// Creates a new `RoomManager` with a custom broadcaster (useful for testing or mocks).
    pub fn with_broadcaster(config: Config, broadcaster: Arc<dyn RoomBroadcaster>) -> Self {
        Self {
            rooms: DashMap::new(),
            code_to_id: DashMap::new(),
            rotation_locks: DashMap::new(),
            config,
            broadcaster,
        }
    }

    /// Creates a new ephemeral room with a unique `RoomId` and an initial 12-digit `RoomCode`.
    /// Inserts entries into both primary `rooms` storage and secondary `code_to_id` index.
    /// Sets initial expiration timer to `config.initial_room_duration_secs` (10m).
    pub fn create_room(
        &self,
        owner_peer_id: Option<String>,
        owner_rate_key: Option<RateKey>,
        password_status: PasswordStatus,
    ) -> Result<(RoomId, RoomCode), RoomCodeError> {
        self.create_room_with_options(owner_peer_id, owner_rate_key, password_status, false, None)
    }

    /// Creates a new ephemeral room with hopping room codes and optional periodic rotation interval.
    pub fn create_room_with_options(
        &self,
        owner_peer_id: Option<String>,
        owner_rate_key: Option<RateKey>,
        password_status: PasswordStatus,
        hopping_enabled: bool,
        auto_rotate_interval_seconds: Option<u64>,
    ) -> Result<(RoomId, RoomCode), RoomCodeError> {
        let code = RoomCode::generate_unique(&self.code_to_id)?;
        let room_id = RoomId::generate();
        let now_ts = Utc::now().timestamp();
        let state = RoomState::with_hopping(
            room_id,
            code.clone(),
            owner_peer_id,
            owner_rate_key,
            password_status,
            &self.config,
            now_ts,
            hopping_enabled,
            auto_rotate_interval_seconds,
        );

        self.rooms.insert(room_id, state);
        self.code_to_id.insert(code.clone(), room_id);
        info!(
            room_id = %room_id,
            room = %code,
            hopping = hopping_enabled,
            interval = ?auto_rotate_interval_seconds,
            "Created new ephemeral room in-memory"
        );
        Ok((room_id, code))
    }

    /// Rotates the public `RoomCode` for the specified room using current instant.
    pub fn rotate_room_code(&self, id: &RoomId) -> Result<RoomCode, RoomError> {
        self.rotate_room_code_at(id, std::time::Instant::now())
    }

    /// Rotates the public `RoomCode` for the specified room with an explicit timestamp.
    /// Serialized per-room through `rotation_locks` to prevent race conditions.
    pub fn rotate_room_code_at(&self, id: &RoomId, now: std::time::Instant) -> Result<RoomCode, RoomError> {
        let lock = self
            .rotation_locks
            .entry(*id)
            .or_insert_with(|| Arc::new(std::sync::Mutex::new(())))
            .clone();
        let _guard = lock.lock().unwrap();

        // 1. Verify room exists and hopping is enabled
        let (old_code, hopping_enabled) = {
            let room = self.rooms.get(id).ok_or_else(|| RoomError::PeerNotFound(String::new()))?;
            (room.current_code.clone(), room.hopping_enabled)
        };

        if !hopping_enabled {
            return Ok(old_code);
        }

        // 2. Generate new unique code avoiding collision with current keys in code_to_id
        let new_code = RoomCode::generate_unique(&self.code_to_id)
            .map_err(|_| RoomError::RoomTerminated)?;

        // 3. Atomically update auxiliary map: insert new code before removing old code
        self.code_to_id.insert(new_code.clone(), *id);
        self.code_to_id.remove(&old_code);

        // 4. Update room state
        let mut room = self.rooms.get_mut(id).ok_or_else(|| RoomError::PeerNotFound(String::new()))?;
        room.current_code = new_code.clone();
        room.last_rotation_at = now;

        info!(
            room_id = %id,
            previous_code = %old_code,
            new_code = %new_code,
            "Room code rotated successfully"
        );

        Ok(new_code)
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

    /// Resolves `RoomId` from public `RoomCode` using the secondary lookup map.
    pub fn get_room_id_by_code(&self, code: &RoomCode) -> Option<RoomId> {
        self.code_to_id.get(code).map(|r| *r.value())
    }

    /// Retrieves a cloned snapshot of the current state of a room by `RoomId`, if it exists.
    pub fn get_room_state(&self, id: &RoomId) -> Option<RoomState> {
        self.rooms.get(id).map(|r| r.value().clone())
    }

    /// Retrieves a cloned snapshot of the current state of a room by public `RoomCode`, if it exists.
    pub fn get_room_state_by_code(&self, code: &RoomCode) -> Option<RoomState> {
        let id = self.get_room_id_by_code(code)?;
        self.get_room_state(&id)
    }

    /// Adds a peer to the specified room by `RoomId`.
    pub fn join_room(
        &self,
        id: &RoomId,
        peer_id: String,
        is_owner: bool,
        rate_key: Option<RateKey>,
    ) -> Result<(), RoomError> {
        self.join_room_with_password(id, peer_id, is_owner, None, rate_key)
    }

    /// Adds a peer to the specified room by `RoomId` with password verification.
    pub fn join_room_with_password(
        &self,
        id: &RoomId,
        peer_id: String,
        is_owner: bool,
        password: Option<&str>,
        rate_key: Option<RateKey>,
    ) -> Result<(), RoomError> {
        let mut room = self
            .rooms
            .get_mut(id)
            .ok_or_else(|| RoomError::PeerNotFound(peer_id.clone()))?;

        let now_ts = Utc::now().timestamp();
        room.add_peer_with_password(peer_id, is_owner, password, now_ts, &self.config, rate_key)
    }

    /// Adds a peer by resolving public `RoomCode` through secondary index to `RoomId`.
    pub fn join_room_by_code(
        &self,
        code: &RoomCode,
        peer_id: String,
        is_owner: bool,
        password: Option<&str>,
        rate_key: Option<RateKey>,
    ) -> Result<RoomId, RoomError> {
        let id = self
            .get_room_id_by_code(code)
            .ok_or_else(|| RoomError::PeerNotFound(peer_id.clone()))?;
        self.join_room_with_password(&id, peer_id, is_owner, password, rate_key)?;
        Ok(id)
    }

    /// Performs rekeying on an active room by `RoomId`, configuring or updating password protection.
    pub fn rekey_room(
        &self,
        id: &RoomId,
        peer_id: &str,
        password: &str,
        salt: Option<[u8; 16]>,
    ) -> Result<(RoomCode, PasswordStatus), RoomError> {
        let mut room = self
            .rooms
            .get_mut(id)
            .ok_or_else(|| RoomError::PeerNotFound(peer_id.to_string()))?;

        room.rekey_by_owner(peer_id, password, salt)?;
        let current_code = room.current_code.clone();
        let status = room.password_status.clone();
        info!(room_id = %id, room = %current_code, peer = %peer_id, "Room rekeyed by owner with password protection");
        Ok((current_code, status))
    }

    /// Extends a room's lifetime by 5 minutes.
    /// Must be invoked by the room owner while in `ExtendableWindow` (remaining <= 2m).
    pub fn extend_room(&self, id: &RoomId, peer_id: &str) -> Result<(), RoomError> {
        let mut room = self
            .rooms
            .get_mut(id)
            .ok_or_else(|| RoomError::PeerNotFound(peer_id.to_string()))?;

        room.extend_by_owner(peer_id, &self.config)?;
        let code = room.current_code.clone();
        self.broadcaster
            .broadcast_state_changed(id, &code, RoomLifecycleState::Active);
        info!(room_id = %id, room = %code, peer = %peer_id, "Room lifetime extended by 5 minutes");
        Ok(())
    }

    /// Manually closes a room by its owner. Transitions to `Closing` with a 10s grace period.
    pub fn close_room(&self, id: &RoomId, peer_id: &str) -> Result<(), RoomError> {
        let now_ts = Utc::now().timestamp();
        let mut room = self
            .rooms
            .get_mut(id)
            .ok_or_else(|| RoomError::PeerNotFound(peer_id.to_string()))?;

        room.close_by_owner(peer_id, now_ts, &self.config)?;
        let code = room.current_code.clone();
        self.broadcaster
            .broadcast_state_changed(id, &code, RoomLifecycleState::Closing);
        info!(room_id = %id, room = %code, peer = %peer_id, "Room manual closing initiated by owner");
        Ok(())
    }

    /// Immediately and permanently destroys a room without any grace period.
    ///
    /// The caller must hold `Permission::DetonateRoom`.
    /// The room is instantly evicted from both `rooms` and `code_to_id` DashMaps,
    /// evaporating all ephemeral state, and a ROOM_DETONATED broadcast is dispatched immediately.
    pub fn detonate_room(&self, id: &RoomId, operator_peer_id: &str) -> Result<(), RoomError> {
        let code = {
            let room = self
                .rooms
                .get(id)
                .ok_or_else(|| RoomError::PeerNotFound(operator_peer_id.to_string()))?;

            if !room.has_permission(operator_peer_id, crate::room::permissions::Permission::DetonateRoom) {
                return Err(RoomError::Unauthorized);
            }
            room.current_code.clone()
        };

        // Atomically evict room record from DashMaps and rotation locks
        self.rooms.remove(id);
        self.code_to_id.remove(&code);
        self.rotation_locks.remove(id);
        self.broadcaster.broadcast_room_detonated(id, &code);
        info!(
            room_id = %id,
            room = %code,
            operator = %operator_peer_id,
            "Room detonated and destroyed immediately by owner"
        );
        Ok(())
    }

    /// Checks atomically whether a peer is the registered owner of the room.
    pub fn is_owner(&self, id: &RoomId, peer_id: &str) -> bool {
        self.rooms
            .get(id)
            .map(|r| r.is_owner(peer_id))
            .unwrap_or(false)
    }

    /// Evaluates whether a peer holds the specified permission within a room.
    pub fn has_permission(
        &self,
        id: &RoomId,
        peer_id: &crate::room::permissions::PeerId,
        permission: crate::room::permissions::Permission,
    ) -> bool {
        self.rooms
            .get(id)
            .map(|r| r.has_permission(peer_id, permission))
            .unwrap_or(false)
    }

    /// Resolves the role assigned to a peer within a room, if the room exists.
    pub fn get_role(
        &self,
        id: &RoomId,
        peer_id: &crate::room::permissions::PeerId,
    ) -> Option<crate::room::permissions::Role> {
        self.rooms.get(id).map(|r| r.get_role(peer_id))
    }

    /// Verifies whether the provided password matches the room's password requirement.
    pub fn verify_room_password(&self, id: &RoomId, password: &str) -> bool {
        self.rooms
            .get(id)
            .map(|r| r.password_status.has_password && r.verify_password(Some(password)))
            .unwrap_or(false)
    }

    /// Kicks a peer from the room if the operator holds `Permission::KickPeer`.
    /// Kicked peer's rate key is added to the in-memory room blocklist.
    pub fn kick_peer(
        &self,
        id: &RoomId,
        operator_peer_id: &str,
        target_peer_id: &str,
    ) -> Result<Option<RateKey>, RoomError> {
        let mut room = self
            .rooms
            .get_mut(id)
            .ok_or_else(|| RoomError::PeerNotFound(target_peer_id.to_string()))?;

        if !room.has_permission(operator_peer_id, crate::room::permissions::Permission::KickPeer) {
            return Err(RoomError::Unauthorized);
        }

        if operator_peer_id == target_peer_id {
            return Err(RoomError::Unauthorized);
        }

        let code = room.current_code.clone();
        let kicked_peer = room.kick_peer(target_peer_id)?;
        info!(
            room_id = %id,
            room = %code,
            operator = %operator_peer_id,
            target = %target_peer_id,
            "Peer kicked from room"
        );
        Ok(kicked_peer.rate_key)
    }

    /// Mutes a peer in the room if the operator holds `Permission::MutePeer`.
    pub fn mute_peer(
        &self,
        id: &RoomId,
        operator_peer_id: &str,
        target_peer_id: &str,
        duration_secs: Option<u64>,
    ) -> Result<Option<i64>, RoomError> {
        let mut room = self
            .rooms
            .get_mut(id)
            .ok_or_else(|| RoomError::PeerNotFound(target_peer_id.to_string()))?;

        if !room.has_permission(operator_peer_id, crate::room::permissions::Permission::MutePeer) {
            return Err(RoomError::Unauthorized);
        }

        let now_ts = chrono::Utc::now().timestamp();
        let code = room.current_code.clone();
        let until = room.mute_peer(target_peer_id, duration_secs, now_ts)?;
        info!(
            room_id = %id,
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
        id: &RoomId,
        operator_peer_id: &str,
        target_peer_id: &str,
    ) -> Result<(), RoomError> {
        let mut room = self
            .rooms
            .get_mut(id)
            .ok_or_else(|| RoomError::PeerNotFound(target_peer_id.to_string()))?;

        if !room.has_permission(operator_peer_id, crate::room::permissions::Permission::MutePeer) {
            return Err(RoomError::Unauthorized);
        }

        let code = room.current_code.clone();
        room.unmute_peer(target_peer_id)?;
        info!(
            room_id = %id,
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
        id: &RoomId,
        operator_peer_id: &str,
        new_owner_peer_id: &str,
    ) -> Result<RoomCode, RoomError> {
        let mut room = self
            .rooms
            .get_mut(id)
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

        let code = room.current_code.clone();
        info!(
            room_id = %id,
            room = %code,
            operator = %operator_peer_id,
            new_owner = %new_owner_peer_id,
            "Room ownership transferred to peer"
        );
        Ok(code)
    }

    /// Sets the room lock status if the operator holds `Permission::LockRoom`.
    pub fn set_room_locked(
        &self,
        id: &RoomId,
        operator_peer_id: &str,
        locked: bool,
    ) -> Result<RoomCode, RoomError> {
        let mut room = self
            .rooms
            .get_mut(id)
            .ok_or_else(|| RoomError::PeerNotFound(operator_peer_id.to_string()))?;

        if !room.has_permission(operator_peer_id, crate::room::permissions::Permission::LockRoom) {
            return Err(RoomError::Unauthorized);
        }

        room.set_locked(locked);
        let code = room.current_code.clone();
        info!(
            room_id = %id,
            room = %code,
            operator = %operator_peer_id,
            locked = locked,
            "Room lock status updated"
        );
        Ok(code)
    }

    /// Checks whether a room is currently locked to new participants.
    pub fn is_room_locked(&self, id: &RoomId) -> bool {
        self.rooms.get(id).map(|r| r.is_locked).unwrap_or(false)
    }

    /// Sets whether a peer is blocked from receiving chat messages if the operator holds `Permission::ManageChatVisibility`.
    pub fn set_chat_visibility_blocked(
        &self,
        id: &RoomId,
        operator_peer_id: &str,
        target_peer_id: &str,
        blocked: bool,
    ) -> Result<(), RoomError> {
        let mut room = self
            .rooms
            .get_mut(id)
            .ok_or_else(|| RoomError::PeerNotFound(operator_peer_id.to_string()))?;

        if !room.has_permission(operator_peer_id, crate::room::permissions::Permission::ManageChatVisibility) {
            return Err(RoomError::Unauthorized);
        }

        let code = room.current_code.clone();
        room.set_chat_visibility_blocked(target_peer_id, blocked)?;
        info!(
            room_id = %id,
            room = %code,
            operator = %operator_peer_id,
            target = %target_peer_id,
            blocked = blocked,
            "Peer chat visibility block updated"
        );
        Ok(())
    }

    /// Sets whether a peer is blocked from receiving files if the operator holds `Permission::ManageFileVisibility`.
    pub fn set_file_visibility_blocked(
        &self,
        id: &RoomId,
        operator_peer_id: &str,
        target_peer_id: &str,
        blocked: bool,
    ) -> Result<(), RoomError> {
        let mut room = self
            .rooms
            .get_mut(id)
            .ok_or_else(|| RoomError::PeerNotFound(operator_peer_id.to_string()))?;

        if !room.has_permission(operator_peer_id, crate::room::permissions::Permission::ManageFileVisibility) {
            return Err(RoomError::Unauthorized);
        }

        let code = room.current_code.clone();
        room.set_file_visibility_blocked(target_peer_id, blocked)?;
        info!(
            room_id = %id,
            room = %code,
            operator = %operator_peer_id,
            target = %target_peer_id,
            blocked = blocked,
            "Peer file visibility block updated"
        );
        Ok(())
    }

    /// Handles peer departure from a room.
    ///
    /// - If the departing peer was the owner and other peers remain, ownership is
    ///   automatically transferred to the oldest remaining participant.
    /// - If the room has no remaining peers, it is immediately purged from both `rooms`
    ///   and `code_to_id` maps.
    pub fn leave_room(&self, id: &RoomId, peer_id: &str) -> Option<PeerLeaveOutcome> {
        let mut room_entry = self.rooms.get_mut(id)?;
        let removed_peer = room_entry.remove_peer(peer_id).ok()?;
        let was_owner = removed_peer.is_owner;
        let current_code = room_entry.current_code.clone();

        if room_entry.peers.is_empty() {
            // Drop mutable reference before removing from DashMaps
            drop(room_entry);
            self.rooms.remove(id);
            self.code_to_id.remove(&current_code);
            self.rotation_locks.remove(id);
            self.broadcaster.broadcast_room_closed(id, &current_code, "room_empty");
            info!(room_id = %id, room = %current_code, "Room emptied; automatically destroyed from memory");
            return Some(PeerLeaveOutcome {
                was_owner,
                new_owner_id: None,
                room_destroyed: true,
                current_code,
            });
        }

        let mut new_owner_id = None;
        if was_owner {
            // Reassign owner flag and owner_rate_key to the first remaining participant
            let assigned_owner = room_entry.peers[0].id.clone();
            room_entry.set_owner(&assigned_owner);
            info!(
                room_id = %id,
                room = %current_code,
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
            current_code,
        })
    }

    /// Evaluates lifecycle across all rooms at a specific timestamp.
    /// Acts as the single source of truth for expiration timers:
    /// - Advances states to ExtendableWindow or Closing
    /// - Purges Destroyed rooms from both primary and secondary DashMaps and triggers ROOM_CLOSED broadcast
    /// - Automatically expires temporary mutes and triggers PEER_UNMUTED broadcast.
    pub fn tick_lifecycle(&self, now_ts: i64) -> Vec<(RoomId, LifecycleAction)> {
        let mut actions = Vec::new();
        let mut unmuted_peers = Vec::new();

        // Pass 1: Evaluate state under mutable reference and collect actions & expired mutes
        for mut entry in self.rooms.iter_mut() {
            let action = entry.value_mut().evaluate_lifecycle(now_ts, &self.config);
            let id = *entry.key();
            let code = entry.value().current_code.clone();
            if action != LifecycleAction::None {
                actions.push((id, code, action));
            }

            let unmuted = entry.value_mut().check_expired_mutes(now_ts);
            for peer_id in unmuted {
                unmuted_peers.push((id, peer_id));
            }
        }

        // Pass 2: Execute actions and notify broadcasters
        for (id, code, action) in &actions {
            match action {
                LifecycleAction::StateChanged(new_state) => {
                    self.broadcaster.broadcast_state_changed(id, code, *new_state);
                }
                LifecycleAction::Destroy => {
                    if let Some((_, destroyed_room)) = self.rooms.remove(id) {
                        self.code_to_id.remove(&destroyed_room.current_code);
                        self.rotation_locks.remove(id);
                        self.broadcaster
                            .broadcast_room_closed(id, &destroyed_room.current_code, "lifetime_or_grace_period_expired");
                        info!(room_id = %id, room = %destroyed_room.current_code, "Room purged from DashMap memory (destroyed)");
                    }
                }
                LifecycleAction::None => {}
            }
        }

        // Pass 3: Broadcast expired mutes
        for (id, peer_id) in unmuted_peers {
            self.broadcaster.broadcast_peer_unmuted(&id, &peer_id);
        }

        actions.into_iter().map(|(id, _, action)| (id, action)).collect()
    }

    /// Evaluates all active rooms for periodic automatic room code rotation.
    /// Performs serialized rotation for any eligible rooms and notifies their owners.
    /// Returns a list of `(RoomId, RoomCode, String)` describing rotated rooms (id, new_code, owner_peer_id).
    pub fn tick_auto_rotations(&self, now: std::time::Instant) -> Vec<(RoomId, RoomCode, String)> {
        let mut candidates = Vec::new();

        for entry in self.rooms.iter() {
            let room = entry.value();
            if room.check_auto_rotation(now) {
                if let Some(owner) = room.owner_peer_id() {
                    candidates.push((*entry.key(), owner.to_string()));
                }
            }
        }

        let mut results = Vec::new();
        for (room_id, owner_peer_id) in candidates {
            if let Ok(new_code) = self.rotate_room_code_at(&room_id, now) {
                self.broadcaster.broadcast_room_code_rotated(&room_id, &owner_peer_id, &new_code);
                results.push((room_id, new_code, owner_peer_id));
            }
        }

        results
    }

    /// Returns current number of active rooms stored in memory.
    pub fn room_count(&self) -> usize {
        self.rooms.len()
    }
}

/// Starts the periodic background sweeper task enforcing room lifecycles and periodic code rotations.
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

            let rotations = manager.tick_auto_rotations(std::time::Instant::now());
            if !rotations.is_empty() {
                debug!("Lifecycle sweeper rotated {} room code(s)", rotations.len());
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
        detonated_count: AtomicUsize,
        state_changes: AtomicUsize,
        unmuted_count: AtomicUsize,
        rotated_count: AtomicUsize,
    }

    impl RoomBroadcaster for MockBroadcaster {
        fn broadcast_room_closed(&self, _id: &RoomId, _code: &RoomCode, _reason: &str) {
            self.closed_count.fetch_add(1, Ordering::SeqCst);
        }

        fn broadcast_room_detonated(&self, _id: &RoomId, _code: &RoomCode) {
            self.detonated_count.fetch_add(1, Ordering::SeqCst);
        }

        fn broadcast_state_changed(&self, _id: &RoomId, _code: &RoomCode, _new_state: RoomLifecycleState) {
            self.state_changes.fetch_add(1, Ordering::SeqCst);
        }

        fn broadcast_peer_unmuted(&self, _id: &RoomId, _peer_id: &str) {
            self.unmuted_count.fetch_add(1, Ordering::SeqCst);
        }

        fn broadcast_room_code_rotated(&self, _id: &RoomId, _owner_peer_id: &str, _new_code: &RoomCode) {
            self.rotated_count.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn test_manager_creation_and_lookup() {
        let config = Config::default();
        let manager = RoomManager::new(config);

        let (room_id, code) = manager
            .create_room(Some("alice".to_string()), None, PasswordStatus::none())
            .expect("Room creation failed");

        assert_eq!(manager.room_count(), 1);
        assert_eq!(manager.code_to_id.len(), 1);

        let state = manager.get_room_state(&room_id).expect("Room should exist");
        assert_eq!(state.id, room_id);
        assert_eq!(state.current_code, code);
        assert_eq!(state.peers.len(), 1);
        assert_eq!(state.peers[0].id, "alice");

        let id_from_code = manager.get_room_id_by_code(&code).expect("Should find ID by code");
        assert_eq!(id_from_code, room_id);

        let state_from_code = manager.get_room_state_by_code(&code).expect("Should find state by code");
        assert_eq!(state_from_code.id, room_id);
    }

    #[test]
    fn test_manager_count_active_rooms_by_owner() {
        let config = Config::default();
        let manager = RoomManager::new(config);
        let key_a = RateKey([1u8; 16]);
        let key_b = RateKey([2u8; 16]);
        let now = 1_000_000;

        assert_eq!(manager.count_active_rooms_by_owner(&key_a, now), 0);

        let (room_id_a, _) = manager
            .create_room(Some("alice".to_string()), Some(key_a), PasswordStatus::none())
            .unwrap();
        assert_eq!(manager.count_active_rooms_by_owner(&key_a, now), 1);
        assert_eq!(manager.count_active_rooms_by_owner(&key_b, now), 0);

        // Bob joins room
        manager
            .join_room(&room_id_a, "bob".to_string(), false, Some(key_b))
            .unwrap();
        assert_eq!(manager.count_active_rooms_by_owner(&key_a, now), 1);
        assert_eq!(manager.count_active_rooms_by_owner(&key_b, now), 0);

        // Alice (owner) leaves -> ownership transfers to Bob
        let outcome = manager.leave_room(&room_id_a, "alice").unwrap();
        assert_eq!(outcome.new_owner_id, Some("bob".to_string()));

        // Limiter now reflects Bob as owner, Alice is freed
        assert_eq!(manager.count_active_rooms_by_owner(&key_a, now), 0);
        assert_eq!(manager.count_active_rooms_by_owner(&key_b, now), 1);

        // Close room -> Bob is freed
        manager.close_room(&room_id_a, "bob").unwrap();
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

        let (room_id, code) = manager
            .create_room(Some("alice".to_string()), None, PasswordStatus::none())
            .unwrap();

        let initial_state = manager.get_room_state(&room_id).unwrap();
        let start_time = initial_state.created_at;

        // 1. Tick at +300s -> no change (still Creating/Active)
        manager.tick_lifecycle(start_time + 300);
        assert_eq!(manager.room_count(), 1);
        assert_eq!(broadcaster.state_changes.load(Ordering::SeqCst), 0);

        // 2. Tick at +480s (remaining 120s <= 120s) -> ExtendableWindow
        manager.tick_lifecycle(start_time + 480);
        assert_eq!(broadcaster.state_changes.load(Ordering::SeqCst), 1);
        let room = manager.get_room_state(&room_id).unwrap();
        assert_eq!(room.state, RoomLifecycleState::ExtendableWindow);

        // 3. Tick at +601s (past 600s) -> Closing
        manager.tick_lifecycle(start_time + 601);
        assert_eq!(broadcaster.state_changes.load(Ordering::SeqCst), 2);
        let room = manager.get_room_state(&room_id).unwrap();
        assert_eq!(room.state, RoomLifecycleState::Closing);

        // 4. Tick during grace period (+605s) -> still Closing, not destroyed
        manager.tick_lifecycle(start_time + 605);
        assert_eq!(manager.room_count(), 1);

        // 5. Tick after grace period (+612s) -> Destroyed, removed from both DashMaps
        manager.tick_lifecycle(start_time + 612);
        assert_eq!(manager.room_count(), 0);
        assert_eq!(manager.code_to_id.len(), 0);
        assert!(manager.get_room_id_by_code(&code).is_none());
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

        let (room_id, code) = manager
            .create_room(Some("alice".to_string()), Some(key_alice), PasswordStatus::none())
            .unwrap();

        manager.join_room(&room_id, "bob".to_string(), false, Some(key_bob)).unwrap();
        manager.join_room(&room_id, "charlie".to_string(), false, None).unwrap();

        assert!(manager.is_owner(&room_id, "alice"));
        assert!(!manager.is_owner(&room_id, "bob"));
        assert!(!manager.is_owner(&room_id, "charlie"));
        assert_eq!(manager.count_active_rooms_by_owner(&key_alice, now), 1);
        assert_eq!(manager.count_active_rooms_by_owner(&key_bob, now), 0);

        // 1. Charlie (non-owner) leaves
        let outcome_c = manager.leave_room(&room_id, "charlie").unwrap();
        assert_eq!(
            outcome_c,
            PeerLeaveOutcome {
                was_owner: false,
                new_owner_id: None,
                room_destroyed: false,
                current_code: code.clone(),
            }
        );
        assert!(manager.is_owner(&room_id, "alice"));
        assert_eq!(manager.room_count(), 1);
        assert_eq!(manager.count_active_rooms_by_owner(&key_alice, now), 1);

        // 2. Alice (owner) leaves -> ownership transfers to bob
        let outcome_a = manager.leave_room(&room_id, "alice").unwrap();
        assert_eq!(
            outcome_a,
            PeerLeaveOutcome {
                was_owner: true,
                new_owner_id: Some("bob".to_string()),
                room_destroyed: false,
                current_code: code.clone(),
            }
        );
        assert!(manager.is_owner(&room_id, "bob"));
        assert!(!manager.is_owner(&room_id, "alice"));
        assert_eq!(manager.room_count(), 1);
        assert_eq!(manager.count_active_rooms_by_owner(&key_alice, now), 0);
        assert_eq!(manager.count_active_rooms_by_owner(&key_bob, now), 1);

        // 3. Bob leaves -> room empty -> auto destroyed immediately from both DashMaps
        let outcome_b = manager.leave_room(&room_id, "bob").unwrap();
        assert_eq!(
            outcome_b,
            PeerLeaveOutcome {
                was_owner: true,
                new_owner_id: None,
                room_destroyed: true,
                current_code: code.clone(),
            }
        );
        assert_eq!(manager.room_count(), 0);
        assert_eq!(manager.code_to_id.len(), 0);
        assert!(manager.get_room_id_by_code(&code).is_none());
        assert_eq!(broadcaster.closed_count.load(Ordering::SeqCst), 1);
        assert_eq!(manager.count_active_rooms_by_owner(&key_bob, now), 0);
    }

    #[test]
    fn test_manager_chat_and_file_visibility_authorization() {
        let config = Config::default();
        let manager = RoomManager::new(config);
        let (room_id, _) = manager
            .create_room(Some("alice".to_string()), None, PasswordStatus::none())
            .unwrap();

        manager
            .join_room(&room_id, "bob".to_string(), false, None)
            .unwrap();

        // 1. Bob (participant) attempts to block alice -> Unauthorized
        let res_bob_chat = manager.set_chat_visibility_blocked(&room_id, "bob", "alice", true);
        assert_eq!(res_bob_chat, Err(RoomError::Unauthorized));

        let res_bob_file = manager.set_file_visibility_blocked(&room_id, "bob", "alice", true);
        assert_eq!(res_bob_file, Err(RoomError::Unauthorized));

        // 2. Alice (owner) blocks bob from chat -> Success
        let res_alice_chat = manager.set_chat_visibility_blocked(&room_id, "alice", "bob", true);
        assert!(res_alice_chat.is_ok());
        let room_snap = manager.get_room_state(&room_id).unwrap();
        assert!(room_snap.is_chat_blocked("bob"));

        // 3. Alice (owner) blocks bob from files -> Success
        let res_alice_file = manager.set_file_visibility_blocked(&room_id, "alice", "bob", true);
        assert!(res_alice_file.is_ok());
        let room_snap2 = manager.get_room_state(&room_id).unwrap();
        assert!(room_snap2.is_file_blocked("bob"));

        // 4. Alice unblocks bob
        assert!(manager.set_chat_visibility_blocked(&room_id, "alice", "bob", false).is_ok());
        assert!(manager.set_file_visibility_blocked(&room_id, "alice", "bob", false).is_ok());
        let room_snap3 = manager.get_room_state(&room_id).unwrap();
        assert!(!room_snap3.is_chat_blocked("bob"));
        assert!(!room_snap3.is_file_blocked("bob"));
    }

    #[test]
    fn test_manager_detonate_room_authorized_and_unauthorized() {
        let config = Config::default();
        let broadcaster = Arc::new(MockBroadcaster::default());
        let manager = RoomManager::with_broadcaster(config.clone(), broadcaster.clone());

        let (room_id, code) = manager
            .create_room(Some("alice".to_string()), None, PasswordStatus::none())
            .unwrap();

        manager
            .join_room(&room_id, "bob".to_string(), false, None)
            .unwrap();

        // 1. Bob (non-owner participant) attempts to detonate -> Unauthorized
        let detonate_res = manager.detonate_room(&room_id, "bob");
        assert_eq!(detonate_res, Err(RoomError::Unauthorized));
        assert!(manager.get_room_state(&room_id).is_some());
        assert_eq!(broadcaster.detonated_count.load(Ordering::SeqCst), 0);

        // 2. Alice (owner) detonates room -> Success
        let detonate_res = manager.detonate_room(&room_id, "alice");
        assert!(detonate_res.is_ok());

        // Room is instantly wiped from both rooms and code_to_id DashMaps
        assert!(manager.get_room_state(&room_id).is_none());
        assert_eq!(manager.room_count(), 0);
        assert_eq!(manager.code_to_id.len(), 0);
        assert!(manager.get_room_id_by_code(&code).is_none());
        assert_eq!(broadcaster.detonated_count.load(Ordering::SeqCst), 1);

        // 3. Confirm that the exact same room code can be re-created and used with clean state
        let now_ts = Utc::now().timestamp();
        let fresh_id = RoomId::generate();
        let fresh_room = RoomState::new(
            fresh_id,
            code.clone(),
            Some("carol".to_string()),
            None,
            PasswordStatus::none(),
            &config,
            now_ts,
        );
        manager.rooms.insert(fresh_id, fresh_room);
        manager.code_to_id.insert(code.clone(), fresh_id);
        let fresh_snap = manager.get_room_state(&fresh_id).expect("Fresh room should exist");
        assert_eq!(fresh_snap.owner_peer_id(), Some("carol"));
        assert_eq!(fresh_snap.peers.len(), 1);
        assert_eq!(fresh_snap.state, RoomLifecycleState::Creating);
    }

    #[test]
    fn test_hopping_code_rotation_updates_state_and_maps() {
        let config = Config::default();
        let manager = RoomManager::new(config);

        let (room_id, initial_code) = manager
            .create_room_with_options(
                Some("alice".to_string()),
                None,
                PasswordStatus::none(),
                true,
                None,
            )
            .unwrap();

        assert_eq!(manager.get_room_id_by_code(&initial_code), Some(room_id));
        let state_before = manager.get_room_state(&room_id).unwrap();
        assert!(state_before.is_hopping_enabled());
        assert_eq!(state_before.current_code, initial_code);

        // Rotate room code
        let new_code = manager.rotate_room_code(&room_id).unwrap();
        assert_ne!(new_code, initial_code);

        // Verify old code is no longer mapped
        assert_eq!(manager.get_room_id_by_code(&initial_code), None);

        // Verify new code is mapped to the same room_id
        assert_eq!(manager.get_room_id_by_code(&new_code), Some(room_id));

        // Verify RoomState has new code
        let state_after = manager.get_room_state(&room_id).unwrap();
        assert_eq!(state_after.current_code, new_code);
    }

    #[test]
    fn test_hopping_code_rapid_rotations_no_collisions() {
        let config = Config::default();
        let manager = RoomManager::new(config);

        let (room_id, initial_code) = manager
            .create_room_with_options(
                Some("alice".to_string()),
                None,
                PasswordStatus::none(),
                true,
                None,
            )
            .unwrap();

        let mut current = initial_code;
        let mut seen = std::collections::HashSet::new();
        seen.insert(current.clone());

        for _ in 0..50 {
            let next_code = manager.rotate_room_code(&room_id).unwrap();
            assert!(!seen.contains(&next_code), "Generated code collision!");
            assert_eq!(manager.get_room_id_by_code(&current), None);
            assert_eq!(manager.get_room_id_by_code(&next_code), Some(room_id));
            seen.insert(next_code.clone());
            current = next_code;
        }

        assert_eq!(manager.code_to_id.len(), 1);
        assert_eq!(manager.get_room_state(&room_id).unwrap().current_code, current);
    }

    #[test]
    fn test_periodic_auto_rotation_with_simulated_time() {
        let config = Config::default();
        let broadcaster = Arc::new(MockBroadcaster::default());
        let manager = RoomManager::with_broadcaster(config, broadcaster.clone());

        let (room_id, initial_code) = manager
            .create_room_with_options(
                Some("alice".to_string()),
                None,
                PasswordStatus::none(),
                true,
                Some(60),
            )
            .unwrap();

        let t0 = manager.get_room_state(&room_id).unwrap().last_rotation_at;

        // 1. At t0 + 30s: interval not reached -> no rotation
        let res_30 = manager.tick_auto_rotations(t0 + Duration::from_secs(30));
        assert!(res_30.is_empty());
        assert_eq!(broadcaster.rotated_count.load(Ordering::SeqCst), 0);
        assert_eq!(manager.get_room_id_by_code(&initial_code), Some(room_id));

        // 2. At t0 + 61s: interval elapsed -> rotated once
        let res_61 = manager.tick_auto_rotations(t0 + Duration::from_secs(61));
        assert_eq!(res_61.len(), 1);
        let (rot_id, code_1, owner) = &res_61[0];
        assert_eq!(*rot_id, room_id);
        assert_eq!(owner, "alice");
        assert_ne!(*code_1, initial_code);
        assert_eq!(broadcaster.rotated_count.load(Ordering::SeqCst), 1);
        assert_eq!(manager.get_room_id_by_code(&initial_code), None);
        assert_eq!(manager.get_room_id_by_code(code_1), Some(room_id));

        // 3. At t0 + 90s: only 29s since last rotation (at t0+61s) -> no rotation
        let res_90 = manager.tick_auto_rotations(t0 + Duration::from_secs(90));
        assert!(res_90.is_empty());
        assert_eq!(broadcaster.rotated_count.load(Ordering::SeqCst), 1);

        // 4. At t0 + 125s: 64s since last rotation -> rotated again
        let res_125 = manager.tick_auto_rotations(t0 + Duration::from_secs(125));
        assert_eq!(res_125.len(), 1);
        let (_, code_2, _) = &res_125[0];
        assert_ne!(*code_2, *code_1);
        assert_eq!(broadcaster.rotated_count.load(Ordering::SeqCst), 2);
        assert_eq!(manager.get_room_id_by_code(code_1), None);
        assert_eq!(manager.get_room_id_by_code(code_2), Some(room_id));
    }
}

