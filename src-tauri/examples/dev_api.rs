#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let ctx = app_lib::application::AppContext::resolve()?;
    let port = std::env::var("PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(5559);
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    println!("sub2api rust dev api listening on http://{addr}");
    app_lib::adapters::http::serve(ctx, addr).await
}
