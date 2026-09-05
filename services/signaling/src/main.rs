use fastchat_signaling::{
    config::Config,
    create_router,
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
        "Initializing FastChat Signaling Service"
    );

    let app_state = AppState::new(config.clone());

    // Spawn background sweeper task for enforcing room lifetime on the server
    start_sweeper_task(app_state.room_manager.clone());

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
