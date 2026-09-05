use crate::limiter::key::RateKey;
use dashmap::DashMap;
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
struct JoinRecord {
    attempts: Vec<Instant>,
    failed_attempts: Vec<Instant>,
    locked_until: Option<Instant>,
    last_activity: Instant,
}

/// Evaluation result when checking join permission.
#[derive(Debug, PartialEq, Eq)]
pub enum JoinCheckError {
    /// Client is temporarily locked out due to multiple failed join attempts.
    LockedOut { retry_after_secs: u64 },
    /// Client exceeded general per-minute join attempt rate.
    RateLimited { retry_after_secs: u64 },
}

/// In-memory rate limiter and failed-attempt lockout guard for room joins.
/// Protects against room code brute-forcing and password guessing attacks.
#[derive(Debug)]
pub struct JoinLimiter {
    records: DashMap<RateKey, JoinRecord>,
    max_joins_per_min: usize,
    failed_attempts_threshold: usize,
    failed_window: Duration,
    lockout_duration: Duration,
    rate_window: Duration,
}

impl JoinLimiter {
    /// Instantiates a new JoinLimiter with specified thresholds and durations.
    pub fn new(
        max_joins_per_min: usize,
        failed_attempts_threshold: usize,
        failed_window_secs: u64,
        lockout_duration_secs: u64,
    ) -> Self {
        Self {
            records: DashMap::new(),
            max_joins_per_min,
            failed_attempts_threshold,
            failed_window: Duration::from_secs(failed_window_secs.max(1)),
            lockout_duration: Duration::from_secs(lockout_duration_secs.max(1)),
            rate_window: Duration::from_secs(60),
        }
    }

    /// Checks if a join attempt is permitted for the given rate key.
    /// Returns Err(JoinCheckError) if the client is currently locked out or has exceeded the per-minute limit.
    pub fn check_join_permitted(&self, key: &RateKey) -> Result<(), JoinCheckError> {
        let now = Instant::now();
        let mut entry = self.records.entry(*key).or_insert_with(|| JoinRecord {
            attempts: Vec::new(),
            failed_attempts: Vec::new(),
            locked_until: None,
            last_activity: now,
        });

        // 1. Check if temporary lockout is active
        if let Some(locked_until) = entry.locked_until {
            if now < locked_until {
                let retry_after = (locked_until - now).as_secs().max(1);
                return Err(JoinCheckError::LockedOut {
                    retry_after_secs: retry_after,
                });
            } else {
                entry.locked_until = None;
                entry.failed_attempts.clear();
            }
        }

        entry.last_activity = now;
        entry.attempts.retain(|&t| now.duration_since(t) < self.rate_window);

        // 2. Check general join attempts per minute
        if entry.attempts.len() >= self.max_joins_per_min {
            let oldest = entry.attempts[0];
            let elapsed = now.duration_since(oldest);
            let retry_after = if elapsed < self.rate_window {
                (self.rate_window - elapsed).as_secs().max(1)
            } else {
                1
            };
            return Err(JoinCheckError::RateLimited {
                retry_after_secs: retry_after,
            });
        }

        entry.attempts.push(now);
        Ok(())
    }

    /// Records a failed join attempt (invalid code, wrong password, or terminated room).
    /// If failed attempts reach threshold within failed_window, activates temporary lockout.
    pub fn record_failure(&self, key: &RateKey) {
        let now = Instant::now();
        let mut entry = self.records.entry(*key).or_insert_with(|| JoinRecord {
            attempts: Vec::new(),
            failed_attempts: Vec::new(),
            locked_until: None,
            last_activity: now,
        });

        entry.last_activity = now;
        entry.failed_attempts.retain(|&t| now.duration_since(t) < self.failed_window);
        entry.failed_attempts.push(now);

        if entry.failed_attempts.len() >= self.failed_attempts_threshold {
            entry.locked_until = Some(now + self.lockout_duration);
            entry.failed_attempts.clear();
        }
    }

    /// Records a successful room join, resetting the consecutive failure counter.
    pub fn record_success(&self, key: &RateKey) {
        if let Some(mut entry) = self.records.get_mut(key) {
            entry.failed_attempts.clear();
            entry.last_activity = Instant::now();
        }
    }

    /// Prunes stale join records where the client has remained inactive.
    pub fn prune_stale(&self) {
        let now = Instant::now();
        let max_retention = self.lockout_duration + self.failed_window;
        self.records.retain(|_, record| {
            if let Some(locked_until) = record.locked_until {
                if now < locked_until {
                    return true;
                }
            }
            now.duration_since(record.last_activity) < max_retention
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
    fn test_join_rate_limit_per_minute() {
        let limiter = JoinLimiter::new(3, 10, 300, 900);
        let key = RateKey([30u8; 16]);

        assert!(limiter.check_join_permitted(&key).is_ok());
        assert!(limiter.check_join_permitted(&key).is_ok());
        assert!(limiter.check_join_permitted(&key).is_ok());

        // 4th attempt exceeds per-minute rate
        let res = limiter.check_join_permitted(&key);
        assert!(matches!(res, Err(JoinCheckError::RateLimited { .. })));
    }

    #[test]
    fn test_failed_attempts_lockout_activation() {
        let limiter = JoinLimiter::new(20, 3, 300, 60);
        let key = RateKey([31u8; 16]);

        assert!(limiter.check_join_permitted(&key).is_ok());
        limiter.record_failure(&key);

        assert!(limiter.check_join_permitted(&key).is_ok());
        limiter.record_failure(&key);

        assert!(limiter.check_join_permitted(&key).is_ok());
        limiter.record_failure(&key); // 3rd failure triggers lockout

        // Next join attempt must be locked out
        let res = limiter.check_join_permitted(&key);
        assert!(matches!(res, Err(JoinCheckError::LockedOut { .. })));
    }

    #[test]
    fn test_successful_join_clears_failures() {
        let limiter = JoinLimiter::new(20, 3, 300, 60);
        let key = RateKey([32u8; 16]);

        // 2 failures
        limiter.record_failure(&key);
        limiter.record_failure(&key);

        // Success resets counter
        limiter.record_success(&key);

        // 1 more failure should not trigger lockout
        limiter.record_failure(&key);
        assert!(limiter.check_join_permitted(&key).is_ok());
    }
}
