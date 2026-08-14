use anyhow::{anyhow, Result};
use rusqlite::params;

use crate::contracts::{
    SubscriptionSwitchChainNode, SubscriptionSwitchRuleRecord, SubscriptionSwitchRuntimeState,
    SubscriptionSwitchThresholdMode, SubscriptionSwitchTriggerReason,
};
use crate::infrastructure::sqlite::Database;

pub fn save_subscription_switch_rule(
    db: &Database,
    rule: &SubscriptionSwitchRuleRecord,
) -> Result<()> {
    let source_node = rule
        .chain_nodes
        .first()
        .ok_or_else(|| anyhow!("订阅链至少需要包含源订阅节点。"))?;
    if source_node.group_id != rule.source_group_id {
        return Err(anyhow!("订阅链首节点必须是源订阅。"));
    }
    let candidate_group_ids = rule
        .chain_nodes
        .iter()
        .skip(1)
        .map(|node| node.group_id)
        .collect::<Vec<_>>();
    let conn = db.connect()?;
    conn.execute(
        "INSERT INTO account_key_subscription_switch_rules (
            account_id, key_id, source_group_id, enabled, chain_nodes_json, candidate_group_ids_json,
            auto_restore, strict_mode, threshold_mode, threshold_value, runtime_state,
            active_target_group_id, last_trigger_reason, last_switched_at, last_restored_at,
            last_error, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
         ON CONFLICT(account_id, key_id) DO UPDATE SET
            source_group_id = excluded.source_group_id,
            enabled = excluded.enabled,
            chain_nodes_json = excluded.chain_nodes_json,
            candidate_group_ids_json = excluded.candidate_group_ids_json,
            auto_restore = excluded.auto_restore,
            strict_mode = excluded.strict_mode,
            threshold_mode = excluded.threshold_mode,
            threshold_value = excluded.threshold_value,
            runtime_state = excluded.runtime_state,
            active_target_group_id = excluded.active_target_group_id,
            last_trigger_reason = excluded.last_trigger_reason,
            last_switched_at = excluded.last_switched_at,
            last_restored_at = excluded.last_restored_at,
            last_error = excluded.last_error,
            updated_at = excluded.updated_at",
        params![
            &rule.account_id,
            &rule.key_id,
            rule.source_group_id,
            if rule.enabled { 1 } else { 0 },
            serde_json::to_string(&rule.chain_nodes)?,
            serde_json::to_string(&candidate_group_ids)?,
            if rule.auto_restore { 1 } else { 0 },
            if rule.strict_mode { 1 } else { 0 },
            threshold_mode_to_str(&source_node.threshold_mode),
            source_node.threshold_value,
            runtime_state_to_str(&rule.runtime_state),
            rule.active_target_group_id,
            rule.last_trigger_reason.as_ref().map(trigger_reason_to_str),
            &rule.last_switched_at,
            &rule.last_restored_at,
            &rule.last_error,
            &rule.updated_at,
        ],
    )?;
    Ok(())
}

pub fn delete_subscription_switch_rule(
    db: &Database,
    account_id: &str,
    key_id: &str,
) -> Result<bool> {
    let conn = db.connect()?;
    let affected = conn.execute(
        "DELETE FROM account_key_subscription_switch_rules WHERE account_id = ?1 AND key_id = ?2",
        params![account_id, key_id],
    )?;
    Ok(affected > 0)
}

pub fn list_subscription_switch_rules(
    db: &Database,
    account_id: &str,
) -> Result<Vec<SubscriptionSwitchRuleRecord>> {
    let conn = db.connect()?;
    let mut stmt = conn.prepare(
        "SELECT account_id, key_id, source_group_id, enabled, chain_nodes_json, candidate_group_ids_json,
                auto_restore, strict_mode, threshold_mode, threshold_value, runtime_state,
                active_target_group_id, last_trigger_reason, last_switched_at, last_restored_at,
                last_error, updated_at
         FROM account_key_subscription_switch_rules
         WHERE account_id = ?1
         ORDER BY updated_at DESC, key_id ASC",
    )?;
    let rows = stmt.query_map(params![account_id], |row| {
        let source_group_id: i64 = row.get(2)?;
        let chain_nodes_json: String = row.get(4)?;
        let candidate_group_ids_json: String = row.get(5)?;
        let threshold_mode: String = row.get(8)?;
        let threshold_value: f64 = row.get(9)?;
        let runtime_state: String = row.get(10)?;
        let last_trigger_reason: Option<String> = row.get(12)?;
        let legacy_candidate_group_ids =
            serde_json::from_str(&candidate_group_ids_json).unwrap_or_default();
        Ok(SubscriptionSwitchRuleRecord {
            account_id: row.get(0)?,
            key_id: row.get(1)?,
            source_group_id,
            enabled: row.get::<_, i64>(3)? > 0,
            chain_nodes: parse_chain_nodes(
                &chain_nodes_json,
                source_group_id,
                legacy_candidate_group_ids,
                parse_threshold_mode(&threshold_mode),
                threshold_value,
            ),
            auto_restore: row.get::<_, i64>(6)? > 0,
            strict_mode: row.get::<_, i64>(7)? > 0,
            runtime_state: parse_runtime_state(&runtime_state),
            active_target_group_id: row.get(11)?,
            last_trigger_reason: last_trigger_reason.as_deref().map(parse_trigger_reason),
            last_switched_at: row.get(13)?,
            last_restored_at: row.get(14)?,
            last_error: row.get(15)?,
            updated_at: row.get(16)?,
        })
    })?;

    let mut result = Vec::new();
    for row in rows {
        result.push(row?);
    }
    Ok(result)
}

/// 旧规则升级前没有节点 JSON, 读取时以旧列构造等价链避免单条坏数据阻断列表。
fn parse_chain_nodes(
    chain_nodes_json: &str,
    source_group_id: i64,
    candidate_group_ids: Vec<i64>,
    threshold_mode: SubscriptionSwitchThresholdMode,
    threshold_value: f64,
) -> Vec<SubscriptionSwitchChainNode> {
    match serde_json::from_str::<Vec<SubscriptionSwitchChainNode>>(chain_nodes_json) {
        Ok(nodes) if !nodes.is_empty() => nodes,
        _ => std::iter::once(SubscriptionSwitchChainNode {
            group_id: source_group_id,
            threshold_mode: threshold_mode.clone(),
            threshold_value,
        })
        .chain(
            candidate_group_ids
                .into_iter()
                .map(|group_id| SubscriptionSwitchChainNode {
                    group_id,
                    threshold_mode: threshold_mode.clone(),
                    threshold_value,
                }),
        )
        .collect(),
    }
}

pub fn has_enabled_subscription_switch_rules(db: &Database, account_id: &str) -> Result<bool> {
    let conn = db.connect()?;
    let exists = conn.query_row(
        "SELECT EXISTS(
            SELECT 1
            FROM account_key_subscription_switch_rules
            WHERE account_id = ?1 AND enabled > 0
        )",
        params![account_id],
        |row| row.get::<_, i64>(0),
    )?;
    Ok(exists > 0)
}

fn threshold_mode_to_str(value: &SubscriptionSwitchThresholdMode) -> &'static str {
    match value {
        SubscriptionSwitchThresholdMode::AmountUsd => "amount_usd",
        SubscriptionSwitchThresholdMode::UsagePercent => "usage_percent",
    }
}

fn parse_threshold_mode(value: &str) -> SubscriptionSwitchThresholdMode {
    match value {
        "amount_usd" => SubscriptionSwitchThresholdMode::AmountUsd,
        _ => SubscriptionSwitchThresholdMode::UsagePercent,
    }
}

fn runtime_state_to_str(value: &SubscriptionSwitchRuntimeState) -> &'static str {
    match value {
        SubscriptionSwitchRuntimeState::Idle => "idle",
        SubscriptionSwitchRuntimeState::Switched => "switched",
        SubscriptionSwitchRuntimeState::Failed => "failed",
    }
}

fn parse_runtime_state(value: &str) -> SubscriptionSwitchRuntimeState {
    match value {
        "switched" => SubscriptionSwitchRuntimeState::Switched,
        "failed" => SubscriptionSwitchRuntimeState::Failed,
        _ => SubscriptionSwitchRuntimeState::Idle,
    }
}

fn trigger_reason_to_str(value: &SubscriptionSwitchTriggerReason) -> &'static str {
    match value {
        SubscriptionSwitchTriggerReason::BalanceLow => "balance_low",
        SubscriptionSwitchTriggerReason::SourceSubscriptionAmountThresholdReached => {
            "source_subscription_amount_threshold_reached"
        }
        SubscriptionSwitchTriggerReason::SourceSubscriptionPercentThresholdReached => {
            "source_subscription_percent_threshold_reached"
        }
        SubscriptionSwitchTriggerReason::SourceSubscriptionUnavailable => {
            "source_subscription_unavailable"
        }
        SubscriptionSwitchTriggerReason::SourceSubscriptionQuotaExhausted => {
            "source_subscription_quota_exhausted"
        }
        SubscriptionSwitchTriggerReason::CandidateSubscriptionUnavailable => {
            "candidate_subscription_unavailable"
        }
        SubscriptionSwitchTriggerReason::CandidateSubscriptionQuotaExhausted => {
            "candidate_subscription_quota_exhausted"
        }
        SubscriptionSwitchTriggerReason::CandidateSubscriptionAmountThresholdReached => {
            "candidate_subscription_amount_threshold_reached"
        }
        SubscriptionSwitchTriggerReason::CandidateSubscriptionPercentThresholdReached => {
            "candidate_subscription_percent_threshold_reached"
        }
        SubscriptionSwitchTriggerReason::StrictPriorityReconciled => "strict_priority_reconciled",
        SubscriptionSwitchTriggerReason::Restored => "restored",
    }
}

fn parse_trigger_reason(value: &str) -> SubscriptionSwitchTriggerReason {
    match value {
        "balance_low" => SubscriptionSwitchTriggerReason::BalanceLow,
        "source_subscription_amount_threshold_reached" => {
            SubscriptionSwitchTriggerReason::SourceSubscriptionAmountThresholdReached
        }
        "source_subscription_percent_threshold_reached" => {
            SubscriptionSwitchTriggerReason::SourceSubscriptionPercentThresholdReached
        }
        "source_subscription_unavailable" => {
            SubscriptionSwitchTriggerReason::SourceSubscriptionUnavailable
        }
        "source_subscription_quota_exhausted" => {
            SubscriptionSwitchTriggerReason::SourceSubscriptionQuotaExhausted
        }
        "candidate_subscription_unavailable" => {
            SubscriptionSwitchTriggerReason::CandidateSubscriptionUnavailable
        }
        "candidate_subscription_quota_exhausted" => {
            SubscriptionSwitchTriggerReason::CandidateSubscriptionQuotaExhausted
        }
        "candidate_subscription_amount_threshold_reached" => {
            SubscriptionSwitchTriggerReason::CandidateSubscriptionAmountThresholdReached
        }
        "candidate_subscription_percent_threshold_reached" => {
            SubscriptionSwitchTriggerReason::CandidateSubscriptionPercentThresholdReached
        }
        "strict_priority_reconciled" => SubscriptionSwitchTriggerReason::StrictPriorityReconciled,
        "restored" => SubscriptionSwitchTriggerReason::Restored,
        _ => SubscriptionSwitchTriggerReason::SourceSubscriptionUnavailable,
    }
}
