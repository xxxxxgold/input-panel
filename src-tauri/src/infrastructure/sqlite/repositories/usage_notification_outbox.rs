use anyhow::Result;
use rusqlite::params;

use crate::infrastructure::sqlite::Database;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageNotificationOutboxRecord {
    pub sequence: i64,
    pub account_id: String,
    pub id: String,
    pub dedupe_key: String,
    pub payload_json: String,
    pub created_at: String,
}

pub fn enqueue_usage_notification(
    db: &Database,
    account_id: &str,
    id: &str,
    dedupe_key: &str,
    payload_json: &str,
    created_at: &str,
) -> Result<bool> {
    let conn = db.connect()?;
    let affected = conn.execute(
        "INSERT OR IGNORE INTO usage_notification_outbox (
            account_id, id, dedupe_key, payload_json, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![account_id, id, dedupe_key, payload_json, created_at],
    )?;
    Ok(affected > 0)
}

pub fn list_usage_notifications(db: &Database) -> Result<Vec<UsageNotificationOutboxRecord>> {
    let conn = db.connect()?;
    let mut stmt = conn.prepare(
        "SELECT sequence, account_id, id, dedupe_key, payload_json, created_at
         FROM usage_notification_outbox
         ORDER BY sequence ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(UsageNotificationOutboxRecord {
            sequence: row.get(0)?,
            account_id: row.get(1)?,
            id: row.get(2)?,
            dedupe_key: row.get(3)?,
            payload_json: row.get(4)?,
            created_at: row.get(5)?,
        })
    })?;

    let mut records = Vec::new();
    for row in rows {
        records.push(row?);
    }
    Ok(records)
}

pub fn remove_usage_notification(db: &Database, id: &str) -> Result<bool> {
    let conn = db.connect()?;
    let affected = conn.execute(
        "DELETE FROM usage_notification_outbox WHERE id = ?1",
        params![id],
    )?;
    Ok(affected > 0)
}

/// 删除截止时间之前已过期的本地用量通知，保留边界时间及其后的待确认消息。
pub fn prune_usage_notifications_before(db: &Database, cutoff: &str) -> Result<usize> {
    let conn = db.connect()?;
    let affected = conn.execute(
        "DELETE FROM usage_notification_outbox WHERE created_at < ?1",
        params![cutoff],
    )?;
    Ok(affected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::{AccountRecord, SiteRecord};
    use crate::infrastructure::sqlite::repositories;

    fn build_test_db() -> Database {
        let path = std::env::temp_dir().join(format!(
            "api-token-usage-notification-outbox-{}.db",
            uuid::Uuid::new_v4()
        ));
        let db = Database::new(path);
        let _ = db.connect().expect("initialize test database");
        repositories::insert_site(
            &db,
            &SiteRecord {
                id: "site-1".into(),
                name: "测试站点".into(),
                base_url: "https://example.test".into(),
                created_at: "2026-07-19T00:00:00Z".into(),
                updated_at: "2026-07-19T00:00:00Z".into(),
                ..SiteRecord::default()
            },
        )
        .expect("insert site");
        repositories::insert_account(
            &db,
            &AccountRecord {
                id: "account-1".into(),
                site_id: "site-1".into(),
                label: "测试账号".into(),
                email: "account@example.test".into(),
                balance_warning: -1.0,
                last_login_at: None,
                created_at: "2026-07-19T00:00:00Z".into(),
                updated_at: "2026-07-19T00:00:00Z".into(),
            },
        )
        .expect("insert account");
        db
    }

    #[test]
    fn usage_notification_outbox_preserves_insert_order_and_stable_dedupe_until_acknowledged() {
        let db = build_test_db();

        assert!(enqueue_usage_notification(
            &db,
            "account-1",
            "notification-1",
            "usage-sync:account-1:row-1",
            "{\"id\":\"notification-1\"}",
            "2026-07-19T00:00:00Z",
        )
        .expect("enqueue first"));
        assert!(enqueue_usage_notification(
            &db,
            "account-1",
            "notification-2",
            "usage-sync:account-1:row-2",
            "{\"id\":\"notification-2\"}",
            "2026-07-19T00:00:01Z",
        )
        .expect("enqueue second"));
        assert!(!enqueue_usage_notification(
            &db,
            "account-1",
            "notification-duplicate",
            "usage-sync:account-1:row-1",
            "{\"id\":\"notification-duplicate\"}",
            "2026-07-19T00:00:02Z",
        )
        .expect("dedupe insert"));

        let rows = list_usage_notifications(&db).expect("load outbox");
        assert_eq!(
            rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            ["notification-1", "notification-2"]
        );
        assert!(remove_usage_notification(&db, "notification-1").expect("acknowledge first"));
        assert_eq!(
            list_usage_notifications(&db)
                .expect("load after acknowledgement")
                .iter()
                .map(|row| row.id.as_str())
                .collect::<Vec<_>>(),
            ["notification-2"]
        );
    }

    #[test]
    fn prune_usage_notifications_before_keeps_cutoff_and_newer_records() {
        let db = build_test_db();
        for (id, created_at) in [
            ("notification-expired", "2026-07-19 23:59:59"),
            ("notification-cutoff", "2026-07-20 00:00:00"),
            ("notification-current", "2026-07-20 00:00:01"),
        ] {
            assert!(enqueue_usage_notification(
                &db,
                "account-1",
                id,
                &format!("usage-sync:account-1:{id}"),
                &format!(r#"{{\"id\":\"{id}\"}}"#),
                created_at,
            )
            .expect("enqueue usage notification"));
        }

        assert_eq!(
            prune_usage_notifications_before(&db, "2026-07-20 00:00:00")
                .expect("prune expired notifications"),
            1
        );
        assert_eq!(
            list_usage_notifications(&db)
                .expect("load retained notifications")
                .iter()
                .map(|row| row.id.as_str())
                .collect::<Vec<_>>(),
            ["notification-cutoff", "notification-current"]
        );
    }
}
