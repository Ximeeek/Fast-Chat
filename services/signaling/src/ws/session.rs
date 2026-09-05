use crate::room::code::RoomCode;
use crate::ws::protocol::ServerMessage;
use dashmap::DashMap;
use std::sync::Arc;
use tokio::sync::mpsc::UnboundedSender;

/// In-memory registry of active WebSocket peer outbound channels mapped by room.
#[derive(Debug, Clone, Default)]
pub struct PeerSessionRegistry {
    rooms: Arc<DashMap<RoomCode, DashMap<String, UnboundedSender<ServerMessage>>>>,
}

impl PeerSessionRegistry {
    /// Creates a new empty session registry.
    pub fn new() -> Self {
        Self {
            rooms: Arc::new(DashMap::new()),
        }
    }

    /// Registers an outbound channel for a peer in the specified room.
    pub fn register(&self, code: &RoomCode, peer_id: String, tx: UnboundedSender<ServerMessage>) {
        let entry = self.rooms.entry(code.clone()).or_default();
        entry.insert(peer_id, tx);
    }

    /// Unregisters an outbound channel for a peer. Removes the room entry if no peers remain.
    pub fn unregister(&self, code: &RoomCode, peer_id: &str) -> Option<UnboundedSender<ServerMessage>> {
        let mut remove_room = false;
        let removed = if let Some(room_peers) = self.rooms.get(code) {
            let res = room_peers.remove(peer_id).map(|(_, tx)| tx);
            if room_peers.is_empty() {
                remove_room = true;
            }
            res
        } else {
            None
        };

        if remove_room {
            self.rooms.remove(code);
        }

        removed
    }

    /// Sends a message directly to a target peer in the specified room.
    /// Returns `true` if the message was successfully dispatched, `false` if target not found.
    pub fn send_to_peer(&self, code: &RoomCode, target_peer_id: &str, msg: ServerMessage) -> bool {
        if let Some(room_peers) = self.rooms.get(code) {
            if let Some(tx) = room_peers.get(target_peer_id) {
                return tx.send(msg).is_ok();
            }
        }
        false
    }

    /// Broadcasts a message to all active peers in the room, optionally excluding a specific peer.
    /// Returns the number of peers to which the message was successfully dispatched.
    pub fn broadcast(&self, code: &RoomCode, msg: ServerMessage, exclude_peer_id: Option<&str>) -> usize {
        let mut sent_count = 0;
        if let Some(room_peers) = self.rooms.get(code) {
            for entry in room_peers.iter() {
                if let Some(exclude) = exclude_peer_id {
                    if entry.key() == exclude {
                        continue;
                    }
                }
                if entry.value().send(msg.clone()).is_ok() {
                    sent_count += 1;
                }
            }
        }
        sent_count
    }

    /// Lists all active peer IDs currently connected in the specified room.
    pub fn list_peers(&self, code: &RoomCode) -> Vec<String> {
        if let Some(room_peers) = self.rooms.get(code) {
            room_peers.iter().map(|entry| entry.key().clone()).collect()
        } else {
            Vec::new()
        }
    }

    /// Checks if a peer is currently connected in the specified room.
    pub fn contains_peer(&self, code: &RoomCode, peer_id: &str) -> bool {
        self.rooms
            .get(code)
            .map(|peers| peers.contains_key(peer_id))
            .unwrap_or(false)
    }

    /// Evicts an entire room and its registered peer sessions.
    pub fn remove_room(&self, code: &RoomCode) {
        self.rooms.remove(code);
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
        let code = RoomCode::new("1111-2222-3333").unwrap();

        let (tx_a, mut rx_a) = mpsc::unbounded_channel();
        let (tx_b, mut rx_b) = mpsc::unbounded_channel();

        registry.register(&code, "alice".to_string(), tx_a);
        registry.register(&code, "bob".to_string(), tx_b);

        assert_eq!(registry.list_peers(&code).len(), 2);
        assert!(registry.contains_peer(&code, "alice"));
        assert!(registry.contains_peer(&code, "bob"));
        assert!(!registry.contains_peer(&code, "charlie"));

        // 1:1 Direct message relay from Alice to Bob
        let relay_msg = ServerMessage::sdp_offer("alice", serde_json::json!({"type": "offer"}));
        let sent = registry.send_to_peer(&code, "bob", relay_msg.clone());
        assert!(sent);

        let received_by_b = rx_b.recv().await.expect("Bob should receive offer");
        assert_eq!(received_by_b, relay_msg);
        assert!(rx_a.try_recv().is_err()); // Alice did not receive direct message

        // Room broadcast excluding Alice
        let broadcast_msg = ServerMessage::peer_joined("bob");
        let count = registry.broadcast(&code, broadcast_msg.clone(), Some("alice"));
        assert_eq!(count, 1);
        let b_broadcast = rx_b.recv().await.expect("Bob receives broadcast");
        assert_eq!(b_broadcast, broadcast_msg);

        // Unregister Alice
        registry.unregister(&code, "alice");
        assert!(!registry.contains_peer(&code, "alice"));
        assert_eq!(registry.list_peers(&code), vec!["bob".to_string()]);

        // Unregister Bob -> room map pruned
        registry.unregister(&code, "bob");
        assert_eq!(registry.room_count(), 0);
    }
}
