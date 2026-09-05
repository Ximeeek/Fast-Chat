use crate::limiter::key::RateKey;
use dashmap::DashMap;
use std::time::{Duration, Instant};

/// Sliding window rate limiter for room creations.
/// Enforces a maximum number of rooms created per hour per RateKey.
/// Records are stored volatilely in RAM and automatically pruned.
#[derive(Debug)]
pub struct RoomCreationLimiter {
    records: DashMap<RateKey, Vec<Instant>>,
    max_creations_per_hour: usize,
    window: Duration,
}

impl RoomCreationLimiter {
    /// Instantiates a new RoomCreationLimiter with specified hourly threshold.
    pub fn new(max_creations_per_hour: usize) -> Self {
        Self {
            records: DashMap::new(),
            max_creations_per_hour,
            window: Duration::from_secs(3600), // 1 hour sliding window
        }
    }

    /// Checks whether room creation is permitted for the specified rate key.
    /// If permitted, registers the current timestamp and returns Ok(()).
    /// If the rate limit is exceeded, returns Err(retry_after_seconds).
    pub fn check_and_record(&self, key: &RateKey) -> Result<(), u64> {
        let now = Instant::now();
        let mut entry = self.records.entry(*key).or_default();

        // Evict timestamps older than 1 hour
        entry.retain(|&t| now.duration_since(t) < self.window);

        if entry.len() >= self.max_creations_per_hour {
            let oldest = entry[0];
            let elapsed = now.duration_since(oldest);
            let retry_after = if elapsed < self.window {
                (self.window - elapsed).as_secs().max(1)
            } else {
                1
            };
            Err(retry_after)
        } else {
            entry.push(now);
            Ok(())
        }
    }

    /// Prunes expired rate key records where all creation timestamps have passed the 1-hour window.
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
    fn test_room_creation_within_and_exceeding_limit() {
        let limiter = RoomCreationLimiter::new(3);
        let key = RateKey([1u8; 16]);

        assert!(limiter.check_and_record(&key).is_ok());
        assert!(limiter.check_and_record(&key).is_ok());
        assert!(limiter.check_and_record(&key).is_ok());

        // 4th creation attempt within window must be rejected
        let result = limiter.check_and_record(&key);
        assert!(result.is_err());
        let retry_after = result.unwrap_err();
        assert!(retry_after > 0 && retry_after <= 3600);
    }

    #[test]
    fn test_distinct_keys_have_independent_creation_quotas() {
        let limiter = RoomCreationLimiter::new(2);
        let key_a = RateKey([1u8; 16]);
        let key_b = RateKey([2u8; 16]);

        assert!(limiter.check_and_record(&key_a).is_ok());
        assert!(limiter.check_and_record(&key_a).is_ok());
        assert!(limiter.check_and_record(&key_a).is_err());

        // key_b should still have its full quota
        assert!(limiter.check_and_record(&key_b).is_ok());
        assert!(limiter.check_and_record(&key_b).is_ok());
        assert!(limiter.check_and_record(&key_b).is_err());
    }

    #[test]
    fn test_prune_stale_records() {
        let limiter = RoomCreationLimiter::new(5);
        let key = RateKey([3u8; 16]);
        assert!(limiter.check_and_record(&key).is_ok());
        assert_eq!(limiter.tracked_keys_count(), 1);

        // Simulated prune with no expired timestamps keeps the entry
        limiter.prune_stale();
        assert_eq!(limiter.tracked_keys_count(), 1);
    }
}
