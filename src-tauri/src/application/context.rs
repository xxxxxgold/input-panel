use anyhow::Result;
use tokio::sync::Mutex;

use std::collections::HashMap;
use std::sync::Arc;

use crate::contracts::{AccountSyncProgress, SyncFailurePayload, TaskRunRecord};
use crate::infrastructure::files::AppPaths;
use crate::infrastructure::sqlite::Database;

use super::data_center_service::{self, SyncExecutionResult};
use super::resource_coordinator::ResourceCoordinator;
use super::runtime_coordination_service::RuntimeCoordinationService;

#[derive(Clone)]
pub struct AppContext {
    pub paths: AppPaths,
    pub db: Database,
    pub sync_tasks: Arc<Mutex<HashMap<String, Arc<SyncTaskHandle>>>>,
    pub live_resources: ResourceCoordinator,
    pub runtime_coordination: RuntimeCoordinationService,
    pub(crate) native_notifications_enabled: bool,
}

#[derive(Debug, Clone)]
pub struct SyncTaskState {
    pub run: TaskRunRecord,
    pub progress: Option<AccountSyncProgress>,
    pub completed: bool,
    pub(crate) result: Option<Result<SyncExecutionResult, SyncTaskFailure>>,
}

#[derive(Debug, Clone)]
pub(crate) struct SyncTaskFailure {
    pub payload: SyncFailurePayload,
}

impl std::fmt::Display for SyncTaskFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.payload.message)
    }
}

impl std::error::Error for SyncTaskFailure {}

pub struct SyncTaskHandle {
    pub state: Mutex<SyncTaskState>,
    pub notify: tokio::sync::Notify,
}

impl AppContext {
    pub async fn resolve() -> Result<Self> {
        let paths = AppPaths::resolve()?;
        Self::from_paths(paths, false).await
    }

    /// 装配浏览器调试后端使用的独立运行数据库。
    pub async fn resolve_web() -> Result<Self> {
        let paths = AppPaths::resolve_web()?;
        Self::from_paths(paths, false).await
    }

    /// 装配桌面应用使用的独立运行数据库。
    pub async fn resolve_desktop() -> Result<Self> {
        let paths = AppPaths::resolve_desktop()?;
        Self::from_paths(paths, true).await
    }

    async fn from_paths(paths: AppPaths, native_notifications_enabled: bool) -> Result<Self> {
        paths.ensure()?;
        crate::infrastructure::sqlite::migration::upgrade_legacy_database_if_needed(&paths)?;
        let runtime_coordination = RuntimeCoordinationService::from_paths(&paths).await?;
        let db = Database::new(paths.db_path.clone());
        let _ = db.connect()?;
        let ctx = Self {
            paths,
            db,
            sync_tasks: Arc::new(Mutex::new(HashMap::new())),
            live_resources: ResourceCoordinator::default(),
            runtime_coordination,
            native_notifications_enabled,
        };
        data_center_service::repair_usage_cache_from_legacy(&ctx)?;
        crate::infrastructure::sqlite::repositories::drop_non_usage_runtime_tables(&ctx.db)?;
        let connection = ctx.db.connect()?;
        crate::infrastructure::sqlite::schema::verify_schema_documentation(&connection, true)?;
        Ok(ctx)
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    #[tokio::test]
    async fn cloned_context_reuses_the_single_runtime_coordination_service() {
        let root = std::env::temp_dir().join(format!(
            "input-panel-context-coordination-{}",
            uuid::Uuid::new_v4()
        ));
        let context = AppContext::from_paths(AppPaths::from_root(root.clone()), false)
            .await
            .expect("build isolated app context");
        let cloned = context.clone();

        assert!(context
            .runtime_coordination
            .shares_instance_with(&cloned.runtime_coordination));
        assert_eq!(
            context.runtime_coordination.coordination_db_path(),
            context.paths.coordination_db_path
        );
        drop(cloned);
        drop(context);
        let _ = fs::remove_dir_all(root);
    }
}
