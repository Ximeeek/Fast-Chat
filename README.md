# FastChat Room

> Anonymous, ephemeral P2P chat room with file transfer — zero login, zero server cost, zero footprint.

## Project Structure (Monorepo)

This repository is organized as a monorepo containing three independent subprojects:

- **`apps/landing`** — Public landing page (planned implementation: Astro, Phase 12). Responsible for product presentation and instant room link generation.
- **`apps/room`** — Main P2P chat room client application (planned implementation: SvelteKit, Phases 6–11). Responsible for chat UI, WebRTC DataChannel P2P negotiation, ephemeral in-memory text chat, and browser-to-browser direct file transfer.
- **`services/signaling`** — Lightweight WebRTC signaling service (planned implementation: Rust + axum, Phases 2–5). Responsible for relaying WebSocket signaling payloads (SDP offer/answer and ICE candidates) between peers before direct P2P connections are established.

## Status

**Status: Production Ready**  
- Phase 1 (Monorepo scaffolding and repository initialization): Completed.
- Phase 2 (Signaling server core — Rust, axum, DashMap room lifecycle state machine): Completed.
- Phase 3 (Signaling WebSocket protocol — framing, transparent SDP/ICE relay, REKEY, and room lifecycle integration): Completed.
- Phase 4 (Multi-layer abuse protection & rate limiting — ephemeral daily pepper, HMAC-SHA256 rate keys, zero IP logging): Completed.
- Phase 5 (Realtime TURN integration & automated cost governor): Completed.
- Phases 6–11 (SvelteKit room application, WebRTC mesh, file transfer, UI tokens, security audits): Completed.
- Phase 12 (Astro static landing page & brutalist design): Completed.
- Phase 13 (Production deployment: Cloudflare Pages & Oracle Cloud Always Free): Completed.
- Phase 14 (Automated secrets detection & repository security hardening): Completed.


## Frontend Deployment (Cloudflare Pages)

The public frontend is hosted entirely on **Cloudflare Pages** under a single custom domain (e.g., `fastchat.room`). It merges two distinct frontend frameworks into an atomic static delivery artifact:

- **Root Landing (`/`)**: Statically rendered via **Astro** (`apps/landing`), generating zero-JS semantic markup, OpenGraph metadata, and structured JSON-LD schemas. Assets reside in `_astro/`.
- **Session Dispatch (`/create`) & Dynamic Rooms (`/room/*`)**: Single-page application rendered via **SvelteKit** (`apps/room`) using `@sveltejs/adapter-static`. Assets reside in `_app/`.

### Unified Monorepo Build Pipeline

Cloudflare Pages binds to the repository root with:
- **Build command:** `npm run build`
- **Build output directory:** `dist`

The build orchestrator (`scripts/build-pages.mjs`) performs:
1. `npm --prefix apps/landing run build` generating the static Astro landing page.
2. `npm --prefix apps/room run build` compiling SvelteKit in static SPA mode (`room.html` fallback, `create.html`, and `_app/` bundles).
3. Merges both outputs into root `dist/` without collision (`_astro/` and `_app/` namespaces are completely disjoint).
4. Emits `_redirects` ensuring `/room/*` requests execute a 200 rewrite to `/room.html`, allowing the client-side router to parse dynamic room codes and URL hash encryption keys.
5. Emits `_headers` enforcing edge-level indexing blocks (`X-Robots-Tag: noindex, nofollow`) and privacy protections (`Referrer-Policy: no-referrer`) on room paths.

### Frontend Environment Variables (Cloudflare Pages Dashboard)

Configure in **Pages Project > Settings > Environment variables**:
- `PUBLIC_SIGNALING_WS_URL`: `wss://signaling.fastchat.room/ws`
- `PUBLIC_SIGNALING_HTTP_URL`: `https://signaling.fastchat.room`


