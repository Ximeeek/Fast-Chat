use crate::limiter::key::RateKey;
use dashmap::DashMap;
use std::time::{Duration, Instant};

/// Sliding window rate limiter for TURN credential issuances.
/// Enforces a maximum number of generated TURN credential sets per hour per RateKey.
/// Records are stored volatilely in RAM and automatically pruned.
#[derive(Debug)]
pub struct TurnIssuanceLimiter {
    records: DashMap<RateKey, Vec<Instant>>,
    max_issuances_per_hour: usize,
    window: Duration,
}

impl TurnIssuanceLimiter {
    /// Instantiates a new TurnIssuanceLimiter with specified hourly threshold.
    pub fn new(max_issuances_per_hour: usize) -> Self {
        Self {
            records: DashMap::new(),
            max_issuances_per_hour,
            window: Duration::from_secs(3600), // 1 hour sliding window
        }
    }

    /// Checks whether the specified rate key has reached or exceeded its hourly issuance allowance.
    pub fn is_limited(&self, key: &RateKey) -> bool {
        let now = Instant::now();
        if let Some(mut entry) = self.records.get_mut(key) {
            entry.retain(|&t| now.duration_since(t) < self.window);
            entry.len() >= self.max_issuances_per_hour
        } else {
            false
        }
    }

    /// Records an issuance of TURN credentials for the specified rate key.
    pub fn record_issuance(&self, key: &RateKey) {
        let now = Instant::now();
        let mut entry = self.records.entry(*key).or_default();
        entry.retain(|&t| now.duration_since(t) < self.window);
        entry.push(now);
    }

    /// Prunes expired rate key records where all issuance timestamps have passed the 1-hour window.
    pub fn prune_stale(&self) {
        let now = Instant::now();
        self.records.retain(|_, timestamps| {
            timestamps.retain(|&t| now.duration_since(t) < self.window);
            !timestamps.is_empty()
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
    fn test_turn_issuance_limiter_threshold() {
        let limiter = TurnIssuanceLimiter::new(3);
        let key = RateKey([42u8; 16]);

        assert!(!limiter.is_limited(&key));
        limiter.record_issuance(&key);
        assert!(!limiter.is_limited(&key));
        limiter.record_issuance(&key);
        assert!(!limiter.is_limited(&key));
        limiter.record_issuance(&key);

        // 3 recorded issuances reach threshold of 3
        assert!(limiter.is_limited(&key));
    }

    #[test]
    fn test_distinct_keys_independent_quotas() {
        let limiter = TurnIssuanceLimiter::new(2);
        let key1 = RateKey([1u8; 16]);
        let key2 = RateKey([2u8; 16]);

        limiter.record_issuance(&key1);
        limiter.record_issuance(&key1);
        assert!(limiter.is_limited(&key1));

        assert!(!limiter.is_limited(&key2));
        limiter.record_issuance(&key2);
        assert!(!limiter.is_limited(&key2));
    }
}
