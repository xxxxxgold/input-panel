use anyhow::Result;
use tokio::sync::Mutex;

use std::collections::HashMap;
use std::sync::Arc;

use crate::contracts::{AccountSyncStatusPayload, TaskRunRecord};
use crate::infrastructure::files::AppPaths;
use crate::infrastructure::sqlite::Database;

use super::data_center_service;

#[derive(Clone)]
pub struct AppContext {
    pub paths: AppPaths,
    pub db: Database,
    pub sync_tasks: Arc<Mutex<HashMap<String, Arc<SyncTaskHandle>>>>,
}

#[derive(Debug, Clone)]
pub struct SyncTaskState {
    pub run: TaskRunRecord,
    pub completed: bool,
    pub result: Option<Result<AccountSyncStatusPayload, String>>,
}

pub struct SyncTaskHandle {
    pub state: Mutex<SyncTaskState>,
    pub notify: tokio::sync::Notify,
}

impl AppContext {
    pub fn resolve() -> Result<Self> {
        let paths = AppPaths::resolve()?;
        paths.ensure()?;
        let db = Database::new(paths.db_path.clone());
        let _ = db.connect()?;
        let ctx = Self {
            paths,
            db,
            sync_tasks: Arc::new(Mutex::new(HashMap::new())),
        };
        data_center_service::migrate_legacy_runtime_state(&ctx)?;
        data_center_service::repair_usage_cache_from_legacy(&ctx)?;
        data_center_service::repair_sync_status_from_cache(&ctx)?;
        Ok(ctx)
    }
}
