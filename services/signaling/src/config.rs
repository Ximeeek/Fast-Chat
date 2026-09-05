use std::env;

/// Application configuration for FastChat signaling service.
/// All timeout durations and participant limits are centralized here
/// rather than hardcoded in business logic.
#[derive(Debug, Clone, PartialEq, Eq)]
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
}

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

        Self {
            max_participants_per_room,
            initial_room_duration_secs,
            extendable_threshold_secs,
            extension_duration_secs,
            closing_grace_period_secs,
            sweeper_interval_secs,
            server_port,
            server_host,
        }
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
    }
}
