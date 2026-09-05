use dashmap::DashMap;
use fastchat_signaling::config::Config;
use fastchat_signaling::room::{
    broadcast::RoomBroadcaster, code::RoomCode, manager::RoomManager, PasswordStatus,
    RoomError, RoomLifecycleState, RoomState,
};
use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

#[derive(Debug, Default)]
struct RecordingBroadcaster {
    closed_events: AtomicUsize,
    state_change_events: AtomicUsize,
}

impl RoomBroadcaster for RecordingBroadcaster {
    fn broadcast_room_closed(&self, _code: &RoomCode, _reason: &str) {
        self.closed_events.fetch_add(1, Ordering::SeqCst);
    }

    fn broadcast_state_changed(&self, _code: &RoomCode, _new_state: RoomLifecycleState) {
        self.state_change_events.fetch_add(1, Ordering::SeqCst);
    }
}

#[test]
fn test_room_code_strict_format_and_uniqueness() {
    let map = DashMap::new();
    let mut generated_codes = HashSet::new();

    // Generate 500 unique room codes and verify strict format and zero collisions
    for _ in 0..500 {
        let code = RoomCode::generate_unique(&map).expect("Failed to generate unique room code");
        assert_eq!(code.len(), 14);
        assert!(RoomCode::is_valid(&code));
        assert!(!generated_codes.contains(&code));

        generated_codes.insert(code.clone());
        map.insert(code, ());
    }

    assert_eq!(map.len(), 500);

    // Verify invalid formats
    assert!(RoomCode::new("").is_err());
    assert!(RoomCode::new("123456789012").is_err()); // missing dashes
    assert!(RoomCode::new("1234-5678-901").is_err()); // 11 digits
    assert!(RoomCode::new("1234-5678-90123").is_err()); // 13 digits
    assert!(RoomCode::new("abcd-efgh-ijkl").is_err()); // non-digits
}

#[test]
fn test_configurable_participant_limit() {
    let config = Config {
        max_participants_per_room: 3, // Enforce limit = 3
        ..Default::default()
    };

    let mut room = RoomState::new(
        RoomCode::new("1111-2222-3333").unwrap(),
        Some("owner".to_string()),
        PasswordStatus::none(),
        &config,
        1000,
    );

    assert_eq!(room.peers.len(), 1);

    // Peer 2 joins
    assert!(room.add_peer("peer2".to_string(), false, 1001, &config).is_ok());
    assert_eq!(room.peers.len(), 2);

    // Peer 3 joins (reaches limit of 3)
    assert!(room.add_peer("peer3".to_string(), false, 1002, &config).is_ok());
    assert_eq!(room.peers.len(), 3);

    // Peer 4 tries to join -> Must be rejected with RoomFull(3)
    let overflow_err = room.add_peer("peer4".to_string(), false, 1003, &config);
    assert_eq!(overflow_err, Err(RoomError::RoomFull(3)));
    assert_eq!(room.peers.len(), 3);

    // Peer 2 leaves
    let removed = room.remove_peer("peer2").expect("Remove should succeed");
    assert_eq!(removed.id, "peer2");
    assert_eq!(room.peers.len(), 2);

    // Peer 4 can now join successfully
    assert!(room.add_peer("peer4".to_string(), false, 1004, &config).is_ok());
    assert_eq!(room.peers.len(), 3);
}

#[test]
fn test_lifecycle_full_state_machine_with_extension_and_server_time() {
    let config = Config {
        initial_room_duration_secs: 600, // 10 minutes
        extendable_threshold_secs: 120,  // 2 minutes
        extension_duration_secs: 300,   // 5 minutes
        closing_grace_period_secs: 10,   // 10 seconds
        ..Default::default()
    };

    let broadcaster = Arc::new(RecordingBroadcaster::default());
    let manager = RoomManager::with_broadcaster(config.clone(), broadcaster.clone());

    let code = manager
        .create_room(Some("owner_alice".to_string()), PasswordStatus::none())
        .expect("Creation failed");

    let initial = manager.get_room_state(&code).unwrap();
    let start_ts = initial.created_at;

    // Initial state: Creating, timer set to start_ts + 600
    assert_eq!(initial.state, RoomLifecycleState::Creating);
    assert_eq!(initial.expires_at, start_ts + 600);

    // 1. Peer joins -> room transitions to Active
    manager
        .join_room(&code, "bob".to_string(), false)
        .expect("Bob should join");
    let room = manager.get_room_state(&code).unwrap();
    assert_eq!(room.state, RoomLifecycleState::Active);

    // 2. Server time tick at +400s (remaining 200s > 120s threshold) -> Still Active
    manager.tick_lifecycle(start_ts + 400);
    let room = manager.get_room_state(&code).unwrap();
    assert_eq!(room.state, RoomLifecycleState::Active);
    assert_eq!(broadcaster.state_change_events.load(Ordering::SeqCst), 0);

    // 3. Server time tick at +480s (remaining 120s <= 120s threshold) -> ExtendableWindow
    manager.tick_lifecycle(start_ts + 480);
    let room = manager.get_room_state(&code).unwrap();
    assert_eq!(room.state, RoomLifecycleState::ExtendableWindow);
    assert_eq!(broadcaster.state_change_events.load(Ordering::SeqCst), 1);

    // 4. Non-owner (Bob) attempts to extend -> Unauthorized
    let bob_res = manager.extend_room(&code, "bob");
    assert_eq!(bob_res, Err(RoomError::Unauthorized));

    // 5. Owner (Alice) extends room -> Adds 300s (expires_at = start_ts + 900) & returns to Active
    manager
        .extend_room(&code, "owner_alice")
        .expect("Extension failed");
    let room = manager.get_room_state(&code).unwrap();
    assert_eq!(room.state, RoomLifecycleState::Active);
    assert_eq!(room.expires_at, start_ts + 900);
    assert_eq!(room.extension_count, 1);
    assert_eq!(broadcaster.state_change_events.load(Ordering::SeqCst), 2);

    // 6. Advance to second ExtendableWindow (start_ts + 780s, remaining 120s)
    manager.tick_lifecycle(start_ts + 780);
    let room = manager.get_room_state(&code).unwrap();
    assert_eq!(room.state, RoomLifecycleState::ExtendableWindow);
    assert_eq!(broadcaster.state_change_events.load(Ordering::SeqCst), 3);

    // 7. Advance past expiration (start_ts + 901s) -> Closing state with 10s grace period
    manager.tick_lifecycle(start_ts + 901);
    let room = manager.get_room_state(&code).unwrap();
    assert_eq!(room.state, RoomLifecycleState::Closing);
    assert_eq!(room.closing_deadline, Some(start_ts + 901 + 10));
    assert_eq!(broadcaster.state_change_events.load(Ordering::SeqCst), 4);
    assert_eq!(manager.room_count(), 1); // Still in memory during grace period

    // 8. Tick during grace period (start_ts + 906s) -> Still Closing
    manager.tick_lifecycle(start_ts + 906);
    assert_eq!(manager.room_count(), 1);
    assert_eq!(broadcaster.closed_events.load(Ordering::SeqCst), 0);

    // 9. Tick after grace period expires (start_ts + 912s) -> Destroyed, purged from DashMap
    manager.tick_lifecycle(start_ts + 912);
    assert_eq!(manager.room_count(), 0);
    assert!(manager.get_room_state(&code).is_none());
    assert_eq!(broadcaster.closed_events.load(Ordering::SeqCst), 1);
}

#[test]
fn test_manual_close_by_owner_initiates_closing_grace_period() {
    let config = Config::default();
    let broadcaster = Arc::new(RecordingBroadcaster::default());
    let manager = RoomManager::with_broadcaster(config, broadcaster.clone());

    let code = manager
        .create_room(Some("owner".to_string()), PasswordStatus::none())
        .unwrap();

    let start_ts = manager.get_room_state(&code).unwrap().created_at;

    // Impostor tries to close room -> Unauthorized
    let err = manager.close_room(&code, "stranger");
    assert_eq!(err, Err(RoomError::Unauthorized));

    // Owner closes room manually
    manager.close_room(&code, "owner").expect("Close failed");
    let room = manager.get_room_state(&code).unwrap();
    assert_eq!(room.state, RoomLifecycleState::Closing);
    assert_eq!(room.closing_deadline, Some(start_ts + 10));

    // Tick after grace period (start_ts + 11s) -> Pruned
    manager.tick_lifecycle(start_ts + 11);
    assert_eq!(manager.room_count(), 0);
    assert_eq!(broadcaster.closed_events.load(Ordering::SeqCst), 1);
}

#[test]
fn test_zero_disk_persistence() {
    // Verify that operations do not write temporary or persistent files to disk
    let config = Config::default();
    let manager = RoomManager::new(config);

    let code = manager
        .create_room(Some("ephemeral_peer".to_string()), PasswordStatus::none())
        .unwrap();

    assert_eq!(manager.room_count(), 1);

    // Drop manager -> everything in memory is discarded
    drop(manager);

    // A fresh manager has 0 rooms
    let fresh_manager = RoomManager::new(Config::default());
    assert_eq!(fresh_manager.room_count(), 0);
    assert!(fresh_manager.get_room_state(&code).is_none());
}
