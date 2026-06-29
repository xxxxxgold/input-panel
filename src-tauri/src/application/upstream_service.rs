use anyhow::{anyhow, Result};
use serde_json::Value;

use crate::infrastructure::sqlite::repositories;
use crate::infrastructure::sub2api::client::Sub2ApiClient;

use super::{account_service, auth_service, AppContext};

pub async fn account_upstream_request(
    ctx: &AppContext,
    account_id: &str,
    path: &str,
    method: &str,
    payload: Option<Value>,
) -> Result<Value> {
    if !path.starts_with("/api/v1/") {
        return Err(anyhow!("仅允许代理用户中心 API 路径。"));
    }

    let (account, site) = account_service::load_account_site(ctx, account_id)?;
    let session = repositories::load_session(&ctx.db, account_id)?;
    let mut client = Sub2ApiClient::new(&site.base_url, session)?;
    let relogged_before_request = auth_service::ensure_authorized(ctx, &mut client, &account).await?;
    maybe_schedule_full_sync_after_relogin(ctx, &account.id, relogged_before_request);

    let request_payload = payload.clone();
    let data = match client.request_api(path, method, payload).await {
        Ok(value) => value,
        Err(error) if auth_service::is_auth_expired_error(&error) => {
            let relogged_after_retry = auth_service::relogin_with_saved_credential(ctx, &mut client, &account).await?;
            maybe_schedule_full_sync_after_relogin(ctx, &account.id, relogged_after_retry);
            client.request_api(path, method, request_payload).await?
        }
        Err(error) => return Err(error),
    };

    repositories::save_session(&ctx.db, account_id, &client.serialize())?;
    Ok(data)
}

fn maybe_schedule_full_sync_after_relogin(ctx: &AppContext, account_id: &str, relogged: bool) {
    if !relogged {
        return;
    }

    let ctx = ctx.clone();
    let account_id = account_id.to_string();
    tokio::spawn(async move {
        let _ = super::data_center_service::sync_account_data(
            &ctx,
            &account_id,
            crate::contracts::SyncAccountDataInput {
                scope: crate::contracts::DataSyncScope::Full,
                trigger_source: crate::contracts::DataSyncTrigger::PostWrite,
            },
        )
        .await;
    });
}
