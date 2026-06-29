use anyhow::{Context, Result};
use std::time::Duration;

use crate::contracts::ServiceStatusPayload;

const STATUS_ENDPOINT: &str = "https://status.input.im/api/status";

pub async fn get_service_status() -> Result<ServiceStatusPayload> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .context("初始化服务状态请求客户端失败")?;

    let fetch = || async {
        let response = client
            .get(STATUS_ENDPOINT)
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .await
            .context("请求 status.input.im 服务状态失败")?
            .error_for_status()
            .context("服务状态接口返回失败状态")?;

        let raw = response
            .text()
            .await
            .context("读取服务状态响应正文失败")?;

        serde_json::from_str::<ServiceStatusPayload>(&raw)
            .map_err(|error| anyhow::anyhow!("解析服务状态返回失败: {error}"))
    };

    match fetch().await {
        Ok(payload) => Ok(payload),
        Err(error) => {
            tokio::time::sleep(Duration::from_secs(1)).await;
            fetch().await.map_err(|e| anyhow::anyhow!("{error}; 重试后: {e}"))
        }
    }
}
