#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let ctx = app_lib::application::AppContext::resolve_web().await?;
    let _scheduler =
        app_lib::application::scheduler_service::DataSyncScheduler::start_headless(ctx.clone());
    let port = std::env::var("PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(5559);
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    println!("inputApi listening on http://{addr}");
    app_lib::adapters::http::serve(ctx, addr).await
}
