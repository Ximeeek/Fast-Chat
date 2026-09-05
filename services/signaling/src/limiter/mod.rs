pub mod connection;
pub mod key;
pub mod room_creation;

pub use connection::ConnectionLimiter;
pub use key::{derive_rate_key, ClientIp, PepperManager, RateKey};
pub use room_creation::RoomCreationLimiter;

use crate::config::Config;
use std::sync::Arc;

/// Centralized in-memory rate limiting and abuse prevention service.
/// Coordinates ephemeral key derivation and multi-layered rate limiters.
#[derive(Clone, Debug)]
pub struct RateLimiterService {
    pub pepper: Arc<PepperManager>,
    pub room_creation: Arc<RoomCreationLimiter>,
    pub connection: Arc<ConnectionLimiter>,
}

impl RateLimiterService {
    pub fn new(config: &Config) -> Self {
        Self {
            pepper: Arc::new(PepperManager::new()),
            room_creation: Arc::new(RoomCreationLimiter::new(
                config.rate_limit_room_creations_per_hour,
            )),
            connection: Arc::new(ConnectionLimiter::new(
                config.rate_limit_ws_connections_per_min,
                config.rate_limit_ws_base_backoff_secs,
                config.rate_limit_ws_max_backoff_secs,
            )),
        }
    }
}
