use crate::contracts::{AccountRecord, KeyRecord, SiteRecord, SnapshotAlert};

pub fn build_alerts(
    account: &AccountRecord,
    site: &SiteRecord,
    balance: f64,
    keys: &[KeyRecord],
    fetched_at: &str,
) -> Vec<SnapshotAlert> {
    let mut alerts = Vec::new();

    if balance <= 0.0 {
        alerts.push(SnapshotAlert {
            id: format!("{}:balance-empty", account.id),
            severity: "critical".into(),
            title: format!("{} 余额已耗尽", account.label),
            detail: format!("{} 当前余额为 0，请尽快充值或检查套餐。", site.name),
            site_id: site.id.clone(),
            account_id: account.id.clone(),
            created_at: fetched_at.to_string(),
        });
    } else if account.balance_warning >= 0.0 && balance <= account.balance_warning {
        alerts.push(SnapshotAlert {
            id: format!("{}:balance-low", account.id),
            severity: "high".into(),
            title: format!("{} 余额偏低", account.label),
            detail: format!(
                "{} 当前余额 {:.2}，低于预警阈值 {:.2}。",
                site.name, balance, account.balance_warning
            ),
            site_id: site.id.clone(),
            account_id: account.id.clone(),
            created_at: fetched_at.to_string(),
        });
    }

    let exhausted = keys
        .iter()
        .filter(|item| item.status == "quota_exhausted")
        .count();
    if exhausted > 0 {
        alerts.push(SnapshotAlert {
            id: format!("{}:keys-exhausted", account.id),
            severity: "medium".into(),
            title: format!("{} 存在额度耗尽的 Keys", account.label),
            detail: format!("共 {exhausted} 个 key 处于 quota_exhausted 状态。"),
            site_id: site.id.clone(),
            account_id: account.id.clone(),
            created_at: fetched_at.to_string(),
        });
    }

    alerts
}
