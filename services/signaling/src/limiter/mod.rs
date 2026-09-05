pub mod ceiling;
pub mod connection;
pub mod flood;
pub mod join;
pub mod key;
pub mod sweeper;
pub mod turn_bandwidth;
pub mod turn_issuance;

pub use ceiling::{ConnectionGuard, GlobalCeiling};
pub use connection::ConnectionLimiter;
pub use flood::TokenBucket;
pub use join::{JoinCheckError, JoinLimiter};
pub use key::{derive_rate_key, ClientIp, PepperManager, RateKey};
pub use sweeper::{start_limiter_sweeper, start_pepper_rotator};
pub use turn_bandwidth::TurnBandwidthLimiter;
pub use turn_issuance::TurnIssuanceLimiter;

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
    pub turn_issuance: Arc<TurnIssuanceLimiter>,
    pub turn_bandwidth: Arc<TurnBandwidthLimiter>,
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
            turn_issuance: Arc::new(TurnIssuanceLimiter::new(
                config.rate_limit_turn_issuances_per_hour,
            )),
            turn_bandwidth: Arc::new(TurnBandwidthLimiter::new(
                config.rate_limit_turn_max_hourly_bytes_per_ip,
            )),
        }
    }
}
