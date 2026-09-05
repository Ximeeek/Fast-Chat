use crate::config::Config;
use crate::limiter::RateLimiterService;
use crate::room::manager::RoomManager;
use crate::ws::session::PeerSessionRegistry;
use std::sync::Arc;

/// Shared application state injected into Axum route handlers.
#[derive(Clone, Debug)]
pub struct AppState {
    pub room_manager: Arc<RoomManager>,
    pub sessions: PeerSessionRegistry,
    pub config: Config,
    pub limiter: Arc<RateLimiterService>,
}

impl AppState {
    pub fn new(config: Config) -> Self {
        let sessions = PeerSessionRegistry::new();
        let broadcaster = Arc::new(crate::room::broadcast::WebSocketBroadcaster::new(sessions.clone()));
        let room_manager = Arc::new(RoomManager::with_broadcaster(config.clone(), broadcaster));
        let limiter = Arc::new(RateLimiterService::new(&config));
        Self {
            room_manager,
            sessions,
            config,
            limiter,
        }
    }

    pub fn with_room_manager(room_manager: Arc<RoomManager>, sessions: PeerSessionRegistry, config: Config) -> Self {
        let limiter = Arc::new(RateLimiterService::new(&config));
        Self {
            room_manager,
            sessions,
            config,
            limiter,
        }
    }
}
