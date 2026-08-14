use anyhow::Result;
use rusqlite::params;

use crate::infrastructure::sqlite::Database;

const APP_SETTINGS_KEYS_TO_DELETE: [&str; 3] = [
    "data_center_migration_done_v1",
    "data_center_usage_repair_done_v1",
    "data_center_sync_status_repair_done_v1",
];

pub fn clear_runtime_data(db: &Database, remove_sites_and_accounts: bool) -> Result<()> {
    let mut conn = db.connect()?;
    let tx = conn.transaction()?;

    tx.execute("DELETE FROM account_usage_row_cache", [])?;
    tx.execute("DELETE FROM account_usage_daily_rollup", [])?;
    tx.execute("DELETE FROM codex_radar_intelligence_cache", [])?;
    tx.execute("DELETE FROM codex_radar_iq_cache", [])?;
    tx.execute("DELETE FROM codex_radar_insights_cache", [])?;
    tx.execute("DELETE FROM usage_notification_outbox", [])?;
    tx.execute("DELETE FROM subscription_quota_alert_events", [])?;
    tx.execute("DELETE FROM subscription_quota_alert_window_states", [])?;
    tx.execute("DELETE FROM subscription_quota_alert_configs", [])?;
    tx.execute("DELETE FROM subscription_quota_alert_subjects", [])?;
    tx.execute("DELETE FROM account_key_subscription_switch_rules", [])?;
    tx.execute("DELETE FROM sessions", [])?;
    tx.execute("DELETE FROM credentials", [])?;

    if remove_sites_and_accounts {
        tx.execute("DELETE FROM accounts", [])?;
        tx.execute("DELETE FROM sites", [])?;
    } else {
        tx.execute(
            "UPDATE accounts SET last_login_at = NULL, updated_at = updated_at",
            [],
        )?;
    }

    for key in APP_SETTINGS_KEYS_TO_DELETE {
        tx.execute("DELETE FROM app_settings WHERE key = ?1", params![key])?;
    }

    tx.commit()?;
    Ok(())
}

pub fn drop_non_usage_runtime_tables(db: &Database) -> Result<()> {
    let conn = db.connect()?;
    conn.execute_batch(
        r#"
        DROP TABLE IF EXISTS task_runs;
        DROP TABLE IF EXISTS account_sync_status;
        DROP TABLE IF EXISTS account_profile_cache;
        DROP TABLE IF EXISTS account_platform_quota_cache;
        DROP TABLE IF EXISTS account_subscription_cache;
        DROP TABLE IF EXISTS account_subscription_summary_cache;
        DROP TABLE IF EXISTS account_group_cache;
        DROP TABLE IF EXISTS account_key_cache;
        DROP TABLE IF EXISTS account_snapshots;
        DROP TABLE IF EXISTS usage_history;
        "#,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::{AccountRecord, SiteRecord, StoredCredential, StoredSession};
    use crate::infrastructure::sqlite::repositories;

    fn build_test_db() -> Database {
        let db_path =
            std::env::temp_dir().join(format!("api-token-maintenance-{}.db", uuid::Uuid::new_v4()));
        let db = Database::new(db_path);
        let _ = db.connect().expect("init sqlite");
        db
    }

    fn seed_site_and_account(db: &Database) {
        repositories::insert_site(
            db,
            &SiteRecord {
                id: "site-1".into(),
                name: "AI INPUT".into(),
                base_url: "https://ai.input.im".into(),
                created_at: "2026-07-01T00:00:00Z".into(),
                updated_at: "2026-07-01T00:00:00Z".into(),
                ..SiteRecord::default()
            },
        )
        .expect("insert site");
        repositories::insert_account(
            db,
            &AccountRecord {
                id: "account-1".into(),
                site_id: "site-1".into(),
                label: "主账号".into(),
                email: "main@example.com".into(),
                balance_warning: -1.0,
                last_login_at: Some("2026-07-01T01:00:00Z".into()),
                created_at: "2026-07-01T00:00:00Z".into(),
                updated_at: "2026-07-01T00:00:00Z".into(),
            },
        )
        .expect("insert account");
        repositories::save_credential(
            db,
            &StoredCredential {
                account_id: "account-1".into(),
                email: "main@example.com".into(),
                password: "secret".into(),
                saved_at: "2026-07-01T01:00:00Z".into(),
            },
        )
        .expect("save credential");
        repositories::save_session(
            db,
            "account-1",
            &StoredSession {
                saved_at: "2026-07-01T01:00:00Z".into(),
                access_token: Some("token".into()),
                refresh_token: Some("refresh".into()),
                token_type: Some("bearer".into()),
                cookie_jar_json: None,
            },
        )
        .expect("save session");
        repositories::set_setting(db, "desktop_ui_prefs", "{\"theme\":\"light\"}")
            .expect("save desktop prefs");
        repositories::set_setting(db, "scheduler_enabled", "0").expect("save scheduler enabled");
        repositories::set_setting(db, "data_center_migration_done_v1", "1")
            .expect("save migration marker");
        repositories::upsert_codex_radar_model_iq_cache(
            db,
            &repositories::CodexRadarModelIqCacheRecord {
                payload_json: r#"{\"items\":[]}"#.into(),
                source_updated_at: "2026-07-21T18:07:02+08:00".into(),
                fetched_at: "2026-07-21T18:10:00+08:00".into(),
                last_error: None,
            },
        )
        .expect("save Codex Radar cache");
    }

    #[test]
    fn clear_runtime_data_keeps_sites_and_accounts_by_default() {
        let db = build_test_db();
        seed_site_and_account(&db);

        clear_runtime_data(&db, false).expect("clear runtime data");

        assert!(repositories::find_site(&db, "site-1")
            .expect("find site")
            .is_some());
        let account = repositories::find_account(&db, "account-1")
            .expect("find account")
            .expect("account exists");
        assert_eq!(account.last_login_at, None);
        assert!(repositories::load_session(&db, "account-1")
            .expect("load session")
            .is_none());
        assert!(repositories::load_credential(&db, "account-1")
            .expect("load credential")
            .is_none());
        assert!(repositories::find_codex_radar_model_iq_cache(&db)
            .expect("read Codex Radar cache")
            .is_none());
        assert_eq!(
            repositories::get_setting(&db, "desktop_ui_prefs").expect("desktop prefs"),
            Some("{\"theme\":\"light\"}".into())
        );
        assert_eq!(
            repositories::get_setting(&db, "scheduler_enabled").expect("scheduler enabled"),
            Some("0".into())
        );
        assert_eq!(
            repositories::get_setting(&db, "data_center_migration_done_v1")
                .expect("migration marker"),
            None
        );
    }

    #[test]
    fn clear_runtime_data_can_remove_sites_and_accounts() {
        let db = build_test_db();
        seed_site_and_account(&db);

        clear_runtime_data(&db, true).expect("clear runtime data");

        assert!(repositories::find_site(&db, "site-1")
            .expect("find site")
            .is_none());
        assert!(repositories::find_account(&db, "account-1")
            .expect("find account")
            .is_none());
    }

    #[test]
    fn clear_runtime_data_removes_codex_radar_insights_cache() {
        let db = build_test_db();
        repositories::upsert_codex_radar_insights_cache(
            &db,
            &repositories::CodexRadarInsightsCacheRecord {
                payload_json: r#"{"recommendations":[],"degradationAlerts":[]}"#.into(),
                source_updated_at: "2026-07-29T20:38:00+08:00".into(),
                fetched_at: "2026-07-29 20:39:00".into(),
                last_error: None,
            },
        )
        .expect("save insights cache");

        clear_runtime_data(&db, false).expect("clear runtime data");

        assert!(repositories::find_codex_radar_insights_cache(&db)
            .expect("read insights cache")
            .is_none());
    }
}
