use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

/// RAII guard that automatically decrements active connection count upon drop.
#[derive(Debug)]
pub struct ConnectionGuard {
    active_connections: Arc<AtomicUsize>,
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.active_connections.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Server-wide concurrency limiter managing global capacity ceilings.
/// Rejects new allocations with "server busy" status when thresholds are reached.
#[derive(Debug)]
pub struct GlobalCeiling {
    active_connections: Arc<AtomicUsize>,
    max_rooms: usize,
    max_connections: usize,
}

impl GlobalCeiling {
    /// Instantiates a new GlobalCeiling with maximum room and connection thresholds.
    pub fn new(max_rooms: usize, max_connections: usize) -> Self {
        Self {
            active_connections: Arc::new(AtomicUsize::new(0)),
            max_rooms,
            max_connections,
        }
    }

    /// Evaluates whether a new room can be created given current room count.
    pub fn check_room_capacity(&self, current_rooms: usize) -> Result<(), &'static str> {
        if current_rooms >= self.max_rooms {
            Err("Server is currently at maximum capacity (server busy). Please try again later.")
        } else {
            Ok(())
        }
    }

    /// Evaluates whether a new WebSocket connection can be accepted.
    /// If permitted, increments the active connection counter and returns an RAII ConnectionGuard.
    pub fn acquire_connection(&self) -> Result<ConnectionGuard, &'static str> {
        loop {
            let current = self.active_connections.load(Ordering::SeqCst);
            if current >= self.max_connections {
                return Err("Server is currently at maximum capacity (server busy). Please try again later.");
            }
            if self
                .active_connections
                .compare_exchange(current, current + 1, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                return Ok(ConnectionGuard {
                    active_connections: self.active_connections.clone(),
                });
            }
        }
    }

    /// Returns the current number of active concurrent WebSocket connections.
    pub fn current_connections(&self) -> usize {
        self.active_connections.load(Ordering::SeqCst)
    }

    /// Maximum total rooms ceiling.
    pub fn max_rooms(&self) -> usize {
        self.max_rooms
    }

    /// Maximum total connections ceiling.
    pub fn max_connections(&self) -> usize {
        self.max_connections
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_room_capacity_ceiling() {
        let ceiling = GlobalCeiling::new(3, 10);

        assert!(ceiling.check_room_capacity(0).is_ok());
        assert!(ceiling.check_room_capacity(2).is_ok());
        assert!(ceiling.check_room_capacity(3).is_err());
        assert!(ceiling.check_room_capacity(4).is_err());
    }

    #[test]
    fn test_connection_capacity_and_raii_guard() {
        let ceiling = GlobalCeiling::new(10, 2);

        assert_eq!(ceiling.current_connections(), 0);

        let guard1 = ceiling.acquire_connection().expect("connection 1 allowed");
        assert_eq!(ceiling.current_connections(), 1);

        let guard2 = ceiling.acquire_connection().expect("connection 2 allowed");
        assert_eq!(ceiling.current_connections(), 2);

        // 3rd connection exceeds ceiling
        assert!(ceiling.acquire_connection().is_err());

        // Dropping guard1 frees capacity
        drop(guard1);
        assert_eq!(ceiling.current_connections(), 1);

        let guard3 = ceiling.acquire_connection().expect("connection 3 allowed");
        assert_eq!(ceiling.current_connections(), 2);

        drop(guard2);
        drop(guard3);
        assert_eq!(ceiling.current_connections(), 0);
    }
}
