pub mod ceiling;
pub mod connection;
pub mod flood;
pub mod join;
pub mod key;
pub mod sweeper;

pub use ceiling::{ConnectionGuard, GlobalCeiling};
pub use connection::ConnectionLimiter;
pub use flood::TokenBucket;
pub use join::{JoinCheckError, JoinLimiter};
pub use key::{derive_rate_key, ClientIp, PepperManager, RateKey};
pub use sweeper::{start_limiter_sweeper, start_pepper_rotator};

use crate::config::Config;
use std::sync::Arc;

/// Centralized in-memory rate limiting and abuse prevention service.
/// Coordinates ephemeral key derivation and multi-layered rate limiters.
#[derive(Clone, Debug)]
pub struct RateLimiterService {
    pub pepper: Arc<PepperManager>,
    pub connection: Arc<ConnectionLimiter>,
    pub join: Arc<JoinLimiter>,
    pub ceiling: Arc<GlobalCeiling>,
}

impl RateLimiterService {
    pub fn new(config: &Config) -> Self {
        Self {
            pepper: Arc::new(PepperManager::new()),
            connection: Arc::new(ConnectionLimiter::new(
                config.rate_limit_ws_connections_per_min,
                config.rate_limit_ws_base_backoff_secs,
                config.rate_limit_ws_max_backoff_secs,
            )),
            join: Arc::new(JoinLimiter::new(
                config.rate_limit_joins_per_min,
                config.rate_limit_failed_joins_threshold,
                config.rate_limit_failed_joins_window_secs,
                config.rate_limit_join_lockout_secs,
            )),
            ceiling: Arc::new(GlobalCeiling::new(
                config.max_total_rooms,
                config.max_total_connections,
            )),
        }
    }
}
