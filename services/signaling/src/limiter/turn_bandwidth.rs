use crate::limiter::key::RateKey;
use dashmap::DashMap;
use std::time::{Duration, Instant};

/// Sliding window rate limiter for relayed TURN bandwidth consumption.
/// Accumulates client-reported relayed bytes over a 1-hour rolling window.
/// If usage meets or exceeds the configured hourly budget, further TURN credential
/// generation is denied (falling back to STUN-only).
#[derive(Debug)]
pub struct TurnBandwidthLimiter {
    records: DashMap<RateKey, Vec<(Instant, u64)>>,
    max_hourly_bytes: u64,
    window: Duration,
}

impl TurnBandwidthLimiter {
    /// Instantiates a new TurnBandwidthLimiter with the specified hourly byte budget.
    pub fn new(max_hourly_bytes: u64) -> Self {
        Self {
            records: DashMap::new(),
            max_hourly_bytes,
            window: Duration::from_secs(3600), // 1 hour sliding window
        }
    }

    /// Checks whether the specified rate key has reached or exceeded its hourly byte allowance.
    pub fn is_limited(&self, key: &RateKey) -> bool {
        let now = Instant::now();
        if let Some(mut entry) = self.records.get_mut(key) {
            entry.retain(|(t, _)| now.duration_since(*t) < self.window);
            let total: u64 = entry.iter().map(|(_, b)| *b).sum();
            total >= self.max_hourly_bytes
        } else {
            false
        }
    }

    /// Records client-reported relayed bytes for the specified rate key.
    pub fn record_usage(&self, key: &RateKey, bytes: u64) {
        if bytes == 0 {
            return;
        }
        let now = Instant::now();
        let mut entry = self.records.entry(*key).or_default();
        entry.retain(|(t, _)| now.duration_since(*t) < self.window);
        entry.push((now, bytes));
    }

    /// Returns the total relayed bytes accumulated for the specified rate key within the active window.
    pub fn current_usage(&self, key: &RateKey) -> u64 {
        let now = Instant::now();
        if let Some(mut entry) = self.records.get_mut(key) {
            entry.retain(|(t, _)| now.duration_since(*t) < self.window);
            entry.iter().map(|(_, b)| *b).sum()
        } else {
            0
        }
    }

    /// Prunes expired rate key records where all byte usage entries have aged past the 1-hour window.
    pub fn prune_stale(&self) {
        let now = Instant::now();
        self.records.retain(|_, usage| {
            usage.retain(|(t, _)| now.duration_since(*t) < self.window);
            !usage.is_empty()
        });
    }

    /// Returns the number of distinct rate keys currently tracked in memory.
    pub fn tracked_keys_count(&self) -> usize {
        self.records.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_turn_bandwidth_limiter_threshold() {
        let limiter = TurnBandwidthLimiter::new(1000);
        let key = RateKey([77u8; 16]);

        assert!(!limiter.is_limited(&key));
        assert_eq!(limiter.current_usage(&key), 0);

        limiter.record_usage(&key, 400);
        assert!(!limiter.is_limited(&key));
        assert_eq!(limiter.current_usage(&key), 400);

        limiter.record_usage(&key, 599);
        assert!(!limiter.is_limited(&key));
        assert_eq!(limiter.current_usage(&key), 999);

        // Reaching exactly or exceeding 1000 triggers is_limited
        limiter.record_usage(&key, 1);
        assert!(limiter.is_limited(&key));
        assert_eq!(limiter.current_usage(&key), 1000);
    }

    #[test]
    fn test_zero_bytes_noop() {
        let limiter = TurnBandwidthLimiter::new(1000);
        let key = RateKey([88u8; 16]);

        limiter.record_usage(&key, 0);
        assert_eq!(limiter.tracked_keys_count(), 0);
        assert_eq!(limiter.current_usage(&key), 0);
    }

    #[test]
    fn test_distinct_keys_independent_bandwidth() {
        let limiter = TurnBandwidthLimiter::new(500);
        let key1 = RateKey([1u8; 16]);
        let key2 = RateKey([2u8; 16]);

        limiter.record_usage(&key1, 500);
        assert!(limiter.is_limited(&key1));

        assert!(!limiter.is_limited(&key2));
        limiter.record_usage(&key2, 250);
        assert!(!limiter.is_limited(&key2));
    }
}
