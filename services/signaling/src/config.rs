use std::env;

/// Application configuration for FastChat signaling service.
/// All timeout durations and participant limits are centralized here
/// rather than hardcoded in business logic.
#[derive(Clone, PartialEq, Eq)]
pub struct Config {
    /// Maximum number of concurrent participants allowed in a single room.
    /// Default is 4. Configurable via FASTCHAT_MAX_PARTICIPANTS_PER_ROOM.
    pub max_participants_per_room: usize,

    /// Initial duration of a room in seconds upon creation (default: 600s = 10m).
    pub initial_room_duration_secs: i64,

    /// Remaining duration threshold in seconds that triggers the ExtendableWindow state (default: 120s = 2m).
    pub extendable_threshold_secs: i64,

    /// Additional duration added in seconds when the owner extends a room (default: 300s = 5m).
    pub extension_duration_secs: i64,

    /// Grace period duration in seconds for the Closing state before room destruction (default: 10s).
    pub closing_grace_period_secs: i64,

    /// Interval in seconds for the background lifecycle cleanup ticker (default: 1s).
    pub sweeper_interval_secs: u64,

    /// HTTP/WebSocket server listening port (default: 3000).
    pub server_port: u16,

    /// HTTP/WebSocket server listening host (default: "0.0.0.0").
    pub server_host: String,

    /// Interval in seconds for daily pepper secret rotation in RAM (default: 86400s = 24h).
    pub pepper_rotation_secs: u64,

    /// Maximum concurrent active rooms allowed per IP address (default: 1).
    /// Configurable via FASTCHAT_MAX_ACTIVE_ROOMS_PER_IP.
    pub max_active_rooms_per_ip: usize,

    /// Maximum WebSocket connection attempts per minute per rate key before backoff (default: 30).
    pub rate_limit_ws_connections_per_min: usize,

    /// Base backoff duration in seconds for connection rate limiting (default: 2s).
    pub rate_limit_ws_base_backoff_secs: u64,

    /// Maximum backoff duration in seconds for connection rate limiting (default: 300s = 5m).
    pub rate_limit_ws_max_backoff_secs: u64,

    /// Maximum join attempts per minute per rate key (default: 30).
    pub rate_limit_joins_per_min: usize,

    /// Maximum consecutive failed join attempts before temporary lockout (default: 5).
    pub rate_limit_failed_joins_threshold: usize,

    /// Time window in seconds for counting consecutive failed join attempts (default: 300s = 5m).
    pub rate_limit_failed_joins_window_secs: u64,

    /// Lockout duration in seconds applied after exceeding failed join attempts threshold (default: 900s = 15m).
    pub rate_limit_join_lockout_secs: u64,

    /// Token bucket capacity (burst allowance) for signaling message flood control (default: 30).
    pub flood_bucket_capacity: u32,

    /// Token bucket refill rate in tokens per second for signaling flood control (default: 10).
    pub flood_refill_per_sec: u32,

    /// Global server ceiling for concurrent active rooms (default: 1000).
    pub max_total_rooms: usize,

    /// Global server ceiling for concurrent active WebSocket connections (default: 4000).
    pub max_total_connections: usize,

    /// Interval in seconds for pruning stale in-memory rate limiter records (default: 60s).
    pub limiter_prune_interval_secs: u64,

    /// Cloudflare Realtime TURN API token read from CLOUDFLARE_TURN_API_TOKEN.
    pub cloudflare_turn_api_token: Option<String>,

    /// Cloudflare Realtime TURN Key ID read from CLOUDFLARE_TURN_KEY_ID.
    pub cloudflare_turn_key_id: Option<String>,

    /// Safety threshold in bytes for monthly TURN usage (default: 900 GB).
    pub turn_max_monthly_bytes: u64,

    /// Default TTL in seconds for generated temporary TURN credentials (default: 86400s).
    pub turn_credential_ttl_secs: u64,

    /// Base URL for Cloudflare Realtime TURN API (default: "https://rtc.live.cloudflare.com").
    pub turn_api_base_url: String,
}

/// Default maximum concurrent active rooms allowed per IP address.
pub const DEFAULT_MAX_ACTIVE_ROOMS_PER_IP: usize = 1;

/// Default monthly TURN bandwidth allowance threshold in bytes (900 GiB).
/// Cloudflare Realtime TURN provides 1,000 GB/month on the free tier; 900 GiB leaves a 10% safety margin.
pub const DEFAULT_TURN_MAX_MONTHLY_BYTES: u64 = 900 * 1024 * 1024 * 1024;

impl Default for Config {
    fn default() -> Self {
        Self {
            max_participants_per_room: 4,
            initial_room_duration_secs: 600, // 10 minutes
            extendable_threshold_secs: 120,  // 2 minutes
            extension_duration_secs: 300,   // 5 minutes
            closing_grace_period_secs: 10,   // 10 seconds
            sweeper_interval_secs: 1,        // 1 second
            server_port: 3000,
            server_host: "0.0.0.0".to_string(),
            pepper_rotation_secs: 86400,     // 24 hours
            max_active_rooms_per_ip: DEFAULT_MAX_ACTIVE_ROOMS_PER_IP,
            rate_limit_ws_connections_per_min: 30,
            rate_limit_ws_base_backoff_secs: 2,
            rate_limit_ws_max_backoff_secs: 300,
            rate_limit_joins_per_min: 30,
            rate_limit_failed_joins_threshold: 5,
            rate_limit_failed_joins_window_secs: 300,
            rate_limit_join_lockout_secs: 900,
            flood_bucket_capacity: 30,
            flood_refill_per_sec: 10,
            max_total_rooms: 1000,
            max_total_connections: 4000,
            limiter_prune_interval_secs: 60,
            cloudflare_turn_api_token: None,
            cloudflare_turn_key_id: None,
            turn_max_monthly_bytes: DEFAULT_TURN_MAX_MONTHLY_BYTES,
            turn_credential_ttl_secs: 86400,
            turn_api_base_url: "https://rtc.live.cloudflare.com".to_string(),
        }
    }
}

impl Config {
    /// Load configuration from environment variables with fallbacks to defaults.
    pub fn from_env() -> Self {
        let default = Self::default();

        let max_participants_per_room = env::var("FASTCHAT_MAX_PARTICIPANTS_PER_ROOM")
            .or_else(|_| env::var("MAX_PARTICIPANTS_PER_ROOM"))
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(default.max_participants_per_room);

        let initial_room_duration_secs = env::var("FASTCHAT_INITIAL_ROOM_DURATION_SECS")
            .ok()
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(default.initial_room_duration_secs);

        let extendable_threshold_secs = env::var("FASTCHAT_EXTENDABLE_THRESHOLD_SECS")
            .ok()
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(default.extendable_threshold_secs);

        let extension_duration_secs = env::var("FASTCHAT_EXTENSION_DURATION_SECS")
            .ok()
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(default.extension_duration_secs);

        let closing_grace_period_secs = env::var("FASTCHAT_CLOSING_GRACE_PERIOD_SECS")
            .ok()
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(default.closing_grace_period_secs);

        let sweeper_interval_secs = env::var("FASTCHAT_SWEEPER_INTERVAL_SECS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(default.sweeper_interval_secs);

        let server_port = env::var("PORT")
            .or_else(|_| env::var("FASTCHAT_PORT"))
            .ok()
            .and_then(|v| v.parse::<u16>().ok())
            .unwrap_or(default.server_port);

        let server_host = env::var("HOST")
            .or_else(|_| env::var("FASTCHAT_HOST"))
            .unwrap_or(default.server_host);

        let pepper_rotation_secs = env::var("FASTCHAT_PEPPER_ROTATION_SECS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(default.pepper_rotation_secs);

        let max_active_rooms_per_ip = env::var("FASTCHAT_MAX_ACTIVE_ROOMS_PER_IP")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(default.max_active_rooms_per_ip);

        let rate_limit_ws_connections_per_min = env::var("FASTCHAT_RATE_LIMIT_WS_PER_MIN")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(default.rate_limit_ws_connections_per_min);

        let rate_limit_ws_base_backoff_secs = env::var("FASTCHAT_RATE_LIMIT_WS_BASE_BACKOFF_SECS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(default.rate_limit_ws_base_backoff_secs);

        let rate_limit_ws_max_backoff_secs = env::var("FASTCHAT_RATE_LIMIT_WS_MAX_BACKOFF_SECS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(default.rate_limit_ws_max_backoff_secs);

        let rate_limit_joins_per_min = env::var("FASTCHAT_RATE_LIMIT_JOIN_PER_MIN")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(default.rate_limit_joins_per_min);

        let rate_limit_failed_joins_threshold = env::var("FASTCHAT_MAX_FAILED_JOINS")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(default.rate_limit_failed_joins_threshold);

        let rate_limit_failed_joins_window_secs = env::var("FASTCHAT_FAILED_JOINS_WINDOW_SECS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(default.rate_limit_failed_joins_window_secs);

        let rate_limit_join_lockout_secs = env::var("FASTCHAT_JOIN_LOCKOUT_SECS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(default.rate_limit_join_lockout_secs);

        let flood_bucket_capacity = env::var("FASTCHAT_FLOOD_CAPACITY")
            .ok()
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(default.flood_bucket_capacity);

        let flood_refill_per_sec = env::var("FASTCHAT_FLOOD_REFILL_PER_SEC")
            .ok()
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(default.flood_refill_per_sec);

        let max_total_rooms = env::var("FASTCHAT_MAX_TOTAL_ROOMS")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(default.max_total_rooms);

        let max_total_connections = env::var("FASTCHAT_MAX_TOTAL_CONNECTIONS")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(default.max_total_connections);

        let limiter_prune_interval_secs = env::var("FASTCHAT_LIMITER_PRUNE_INTERVAL_SECS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(default.limiter_prune_interval_secs);

        let cloudflare_turn_api_token = env::var("CLOUDFLARE_TURN_API_TOKEN")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let cloudflare_turn_key_id = env::var("CLOUDFLARE_TURN_KEY_ID")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let turn_max_monthly_bytes = env::var("FASTCHAT_TURN_MAX_MONTHLY_BYTES")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(default.turn_max_monthly_bytes);

        let turn_credential_ttl_secs = env::var("FASTCHAT_TURN_CREDENTIAL_TTL_SECS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(default.turn_credential_ttl_secs);

        let turn_api_base_url = env::var("FASTCHAT_TURN_API_BASE_URL")
            .unwrap_or(default.turn_api_base_url);

        Self {
            max_participants_per_room,
            initial_room_duration_secs,
            extendable_threshold_secs,
            extension_duration_secs,
            closing_grace_period_secs,
            sweeper_interval_secs,
            server_port,
            server_host,
            pepper_rotation_secs,
            max_active_rooms_per_ip,
            rate_limit_ws_connections_per_min,
            rate_limit_ws_base_backoff_secs,
            rate_limit_ws_max_backoff_secs,
            rate_limit_joins_per_min,
            rate_limit_failed_joins_threshold,
            rate_limit_failed_joins_window_secs,
            rate_limit_join_lockout_secs,
            flood_bucket_capacity,
            flood_refill_per_sec,
            max_total_rooms,
            max_total_connections,
            limiter_prune_interval_secs,
            cloudflare_turn_api_token,
            cloudflare_turn_key_id,
            turn_max_monthly_bytes,
            turn_credential_ttl_secs,
            turn_api_base_url,
        }
    }
}

impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("max_participants_per_room", &self.max_participants_per_room)
            .field("initial_room_duration_secs", &self.initial_room_duration_secs)
            .field("extendable_threshold_secs", &self.extendable_threshold_secs)
            .field("extension_duration_secs", &self.extension_duration_secs)
            .field("closing_grace_period_secs", &self.closing_grace_period_secs)
            .field("sweeper_interval_secs", &self.sweeper_interval_secs)
            .field("server_port", &self.server_port)
            .field("server_host", &self.server_host)
            .field("pepper_rotation_secs", &self.pepper_rotation_secs)
            .field("max_active_rooms_per_ip", &self.max_active_rooms_per_ip)
            .field("rate_limit_ws_connections_per_min", &self.rate_limit_ws_connections_per_min)
            .field("rate_limit_ws_base_backoff_secs", &self.rate_limit_ws_base_backoff_secs)
            .field("rate_limit_ws_max_backoff_secs", &self.rate_limit_ws_max_backoff_secs)
            .field("rate_limit_joins_per_min", &self.rate_limit_joins_per_min)
            .field("rate_limit_failed_joins_threshold", &self.rate_limit_failed_joins_threshold)
            .field("rate_limit_failed_joins_window_secs", &self.rate_limit_failed_joins_window_secs)
            .field("rate_limit_join_lockout_secs", &self.rate_limit_join_lockout_secs)
            .field("flood_bucket_capacity", &self.flood_bucket_capacity)
            .field("flood_refill_per_sec", &self.flood_refill_per_sec)
            .field("max_total_rooms", &self.max_total_rooms)
            .field("max_total_connections", &self.max_total_connections)
            .field("limiter_prune_interval_secs", &self.limiter_prune_interval_secs)
            .field(
                "cloudflare_turn_api_token",
                &self.cloudflare_turn_api_token.as_ref().map(|_| "[REDACTED]"),
            )
            .field("cloudflare_turn_key_id", &self.cloudflare_turn_key_id)
            .field("turn_max_monthly_bytes", &self.turn_max_monthly_bytes)
            .field("turn_credential_ttl_secs", &self.turn_credential_ttl_secs)
            .field("turn_api_base_url", &self.turn_api_base_url)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config() {
        let config = Config::default();
        assert_eq!(config.max_participants_per_room, 4);
        assert_eq!(config.initial_room_duration_secs, 600);
        assert_eq!(config.extendable_threshold_secs, 120);
        assert_eq!(config.extension_duration_secs, 300);
        assert_eq!(config.closing_grace_period_secs, 10);
        assert_eq!(config.sweeper_interval_secs, 1);
        assert_eq!(config.server_port, 3000);
        assert_eq!(config.server_host, "0.0.0.0");
        assert_eq!(config.cloudflare_turn_api_token, None);
        assert_eq!(config.cloudflare_turn_key_id, None);
        assert_eq!(config.turn_max_monthly_bytes, DEFAULT_TURN_MAX_MONTHLY_BYTES);
        assert_eq!(config.turn_credential_ttl_secs, 86400);
        assert_eq!(config.turn_api_base_url, "https://rtc.live.cloudflare.com");
    }

    #[test]
    fn test_debug_redacts_api_token() {
        let mut config = Config::default();
        config.cloudflare_turn_api_token = Some("super_secret_cf_token_12345".to_string());
        config.cloudflare_turn_key_id = Some("turn-key-uuid-67890".to_string());

        let debug_output = format!("{:?}", config);
        assert!(!debug_output.contains("super_secret_cf_token_12345"));
        assert!(debug_output.contains("[REDACTED]"));
        assert!(debug_output.contains("turn-key-uuid-67890"));
    }
}
