use anyhow::Result;
use rusqlite::{params, OptionalExtension};

use crate::contracts::{DataSyncScope, DataSyncTrigger, TaskRunRecord, TaskRunStatus};

use crate::infrastructure::sqlite::Database;

pub fn insert_task_run(db: &Database, run: &TaskRunRecord) -> Result<()> {
    let conn = db.connect()?;
    conn.execute(
        "INSERT INTO task_runs (
            id, account_id, scope, primary_trigger_source, status, join_count, started_at, finished_at, error_message
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            run.id,
            run.account_id,
            sync_scope_to_str(&run.scope),
            trigger_source_to_str(&run.primary_trigger_source),
            status_to_str(&run.status),
            run.join_count,
            run.started_at,
            run.finished_at,
            run.error_message
        ],
    )?;
    Ok(())
}

pub fn update_task_run(db: &Database, run: &TaskRunRecord) -> Result<()> {
    let conn = db.connect()?;
    conn.execute(
        "UPDATE task_runs
         SET scope = ?2,
             primary_trigger_source = ?3,
             status = ?4,
             join_count = ?5,
             started_at = ?6,
             finished_at = ?7,
             error_message = ?8
         WHERE id = ?1",
        params![
            run.id,
            sync_scope_to_str(&run.scope),
            trigger_source_to_str(&run.primary_trigger_source),
            status_to_str(&run.status),
            run.join_count,
            run.started_at,
            run.finished_at,
            run.error_message
        ],
    )?;
    Ok(())
}

pub fn find_task_run(db: &Database, run_id: &str) -> Result<Option<TaskRunRecord>> {
    let conn = db.connect()?;
    let run = conn
        .query_row(
            "SELECT id, account_id, scope, primary_trigger_source, status, join_count, started_at, finished_at, error_message
             FROM task_runs WHERE id = ?1",
            params![run_id],
            |row| {
                Ok(TaskRunRecord {
                    id: row.get(0)?,
                    account_id: row.get(1)?,
                    scope: parse_sync_scope(&row.get::<_, String>(2)?),
                    primary_trigger_source: parse_trigger_source(&row.get::<_, String>(3)?),
                    status: parse_status(&row.get::<_, String>(4)?),
                    join_count: row.get(5)?,
                    started_at: row.get(6)?,
                    finished_at: row.get(7)?,
                    error_message: row.get(8)?,
                })
            },
        )
        .optional()?;
    Ok(run)
}

fn trigger_source_to_str(source: &DataSyncTrigger) -> &'static str {
    match source {
        DataSyncTrigger::Manual => "manual",
        DataSyncTrigger::StaleAuto => "stale_auto",
        DataSyncTrigger::PostWrite => "post_write",
        DataSyncTrigger::Bootstrap => "bootstrap",
        DataSyncTrigger::Auto => "auto",
    }
}

fn status_to_str(status: &TaskRunStatus) -> &'static str {
    match status {
        TaskRunStatus::Running => "running",
        TaskRunStatus::Succeeded => "succeeded",
        TaskRunStatus::Failed => "failed",
    }
}

fn parse_trigger_source(value: &str) -> DataSyncTrigger {
    match value {
        "stale_auto" => DataSyncTrigger::StaleAuto,
        "post_write" => DataSyncTrigger::PostWrite,
        "bootstrap" => DataSyncTrigger::Bootstrap,
        "auto" => DataSyncTrigger::Auto,
        _ => DataSyncTrigger::Manual,
    }
}

fn parse_status(value: &str) -> TaskRunStatus {
    match value {
        "succeeded" => TaskRunStatus::Succeeded,
        "failed" => TaskRunStatus::Failed,
        _ => TaskRunStatus::Running,
    }
}

fn sync_scope_to_str(scope: &DataSyncScope) -> &'static str {
    match scope {
        DataSyncScope::Core => "core",
        DataSyncScope::Keys => "keys",
        DataSyncScope::Usage => "usage",
        DataSyncScope::Full => "full",
    }
}

fn parse_sync_scope(value: &str) -> DataSyncScope {
    match value {
        "core" => DataSyncScope::Core,
        "keys" => DataSyncScope::Keys,
        "usage" => DataSyncScope::Usage,
        _ => DataSyncScope::Full,
    }
}

#[cfg(test)]
mod tests {
    use super::{find_task_run, insert_task_run, update_task_run};
    use crate::contracts::{DataSyncScope, DataSyncTrigger, TaskRunRecord, TaskRunStatus};
    use crate::contracts::{AccountRecord, SiteRecord};
    use crate::infrastructure::sqlite::Database;
    use crate::infrastructure::sqlite::repositories::{insert_account, insert_site};

    #[test]
    fn persists_and_updates_task_run_with_scope_and_join_count() {
        let db_path = std::env::temp_dir().join(format!(
            "api-token-task-runs-{}.db",
            uuid::Uuid::new_v4()
        ));
        let db = Database::new(db_path);
        let _ = db.connect().expect("init db");

        insert_site(
            &db,
            &SiteRecord {
                id: "site-1".into(),
                name: "Test Site".into(),
                base_url: "https://example.com".into(),
                created_at: "2026-06-28T00:00:00Z".into(),
                updated_at: "2026-06-28T00:00:00Z".into(),
            },
        )
        .expect("insert site");
        insert_account(
            &db,
            &AccountRecord {
                id: "account-1".into(),
                site_id: "site-1".into(),
                label: "Test Account".into(),
                email: "test@example.com".into(),
                balance_warning: -1.0,
                last_login_at: None,
                created_at: "2026-06-28T00:00:00Z".into(),
                updated_at: "2026-06-28T00:00:00Z".into(),
            },
        )
        .expect("insert account");

        let mut run = TaskRunRecord {
            id: "run-1".into(),
            account_id: "account-1".into(),
            scope: DataSyncScope::Keys,
            primary_trigger_source: DataSyncTrigger::PostWrite,
            status: TaskRunStatus::Running,
            join_count: 0,
            started_at: "2026-06-28T00:00:00Z".into(),
            finished_at: None,
            error_message: None,
        };

        insert_task_run(&db, &run).expect("insert task run");

        let stored = find_task_run(&db, &run.id)
            .expect("find inserted run")
            .expect("run should exist");
        assert_eq!(stored.scope, DataSyncScope::Keys);
        assert_eq!(stored.primary_trigger_source, DataSyncTrigger::PostWrite);
        assert_eq!(stored.join_count, 0);
        assert_eq!(stored.status, TaskRunStatus::Running);

        run.join_count = 2;
        run.status = TaskRunStatus::Succeeded;
        run.finished_at = Some("2026-06-28T00:01:00Z".into());
        update_task_run(&db, &run).expect("update task run");

        let updated = find_task_run(&db, &run.id)
            .expect("find updated run")
            .expect("run should still exist");
        assert_eq!(updated.scope, DataSyncScope::Keys);
        assert_eq!(updated.primary_trigger_source, DataSyncTrigger::PostWrite);
        assert_eq!(updated.join_count, 2);
        assert_eq!(updated.status, TaskRunStatus::Succeeded);
        assert_eq!(updated.finished_at.as_deref(), Some("2026-06-28T00:01:00Z"));
    }
}

