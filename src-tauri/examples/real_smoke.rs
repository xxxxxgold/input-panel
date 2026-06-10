#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let base_url = std::env::var("SUB2API_SITE_URL")
        .map_err(|_| anyhow::anyhow!("缺少 SUB2API_SITE_URL"))?;
    let email = std::env::var("SUB2API_EMAIL")
        .map_err(|_| anyhow::anyhow!("缺少 SUB2API_EMAIL"))?;
    let password = std::env::var("SUB2API_PASSWORD")
        .map_err(|_| anyhow::anyhow!("缺少 SUB2API_PASSWORD"))?;

    let mut client = app_lib::infrastructure::sub2api::client::Sub2ApiClient::new(&base_url, None)?;
    let login = client.login(&email, &password).await?;
    if login.requires2fa {
        return Err(anyhow::anyhow!("真实站点返回了 2FA 挑战，当前 smoke 二进制未处理。"));
    }

    let snapshot = client
        .build_snapshot(
            &app_lib::contracts::AccountRecord {
                id: "smoke-account".into(),
                site_id: "smoke-site".into(),
                label: "Smoke".into(),
                email,
                balance_warning: 10.0,
                last_login_at: Some(chrono::Utc::now().to_rfc3339()),
                created_at: chrono::Utc::now().to_rfc3339(),
                updated_at: chrono::Utc::now().to_rfc3339(),
            },
            &app_lib::contracts::SiteRecord {
                id: "smoke-site".into(),
                name: "Smoke Site".into(),
                base_url,
                created_at: chrono::Utc::now().to_rfc3339(),
                updated_at: chrono::Utc::now().to_rfc3339(),
            },
        )
        .await?;

    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "balance": snapshot.balance,
            "todayActualCost": snapshot.stats.today_actual_cost,
            "totalApiKeys": snapshot.stats.total_api_keys,
            "activeSubscription": snapshot.active_subscription.as_ref().map(|item| item.name.clone()),
            "recentUsage": snapshot.recent_usage.first(),
        }))?
    );

    Ok(())
}
