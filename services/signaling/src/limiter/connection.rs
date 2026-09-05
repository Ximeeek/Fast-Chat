use crate::limiter::key::RateKey;
use dashmap::DashMap;
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
struct ConnectionRecord {
    attempts: Vec<Instant>,
    backoff_level: u32,
    blocked_until: Option<Instant>,
    last_attempt: Instant,
}

/// WebSocket connection rate limiter with sliding 1-minute window and exponential backoff.
/// Keyed strictly in RAM by ephemeral 128-bit RateKey.
#[derive(Debug)]
pub struct ConnectionLimiter {
    records: DashMap<RateKey, ConnectionRecord>,
    max_per_minute: usize,
    base_backoff: Duration,
    max_backoff: Duration,
    window: Duration,
}

impl ConnectionLimiter {
    /// Instantiates a new ConnectionLimiter with specified threshold and backoff durations.
    pub fn new(max_per_minute: usize, base_backoff_secs: u64, max_backoff_secs: u64) -> Self {
        Self {
            records: DashMap::new(),
            max_per_minute,
            base_backoff: Duration::from_secs(base_backoff_secs.max(1)),
            max_backoff: Duration::from_secs(max_backoff_secs.max(1)),
            window: Duration::from_secs(60),
        }
    }

    /// Checks if a WebSocket connection attempt is permitted for the given rate key.
    /// If currently in an active exponential backoff or the per-minute limit is exceeded,
    /// returns Err(retry_after_seconds). Otherwise records the attempt and returns Ok(()).
    pub fn check_and_record(&self, key: &RateKey) -> Result<(), u64> {
        let now = Instant::now();
        let mut entry = self.records.entry(*key).or_insert_with(|| ConnectionRecord {
            attempts: Vec::new(),
            backoff_level: 0,
            blocked_until: None,
            last_attempt: now,
        });

        // 1. Check if backoff penalty is currently active
        if let Some(blocked_until) = entry.blocked_until {
            if now < blocked_until {
                // Client continues attempting connections during penalty: escalate backoff level
                entry.backoff_level = (entry.backoff_level + 1).min(10);
                let multiplier = 2u64.saturating_pow(entry.backoff_level.saturating_sub(1));
                let new_backoff = (self.base_backoff * multiplier as u32).min(self.max_backoff);
                entry.blocked_until = Some(now + new_backoff);
                entry.last_attempt = now;
                let retry_after = (blocked_until - now).as_secs().max(1);
                return Err(retry_after);
            } else {
                // Backoff duration has expired; reset if idle window has passed
                if now.duration_since(entry.last_attempt) > self.window * 2 {
                    entry.backoff_level = 0;
                }
                entry.blocked_until = None;
            }
        }

        entry.last_attempt = now;

        // 2. Filter attempts outside the 1-minute window
        entry.attempts.retain(|&t| now.duration_since(t) < self.window);

        // 3. Evaluate threshold
        if entry.attempts.len() >= self.max_per_minute {
            // Initiate exponential backoff: base_backoff * 2^(backoff_level - 1)
            entry.backoff_level = (entry.backoff_level + 1).min(10);
            let multiplier = 2u64.saturating_pow(entry.backoff_level.saturating_sub(1));
            let backoff_duration = (self.base_backoff * multiplier as u32).min(self.max_backoff);
            entry.blocked_until = Some(now + backoff_duration);
            let retry_after = backoff_duration.as_secs().max(1);
            Err(retry_after)
        } else {
            entry.attempts.push(now);
            Ok(())
        }
    }

    /// Prunes expired connection records where the client has been inactive longer than retention period.
    pub fn prune_stale(&self) {
        let now = Instant::now();
        let retention = self.window + self.max_backoff;
        self.records.retain(|_, record| {
            if let Some(blocked_until) = record.blocked_until {
                if now < blocked_until {
                    return true;
                }
            }
            now.duration_since(record.last_attempt) < retention
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
    fn test_connection_attempts_within_limit() {
        let limiter = ConnectionLimiter::new(5, 2, 30);
        let key = RateKey([10u8; 16]);

        for _ in 0..5 {
            assert!(limiter.check_and_record(&key).is_ok());
        }

        // 6th attempt triggers exponential backoff
        let res = limiter.check_and_record(&key);
        assert!(res.is_err());
        let retry_after = res.unwrap_err();
        assert_eq!(retry_after, 2); // base backoff = 2s
    }

    #[test]
    fn test_exponential_backoff_escalation() {
        let limiter = ConnectionLimiter::new(2, 2, 60);
        let key = RateKey([20u8; 16]);

        // 2 allowed
        assert!(limiter.check_and_record(&key).is_ok());
        assert!(limiter.check_and_record(&key).is_ok());

        // 3rd attempt exceeds limit -> 2s backoff
        let err1 = limiter.check_and_record(&key);
        assert!(err1.is_err());

        // 4th attempt during backoff -> backoff escalates (2s * 2^1 = 4s)
        let err2 = limiter.check_and_record(&key);
        assert!(err2.is_err());
    }

    #[test]
    fn test_independent_keys_quota() {
        let limiter = ConnectionLimiter::new(2, 2, 30);
        let key1 = RateKey([1u8; 16]);
        let key2 = RateKey([2u8; 16]);

        assert!(limiter.check_and_record(&key1).is_ok());
        assert!(limiter.check_and_record(&key1).is_ok());
        assert!(limiter.check_and_record(&key1).is_err());

        assert!(limiter.check_and_record(&key2).is_ok());
        assert!(limiter.check_and_record(&key2).is_ok());
    }
}
