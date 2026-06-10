use anyhow::Result;

use crate::contracts::OverviewPayload;
use crate::domain::overview::build_overview;
use crate::infrastructure::sqlite::repositories;

use super::AppContext;

pub fn get_overview(ctx: &AppContext) -> Result<OverviewPayload> {
    let state = repositories::read_state(&ctx.db)?;
    Ok(build_overview(&state))
}
