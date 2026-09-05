# FastChat Room

> Anonymous, ephemeral P2P chat room with file transfer — zero login, zero server cost, zero footprint.

## Project Structure (Monorepo)

This repository is organized as a monorepo containing three independent subprojects:

- **`apps/landing`** — Public landing page (planned implementation: Astro, Phase 12). Responsible for product presentation and instant room link generation.
- **`apps/room`** — Main P2P chat room client application (planned implementation: SvelteKit, Phases 6–11). Responsible for chat UI, WebRTC DataChannel P2P negotiation, ephemeral in-memory text chat, and browser-to-browser direct file transfer.
- **`services/signaling`** — Lightweight WebRTC signaling service (planned implementation: Rust + axum, Phases 2–5). Responsible for relaying WebSocket signaling payloads (SDP offer/answer and ICE candidates) between peers before direct P2P connections are established.

## Status

**Status: In Development**  
- Phase 1 (Monorepo scaffolding and repository initialization): Completed.
- Phase 2 (Signaling server core — Rust, axum, DashMap room lifecycle state machine): Completed.

