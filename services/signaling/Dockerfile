# syntax=docker/dockerfile:1.4

# Stage 1: Build binary with cargo dependency caching
FROM rust:1.85-slim-bookworm AS builder

WORKDIR /usr/src/fastchat-signaling

# Install OpenSSL build dependencies and pkg-config for native-tls
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        pkg-config \
        libssl-dev && \
    rm -rf /var/lib/apt/lists/*

# Cache dependency layer by pre-compiling with dummy crate source
COPY Cargo.toml Cargo.lock ./

RUN mkdir -p src && \
    echo 'pub fn dummy() {}' > src/lib.rs && \
    echo 'fn main() { fastchat_signaling::dummy(); }' > src/main.rs && \
    cargo build --release && \
    rm -rf target/release/deps/fastchat_signaling* target/release/fastchat-signaling* src

# Copy real source code and compile final release binary
COPY src ./src
RUN cargo build --release --locked && \
    strip target/release/fastchat-signaling

# Stage 2: Minimal runtime image
FROM debian:bookworm-slim AS runner

# Install ca-certificates for outbound TLS (Cloudflare TURN API) and curl for healthcheck
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        libssl3 \
        curl && \
    rm -rf /var/lib/apt/lists/*

# Security: Create non-root unprivileged service user
RUN groupadd -g 10001 fastchat && \
    useradd -u 10001 -g fastchat -s /bin/false -M fastchat

WORKDIR /app

# Copy binary from builder stage
COPY --from=builder --chown=fastchat:fastchat /usr/src/fastchat-signaling/target/release/fastchat-signaling /usr/local/bin/fastchat-signaling

# Switch to unprivileged execution
USER fastchat:fastchat

# Default environment configuration
ENV PORT=3000 \
    HOST=0.0.0.0 \
    RUST_LOG=info

EXPOSE 3000

# Container health monitoring
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

ENTRYPOINT ["/usr/local/bin/fastchat-signaling"]
