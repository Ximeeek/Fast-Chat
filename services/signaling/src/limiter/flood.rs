use std::time::Instant;

/// Token bucket rate limiter for per-connection signaling message flood control.
/// Stored in volatile RAM within the connection loop state without requiring locks.
#[derive(Debug, Clone)]
pub struct TokenBucket {
    capacity: f64,
    refill_rate_per_sec: f64,
    tokens: f64,
    last_refill: Instant,
}

impl TokenBucket {
    /// Creates a new TokenBucket initialized to maximum capacity.
    pub fn new(capacity: u32, refill_rate_per_sec: u32) -> Self {
        let cap = capacity.max(1) as f64;
        let rate = refill_rate_per_sec.max(1) as f64;
        Self {
            capacity: cap,
            refill_rate_per_sec: rate,
            tokens: cap,
            last_refill: Instant::now(),
        }
    }

    /// Attempts to consume the requested tokens (default 1.0 per message).
    /// Returns true if allowed, or false if the bucket is exhausted.
    pub fn try_acquire(&mut self, cost: f64) -> bool {
        let now = Instant::now();
        let elapsed_secs = now.duration_since(self.last_refill).as_secs_f64();
        self.tokens = (self.tokens + elapsed_secs * self.refill_rate_per_sec).min(self.capacity);
        self.last_refill = now;

        if self.tokens >= cost {
            self.tokens -= cost;
            true
        } else {
            false
        }
    }

    /// Returns the approximate available tokens after accounting for elapsed refill time.
    pub fn available_tokens(&self) -> f64 {
        let now = Instant::now();
        let elapsed_secs = now.duration_since(self.last_refill).as_secs_f64();
        (self.tokens + elapsed_secs * self.refill_rate_per_sec).min(self.capacity)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_token_bucket_burst_and_exhaustion() {
        let mut bucket = TokenBucket::new(3, 1);

        assert!(bucket.try_acquire(1.0));
        assert!(bucket.try_acquire(1.0));
        assert!(bucket.try_acquire(1.0));

        // 4th acquire with empty bucket must fail
        assert!(!bucket.try_acquire(1.0));
    }

    #[test]
    fn test_token_bucket_refill() {
        let mut bucket = TokenBucket::new(5, 100); // 100 tokens/sec
        for _ in 0..5 {
            assert!(bucket.try_acquire(1.0));
        }
        assert!(!bucket.try_acquire(1.0));

        // Sleep briefly to accumulate refill tokens
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(bucket.try_acquire(1.0));
    }
}
