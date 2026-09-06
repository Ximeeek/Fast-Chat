use crate::config::Config;
use crate::limiter::RateKey;
use crate::room::code::RoomCode;
use rand::Rng;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Lifecycle state machine for a FastChat ephemeral room:
/// Creating -> Active <-> ExtendableWindow -> Closing -> Destroyed
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RoomLifecycleState {
    /// Room code generated and 10:00 initial timer initialized.
    Creating,
    /// Normal operation state: participants chatting and negotiating WebRTC P2P channels.
    Active,
    /// Activated when remaining time <= 2:00. Room owner may extend the timer by 5:00.
    ExtendableWindow,
    /// Triggered upon timer expiry or manual close by owner. 10s grace period is active.
    Closing,
    /// Room record is purged from in-memory DashMap and ROOM_CLOSED is broadcast.
    Destroyed,
}

/// Information about a connected peer in the signaling room.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Peer {
    pub id: String,
    pub is_owner: bool,
    pub joined_at: i64,
    #[serde(skip)]
    pub rate_key: Option<RateKey>,
    #[serde(default)]
    pub is_muted: bool,
    #[serde(default)]
    pub muted_until: Option<i64>,
}

/// Optional password protection metadata for the room.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PasswordStatus {
    pub has_password: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub salt: Option<[u8; 16]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password_hash: Option<String>,
}

impl PasswordStatus {
    pub fn none() -> Self {
        Self {
            has_password: false,
            salt: None,
            password_hash: None,
        }
    }

    pub fn with_random_salt() -> Self {
        let mut rng = rand::thread_rng();
        let mut salt = [0u8; 16];
        rng.fill(&mut salt);
        Self {
            has_password: true,
            salt: Some(salt),
            password_hash: None,
        }
    }

    pub fn with_password(password: impl Into<String>) -> Self {
        let mut rng = rand::thread_rng();
        let mut salt = [0u8; 16];
        rng.fill(&mut salt);
        Self {
            has_password: true,
            salt: Some(salt),
            password_hash: Some(password.into()),
        }
    }
}

/// Errors occurring during room state manipulation.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum RoomError {
    #[error("Room capacity reached: maximum of {0} participants allowed")]
    RoomFull(usize),

    #[error("Peer '{0}' is already present in this room")]
    PeerAlreadyExists(String),

    #[error("Peer '{0}' was not found in this room")]
    PeerNotFound(String),

    #[error("Action unauthorized: only the room owner can perform this operation")]
    Unauthorized,

    #[error("Password required or invalid")]
    InvalidPassword,

    #[error("Invalid lifecycle transition from {from:?} to {to:?}")]
    InvalidStateTransition {
        from: RoomLifecycleState,
        to: RoomLifecycleState,
    },

    #[error("Room has already terminated or entered closing grace period")]
    RoomTerminated,

    #[error("Room can only be extended when in the ExtendableWindow state (remaining time <= 2m)")]
    NotInExtendableWindow,

    #[error("Room is currently locked to new participants")]
    RoomLocked,
}

/// Action resulting from evaluating the room's lifecycle against the current server time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleAction {
    /// No lifecycle change occurred.
    None,
    /// Room transitioned to a new state.
    StateChanged(RoomLifecycleState),
    /// Room grace period expired; ready to be destroyed and pruned from memory.
    Destroy,
}

/// In-memory state of an active ephemeral room.
/// FastChat guarantees zero disk footprint and zero database storage.
/// All fields live exclusively in RAM.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoomState {
    pub code: RoomCode,
    pub state: RoomLifecycleState,
    pub peers: Vec<Peer>,
    pub crypto_salt: [u8; 32],
    pub password_status: PasswordStatus,
    pub created_at: i64,
    pub expires_at: i64,
    pub closing_deadline: Option<i64>,
    pub extension_count: u32,
    #[serde(skip)]
    pub owner_rate_key: Option<RateKey>,
    #[serde(skip)]
    pub kicked_rate_keys: std::collections::HashSet<RateKey>,
    #[serde(default)]
    pub is_locked: bool,
    #[serde(default)]
    pub chat_blocked_peers: std::collections::HashSet<String>,
    #[serde(default)]
    pub file_blocked_peers: std::collections::HashSet<String>,
}

impl RoomState {
    /// Creates a new room in the `Creating` lifecycle state.
    /// The server sets `expires_at = now + initial_duration_secs`.
    pub fn new(
        code: RoomCode,
        owner_peer_id: Option<String>,
        owner_rate_key: Option<RateKey>,
        password_status: PasswordStatus,
        config: &Config,
        now_ts: i64,
    ) -> Self {
        let mut rng = rand::thread_rng();
        let mut crypto_salt = [0u8; 32];
        rng.fill(&mut crypto_salt);

        let mut peers = Vec::new();
        if let Some(owner_id) = owner_peer_id {
            peers.push(Peer {
                id: owner_id,
                is_owner: true,
                joined_at: now_ts,
                rate_key: owner_rate_key,
                is_muted: false,
                muted_until: None,
            });
        }

        Self {
            code,
            state: RoomLifecycleState::Creating,
            peers,
            crypto_salt,
            password_status,
            created_at: now_ts,
            expires_at: now_ts + config.initial_room_duration_secs,
            closing_deadline: None,
            extension_count: 0,
            owner_rate_key,
            kicked_rate_keys: std::collections::HashSet::new(),
            is_locked: false,
            chat_blocked_peers: std::collections::HashSet::new(),
            file_blocked_peers: std::collections::HashSet::new(),
        }
    }

    /// Sets room lock status. When locked, new participants cannot join.
    pub fn set_locked(&mut self, locked: bool) {
        self.is_locked = locked;
    }

    /// Returns whether the room is actively alive (not destroyed, not in closing grace period, and unexpired).
    pub fn is_active(&self, now_ts: i64) -> bool {
        self.state != RoomLifecycleState::Destroyed
            && self.state != RoomLifecycleState::Closing
            && now_ts < self.expires_at
    }

    /// Transitions room to `Active`.
    pub fn activate(&mut self) -> Result<(), RoomError> {
        match self.state {
            RoomLifecycleState::Creating | RoomLifecycleState::ExtendableWindow => {
                self.state = RoomLifecycleState::Active;
                Ok(())
            }
            RoomLifecycleState::Active => Ok(()),
            RoomLifecycleState::Closing | RoomLifecycleState::Destroyed => {
                Err(RoomError::RoomTerminated)
            }
        }
    }

    /// Adds a peer to the room while enforcing capacity limits.
    pub fn add_peer(
        &mut self,
        peer_id: String,
        is_owner: bool,
        now_ts: i64,
        config: &Config,
        rate_key: Option<RateKey>,
    ) -> Result<(), RoomError> {
        if matches!(
            self.state,
            RoomLifecycleState::Closing | RoomLifecycleState::Destroyed
        ) {
            return Err(RoomError::RoomTerminated);
        }

        if self.is_locked {
            return Err(RoomError::RoomLocked);
        }

        if self.peers.len() >= config.max_participants_per_room {
            return Err(RoomError::RoomFull(config.max_participants_per_room));
        }

        if self.peers.iter().any(|p| p.id == peer_id) {
            return Err(RoomError::PeerAlreadyExists(peer_id));
        }

        self.peers.push(Peer {
            id: peer_id,
            is_owner,
            joined_at: now_ts,
            rate_key,
            is_muted: false,
            muted_until: None,
        });

        if is_owner {
            self.owner_rate_key = rate_key;
        }

        // Automatically activate when first peer/owner joins
        if self.state == RoomLifecycleState::Creating {
            self.state = RoomLifecycleState::Active;
        }

        Ok(())
    }

    /// Verifies whether a provided password token satisfies the room's access requirement.
    pub fn verify_password(&self, provided_password: Option<&str>) -> bool {
        if !self.password_status.has_password {
            return true;
        }

        match (&self.password_status.password_hash, provided_password) {
            (Some(expected), Some(provided)) => expected == provided,
            (None, _) => true,
            (Some(_), None) => false,
        }
    }

    /// Adds a peer to the room while enforcing capacity limits and password protection.
    pub fn add_peer_with_password(
        &mut self,
        peer_id: String,
        is_owner: bool,
        password: Option<&str>,
        now_ts: i64,
        config: &Config,
        rate_key: Option<RateKey>,
    ) -> Result<(), RoomError> {
        if !is_owner && !self.verify_password(password) {
            return Err(RoomError::InvalidPassword);
        }
        self.add_peer(peer_id, is_owner, now_ts, config, rate_key)
    }

    /// Removes a peer from the room.
    pub fn remove_peer(&mut self, peer_id: &str) -> Result<Peer, RoomError> {
        let pos = self
            .peers
            .iter()
            .position(|p| p.id == peer_id)
            .ok_or_else(|| RoomError::PeerNotFound(peer_id.to_string()))?;

        self.chat_blocked_peers.remove(peer_id);
        self.file_blocked_peers.remove(peer_id);

        Ok(self.peers.remove(pos))
    }

    /// Kicks a peer from the room and records their rate key in the in-memory blacklist.
    pub fn kick_peer(&mut self, peer_id: &str) -> Result<Peer, RoomError> {
        let peer = self.remove_peer(peer_id)?;
        if let Some(rate_key) = peer.rate_key {
            self.kicked_rate_keys.insert(rate_key);
        }
        Ok(peer)
    }

    /// Checks if a rate key has been kicked from this room session.
    pub fn is_rate_key_kicked(&self, rate_key: &RateKey) -> bool {
        self.kicked_rate_keys.contains(rate_key)
    }

    /// Sets whether a peer is blocked from receiving chat messages in this room.
    pub fn set_chat_visibility_blocked(
        &mut self,
        peer_id: &str,
        blocked: bool,
    ) -> Result<(), RoomError> {
        if !self.peers.iter().any(|p| p.id == peer_id) {
            return Err(RoomError::PeerNotFound(peer_id.to_string()));
        }

        if blocked {
            self.chat_blocked_peers.insert(peer_id.to_string());
        } else {
            self.chat_blocked_peers.remove(peer_id);
        }
        Ok(())
    }

    /// Sets whether a peer is blocked from receiving files in this room.
    pub fn set_file_visibility_blocked(
        &mut self,
        peer_id: &str,
        blocked: bool,
    ) -> Result<(), RoomError> {
        if !self.peers.iter().any(|p| p.id == peer_id) {
            return Err(RoomError::PeerNotFound(peer_id.to_string()));
        }

        if blocked {
            self.file_blocked_peers.insert(peer_id.to_string());
        } else {
            self.file_blocked_peers.remove(peer_id);
        }
        Ok(())
    }

    /// Checks whether a peer is blocked from receiving chat messages.
    pub fn is_chat_blocked(&self, peer_id: &str) -> bool {
        self.chat_blocked_peers.contains(peer_id)
    }

    /// Checks whether a peer is blocked from receiving files.
    pub fn is_file_blocked(&self, peer_id: &str) -> bool {
        self.file_blocked_peers.contains(peer_id)
    }

    /// Returns a list of all peers currently blocked from receiving chat messages.
    pub fn get_chat_blocked_peers(&self) -> Vec<String> {
        self.chat_blocked_peers.iter().cloned().collect()
    }

    /// Returns a list of all peers currently blocked from receiving files.
    pub fn get_file_blocked_peers(&self) -> Vec<String> {
        self.file_blocked_peers.iter().cloned().collect()
    }

    /// Mutes a peer either permanently (duration_secs = None) or temporarily until now_ts + duration_secs.
    pub fn mute_peer(
        &mut self,
        target_peer_id: &str,
        duration_secs: Option<u64>,
        now_ts: i64,
    ) -> Result<Option<i64>, RoomError> {
        let peer = self
            .peers
            .iter_mut()
            .find(|p| p.id == target_peer_id)
            .ok_or_else(|| RoomError::PeerNotFound(target_peer_id.to_string()))?;

        peer.is_muted = true;
        let until = duration_secs.map(|d| now_ts + d as i64);
        peer.muted_until = until;
        Ok(until)
    }

    /// Unmutes a peer and clears any mute expiration timestamp.
    pub fn unmute_peer(&mut self, target_peer_id: &str) -> Result<(), RoomError> {
        let peer = self
            .peers
            .iter_mut()
            .find(|p| p.id == target_peer_id)
            .ok_or_else(|| RoomError::PeerNotFound(target_peer_id.to_string()))?;

        peer.is_muted = false;
        peer.muted_until = None;
        Ok(())
    }

    /// Checks for expired temporary mutes, clears them, and returns the list of unmuted peer IDs.
    pub fn check_expired_mutes(&mut self, now_ts: i64) -> Vec<String> {
        let mut unmuted = Vec::new();
        for peer in &mut self.peers {
            if peer.is_muted {
                if let Some(until) = peer.muted_until {
                    if now_ts >= until {
                        peer.is_muted = false;
                        peer.muted_until = None;
                        unmuted.push(peer.id.clone());
                    }
                }
            }
        }
        unmuted
    }

    /// Returns the list of currently active muted peers and their expiration timestamps.
    pub fn get_muted_peers(&self, now_ts: i64) -> Vec<crate::ws::protocol::MutedPeerInfo> {
        self.peers
            .iter()
            .filter(|p| {
                if !p.is_muted {
                    return false;
                }
                if let Some(until) = p.muted_until {
                    now_ts < until
                } else {
                    true
                }
            })
            .map(|p| crate::ws::protocol::MutedPeerInfo {
                peer_id: p.id.clone(),
                peer_id_camel: p.id.clone(),
                muted_until: p.muted_until,
                muted_until_camel: p.muted_until,
            })
            .collect()
    }

    /// Checks if a given peer is the designated owner of this room.
    pub fn is_owner(&self, peer_id: &str) -> bool {
        self.peers
            .iter()
            .any(|p| p.id == peer_id && p.is_owner)
    }

    /// Returns the peer ID of the current room owner, if assigned.
    pub fn get_owner_id(&self) -> Option<String> {
        self.peers
            .iter()
            .find(|p| p.is_owner)
            .map(|p| p.id.clone())
    }

    /// Returns a borrowed reference to the peer ID of the current room owner, if assigned.
    pub fn owner_peer_id(&self) -> Option<&str> {
        self.peers
            .iter()
            .find(|p| p.is_owner)
            .map(|p| p.id.as_str())
    }

    /// Resolves the role assigned to the specified peer in this room.
    pub fn get_role(&self, peer_id: &crate::room::permissions::PeerId) -> crate::room::permissions::Role {
        crate::room::permissions::get_role(self, peer_id)
    }

    /// Checks whether the specified peer holds the requested permission in this room.
    pub fn has_permission(
        &self,
        peer_id: &crate::room::permissions::PeerId,
        permission: crate::room::permissions::Permission,
    ) -> bool {
        crate::room::permissions::has_permission(self, peer_id, permission)
    }

    /// Sets the designated owner of this room to the specified peer ID.
    /// Resets owner status for all other peers and updates `owner_rate_key`.
    /// Returns true if the peer was found.
    pub fn set_owner(&mut self, peer_id: &str) -> bool {
        let mut found = false;
        let mut new_rate_key = None;
        for p in &mut self.peers {
            if p.id == peer_id {
                p.is_owner = true;
                new_rate_key = p.rate_key;
                found = true;
            } else {
                p.is_owner = false;
            }
        }
        if found {
            self.owner_rate_key = new_rate_key;
        }
        found
    }

    /// Evaluates the room's lifecycle against server time and transitions state accordingly.
    /// This is invoked by the background ticker to keep the server as the single source of truth.
    pub fn evaluate_lifecycle(&mut self, now_ts: i64, config: &Config) -> LifecycleAction {
        // Rooms that have no active participants (and are past creation) are destroyed immediately.
        if self.peers.is_empty() && self.state != RoomLifecycleState::Creating {
            self.state = RoomLifecycleState::Destroyed;
            return LifecycleAction::Destroy;
        }

        match self.state {
            RoomLifecycleState::Closing => {
                if let Some(deadline) = self.closing_deadline
                    && now_ts >= deadline
                {
                    self.state = RoomLifecycleState::Destroyed;
                    return LifecycleAction::Destroy;
                }
                LifecycleAction::None
            }
            RoomLifecycleState::Destroyed => LifecycleAction::Destroy,
            RoomLifecycleState::Creating | RoomLifecycleState::Active => {
                if now_ts >= self.expires_at {
                    self.initiate_closing(now_ts, config);
                    LifecycleAction::StateChanged(RoomLifecycleState::Closing)
                } else if self.expires_at - now_ts <= config.extendable_threshold_secs {
                    self.state = RoomLifecycleState::ExtendableWindow;
                    LifecycleAction::StateChanged(RoomLifecycleState::ExtendableWindow)
                } else {
                    LifecycleAction::None
                }
            }
            RoomLifecycleState::ExtendableWindow => {
                if now_ts >= self.expires_at {
                    self.initiate_closing(now_ts, config);
                    LifecycleAction::StateChanged(RoomLifecycleState::Closing)
                } else {
                    LifecycleAction::None
                }
            }
        }
    }

    /// Extends the room's lifetime by `config.extension_duration_secs` (5:00 default).
    /// Can only be performed by the room owner when in `ExtendableWindow` (remaining <= 2:00).
    /// Upon extension, the room transitions back to `Active`.
    pub fn extend_by_owner(
        &mut self,
        peer_id: &str,
        config: &Config,
    ) -> Result<(), RoomError> {
        if !self.is_owner(peer_id) {
            return Err(RoomError::Unauthorized);
        }

        if self.state != RoomLifecycleState::ExtendableWindow {
            return Err(RoomError::NotInExtendableWindow);
        }

        self.expires_at += config.extension_duration_secs;
        self.extension_count += 1;
        self.state = RoomLifecycleState::Active;

        Ok(())
    }

    /// Manually initiates room closing by the owner.
    /// Transitions state to `Closing` with a 10s grace period.
    pub fn close_by_owner(
        &mut self,
        peer_id: &str,
        now_ts: i64,
        config: &Config,
    ) -> Result<(), RoomError> {
        if !self.is_owner(peer_id) {
            return Err(RoomError::Unauthorized);
        }

        if matches!(
            self.state,
            RoomLifecycleState::Closing | RoomLifecycleState::Destroyed
        ) {
            return Err(RoomError::RoomTerminated);
        }

        self.initiate_closing(now_ts, config);
        Ok(())
    }

    /// Reconfigures room password protection when requested by the room owner.
    /// Notice: Server stores only the verifier token and cleartext salt; E2EE keys are never computed or stored.
    pub fn rekey_by_owner(
        &mut self,
        peer_id: &str,
        password: &str,
        salt: Option<[u8; 16]>,
    ) -> Result<(), RoomError> {
        if !self.has_permission(peer_id, crate::room::permissions::Permission::SetRoomPassword) {
            return Err(RoomError::Unauthorized);
        }

        if matches!(
            self.state,
            RoomLifecycleState::Closing | RoomLifecycleState::Destroyed
        ) {
            return Err(RoomError::RoomTerminated);
        }

        let assigned_salt = salt.unwrap_or_else(|| {
            let mut rng = rand::thread_rng();
            let mut s = [0u8; 16];
            rng.fill(&mut s);
            s
        });

        self.password_status = PasswordStatus {
            has_password: true,
            salt: Some(assigned_salt),
            password_hash: Some(password.to_string()),
        };

        Ok(())
    }

    /// Internal helper to set up closing grace period.
    fn initiate_closing(&mut self, now_ts: i64, config: &Config) {
        self.state = RoomLifecycleState::Closing;
        self.closing_deadline = Some(now_ts + config.closing_grace_period_secs);
    }

    /// Returns remaining seconds until expiration, or 0 if expired.
    pub fn remaining_seconds(&self, now_ts: i64) -> i64 {
        (self.expires_at - now_ts).max(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_code() -> RoomCode {
        RoomCode::new("1234-5678-9012").unwrap()
    }

    #[test]
    fn test_room_creation() {
        let config = Config::default();
        let now = 1_000_000;
        let room = RoomState::new(
            sample_code(),
            Some("owner-peer".to_string()),
            None,
            PasswordStatus::none(),
            &config,
            now,
        );

        assert_eq!(room.state, RoomLifecycleState::Creating);
        assert_eq!(room.created_at, now);
        assert_eq!(room.expires_at, now + 600);
        assert_eq!(room.peers.len(), 1);
        assert!(room.is_owner("owner-peer"));
        assert_eq!(room.crypto_salt.len(), 32);
    }

    #[test]
    fn test_participant_limit_enforcement() {
        let config = Config {
            max_participants_per_room: 2,
            ..Default::default()
        };

        let mut room = RoomState::new(
            sample_code(),
            Some("owner".to_string()),
            None,
            PasswordStatus::none(),
            &config,
            1000,
        );
        assert_eq!(room.state, RoomLifecycleState::Creating);
        room.activate().unwrap();
        assert_eq!(room.state, RoomLifecycleState::Active);

        // Add 2nd participant (allowed)
        let res2 = room.add_peer("peer2".to_string(), false, 1001, &config, None);
        assert!(res2.is_ok());

        // Add 3rd participant (should fail)
        let res3 = room.add_peer("peer3".to_string(), false, 1002, &config, None);
        assert_eq!(res3, Err(RoomError::RoomFull(2)));
    }

    #[test]
    fn test_lifecycle_transitions_and_extension() {
        let config = Config::default(); // initial 600s, threshold 120s, ext 300s, grace 10s
        let start_time = 10_000;
        let mut room = RoomState::new(
            sample_code(),
            Some("owner".to_string()),
            None,
            PasswordStatus::none(),
            &config,
            start_time,
        );

        // Activate
        room.activate().unwrap();
        assert_eq!(room.state, RoomLifecycleState::Active);

        // Advance to 5 minutes (remaining 300s > 120s)
        let action = room.evaluate_lifecycle(start_time + 300, &config);
        assert_eq!(action, LifecycleAction::None);
        assert_eq!(room.state, RoomLifecycleState::Active);

        // Advance to 8 minutes (remaining 120s <= 120s) -> ExtendableWindow
        let action = room.evaluate_lifecycle(start_time + 480, &config);
        assert_eq!(
            action,
            LifecycleAction::StateChanged(RoomLifecycleState::ExtendableWindow)
        );
        assert_eq!(room.state, RoomLifecycleState::ExtendableWindow);

        // Non-owner tries to extend -> fails
        let non_owner_res = room.extend_by_owner("impostor", &config);
        assert_eq!(non_owner_res, Err(RoomError::Unauthorized));

        // Owner extends -> succeeds and transitions back to Active
        let owner_res = room.extend_by_owner("owner", &config);
        assert!(owner_res.is_ok());
        assert_eq!(room.state, RoomLifecycleState::Active);
        assert_eq!(room.expires_at, start_time + 600 + 300); // 900s
        assert_eq!(room.extension_count, 1);

        // Advance past new expiry -> Closing
        let action = room.evaluate_lifecycle(start_time + 901, &config);
        assert_eq!(
            action,
            LifecycleAction::StateChanged(RoomLifecycleState::Closing)
        );
        assert_eq!(room.state, RoomLifecycleState::Closing);
        assert_eq!(room.closing_deadline, Some(start_time + 901 + 10));

        // During grace period (e.g. +5s)
        let action = room.evaluate_lifecycle(start_time + 906, &config);
        assert_eq!(action, LifecycleAction::None);
        assert_eq!(room.state, RoomLifecycleState::Closing);

        // After grace period (+10s) -> Destroy
        let action = room.evaluate_lifecycle(start_time + 911, &config);
        assert_eq!(action, LifecycleAction::Destroy);
        assert_eq!(room.state, RoomLifecycleState::Destroyed);
    }

    #[test]
    fn test_manual_close_by_owner() {
        let config = Config::default();
        let start_time = 10_000;
        let mut room = RoomState::new(
            sample_code(),
            Some("owner".to_string()),
            None,
            PasswordStatus::none(),
            &config,
            start_time,
        );

        // Non-owner cannot close
        let err = room.close_by_owner("stranger", start_time + 50, &config);
        assert_eq!(err, Err(RoomError::Unauthorized));

        // Owner closes
        let ok = room.close_by_owner("owner", start_time + 50, &config);
        assert!(ok.is_ok());
        assert_eq!(room.state, RoomLifecycleState::Closing);
        assert_eq!(room.closing_deadline, Some(start_time + 50 + 10));

        // Destroy after grace period
        let action = room.evaluate_lifecycle(start_time + 60, &config);
        assert_eq!(action, LifecycleAction::Destroy);
        assert_eq!(room.state, RoomLifecycleState::Destroyed);
    }

    #[test]
    fn test_password_and_rekey_flow() {
        let config = Config::default();
        let mut room = RoomState::new(
            sample_code(),
            Some("owner".to_string()),
            None,
            PasswordStatus::none(),
            &config,
            1000,
        );

        // Before rekey, room has no password: peer can join without password
        assert!(room.verify_password(None));
        assert!(room.add_peer_with_password("peer1".to_string(), false, None, 1001, &config, None).is_ok());

        // Non-owner cannot rekey
        let err = room.rekey_by_owner("peer1", "secret123", None);
        assert_eq!(err, Err(RoomError::Unauthorized));

        // Owner rekeys room with password
        assert!(room.rekey_by_owner("owner", "secret123", None).is_ok());
        assert!(room.password_status.has_password);
        assert!(room.password_status.salt.is_some());

        // Joining without password fails
        assert!(!room.verify_password(None));
        let join_no_pw = room.add_peer_with_password("peer2".to_string(), false, None, 1002, &config, None);
        assert_eq!(join_no_pw, Err(RoomError::InvalidPassword));

        // Joining with wrong password fails
        assert!(!room.verify_password(Some("wrong")));
        let join_wrong = room.add_peer_with_password("peer2".to_string(), false, Some("wrong"), 1002, &config, None);
        assert_eq!(join_wrong, Err(RoomError::InvalidPassword));

        // Joining with correct password succeeds
        assert!(room.verify_password(Some("secret123")));
        let join_ok = room.add_peer_with_password("peer2".to_string(), false, Some("secret123"), 1002, &config, None);
        assert!(join_ok.is_ok());
    }

    #[test]
    fn test_owner_transfer_and_empty_room_destruction() {
        let config = Config::default();
        let key_alice = RateKey([1u8; 16]);
        let key_bob = RateKey([2u8; 16]);
        let mut room = RoomState::new(
            sample_code(),
            Some("alice".to_string()),
            Some(key_alice),
            PasswordStatus::none(),
            &config,
            1000,
        );

        assert_eq!(room.get_owner_id(), Some("alice".to_string()));
        assert_eq!(room.owner_rate_key, Some(key_alice));
        assert!(room.add_peer("bob".to_string(), false, 1001, &config, Some(key_bob)).is_ok());

        // Transfer ownership to bob
        assert!(room.set_owner("bob"));
        assert_eq!(room.get_owner_id(), Some("bob".to_string()));
        assert_eq!(room.owner_rate_key, Some(key_bob));
        assert!(!room.is_owner("alice"));
        assert!(room.is_owner("bob"));

        // Setting non-existent peer as owner returns false and keeps owner_rate_key
        assert!(!room.set_owner("charlie"));
        assert_eq!(room.owner_rate_key, Some(key_bob));

        // Remove alice then bob -> room empty
        assert!(room.remove_peer("alice").is_ok());
        assert!(room.remove_peer("bob").is_ok());
        assert!(room.peers.is_empty());

        // Empty active room triggers immediate Destroy lifecycle action
        let action = room.evaluate_lifecycle(1050, &config);
        assert_eq!(action, LifecycleAction::Destroy);
        assert_eq!(room.state, RoomLifecycleState::Destroyed);
    }

    #[test]
    fn test_kick_peer_records_rate_key() {
        let config = Config::default();
        let key_alice = RateKey([1u8; 16]);
        let key_bob = RateKey([2u8; 16]);
        let mut room = RoomState::new(
            sample_code(),
            Some("alice".to_string()),
            Some(key_alice),
            PasswordStatus::none(),
            &config,
            1000,
        );
        room.add_peer("bob".to_string(), false, 1001, &config, Some(key_bob)).unwrap();

        assert!(!room.is_rate_key_kicked(&key_bob));
        let kicked = room.kick_peer("bob").expect("Kick should succeed");
        assert_eq!(kicked.id, "bob");
        assert_eq!(room.peers.len(), 1);
        assert!(room.is_rate_key_kicked(&key_bob));
        assert!(!room.is_rate_key_kicked(&key_alice));

        // Kicking non-existent peer returns error
        assert_eq!(room.kick_peer("unknown"), Err(RoomError::PeerNotFound("unknown".to_string())));
    }

    #[test]
    fn test_mute_peer_temporary_and_permanent_flow() {
        let config = Config::default();
        let mut room = RoomState::new(
            sample_code(),
            Some("alice".to_string()),
            None,
            PasswordStatus::none(),
            &config,
            1000,
        );
        room.add_peer("bob".to_string(), false, 1001, &config, None).unwrap();

        // 1. Temporary mute for 60s
        let until = room.mute_peer("bob", Some(60), 1000).unwrap();
        assert_eq!(until, Some(1060));
        let muted_list = room.get_muted_peers(1000);
        assert_eq!(muted_list.len(), 1);
        assert_eq!(muted_list[0].peer_id, "bob");
        assert_eq!(muted_list[0].muted_until, Some(1060));

        // 2. Before expiration, check_expired_mutes returns empty
        assert!(room.check_expired_mutes(1059).is_empty());
        assert_eq!(room.get_muted_peers(1059).len(), 1);

        // 3. At or after expiration, check_expired_mutes returns bob and unsets mute
        let unmuted = room.check_expired_mutes(1060);
        assert_eq!(unmuted, vec!["bob".to_string()]);
        assert!(room.get_muted_peers(1060).is_empty());

        // 4. Permanent mute (duration = None)
        let until_perm = room.mute_peer("bob", None, 1060).unwrap();
        assert_eq!(until_perm, None);
        assert_eq!(room.get_muted_peers(2000).len(), 1);
        // Permanent mute does not expire in check_expired_mutes
        assert!(room.check_expired_mutes(99999).is_empty());

        // 5. Manual unmute
        assert!(room.unmute_peer("bob").is_ok());
        assert!(room.get_muted_peers(2000).is_empty());
    }

    #[test]
    fn test_room_lock_blocks_join() {
        let config = Config::default();
        let mut room = RoomState::new(
            sample_code(),
            Some("alice".to_string()),
            None,
            PasswordStatus::none(),
            &config,
            1000,
        );
        assert!(!room.is_locked);

        // Lock room
        room.set_locked(true);
        assert!(room.is_locked);

        // Attempt to add peer fails with RoomLocked
        let res = room.add_peer("bob".to_string(), false, 1001, &config, None);
        assert_eq!(res, Err(RoomError::RoomLocked));

        // Unlock room
        room.set_locked(false);
        assert!(!room.is_locked);

        // Bob can now join
        let res_ok = room.add_peer("bob".to_string(), false, 1002, &config, None);
        assert!(res_ok.is_ok());
    }

    #[test]
    fn test_chat_and_file_visibility_blocking() {
        let config = Config::default();
        let mut room = RoomState::new(
            sample_code(),
            Some("alice".to_string()),
            None,
            PasswordStatus::none(),
            &config,
            1000,
        );
        room.add_peer("bob".to_string(), false, 1001, &config, None).unwrap();
        room.add_peer("charlie".to_string(), false, 1002, &config, None).unwrap();

        // Initially no peers are blocked
        assert!(!room.is_chat_blocked("bob"));
        assert!(!room.is_file_blocked("bob"));
        assert!(room.get_chat_blocked_peers().is_empty());
        assert!(room.get_file_blocked_peers().is_empty());

        // Blocking unknown peer returns error
        assert_eq!(
            room.set_chat_visibility_blocked("unknown", true),
            Err(RoomError::PeerNotFound("unknown".to_string()))
        );
        assert_eq!(
            room.set_file_visibility_blocked("unknown", true),
            Err(RoomError::PeerNotFound("unknown".to_string()))
        );

        // Block bob from chat
        assert!(room.set_chat_visibility_blocked("bob", true).is_ok());
        assert!(room.is_chat_blocked("bob"));
        assert!(!room.is_chat_blocked("charlie"));
        assert_eq!(room.get_chat_blocked_peers(), vec!["bob".to_string()]);

        // Block charlie from files
        assert!(room.set_file_visibility_blocked("charlie", true).is_ok());
        assert!(room.is_file_blocked("charlie"));
        assert!(!room.is_file_blocked("bob"));
        assert_eq!(room.get_file_blocked_peers(), vec!["charlie".to_string()]);

        // Unblock bob from chat
        assert!(room.set_chat_visibility_blocked("bob", false).is_ok());
        assert!(!room.is_chat_blocked("bob"));
        assert!(room.get_chat_blocked_peers().is_empty());

        // Block bob from files as well
        assert!(room.set_file_visibility_blocked("bob", true).is_ok());
        assert!(room.is_file_blocked("bob"));

        // Removing bob cleans up from file_blocked_peers
        let _ = room.remove_peer("bob");
        assert!(!room.is_file_blocked("bob"));
        assert_eq!(room.get_file_blocked_peers(), vec!["charlie".to_string()]);
    }
}

