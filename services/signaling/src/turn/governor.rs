use crate::config::{Config, DEFAULT_TURN_MAX_MONTHLY_BYTES};
use crate::turn::client::{CloudflareTurnClient, TurnError};
use crate::turn::models::IceServerConfig;
use chrono::{DateTime, Datelike, Utc};
use std::sync::{Arc, RwLock};
use tracing::{info, warn};

// =========================================================================
// TURN Bandwidth Usage Data Source Architectural Decision
// =========================================================================
// FastChat investigated official Cloudflare Realtime TURN documentation and APIs.
// Cloudflare provides credential generation at `rtc.live.cloudflare.com/v1/turn/keys/`,
// but does NOT expose a dedicated REST endpoint for querying bandwidth consumed per key.
//
// Cloudflare's telemetry is exposed exclusively via the centralized GraphQL Analytics API
// at `https://api.cloudflare.com/client/v4/graphql` under datasets such as
// `callsTurnUsageAdaptiveGroups`. However:
// 1. GraphQL Analytics requires broad account-level API tokens (`CLOUDFLARE_ACCOUNT_ID`),
//    which are intentionally excluded from FastChat's zero-knowledge signaling config.
// 2. Cloudflare's official documentation explicitly warns that GraphQL analytics data is
//    aggregated, asynchronous, and intended for informational/dashboard visualization rather
//    than authoritative real-time billing enforcement.
//
// Consequently, the TurnCostGovernor implements a hard in-memory governor in RAM:
// - Maintains real-time byte consumption counter strictly in volatile RAM (zero disk/DB).
// - Automatically resets on the 1st of every calendar month via calendar rollover detection.
// - Enforces a strict threshold (default 900 GiB against Cloudflare's 1,000 GB free tier).
// - Exposes programmatic integration points (`record_usage`, `set_usage`) for telemetry
//   ingestion or webhooks without introducing delayed polling dependencies.
// =========================================================================

/// Pluggable time provider trait enabling deterministic time manipulation in unit tests.
pub trait TimeProvider: Send + Sync + std::fmt::Debug {
    fn now(&self) -> DateTime<Utc>;
}

/// Default system UTC time provider for production operations.
#[derive(Debug, Clone, Default)]
pub struct SystemTimeProvider;

impl TimeProvider for SystemTimeProvider {
    fn now(&self) -> DateTime<Utc> {
        Utc::now()
    }
}

/// Internal state tracking current calendar month and consumed bandwidth in RAM.
#[derive(Debug, Clone)]
struct GovernorState {
    /// Year and month (1..=12) of the current accounting period.
    tracked_period: (i32, u32),
    /// Cumulative bytes transferred via TURN in the active month.
    usage_bytes: u64,
}

/// In-memory cost governor protecting against Cloudflare TURN free tier bandwidth overages.
///
/// Features:
/// - Volatile in-memory counter with zero disk/database persistence.
/// - Hard safety threshold (default: 900 GB against 1000 GB allowance).
/// - Automatic monthly reset on the 1st day of each calendar month.
/// - Injected TimeProvider for reliable unit testing of edge-case rollovers.
#[derive(Debug)]
pub struct TurnCostGovernor {
    state: RwLock<GovernorState>,
    max_monthly_bytes: u64,
    time_provider: Arc<dyn TimeProvider>,
}

impl TurnCostGovernor {
    /// Creates a new TurnCostGovernor from application configuration with system clock.
    pub fn new(config: &Config) -> Self {
        Self::with_time_provider(
            config.turn_max_monthly_bytes,
            Arc::new(SystemTimeProvider),
        )
    }

    /// Creates a TurnCostGovernor with an injected time provider (for deterministic tests).
    pub fn with_time_provider(
        max_monthly_bytes: u64,
        time_provider: Arc<dyn TimeProvider>,
    ) -> Self {
        let now = time_provider.now();
        let initial_period = (now.year(), now.month());
        Self {
            state: RwLock::new(GovernorState {
                tracked_period: initial_period,
                usage_bytes: 0,
            }),
            max_monthly_bytes: if max_monthly_bytes == 0 {
                DEFAULT_TURN_MAX_MONTHLY_BYTES
            } else {
                max_monthly_bytes
            },
            time_provider,
        }
    }

    /// Checks if a new calendar month has begun and resets usage counter if necessary.
    fn check_and_reset_if_new_month(&self, current_time: DateTime<Utc>) -> (i32, u32) {
        let current_period = (current_time.year(), current_time.month());
        let mut state = self.state.write().unwrap();
        if state.tracked_period != current_period {
            info!(
                old_year = state.tracked_period.0,
                old_month = state.tracked_period.1,
                new_year = current_period.0,
                new_month = current_period.1,
                previous_usage_bytes = state.usage_bytes,
                "New calendar month detected; resetting TURN bandwidth usage counter to 0"
            );
            state.tracked_period = current_period;
            state.usage_bytes = 0;
        }
        current_period
    }

    /// Evaluates whether new TURN credentials are permitted under the configured monthly budget.
    ///
    /// If the consumed bytes meet or exceed the safety threshold, returns
    /// `Err(TurnError::QuotaExhausted(bytes))`.
    pub fn check_quota_permitted(&self) -> Result<(), TurnError> {
        let now = self.time_provider.now();
        self.check_and_reset_if_new_month(now);

        let state = self.state.read().unwrap();
        if state.usage_bytes >= self.max_monthly_bytes {
            warn!(
                usage_bytes = state.usage_bytes,
                limit_bytes = self.max_monthly_bytes,
                "TURN monthly quota reached; blocking credential issuance"
            );
            Err(TurnError::QuotaExhausted(state.usage_bytes))
        } else {
            Ok(())
        }
    }

    /// Returns whether the TURN bandwidth quota is currently exhausted.
    pub fn is_quota_exhausted(&self) -> bool {
        self.check_quota_permitted().is_err()
    }

    /// Increments the in-memory consumed bandwidth counter by specified bytes.
    ///
    /// Checks for calendar month rollover prior to accumulating.
    pub fn record_usage(&self, bytes: u64) {
        let now = self.time_provider.now();
        self.check_and_reset_if_new_month(now);

        let mut state = self.state.write().unwrap();
        state.usage_bytes = state.usage_bytes.saturating_add(bytes);
    }

    /// Programmatic integration point to overwrite or reconcile current month's usage.
    pub fn set_usage(&self, bytes: u64) {
        let now = self.time_provider.now();
        self.check_and_reset_if_new_month(now);

        let mut state = self.state.write().unwrap();
        state.usage_bytes = bytes;
    }

    /// Returns the current number of bytes consumed in the active calendar month.
    pub fn get_usage(&self) -> u64 {
        let now = self.time_provider.now();
        self.check_and_reset_if_new_month(now);

        let state = self.state.read().unwrap();
        state.usage_bytes
    }

    /// Returns the remaining available bytes before reaching the safety threshold.
    pub fn remaining_quota(&self) -> u64 {
        let usage = self.get_usage();
        self.max_monthly_bytes.saturating_sub(usage)
    }

    /// Returns the configured monthly quota limit in bytes.
    pub fn quota_limit(&self) -> u64 {
        self.max_monthly_bytes
    }
}

/// Unified service coordinating TURN credential generation with cost governor enforcement.
#[derive(Clone, Debug)]
pub struct TurnService {
    pub client: CloudflareTurnClient,
    pub governor: Arc<TurnCostGovernor>,
}

impl TurnService {
    /// Instantiates a new TurnService with associated client and cost governor.
    pub fn new(config: &Config) -> Self {
        let client = CloudflareTurnClient::new(config);
        let governor = Arc::new(TurnCostGovernor::new(config));
        Self { client, governor }
    }

    /// Creates a TurnService with custom components (useful for testing).
    pub fn with_custom(client: CloudflareTurnClient, governor: Arc<TurnCostGovernor>) -> Self {
        Self { client, governor }
    }

    /// Issues ICE servers including TURN credentials if permitted by the Cost Governor.
    ///
    /// If the governor determines the monthly quota is exhausted, this function immediately
    /// returns `Err(TurnError::QuotaExhausted)` without contacting Cloudflare.
    pub async fn issue_ice_servers(
        &self,
        ttl_secs: Option<u64>,
    ) -> Result<Vec<IceServerConfig>, TurnError> {
        // 1. Enforce hard cost governor ceiling
        self.governor.check_quota_permitted()?;

        // 2. Request short-lived credentials from Cloudflare
        self.client.generate_ice_servers(ttl_secs).await
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use chrono::TimeZone;

    /// Mock time provider for deterministic clock control in tests.
    #[derive(Debug)]
    pub struct MockTimeProvider {
        current: RwLock<DateTime<Utc>>,
    }

    impl MockTimeProvider {
        pub fn new(year: i32, month: u32, day: u32, hour: u32, min: u32, sec: u32) -> Self {
            let dt = Utc.with_ymd_and_hms(year, month, day, hour, min, sec).unwrap();
            Self {
                current: RwLock::new(dt),
            }
        }

        pub fn set_time(&self, dt: DateTime<Utc>) {
            *self.current.write().unwrap() = dt;
        }

        pub fn advance_days(&self, days: i64) {
            let mut cur = self.current.write().unwrap();
            *cur = *cur + chrono::Duration::days(days);
        }
    }

    impl TimeProvider for MockTimeProvider {
        fn now(&self) -> DateTime<Utc> {
            *self.current.read().unwrap()
        }
    }

    #[test]
    fn test_governor_threshold_enforcement() {
        let time_mock = Arc::new(MockTimeProvider::new(2026, 3, 15, 10, 0, 0));
        let threshold = 900 * 1024 * 1024 * 1024; // 900 GiB
        let governor = TurnCostGovernor::with_time_provider(threshold, time_mock);

        assert!(!governor.is_quota_exhausted());
        assert!(governor.check_quota_permitted().is_ok());

        // Incur 800 GiB (below threshold)
        governor.record_usage(800 * 1024 * 1024 * 1024);
        assert!(!governor.is_quota_exhausted());
        assert_eq!(governor.get_usage(), 800 * 1024 * 1024 * 1024);
        assert_eq!(governor.remaining_quota(), 100 * 1024 * 1024 * 1024);

        // Incur another 100 GiB -> exactly at threshold
        governor.record_usage(100 * 1024 * 1024 * 1024);
        assert!(governor.is_quota_exhausted());
        match governor.check_quota_permitted() {
            Err(TurnError::QuotaExhausted(used)) => assert_eq!(used, threshold),
            other => panic!("Expected QuotaExhausted, got {other:?}"),
        }

        // Additional bytes are blocked
        governor.record_usage(10 * 1024 * 1024 * 1024);
        assert!(governor.is_quota_exhausted());
    }

    #[test]
    fn test_governor_automatic_monthly_reset() {
        // Start near end of March 2026
        let time_mock = Arc::new(MockTimeProvider::new(2026, 3, 31, 23, 50, 0));
        let threshold = 1000;
        let governor = TurnCostGovernor::with_time_provider(threshold, time_mock.clone());

        // Exceed quota in March
        governor.record_usage(1200);
        assert!(governor.is_quota_exhausted());
        assert_eq!(governor.get_usage(), 1200);

        // Advance clock by 15 minutes into April 1st, 2026
        let april_first = Utc.with_ymd_and_hms(2026, 4, 1, 0, 5, 0).unwrap();
        time_mock.set_time(april_first);

        // Usage must reset to 0 and quota must be permitted again
        assert!(!governor.is_quota_exhausted());
        assert_eq!(governor.get_usage(), 0);
        assert_eq!(governor.remaining_quota(), 1000);
        assert!(governor.check_quota_permitted().is_ok());
    }

    #[test]
    fn test_governor_year_boundary_reset() {
        // Start on December 31, 2026
        let time_mock = Arc::new(MockTimeProvider::new(2026, 12, 31, 23, 59, 0));
        let threshold = 5000;
        let governor = TurnCostGovernor::with_time_provider(threshold, time_mock.clone());

        governor.record_usage(5000);
        assert!(governor.is_quota_exhausted());

        // Advance to January 1, 2027
        let jan_first = Utc.with_ymd_and_hms(2027, 1, 1, 0, 0, 1).unwrap();
        time_mock.set_time(jan_first);

        assert!(!governor.is_quota_exhausted());
        assert_eq!(governor.get_usage(), 0);
        assert!(governor.check_quota_permitted().is_ok());
    }

    #[test]
    fn test_programmatic_set_usage() {
        let time_mock = Arc::new(MockTimeProvider::new(2026, 5, 1, 12, 0, 0));
        let governor = TurnCostGovernor::with_time_provider(10_000, time_mock);

        governor.set_usage(9_500);
        assert_eq!(governor.get_usage(), 9_500);
        assert_eq!(governor.remaining_quota(), 500);
        assert!(!governor.is_quota_exhausted());

        governor.set_usage(10_500);
        assert!(governor.is_quota_exhausted());
    }

    #[tokio::test]
    async fn test_turn_service_blocks_when_quota_exhausted() {
        let time_mock = Arc::new(MockTimeProvider::new(2026, 6, 1, 10, 0, 0));
        let governor = Arc::new(TurnCostGovernor::with_time_provider(1000, time_mock));
        governor.record_usage(1500); // Exceeded

        let client = CloudflareTurnClient::with_custom_endpoint(
            "http://127.0.0.1:9999",
            Some("token".to_string()),
            Some("key".to_string()),
            3600,
        );
        let service = TurnService::with_custom(client, governor);

        let result = service.issue_ice_servers(None).await;
        match result {
            Err(TurnError::QuotaExhausted(used)) => assert_eq!(used, 1500),
            other => panic!("Expected QuotaExhausted, got {other:?}"),
        }
    }
}
