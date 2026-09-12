# FastChat Room

> Anonymous, ephemeral P2P chat room with file transfer — zero login, zero server cost, zero footprint.

## Project Structure (Monorepo)

This repository is organized as a monorepo containing two primary subprojects:

- **`apps/room`** — Main P2P chat room and session creation application (SvelteKit). Provides immediate room dispatch, custom access controls (password protection, hopping codes), chat UI, WebRTC DataChannel P2P mesh negotiation, ephemeral in-memory text chat, and browser-to-browser direct file transfer.
- **`services/signaling`** — Lightweight WebRTC signaling service (Rust + axum). Responsible for relaying WebSocket signaling payloads (SDP offer/answer and ICE candidates) between peers before direct P2P connections are established.

## Status

**Status: Production Ready**  
- Phase 1 (Monorepo scaffolding and repository initialization): Completed.
- Phase 2 (Signaling server core — Rust, axum, DashMap room lifecycle state machine): Completed.
- Phase 3 (Signaling WebSocket protocol — framing, transparent SDP/ICE relay, REKEY, and room lifecycle integration): Completed.
- Phase 4 (Multi-layer abuse protection & rate limiting — ephemeral daily pepper, HMAC-SHA256 rate keys, zero IP logging): Completed.
- Phase 5 (Realtime TURN integration & automated cost governor): Completed.
- Phases 6–11 (SvelteKit room application, WebRTC mesh, file transfer, UI tokens, security audits): Completed.
- Phase 12 (Direct root room creator and instant session dispatch): Completed.
- Phase 13 (Production deployment: Cloudflare Pages & Vercel edge delivery): Completed.
- Phase 14 (Automated secrets detection & repository security hardening): Completed.

## Frontend Deployment (Vercel & Cloudflare Pages)

The frontend is deployed as a static Single Page Application (SPA) compiled via SvelteKit's `@sveltejs/adapter-static`:

- **Root Creation Interface (`/`) & Session Dispatch (`/create`)**: Pre-rendered static HTML shells generated from `apps/room`, delivering instantaneous room creation and joining capabilities without intermediary landing pages or redirects. Assets reside in `_app/`.
- **Dynamic Ephemeral Rooms (`/room/*`)**: Rendered via the SPA fallback shell (`room.html`), parsing dynamic room codes and URL hash encryption keys entirely in browser memory.

### Unified Monorepo Build Pipeline

The deployment pipeline binds to the repository root with:
- **Build command:** `npm run build`
- **Build output directory:** `dist`

The build orchestrator (`scripts/build-pages.mjs`) performs:
1. `npm --prefix apps/room run build` compiling SvelteKit in static SPA mode (`index.html`, `create.html`, `room.html` fallback, and `_app/` bundles).
2. Merges artifacts into root `dist/`.
3. Emits `_redirects` and `vercel.json` rewrites ensuring `/room/*` requests execute a 200 rewrite to `/room.html`, and bare `/room` redirects to `/`.
4. Emits `_headers` and Vercel edge rules enforcing edge-level indexing blocks (`X-Robots-Tag: noindex, nofollow`) and privacy protections (`Referrer-Policy: no-referrer`) across root and room paths.

### Frontend Environment Variables

Configure in your deployment dashboard:
- `PUBLIC_SIGNALING_WS_URL`: `wss://signaling.fastchat.room/ws`
- `PUBLIC_SIGNALING_HTTP_URL`: `https://signaling.fastchat.room`
