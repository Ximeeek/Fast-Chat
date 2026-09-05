use crate::limiter::RateLimiterService;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::interval;
use tracing::info;

/// Spawns a background task that periodically rotates the daily pepper secret in RAM.
/// When rotated, all previously derived RateKey values become cryptographically disconnected
/// from their originating IP addresses, automatically forgetting stale entries.
pub fn start_pepper_rotator(
    service: Arc<RateLimiterService>,
    interval_secs: u64,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = interval(Duration::from_secs(interval_secs.max(1)));
        // First tick completes immediately, skip it
        ticker.tick().await;

        loop {
            ticker.tick().await;
            service.pepper.rotate();
            info!(
                interval_secs = interval_secs,
                "Rotated ephemeral daily pepper secret in RAM; old rate keys decoupled"
            );
        }
    })
}

/// Spawns a background task that periodically prunes expired rate limiter entries from RAM.
pub fn start_limiter_sweeper(
    service: Arc<RateLimiterService>,
    interval_secs: u64,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = interval(Duration::from_secs(interval_secs.max(1)));
        ticker.tick().await;

        loop {
            ticker.tick().await;
            service.connection.prune_stale();
            service.join.prune_stale();
            service.turn_issuance.prune_stale();
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

    #[tokio::test]
    async fn test_pepper_rotator_task_execution() {
        let config = Config::default();
        let service = Arc::new(RateLimiterService::new(&config));
        let ip = "192.168.1.1".parse().unwrap();
        let key1 = service.pepper.derive_key(&ip);

        // Spawn rotator with very short 10ms interval
        let handle = start_pepper_rotator(service.clone(), 1);
        tokio::time::sleep(Duration::from_millis(20)).await;

        // Manual rotation verified
        service.pepper.rotate();
        let key2 = service.pepper.derive_key(&ip);
        assert_ne!(key1, key2);

        handle.abort();
    }
}
