use crate::room::id::RoomId;
use crate::ws::protocol::ServerMessage;
use dashmap::DashMap;
use std::sync::Arc;
use tokio::sync::mpsc::UnboundedSender;

use rand::Rng;
use std::fmt;

/// Ephemeral in-memory identifier uniquely distinguishing a single WebSocket connection instance.
/// Lives strictly in RAM for the lifetime of the socket; completely independent from IP or rate keys.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ConnectionId(pub String);

impl ConnectionId {
    /// Generates a random 16-byte hex connection identifier.
    pub fn generate() -> Self {
        let mut rng = rand::thread_rng();
        let mut bytes = [0u8; 16];
        rng.fill(&mut bytes);
        Self(crate::ws::protocol::format_hex(&bytes))
    }
}

impl fmt::Display for ConnectionId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Routing metadata for a room defining hopping security settings and active owner.
#[derive(Debug, Clone, Default)]
pub struct RoomRoutingMeta {
    pub hopping_enabled: bool,
    pub owner_peer_id: Option<String>,
}

/// In-memory registry of active WebSocket peer outbound channels and per-connection room mappings.
/// Keyed by immutable `RoomId` to ensure signaling relays and moderation operate independently
/// of public room code rotation.
#[derive(Debug, Clone, Default)]
pub struct PeerSessionRegistry {
    rooms: Arc<DashMap<RoomId, DashMap<String, UnboundedSender<ServerMessage>>>>,
    connection_rooms: Arc<DashMap<ConnectionId, (RoomId, String)>>,
    room_meta: Arc<DashMap<RoomId, RoomRoutingMeta>>,
}

impl PeerSessionRegistry {
    /// Creates a new empty session registry.
    pub fn new() -> Self {
        Self {
            rooms: Arc::new(DashMap::new()),
            connection_rooms: Arc::new(DashMap::new()),
            room_meta: Arc::new(DashMap::new()),
        }
    }

    /// Sets or updates routing metadata for a room.
    pub fn set_room_meta(&self, room_id: RoomId, hopping_enabled: bool, owner_peer_id: Option<String>) {
        self.room_meta.insert(
            room_id,
            RoomRoutingMeta {
                hopping_enabled,
                owner_peer_id,
            },
        );
    }

    /// Updates the owner peer ID for a room.
    pub fn set_room_owner(&self, room_id: &RoomId, owner_peer_id: Option<String>) {
        if let Some(mut meta) = self.room_meta.get_mut(room_id) {
            meta.owner_peer_id = owner_peer_id;
        }
    }

    /// Checks whether room code redaction should be applied for a specific recipient peer.
    pub fn should_redact_for_peer(&self, room_id: &RoomId, target_peer_id: &str) -> bool {
        if let Some(meta) = self.room_meta.get(room_id) {
            meta.hopping_enabled && meta.owner_peer_id.as_deref() != Some(target_peer_id)
        } else {
            false
        }
    }

    /// Checks if a given WebSocket connection is currently registered in any room.
    pub fn is_connection_in_room(&self, conn_id: &ConnectionId) -> bool {
        self.connection_rooms.contains_key(conn_id)
    }

    /// Retrieves the current room ID and peer ID registered to a connection, if any.
    pub fn get_connection_session(&self, conn_id: &ConnectionId) -> Option<(RoomId, String)> {
        self.connection_rooms.get(conn_id).map(|r| r.value().clone())
    }

    /// Registers a connection to a specific room ID and peer ID, and saves its outbound channel.
    pub fn register_connection(
        &self,
        conn_id: ConnectionId,
        room_id: RoomId,
        peer_id: String,
        tx: UnboundedSender<ServerMessage>,
    ) {
        self.connection_rooms.insert(conn_id, (room_id, peer_id.clone()));
        self.register(&room_id, peer_id, tx);
    }

    /// Unregisters a connection and removes its outbound channel from the associated room.
    pub fn unregister_connection(
        &self,
        conn_id: &ConnectionId,
    ) -> Option<(RoomId, String, Option<UnboundedSender<ServerMessage>>)> {
        if let Some((_, (room_id, peer_id))) = self.connection_rooms.remove(conn_id) {
            let tx = self.unregister(&room_id, &peer_id);
            Some((room_id, peer_id, tx))
        } else {
            None
        }
    }

    /// Registers an outbound channel for a peer in the specified room.
    pub fn register(&self, room_id: &RoomId, peer_id: String, tx: UnboundedSender<ServerMessage>) {
        let entry = self.rooms.entry(*room_id).or_default();
        entry.insert(peer_id, tx);
    }

    /// Unregisters an outbound channel for a peer. Removes the room entry if no peers remain.
    pub fn unregister(&self, room_id: &RoomId, peer_id: &str) -> Option<UnboundedSender<ServerMessage>> {
        let mut remove_room = false;
        let removed = if let Some(room_peers) = self.rooms.get(room_id) {
            let res = room_peers.remove(peer_id).map(|(_, tx)| tx);
            if room_peers.is_empty() {
                remove_room = true;
            }
            res
        } else {
            None
        };

        if remove_room {
            self.rooms.remove(room_id);
            self.room_meta.remove(room_id);
        }

        removed
    }

    /// Sends a message directly to a target peer in the specified room.
    /// Redacts room code automatically if hopping is enabled and the recipient is not the room owner.
    /// Returns `true` if the message was successfully dispatched, `false` if target not found.
    pub fn send_to_peer(&self, room_id: &RoomId, target_peer_id: &str, msg: ServerMessage) -> bool {
        let should_redact = self.should_redact_for_peer(room_id, target_peer_id);
        let msg = msg.redact_code(should_redact);
        self.rooms
            .get(room_id)
            .and_then(|room_peers| room_peers.get(target_peer_id).map(|tx| tx.send(msg).is_ok()))
            .unwrap_or(false)
    }

    /// Broadcasts a message to all active peers in the room, optionally excluding a specific peer.
    /// Redacts room code automatically on a per-peer basis for non-owners when hopping is enabled.
    /// Returns the number of peers to which the message was successfully dispatched.
    pub fn broadcast(&self, room_id: &RoomId, msg: ServerMessage, exclude_peer_id: Option<&str>) -> usize {
        let mut sent_count = 0;
        if let Some(room_peers) = self.rooms.get(room_id) {
            for entry in room_peers.iter() {
                let peer_id = entry.key().as_str();
                if exclude_peer_id == Some(peer_id) {
                    continue;
                }
                let should_redact = self.should_redact_for_peer(room_id, peer_id);
                let peer_msg = msg.clone().redact_code(should_redact);
                if entry.value().send(peer_msg).is_ok() {
                    sent_count += 1;
                }
            }
        }
        sent_count
    }

    /// Lists all active peer IDs currently connected in the specified room.
    pub fn list_peers(&self, room_id: &RoomId) -> Vec<String> {
        if let Some(room_peers) = self.rooms.get(room_id) {
            room_peers.iter().map(|entry| entry.key().clone()).collect()
        } else {
            Vec::new()
        }
    }

    /// Checks if a peer is currently connected in the specified room.
    pub fn contains_peer(&self, room_id: &RoomId, peer_id: &str) -> bool {
        self.rooms
            .get(room_id)
            .map(|peers| peers.contains_key(peer_id))
            .unwrap_or(false)
    }

    /// Evicts an entire room and its registered peer sessions.
    pub fn remove_room(&self, room_id: &RoomId) {
        self.rooms.remove(room_id);
        self.room_meta.remove(room_id);
    }

    /// Returns the number of active rooms currently holding registered peer sessions.
    pub fn room_count(&self) -> usize {
        self.rooms.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    #[tokio::test]
    async fn test_session_registry_register_and_relay() {
        let registry = PeerSessionRegistry::new();
        let room_id = RoomId::generate();

        let (tx_a, mut rx_a) = mpsc::unbounded_channel();
        let (tx_b, mut rx_b) = mpsc::unbounded_channel();

        registry.register(&room_id, "alice".to_string(), tx_a);
        registry.register(&room_id, "bob".to_string(), tx_b);

        assert_eq!(registry.list_peers(&room_id).len(), 2);
        assert!(registry.contains_peer(&room_id, "alice"));
        assert!(registry.contains_peer(&room_id, "bob"));
        assert!(!registry.contains_peer(&room_id, "charlie"));

        // 1:1 Direct message relay from Alice to Bob
        let relay_msg = ServerMessage::sdp_offer("alice", serde_json::json!({"type": "offer"}));
        let sent = registry.send_to_peer(&room_id, "bob", relay_msg.clone());
        assert!(sent);

        let received_by_b = rx_b.recv().await.expect("Bob should receive offer");
        assert_eq!(received_by_b, relay_msg);
        assert!(rx_a.try_recv().is_err()); // Alice did not receive direct message

        // Room broadcast excluding Alice
        let broadcast_msg = ServerMessage::peer_joined("bob");
        let count = registry.broadcast(&room_id, broadcast_msg.clone(), Some("alice"));
        assert_eq!(count, 1);
        let b_broadcast = rx_b.recv().await.expect("Bob receives broadcast");
        assert_eq!(b_broadcast, broadcast_msg);

        // Unregister Alice
        registry.unregister(&room_id, "alice");
        assert!(!registry.contains_peer(&room_id, "alice"));
        assert_eq!(registry.list_peers(&room_id), vec!["bob".to_string()]);

        // Unregister Bob -> room map pruned
        registry.unregister(&room_id, "bob");
        assert_eq!(registry.room_count(), 0);
    }

    #[tokio::test]
    async fn test_connection_registry_lifecycle() {
        let registry = PeerSessionRegistry::new();
        let room_id = RoomId::generate();
        let conn_a = ConnectionId::generate();
        let conn_b = ConnectionId::generate();
        assert_ne!(conn_a, conn_b);

        let (tx_a, _rx_a) = mpsc::unbounded_channel();
        let (tx_b, _rx_b) = mpsc::unbounded_channel();

        assert!(!registry.is_connection_in_room(&conn_a));
        assert!(!registry.is_connection_in_room(&conn_b));

        registry.register_connection(conn_a.clone(), room_id, "alice".to_string(), tx_a);
        assert!(registry.is_connection_in_room(&conn_a));
        assert_eq!(
            registry.get_connection_session(&conn_a),
            Some((room_id, "alice".to_string()))
        );
        assert!(!registry.is_connection_in_room(&conn_b));

        registry.register_connection(conn_b.clone(), room_id, "bob".to_string(), tx_b);
        assert!(registry.is_connection_in_room(&conn_b));

        let unreg_a = registry.unregister_connection(&conn_a);
        assert!(unreg_a.is_some());
        assert!(!registry.is_connection_in_room(&conn_a));
        assert!(registry.is_connection_in_room(&conn_b));

        let unreg_b = registry.unregister_connection(&conn_b);
        assert!(unreg_b.is_some());
        assert!(!registry.is_connection_in_room(&conn_b));
        assert_eq!(registry.room_count(), 0);
    }
}

