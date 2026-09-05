# services/signaling

Subproject for the WebRTC signaling service of **FastChat Room**.

- **Technology:** Rust 2024 edition, axum v0.8, tokio v1.43, dashmap v6.1
- **Architecture:** Zero-persistence, volatile in-memory room state machine. Single source of truth for expiration timers. Zero database, zero disk writes.

## Features (Phase 2 Core)

1. **In-Memory Storage (`DashMap<RoomCode, RoomState>`)**:
   - Concurrently accessible, sharded lock-free hash map stored strictly in RAM.
   - Per-room cryptographic salt (`[u8; 32]`) and optional password status.
   - Configurable participant limit (default: 4), enforced centrally.
2. **Room Code Generator**:
   - 12 random digits formatted into `0000-0000-0000`.
   - Collision-free uniqueness verification against active `DashMap` keys.
3. **Room Lifecycle State Machine**:
   - `Creating`: Unique room code assigned; initial 10:00 countdown started.
   - `Active`: Normal operation; peer chat and P2P connection exchange.
   - `ExtendableWindow`: Entered when remaining time is $\le$ 2:00. Room owner can extend duration by 5:00, reverting the state to `Active`.
   - `Closing`: Triggered upon timer expiration or owner manual closure; 10-second grace period initiated.
   - `Destroyed`: Room record evicted from `DashMap`; `ROOM_CLOSED` broadcast triggered.
4. **Server as Single Source of Truth**:
   - Background Tokio ticker task running every second evaluates deadlines and drives state transitions.
5. **Zero Footprint**:
   - No disk I/O, no database credentials, no file logs of rooms.

## Running & Testing

```bash
# Run unit and integration tests
cargo test

# Run signaling server locally
cargo run

# Build release binary
cargo build --release
```

## Configuration

All configuration is driven by environment variables with sensible defaults:

| Variable | Default | Description |
|---|---|---|
| `FASTCHAT_MAX_PARTICIPANTS_PER_ROOM` | `4` | Maximum concurrent participants per room |
| `FASTCHAT_INITIAL_ROOM_DURATION_SECS` | `600` | Initial room lifetime (10 minutes) |
| `FASTCHAT_EXTENDABLE_THRESHOLD_SECS` | `120` | Threshold triggering `ExtendableWindow` (2 minutes) |
| `FASTCHAT_EXTENSION_DURATION_SECS` | `300` | Lifetime added per extension (5 minutes) |
| `FASTCHAT_CLOSING_GRACE_PERIOD_SECS` | `10` | Grace period in `Closing` before eviction |
| `FASTCHAT_SWEEPER_INTERVAL_SECS` | `1` | Background sweep evaluation interval |
| `PORT` | `3000` | Server HTTP/WebSocket port |
| `HOST` | `0.0.0.0` | Server bind host address |
