use crate::limiter::key::RateKey;
use dashmap::DashMap;
use std::time::{Duration, Instant};

/// Default escalating lockout ladder durations: 5 min -> 15 min -> 30 min -> 1 hour -> 2 hours (cap).
pub const DEFAULT_LOCKOUT_LADDER: [Duration; 5] = [
    Duration::from_secs(300),   // 5 minutes
    Duration::from_secs(900),   // 15 minutes
    Duration::from_secs(1800),  // 30 minutes
    Duration::from_secs(3600),  // 1 hour
    Duration::from_secs(7200),  // 2 hours (ceiling cap)
];

#[derive(Debug, Clone)]
struct JoinRecord {
    attempts: Vec<Instant>,
    failed_attempts: Vec<Instant>,
    locked_until: Option<Instant>,
    ladder_level: usize,
    last_lockout_end: Option<Instant>,
    last_penalty_duration: Option<Duration>,
    last_failed_attempt: Option<Instant>,
    last_activity: Instant,
}

impl JoinRecord {
    fn new(now: Instant) -> Self {
        Self {
            attempts: Vec::new(),
            failed_attempts: Vec::new(),
            locked_until: None,
            ladder_level: 0,
            last_lockout_end: None,
            last_penalty_duration: None,
            last_failed_attempt: None,
            last_activity: now,
        }
    }

    /// Evaluates the ladder reset rule:
    /// If an interval equal to 2x the duration of the last penalty has elapsed
    /// without any new failed attempt, the ladder level resets to 0.
    fn maybe_reset_ladder(&mut self, now: Instant) {
        if let (Some(lockout_end), Some(penalty_dur)) = (self.last_lockout_end, self.last_penalty_duration) {
            if now >= lockout_end {
                let reset_window = penalty_dur.saturating_mul(2);
                let quiet_start = self.last_failed_attempt.unwrap_or(lockout_end);
                if now.duration_since(quiet_start) >= reset_window {
                    self.ladder_level = 0;
                    self.last_lockout_end = None;
                    self.last_penalty_duration = None;
                    self.last_failed_attempt = None;
                    self.failed_attempts.clear();
                }
            }
        }
    }
}

/// Evaluation result when checking join permission.
#[derive(Debug, PartialEq, Eq)]
pub enum JoinCheckError {
    /// Client is temporarily locked out due to multiple failed join attempts.
    LockedOut { retry_after_secs: u64 },
    /// Client exceeded general per-minute join attempt rate.
    RateLimited { retry_after_secs: u64 },
}

/// In-memory rate limiter and escalating lockout guard for room joins.
/// Protects against room code brute-forcing and password guessing attacks.
#[derive(Debug)]
pub struct JoinLimiter {
    records: DashMap<RateKey, JoinRecord>,
    max_joins_per_min: usize,
    failed_attempts_threshold: usize,
    failed_window: Duration,
    lockout_ladder: Vec<Duration>,
    rate_window: Duration,
}

impl JoinLimiter {
    /// Instantiates a new JoinLimiter with default escalating lockout ladder.
    pub fn new(
        max_joins_per_min: usize,
        failed_attempts_threshold: usize,
        failed_window_secs: u64,
        _lockout_duration_secs: u64,
    ) -> Self {
        Self::with_ladder(
            max_joins_per_min,
            failed_attempts_threshold,
            failed_window_secs,
            DEFAULT_LOCKOUT_LADDER.to_vec(),
        )
    }

    /// Instantiates a new JoinLimiter with a custom lockout escalation ladder.
    pub fn with_ladder(
        max_joins_per_min: usize,
        failed_attempts_threshold: usize,
        failed_window_secs: u64,
        ladder: Vec<Duration>,
    ) -> Self {
        let ladder = if ladder.is_empty() {
            DEFAULT_LOCKOUT_LADDER.to_vec()
        } else {
            ladder
        };
        Self {
            records: DashMap::new(),
            max_joins_per_min,
            failed_attempts_threshold: failed_attempts_threshold.max(1),
            failed_window: Duration::from_secs(failed_window_secs.max(1)),
            lockout_ladder: ladder,
            rate_window: Duration::from_secs(60),
        }
    }

    /// Checks if a join attempt is permitted at the specified timestamp.
    pub fn check_join_permitted_at(&self, key: &RateKey, now: Instant) -> Result<(), JoinCheckError> {
        let mut entry = self.records.entry(*key).or_insert_with(|| JoinRecord::new(now));

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
                entry.last_failed_attempt = None;
            }
        }

        // 2. Evaluate ladder reset rule (2x penalty duration quiet period)
        entry.maybe_reset_ladder(now);

        entry.last_activity = now;
        entry.attempts.retain(|&t| now.duration_since(t) < self.rate_window);

        // 3. Check general join attempts per minute
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

    /// Checks if a join attempt is permitted for the given rate key using the current system time.
    pub fn check_join_permitted(&self, key: &RateKey) -> Result<(), JoinCheckError> {
        self.check_join_permitted_at(key, Instant::now())
    }

    /// Records a failed join attempt at the specified timestamp.
    /// If failed attempts reach threshold within failed_window, activates escalating lockout.
    pub fn record_failure_at(&self, key: &RateKey, now: Instant) {
        let mut entry = self.records.entry(*key).or_insert_with(|| JoinRecord::new(now));

        // 1. If currently locked out, do not count as a new failure (defense-in-depth)
        if let Some(locked_until) = entry.locked_until {
            if now < locked_until {
                return;
            } else {
                entry.locked_until = None;
                entry.failed_attempts.clear();
                entry.last_failed_attempt = None;
            }
        }

        // 2. Evaluate ladder reset rule before recording the new failure
        entry.maybe_reset_ladder(now);

        entry.last_activity = now;
        let last_lockout_end = entry.last_lockout_end;
        entry.failed_attempts.retain(|&t| {
            now.duration_since(t) < self.failed_window
                && last_lockout_end.map_or(true, |end| t >= end)
        });
        entry.failed_attempts.push(now);
        entry.last_failed_attempt = Some(now);

        // 3. If failure threshold reached, activate escalating lockout
        if entry.failed_attempts.len() >= self.failed_attempts_threshold {
            let penalty_level = entry.ladder_level.min(self.lockout_ladder.len().saturating_sub(1));
            let duration = self.lockout_ladder.get(penalty_level).copied().unwrap_or(Duration::from_secs(300));
            let lockout_end = now + duration;

            entry.locked_until = Some(lockout_end);
            entry.last_lockout_end = Some(lockout_end);
            entry.last_penalty_duration = Some(duration);
            entry.failed_attempts.clear();
            entry.last_failed_attempt = None;

            // Escalate to next level on ladder for future lockouts, capping at max level
            if entry.ladder_level + 1 < self.lockout_ladder.len() {
                entry.ladder_level += 1;
            }
        }
    }

    /// Records a failed join attempt using current system time.
    pub fn record_failure(&self, key: &RateKey) {
        self.record_failure_at(key, Instant::now());
    }

    /// Records a successful room join at the specified timestamp, resetting the window failure counter.
    /// The escalation ladder level is intentionally NOT reset here, but governed strictly by elapsed quiet time.
    pub fn record_success_at(&self, key: &RateKey, now: Instant) {
        if let Some(mut entry) = self.records.get_mut(key) {
            entry.failed_attempts.clear();
            entry.last_activity = now;
        }
    }

    /// Records a successful room join using current system time.
    pub fn record_success(&self, key: &RateKey) {
        self.record_success_at(key, Instant::now());
    }

    /// Prunes stale join records where the client has remained inactive at the specified timestamp.
    pub fn prune_stale_at(&self, now: Instant) {
        self.records.retain(|_, record| {
            // 1. Retain while actively locked out
            if let Some(locked_until) = record.locked_until {
                if now < locked_until {
                    return true;
                }
            }

            // 2. Retain while in the 2x penalty duration reset window
            if let (Some(lockout_end), Some(penalty_dur)) = (record.last_lockout_end, record.last_penalty_duration) {
                let reset_window = penalty_dur.saturating_mul(2);
                let quiet_start = record.last_failed_attempt.unwrap_or(lockout_end);
                if now.duration_since(quiet_start) < reset_window {
                    return true;
                }
            }

            // 3. Retain if active within failed_window or rate_window
            let retention = self.failed_window.max(self.rate_window);
            now.duration_since(record.last_activity) < retention
        });
    }

    /// Prunes stale join records using current system time.
    pub fn prune_stale(&self) {
        self.prune_stale_at(Instant::now());
    }

    /// Returns the current escalation ladder level for the given rate key.
    pub fn get_ladder_level_at(&self, key: &RateKey, now: Instant) -> usize {
        if let Some(mut entry) = self.records.get_mut(key) {
            entry.maybe_reset_ladder(now);
            entry.ladder_level
        } else {
            0
        }
    }

    /// Returns the current escalation ladder level for the given rate key using current system time.
    pub fn get_ladder_level(&self, key: &RateKey) -> usize {
        self.get_ladder_level_at(key, Instant::now())
    }

    /// Returns the active lockout duration remaining for the given rate key, if locked out.
    pub fn get_lockout_remaining_at(&self, key: &RateKey, now: Instant) -> Option<Duration> {
        self.records.get(key).and_then(|entry| {
            entry.locked_until.and_then(|until| {
                if now < until {
                    Some(until - now)
                } else {
                    None
                }
            })
        })
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
    fn test_escalating_lockout_ladder_progression_and_cap() {
        let limiter = JoinLimiter::new(100, 4, 300, 300);
        let key = RateKey([40u8; 16]);
        let base_time = Instant::now();

        // 1. Level 0: 4 failures at base_time -> 5 minutes (300s)
        for _ in 0..4 {
            assert!(limiter.check_join_permitted_at(&key, base_time).is_ok());
            limiter.record_failure_at(&key, base_time);
        }
        let res1 = limiter.check_join_permitted_at(&key, base_time);
        assert_eq!(
            res1,
            Err(JoinCheckError::LockedOut {
                retry_after_secs: 300
            })
        );
        assert_eq!(
            limiter.get_lockout_remaining_at(&key, base_time),
            Some(Duration::from_secs(300))
        );

        // 2. Advance time past 5 min lockout: t1 = base_time + 300s
        let t1 = base_time + Duration::from_secs(300);
        for _ in 0..4 {
            assert!(limiter.check_join_permitted_at(&key, t1).is_ok());
            limiter.record_failure_at(&key, t1);
        }
        // Escalates to Level 1: 15 minutes (900s)
        let res2 = limiter.check_join_permitted_at(&key, t1);
        assert_eq!(
            res2,
            Err(JoinCheckError::LockedOut {
                retry_after_secs: 900
            })
        );

        // 3. Advance past 15 min lockout: t2 = t1 + 900s
        let t2 = t1 + Duration::from_secs(900);
        for _ in 0..4 {
            assert!(limiter.check_join_permitted_at(&key, t2).is_ok());
            limiter.record_failure_at(&key, t2);
        }
        // Escalates to Level 2: 30 minutes (1800s)
        let res3 = limiter.check_join_permitted_at(&key, t2);
        assert_eq!(
            res3,
            Err(JoinCheckError::LockedOut {
                retry_after_secs: 1800
            })
        );

        // 4. Advance past 30 min lockout: t3 = t2 + 1800s
        let t3 = t2 + Duration::from_secs(1800);
        for _ in 0..4 {
            assert!(limiter.check_join_permitted_at(&key, t3).is_ok());
            limiter.record_failure_at(&key, t3);
        }
        // Escalates to Level 3: 1 hour (3600s)
        let res4 = limiter.check_join_permitted_at(&key, t3);
        assert_eq!(
            res4,
            Err(JoinCheckError::LockedOut {
                retry_after_secs: 3600
            })
        );

        // 5. Advance past 1 hour lockout: t4 = t3 + 3600s
        let t4 = t3 + Duration::from_secs(3600);
        for _ in 0..4 {
            assert!(limiter.check_join_permitted_at(&key, t4).is_ok());
            limiter.record_failure_at(&key, t4);
        }
        // Escalates to Level 4 (cap): 2 hours (7200s)
        let res5 = limiter.check_join_permitted_at(&key, t4);
        assert_eq!(
            res5,
            Err(JoinCheckError::LockedOut {
                retry_after_secs: 7200
            })
        );

        // 6. Advance past 2 hours lockout: t5 = t4 + 7200s
        let t5 = t4 + Duration::from_secs(7200);
        for _ in 0..4 {
            assert!(limiter.check_join_permitted_at(&key, t5).is_ok());
            limiter.record_failure_at(&key, t5);
        }
        // Remains capped at 2 hours (7200s) - does not exceed 2 hours
        let res6 = limiter.check_join_permitted_at(&key, t5);
        assert_eq!(
            res6,
            Err(JoinCheckError::LockedOut {
                retry_after_secs: 7200
            })
        );
    }

    #[test]
    fn test_successful_join_resets_window_failure_counter() {
        let limiter = JoinLimiter::new(20, 4, 300, 300);
        let key = RateKey([41u8; 16]);
        let now = Instant::now();

        // 2 failures
        limiter.record_failure_at(&key, now);
        limiter.record_failure_at(&key, now);

        // Client gets it right on 3rd attempt: success resets the window failure counter
        limiter.record_success_at(&key, now);

        // 2 more failures should NOT trigger lockout (only 2 in current window, threshold is 4)
        limiter.record_failure_at(&key, now);
        limiter.record_failure_at(&key, now);
        assert!(limiter.check_join_permitted_at(&key, now).is_ok());

        // 2 more failures reach 4 in current window -> lockout activates
        limiter.record_failure_at(&key, now);
        limiter.record_failure_at(&key, now);
        assert!(matches!(
            limiter.check_join_permitted_at(&key, now),
            Err(JoinCheckError::LockedOut { .. })
        ));
    }

    #[test]
    fn test_ladder_resets_after_two_times_last_penalty_duration_quiet_period() {
        let limiter = JoinLimiter::new(50, 4, 300, 300);
        let key = RateKey([42u8; 16]);
        let t0 = Instant::now();

        // 4 failures -> lockout 5 min (300s). Level escalates to 1.
        for _ in 0..4 {
            limiter.record_failure_at(&key, t0);
        }
        assert_eq!(
            limiter.check_join_permitted_at(&key, t0),
            Err(JoinCheckError::LockedOut {
                retry_after_secs: 300
            })
        );

        // Lockout expires at t1 = t0 + 300s.
        // Last penalty duration was 300s, so reset interval is 2 * 300s = 600s.
        let t1 = t0 + Duration::from_secs(300);

        // At t1 + 599s (just before 2x penalty duration elapses): ladder level is still 1
        let t_before_reset = t1 + Duration::from_secs(599);
        assert_eq!(limiter.get_ladder_level_at(&key, t_before_reset), 1);

        // At t1 + 601s (after 2x penalty duration without any new failures): ladder level resets to 0!
        let t_after_reset = t1 + Duration::from_secs(601);
        assert_eq!(limiter.get_ladder_level_at(&key, t_after_reset), 0);

        // Triggering 4 failures now starts back at Level 0: 5 minutes (300s), NOT 15 minutes!
        for _ in 0..4 {
            limiter.record_failure_at(&key, t_after_reset);
        }
        assert_eq!(
            limiter.check_join_permitted_at(&key, t_after_reset),
            Err(JoinCheckError::LockedOut {
                retry_after_secs: 300
            })
        );
    }

    #[test]
    fn test_new_series_in_two_times_penalty_window_escalates_to_next_level() {
        let limiter = JoinLimiter::new(50, 4, 300, 300);
        let key = RateKey([43u8; 16]);
        let t0 = Instant::now();

        // 4 failures -> lockout 5 min (300s).
        for _ in 0..4 {
            limiter.record_failure_at(&key, t0);
        }
        assert_eq!(
            limiter.check_join_permitted_at(&key, t0),
            Err(JoinCheckError::LockedOut {
                retry_after_secs: 300
            })
        );

        // Lockout expires at t1 = t0 + 300s.
        // Within 2x penalty window (2 * 300s = 600s), e.g. at t1 + 200s:
        let t_attack = t0 + Duration::from_secs(500);

        // New series of 4 failures occurs before full reset:
        for _ in 0..4 {
            limiter.record_failure_at(&key, t_attack);
        }

        // Must escalate to Level 1: 15 minutes (900s), not restart at 5 minutes!
        assert_eq!(
            limiter.check_join_permitted_at(&key, t_attack),
            Err(JoinCheckError::LockedOut {
                retry_after_secs: 900
            })
        );
    }

    #[test]
    fn test_active_lockout_rejection_does_not_count_as_failed_attempts() {
        let limiter = JoinLimiter::new(50, 4, 300, 300);
        let key = RateKey([44u8; 16]);
        let t0 = Instant::now();

        // Trigger 5 min lockout
        for _ in 0..4 {
            limiter.record_failure_at(&key, t0);
        }

        // During active lockout at t0 + 60s, join is rejected immediately
        let t_mid = t0 + Duration::from_secs(60);
        assert_eq!(
            limiter.check_join_permitted_at(&key, t_mid),
            Err(JoinCheckError::LockedOut {
                retry_after_secs: 240
            })
        );

        // Spurious failure calls during lockout are ignored
        for _ in 0..10 {
            limiter.record_failure_at(&key, t_mid);
        }

        // After lockout expires at t1 = t0 + 300s:
        let t1 = t0 + Duration::from_secs(300);
        assert!(limiter.check_join_permitted_at(&key, t1).is_ok());

        // A single failure should not cause immediate lockout
        limiter.record_failure_at(&key, t1);
        assert!(limiter.check_join_permitted_at(&key, t1).is_ok());
    }

    #[test]
    fn test_prune_stale_retains_active_records_and_prunes_expired() {
        let limiter = JoinLimiter::new(50, 4, 300, 300);
        let key = RateKey([45u8; 16]);
        let t0 = Instant::now();

        for _ in 0..4 {
            limiter.record_failure_at(&key, t0);
        }
        assert_eq!(limiter.tracked_keys_count(), 1);

        // 1. While locked out (t0 + 100s), prune must retain
        limiter.prune_stale_at(t0 + Duration::from_secs(100));
        assert_eq!(limiter.tracked_keys_count(), 1);

        // 2. Lockout ends at t0 + 300s. During the 2x reset window (up to t0 + 900s), prune must retain
        limiter.prune_stale_at(t0 + Duration::from_secs(800));
        assert_eq!(limiter.tracked_keys_count(), 1);

        // 3. After 2x reset window and retention window have elapsed (t0 + 1500s), prune removes it
        limiter.prune_stale_at(t0 + Duration::from_secs(1500));
        assert_eq!(limiter.tracked_keys_count(), 0);
    }
}
