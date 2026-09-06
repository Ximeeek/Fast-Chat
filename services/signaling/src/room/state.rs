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
        }
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

        Ok(self.peers.remove(pos))
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
}

