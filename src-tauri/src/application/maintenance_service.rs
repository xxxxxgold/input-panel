use anyhow::Result;

use crate::infrastructure::sqlite::repositories;

use super::AppContext;

pub fn clear_runtime_data(ctx: &AppContext, remove_sites_and_accounts: bool) -> Result<bool> {
    repositories::clear_runtime_data(&ctx.db, remove_sites_and_accounts)?;
    Ok(true)
}
