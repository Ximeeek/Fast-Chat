use fastchat_signaling::{
    config::Config,
    create_router,
    limiter::{start_limiter_sweeper, start_pepper_rotator},
    room::start_sweeper_task,
    state::AppState,
};
use std::net::SocketAddr;
use tracing::info;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let config = Config::from_env();
    info!(
        max_participants = config.max_participants_per_room,
        initial_duration = config.initial_room_duration_secs,
        extendable_threshold = config.extendable_threshold_secs,
        extension_duration = config.extension_duration_secs,
        grace_period = config.closing_grace_period_secs,
        pepper_rotation_secs = config.pepper_rotation_secs,
        max_total_rooms = config.max_total_rooms,
        max_total_connections = config.max_total_connections,
        "Initializing FastChat Signaling Service"
    );

    let app_state = AppState::new(config.clone());

    // Spawn background sweeper task for enforcing room lifetime on the server
    start_sweeper_task(app_state.room_manager.clone());

    // Spawn background rotator for daily pepper secret rotation in RAM
    start_pepper_rotator(app_state.limiter.clone(), config.pepper_rotation_secs);

    // Spawn background sweeper for in-memory rate limiter cache eviction
    start_limiter_sweeper(app_state.limiter.clone(), config.limiter_prune_interval_secs);

    let app = create_router(app_state);

    let addr: SocketAddr = format!("{}:{}", config.server_host, config.server_port).parse()?;
    info!("Signaling server listening on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    info!("FastChat Signaling Service shutdown cleanly");
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("Failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("Failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}
