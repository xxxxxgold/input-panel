use crate::contracts::{AccountAlert, AccountRecord, KeyRecord, SiteRecord};

pub fn build_alerts(
    account: &AccountRecord,
    site: &SiteRecord,
    balance: f64,
    keys: &[KeyRecord],
    fetched_at: &str,
) -> Vec<AccountAlert> {
    let mut alerts = Vec::new();

    if account.balance_warning >= 0.0 && balance < account.balance_warning {
        if balance <= 0.0 {
            alerts.push(AccountAlert {
                id: format!("{}:balance-empty", account.id),
                severity: "critical".into(),
                title: format!("{} 余额已耗尽", account.label),
                detail: format!("{} 当前余额为 0，请尽快充值或检查套餐。", site.name),
                site_id: site.id.clone(),
                account_id: account.id.clone(),
                created_at: fetched_at.to_string(),
            });
        } else {
            alerts.push(AccountAlert {
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
    }

    let exhausted = keys
        .iter()
        .filter(|item| item.status == "quota_exhausted")
        .count();
    if exhausted > 0 {
        alerts.push(AccountAlert {
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

#[cfg(test)]
mod tests {
    use super::build_alerts;
    use crate::contracts::{AccountRecord, KeyRecord, SiteRecord};

    #[test]
    fn disabled_balance_warning_suppresses_empty_balance_alert() {
        let account = build_account(-1.0);
        let site = build_site();
        let alerts = build_alerts(&account, &site, 0.0, &[], "2026-06-15T00:00:00Z");

        assert!(alerts
            .iter()
            .all(|item| !item.id.ends_with(":balance-empty")));
    }

    #[test]
    fn disabled_balance_warning_keeps_key_quota_alerts() {
        let account = build_account(-1.0);
        let site = build_site();
        let key = KeyRecord {
            id: "key-1".into(),
            group_id: None,
            name: "Key".into(),
            status: "quota_exhausted".into(),
            platform: None,
            group_name: None,
            expires_at: None,
            last_used_at: None,
            quota: None,
            quota_used: None,
            rate_limit5h: None,
            rate_limit1d: None,
            rate_limit7d: None,
            usage5h: None,
            usage1d: None,
            usage7d: None,
            current_concurrency: None,
        };

        let alerts = build_alerts(&account, &site, 0.0, &[key], "2026-06-15T00:00:00Z");

        assert_eq!(alerts.len(), 1);
        assert!(alerts[0].id.ends_with(":keys-exhausted"));
    }

    #[test]
    fn balance_warning_uses_strictly_less_than_threshold() {
        let site = build_site();
        let account = build_account(5.0);

        assert!(build_alerts(&account, &site, 5.0, &[], "2026-06-15T00:00:00Z").is_empty());
        assert!(build_alerts(&account, &site, 5.01, &[], "2026-06-15T00:00:00Z").is_empty());
        assert!(
            build_alerts(&account, &site, 4.99, &[], "2026-06-15T00:00:00Z")
                .iter()
                .any(|item| item.id.ends_with(":balance-low"))
        );
    }

    #[test]
    fn zero_threshold_only_alerts_for_negative_balance() {
        let site = build_site();
        let account = build_account(0.0);

        assert!(build_alerts(&account, &site, 0.0, &[], "2026-06-15T00:00:00Z").is_empty());
        assert!(build_alerts(&account, &site, 0.01, &[], "2026-06-15T00:00:00Z").is_empty());
        assert!(
            build_alerts(&account, &site, -0.01, &[], "2026-06-15T00:00:00Z")
                .iter()
                .any(|item| item.id.ends_with(":balance-empty"))
        );
    }

    fn build_account(balance_warning: f64) -> AccountRecord {
        AccountRecord {
            id: "account-1".into(),
            site_id: "site-1".into(),
            label: "主账号".into(),
            email: "demo@example.com".into(),
            balance_warning,
            last_login_at: None,
            created_at: "2026-06-15T00:00:00Z".into(),
            updated_at: "2026-06-15T00:00:00Z".into(),
        }
    }

    fn build_site() -> SiteRecord {
        SiteRecord {
            id: "site-1".into(),
            name: "AI INPUT".into(),
            base_url: "https://ai.input.im".into(),
            created_at: "2026-06-15T00:00:00Z".into(),
            updated_at: "2026-06-15T00:00:00Z".into(),
            ..SiteRecord::default()
        }
    }
}
