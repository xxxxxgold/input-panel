use anyhow::{anyhow, Result};
use serde_json::Value;

use crate::infrastructure::sqlite::repositories;
use crate::infrastructure::sub2api::client::Sub2ApiClient;

use super::{account_service, auth_service, AppContext};

pub async fn account_proxy_request(
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
    auth_service::ensure_authorized(ctx, &mut client, &account).await?;

    let request_payload = payload.clone();
    let data = match client.request_api(path, method, payload).await {
        Ok(value) => value,
        Err(error) if auth_service::is_auth_expired_error(&error) => {
            auth_service::relogin_with_saved_credential(ctx, &mut client, &account).await?;
            client.request_api(path, method, request_payload).await?
        }
        Err(error) => return Err(error),
    };

    repositories::save_session(&ctx.db, account_id, &client.serialize())?;
    Ok(data)
}
