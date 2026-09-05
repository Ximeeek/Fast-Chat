# services/signaling

Subproject for the WebRTC signaling service of **FastChat Room**.

- **Technology:** Rust + axum (planned initialization in Phases 2–5)
- **Purpose:** Minimal, high-performance WebSocket server strictly facilitating SDP offer/answer exchange and ICE candidate relay between peers before direct P2P connections are established.
