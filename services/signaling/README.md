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

## WebSocket Protocol (Phase 3)

The signaling service exposes a WebSocket endpoint at `/ws` using JSON messaging (`SCREAMING_SNAKE_CASE` message tags):

### Client to Server Messages

1. **`CREATE_ROOM`**:
   - Creates a new ephemeral room and registers the sender as owner.
   - Payload: `{ "peer_id"?: string, "has_password"?: boolean, "password"?: string }`.
2. **`JOIN_ROOM`**:
   - Joins an existing room with code and optional password.
   - Payload: `{ "code": "0000-0000-0000", "peer_id"?: string, "password"?: string }`.
3. **`SDP_OFFER`**:
   - Relayed verbatim 1:1 to target peer.
   - Payload: `{ "target_peer_id": string, "sdp": object }`.
4. **`SDP_ANSWER`**:
   - Relayed verbatim 1:1 to target peer.
   - Payload: `{ "target_peer_id": string, "sdp": object }`.
5. **`ICE_CANDIDATES`** (or `ICE_CANDIDATE`):
   - Relayed verbatim 1:1 to target peer.
   - Payload: `{ "target_peer_id": string, "candidates"?: array, "candidate"?: object }`.
6. **`REKEY`**:
   - Owner-only rekey event configuring room password protection and salt.
   - Payload: `{ "password": string, "salt"?: string }`.
7. **`PING`**:
   - Application-level heartbeat ping.

### Server to Client Messages

1. **`ROOM_CREATED`**: `{ "code": string, "peer_id": string, "salt": string, "expires_at": number, "expiresAt": number }`.
2. **`JOIN_OK`**: `{ "status": "OK", "code": string, "peer_id": string, "is_owner": boolean, "salt": string, "expiresAt": number, "peers": string[] }`.
3. **`PEER_JOINED`**: Broadcast to existing room participants: `{ "peer_id": string }`.
4. **`PEER_LEFT`**: Broadcast upon peer disconnect: `{ "peer_id": string }`.
5. **`SDP_OFFER`**: Forwarded to target with verified sender: `{ "sender_peer_id": string, "sdp": object }`.
6. **`SDP_ANSWER`**: Forwarded to target with verified sender: `{ "sender_peer_id": string, "sdp": object }`.
7. **`ICE_CANDIDATES`**: Forwarded to target with verified sender: `{ "sender_peer_id": string, "candidates"?: array, "candidate"?: object }`.
8. **`REKEY`**: Broadcast to all room participants: `{ "room_code": string, "salt": string }` (zero key or secret material).
9. **`ROOM_CLOSING`**: Broadcast when grace period begins: `{ "room_code": string, "closing_deadline": number, "expires_at": number }`.
10. **`ROOM_CLOSED`**: Broadcast upon room destruction: `{ "room_code": string, "reason": string }`.
11. **`PONG`**: Application heartbeat response.
12. **`ERROR`**: Structured error notification: `{ "code": string, "message": string }`.

## Abuse Protection & Multi-Layer Rate Limiting (Phase 4 / ADR-07)

The signaling service incorporates a multi-layer rate limiting and abuse prevention subsystem adhering to strict zero-knowledge and zero-persistence privacy guarantees:

1. **Zero IP Persistence & Daily Pepper**:
   - Client IP addresses are never written to disk, never retained in long-term memory, and never logged.
   - Upon startup, a cryptographically secure 32-byte secret (`dailyPepper`) is generated randomly in RAM.
   - Every 24 hours, a background task (`start_pepper_rotator`) overwrites `dailyPepper` with fresh entropy.
   - Rate limiting is keyed by `rateKey = Truncated(HMAC-SHA256(dailyPepper, client_ip))` (128-bit hash). When the pepper rotates, all existing keys become cryptographically decoupled from physical IPs, automatically forgetting old entries.

2. **Five Distinct Rate-Limiting Layers (RAM with TTL)**:
   - **Room Creation**: Maximum 10 room creations per hour per `rateKey`. Rejections return HTTP 429 or `RATE_LIMIT_EXCEEDED`.
   - **WebSocket Connection Attempts**: Maximum 30 connection attempts per minute per `rateKey` before triggering exponential backoff ($2s \to 4s \to 8s \to \dots \to 300s$). Rejections return HTTP 429 with `Retry-After`.
   - **Room Join Attempts & Lockout**: Maximum 30 join attempts per minute. After 5 consecutive failed join attempts (invalid code, non-existent room, expired room, or incorrect password) within 5 minutes, a 15-minute temporary lockout (`JOIN_LOCKED_OUT`) is applied. Successful room joins reset the failure counter.
   - **Per-Connection Message Flood Control**: Lock-free in-memory `TokenBucket` evaluated inside each connection loop (burst capacity 30, refill rate 10 tokens/s). When exhausted, emits `FLOOD_CONTROL_EXCEEDED` error without terminating the socket.
   - **Global Concurrency Ceiling**: Enforces maximum total active rooms (default: 1,000) and concurrent WebSocket connections (default: 4,000) across the server. Rejections return HTTP 503 Service Unavailable or `SERVER_BUSY`.

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
| `FASTCHAT_PEPPER_ROTATION_SECS` | `86400` | Ephemeral daily pepper secret rotation interval in RAM (24 hours) |
| `FASTCHAT_RATE_LIMIT_ROOM_CREATION_PER_HOUR` | `10` | Maximum room creations per hour per rate key |
| `FASTCHAT_RATE_LIMIT_WS_PER_MIN` | `30` | Maximum WebSocket connection attempts per minute per rate key |
| `FASTCHAT_RATE_LIMIT_WS_BASE_BACKOFF_SECS` | `2` | Initial exponential backoff delay in seconds |
| `FASTCHAT_RATE_LIMIT_WS_MAX_BACKOFF_SECS` | `300` | Maximum capped exponential backoff delay in seconds |
| `FASTCHAT_RATE_LIMIT_JOIN_PER_MIN` | `30` | Maximum join attempts per minute per rate key |
| `FASTCHAT_MAX_FAILED_JOINS` | `5` | Consecutive failed join attempts triggering temporary lockout |
| `FASTCHAT_FAILED_JOINS_WINDOW_SECS` | `300` | Tracking window in seconds for failed join attempts |
| `FASTCHAT_JOIN_LOCKOUT_SECS` | `900` | Duration in seconds of temporary join lockout (15 minutes) |
| `FASTCHAT_FLOOD_CAPACITY` | `30` | Token bucket capacity for per-connection signaling message flood control |
| `FASTCHAT_FLOOD_REFILL_PER_SEC` | `10` | Token bucket refill rate in tokens per second |
| `FASTCHAT_MAX_TOTAL_ROOMS` | `1000` | Global server ceiling for concurrent active rooms |
| `FASTCHAT_MAX_TOTAL_CONNECTIONS` | `4000` | Global server ceiling for concurrent WebSocket connections |
| `FASTCHAT_LIMITER_PRUNE_INTERVAL_SECS` | `60` | Background interval in seconds for pruning stale in-memory rate records |
| `PORT` | `3000` | Server HTTP/WebSocket port |
| `HOST` | `0.0.0.0` | Server bind host address |
