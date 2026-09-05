use crate::config::Config;
use crate::room::manager::RoomManager;
use crate::ws::session::PeerSessionRegistry;
use std::sync::Arc;

/// Shared application state injected into Axum route handlers.
#[derive(Clone, Debug)]
pub struct AppState {
    pub room_manager: Arc<RoomManager>,
    pub sessions: PeerSessionRegistry,
    pub config: Config,
}

impl AppState {
    pub fn new(config: Config) -> Self {
        let sessions = PeerSessionRegistry::new();
        let room_manager = Arc::new(RoomManager::new(config.clone()));
        Self {
            room_manager,
            sessions,
            config,
        }
    }

    pub fn with_room_manager(room_manager: Arc<RoomManager>, sessions: PeerSessionRegistry, config: Config) -> Self {
        Self {
            room_manager,
            sessions,
            config,
        }
    }
}
