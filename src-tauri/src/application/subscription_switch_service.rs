use crate::contracts::{
    DataSyncTrigger, GroupRecord, KeyPatchInput, ManagedKeyRecord, SubscriptionQuotaWindow,
    SubscriptionRecord, SubscriptionSwitchChainNode, SubscriptionSwitchEvaluationResult,
    SubscriptionSwitchRuleRecord, SubscriptionSwitchRuleUpsertInput,
    SubscriptionSwitchRuntimeState, SubscriptionSwitchThresholdMode,
    SubscriptionSwitchTriggerReason,
};
use crate::infrastructure::datetime::now_storage_timestamp;
use crate::infrastructure::sqlite::repositories;
use anyhow::{anyhow, Context, Result};

use super::{
    data_center_service, keys_service, resource_coordinator::LiveResourceKind,
    subscription_snapshot_service, upstream_service::UpstreamRequestPolicy, AppContext,
};

pub async fn list_subscription_switch_rules(
    ctx: &AppContext,
    account_id: &str,
) -> Result<Vec<SubscriptionSwitchRuleRecord>> {
    repositories::list_subscription_switch_rules(&ctx.db, account_id)
}

pub async fn upsert_subscription_switch_rule(
    ctx: &AppContext,
    account_id: &str,
    key_id: &str,
    payload: SubscriptionSwitchRuleUpsertInput,
) -> Result<SubscriptionSwitchRuleRecord> {
    // 配置写入与 evaluator 共用账号 gate，避免旧评估结果覆盖刚保存的订阅链。
    let _evaluation_gate = ctx
        .live_resources
        .acquire_subscription_switch_account_gate(account_id)
        .await;
    let (groups, keys) = load_live_switch_edit_records(ctx, account_id).await?;
    let existing = repositories::list_subscription_switch_rules(&ctx.db, account_id)?
        .into_iter()
        .find(|item| item.key_id == key_id);
    let current_group_id = validate_rule(&groups, &keys, key_id, &payload)?;
    let source_changed = existing
        .as_ref()
        .is_some_and(|item| item.source_group_id != payload.source_group_id);
    // 保存配置时按上游真实分组重新对齐运行态，链首可以由用户重新排序。
    let (runtime_state, active_target_group_id) =
        resolve_runtime_position(payload.source_group_id, current_group_id);

    let now = now_storage_timestamp();
    let rule = SubscriptionSwitchRuleRecord {
        account_id: account_id.to_string(),
        key_id: key_id.to_string(),
        source_group_id: payload.source_group_id,
        enabled: payload.enabled,
        chain_nodes: payload.chain_nodes,
        auto_restore: payload.auto_restore,
        strict_mode: payload.strict_mode,
        runtime_state,
        active_target_group_id,
        last_trigger_reason: if source_changed {
            None
        } else {
            existing
                .as_ref()
                .and_then(|item| item.last_trigger_reason.clone())
        },
        last_switched_at: existing
            .as_ref()
            .and_then(|item| item.last_switched_at.clone()),
        last_restored_at: existing
            .as_ref()
            .and_then(|item| item.last_restored_at.clone()),
        last_error: if source_changed {
            None
        } else {
            existing.as_ref().and_then(|item| item.last_error.clone())
        },
        updated_at: now,
    };
    repositories::save_subscription_switch_rule(&ctx.db, &rule)?;
    Ok(rule)
}

pub async fn delete_subscription_switch_rule(
    ctx: &AppContext,
    account_id: &str,
    key_id: &str,
) -> Result<bool> {
    let _evaluation_gate = ctx
        .live_resources
        .acquire_subscription_switch_account_gate(account_id)
        .await;
    repositories::delete_subscription_switch_rule(&ctx.db, account_id, key_id)
}

pub async fn evaluate_subscription_switch_rules(
    ctx: &AppContext,
    account_id: &str,
) -> Result<Vec<SubscriptionSwitchEvaluationResult>> {
    evaluate_subscription_switch_rules_with_resource_force(ctx, account_id, true).await
}

async fn evaluate_subscription_switch_rules_with_resource_force(
    ctx: &AppContext,
    account_id: &str,
    force_resources: bool,
) -> Result<Vec<SubscriptionSwitchEvaluationResult>> {
    let _evaluation_gate = ctx
        .live_resources
        .acquire_subscription_switch_account_gate(account_id)
        .await;
    evaluate_subscription_switch_rules_under_gate(ctx, account_id, force_resources).await
}

/// 启动期只评估已有会话且有启用规则的账号，不触发完整同步或用量通知。
pub async fn evaluate_saved_subscription_switch_rules_at_startup(ctx: &AppContext) -> Result<()> {
    const MAX_CONCURRENT_STARTUP_EVALUATIONS: usize = 3;

    let sessions = repositories::list_sessions(&ctx.db)?;
    let mut account_ids = Vec::new();
    for account_id in sessions.into_keys() {
        if repositories::has_enabled_subscription_switch_rules(&ctx.db, &account_id)? {
            account_ids.push(account_id);
        }
    }

    let mut pending = account_ids.into_iter();
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..MAX_CONCURRENT_STARTUP_EVALUATIONS {
        let Some(account_id) = pending.next() else {
            break;
        };
        spawn_startup_evaluation(&mut tasks, ctx.clone(), account_id);
    }

    while let Some(joined) = tasks.join_next().await {
        match joined {
            Ok((account_id, Err(error))) => {
                log::warn!(
                    "startup subscription-switch evaluation failed for {account_id}: {error}"
                );
            }
            Err(error) => {
                log::warn!("startup subscription-switch evaluation task aborted: {error}");
            }
            _ => {}
        }
        if let Some(account_id) = pending.next() {
            spawn_startup_evaluation(&mut tasks, ctx.clone(), account_id);
        }
    }
    Ok(())
}

fn spawn_startup_evaluation(
    tasks: &mut tokio::task::JoinSet<(String, Result<Vec<SubscriptionSwitchEvaluationResult>>)>,
    ctx: AppContext,
    account_id: String,
) {
    tasks.spawn(async move {
        let result = evaluate_subscription_switch_rules(&ctx, &account_id).await;
        (account_id, result)
    });
}

async fn evaluate_subscription_switch_rules_under_gate(
    ctx: &AppContext,
    account_id: &str,
    force_resources: bool,
) -> Result<Vec<SubscriptionSwitchEvaluationResult>> {
    let rules = repositories::list_subscription_switch_rules(&ctx.db, account_id)?;
    if rules.is_empty() {
        return Ok(Vec::new());
    }
    let (groups, keys, subscriptions) =
        load_live_switch_records(ctx, account_id, force_resources).await?;

    evaluate_rules_with_records(ctx, account_id, &groups, &keys, &subscriptions, rules).await
}

/// 消费调用方已取得的订阅快照，候补 evaluator 不再发起第二次 subscriptions 请求。
pub(crate) async fn evaluate_subscription_switch_rules_with_snapshot(
    ctx: &AppContext,
    account_id: &str,
    subscriptions: &[SubscriptionRecord],
) -> Result<Vec<SubscriptionSwitchEvaluationResult>> {
    let _evaluation_gate = ctx
        .live_resources
        .acquire_subscription_switch_account_gate(account_id)
        .await;
    let rules = repositories::list_subscription_switch_rules(&ctx.db, account_id)?;
    if rules.is_empty() {
        return Ok(Vec::new());
    }
    let (groups, keys) = load_live_switch_support_records(ctx, account_id, false).await?;
    evaluate_rules_with_records(ctx, account_id, &groups, &keys, subscriptions, rules).await
}

async fn evaluate_rules_with_records(
    ctx: &AppContext,
    account_id: &str,
    groups: &[GroupRecord],
    keys: &[ManagedKeyRecord],
    subscriptions: &[SubscriptionRecord],
    rules: Vec<SubscriptionSwitchRuleRecord>,
) -> Result<Vec<SubscriptionSwitchEvaluationResult>> {
    let mut results = Vec::new();
    for rule in rules {
        let result =
            match evaluate_single_rule(ctx, account_id, groups, keys, subscriptions, rule.clone())
                .await
            {
                Ok(value) => value,
                Err(error) => mark_rule_failed(ctx, rule, error.to_string())?,
            };
        results.push(result);
    }
    Ok(results)
}

async fn evaluate_single_rule(
    ctx: &AppContext,
    account_id: &str,
    groups: &[GroupRecord],
    keys: &[ManagedKeyRecord],
    subscriptions: &[SubscriptionRecord],
    mut rule: SubscriptionSwitchRuleRecord,
) -> Result<SubscriptionSwitchEvaluationResult> {
    if !rule.enabled {
        return Ok(to_evaluation_result(&rule));
    }
    validate_runtime_chain(&rule)?;

    let key = keys
        .iter()
        .find(|item| item.key.id == rule.key_id)
        .cloned()
        .context("规则关联的密钥不存在。")?;
    let _source_group = groups
        .iter()
        .find(|item| item.id == rule.source_group_id)
        .cloned()
        .context("规则的源订阅分组不存在。")?;
    ensure_subscription_group(&_source_group, "源订阅")?;
    let key_group_id = key
        .key
        .group_id
        .context("规则关联的密钥当前没有所属订阅分组。")?;
    let chain_nodes = rule.chain_nodes.clone();
    let current_node_index = chain_nodes
        .iter()
        .position(|node| node.group_id == key_group_id)
        .context("规则关联的密钥当前不在订阅链中。")?;
    let source_node = chain_nodes.first().context("订阅链缺少源订阅节点。")?;
    let source_subscription = subscriptions
        .iter()
        .find(|item| item.group_id == Some(rule.source_group_id))
        .cloned();
    let source_trigger_reason =
        resolve_node_trigger_reason(source_subscription.as_ref(), source_node, true);
    let rule_key_id = rule.key_id.clone();

    if current_node_index > 0 && rule.strict_mode {
        let (target_node_index, last_failure) = find_first_eligible_chain_node(
            &chain_nodes,
            0..current_node_index,
            groups,
            subscriptions,
        );
        if let Some(target_node_index) = target_node_index {
            let target_node = chain_nodes
                .get(target_node_index)
                .context("严格模式目标节点不存在。")?;
            return switch_to_candidate_group(
                ctx,
                account_id,
                &rule_key_id,
                &mut rule,
                target_node.group_id,
                target_node_index,
                SubscriptionSwitchTriggerReason::StrictPriorityReconciled,
                last_failure.map(|(_, message)| message),
            )
            .await;
        }
    }

    if current_node_index > 0
        && !rule.strict_mode
        && rule.auto_restore
        && source_trigger_reason.is_none()
        && has_evaluable_threshold_window(source_subscription.as_ref())
    {
        return restore_source_group(ctx, account_id, &rule_key_id, &mut rule).await;
    }

    let current_node = chain_nodes
        .get(current_node_index)
        .context("订阅链当前节点不存在。")?;
    let current_subscription = subscriptions
        .iter()
        .find(|item| item.group_id == Some(current_node.group_id));
    let current_trigger_reason =
        resolve_node_trigger_reason(current_subscription, current_node, current_node_index == 0);

    if current_trigger_reason.is_none() {
        // 缺少可用额度窗口代表“未知”，不能当成低于阈值，否则会误回切或误判节点健康。
        if !has_evaluable_threshold_window(current_subscription) {
            log::warn!(
                "subscription-switch quota window unavailable for account={account_id} key={} group={}",
                rule.key_id,
                current_node.group_id
            );
            return Ok(to_evaluation_result(&rule));
        }
        let next_state = if current_node_index == 0 {
            SubscriptionSwitchRuntimeState::Idle
        } else {
            SubscriptionSwitchRuntimeState::Switched
        };
        let next_active_target = (current_node_index > 0).then_some(current_node.group_id);
        if rule.runtime_state != next_state
            || rule.active_target_group_id != next_active_target
            || rule.last_error.is_some()
        {
            rule.runtime_state = next_state;
            rule.active_target_group_id = next_active_target;
            rule.last_error = None;
            rule.updated_at = now_storage_timestamp();
            repositories::save_subscription_switch_rule(&ctx.db, &rule)?;
        }
        return Ok(to_evaluation_result(&rule));
    }

    let trigger_reason = current_trigger_reason
        .unwrap_or(SubscriptionSwitchTriggerReason::SourceSubscriptionUnavailable);

    // 当前节点触发后只扫描其余 len - 1 个节点，顺序为链尾后回绕链首。
    let candidate_indexes =
        (1..chain_nodes.len()).map(|offset| (current_node_index + offset) % chain_nodes.len());
    let (target_node_index, last_failure) =
        find_first_eligible_chain_node(&chain_nodes, candidate_indexes, groups, subscriptions);
    if let Some(target_node_index) = target_node_index {
        let target_node = chain_nodes
            .get(target_node_index)
            .context("候补订阅目标节点不存在。")?;
        return switch_to_candidate_group(
            ctx,
            account_id,
            &rule_key_id,
            &mut rule,
            target_node.group_id,
            target_node_index,
            trigger_reason,
            last_failure.map(|(_, message)| message),
        )
        .await;
    }

    rule.runtime_state = SubscriptionSwitchRuntimeState::Failed;
    rule.active_target_group_id = (current_node_index > 0).then_some(current_node.group_id);
    rule.last_trigger_reason = Some(
        last_failure
            .as_ref()
            .map(|(reason, _)| reason.clone())
            .unwrap_or(trigger_reason),
    );
    rule.last_error = Some(
        last_failure
            .map(|(_, message)| message)
            .unwrap_or_else(|| "当前没有可用的候补订阅。".to_string()),
    );
    rule.updated_at = now_storage_timestamp();
    repositories::save_subscription_switch_rule(&ctx.db, &rule)?;
    Ok(to_evaluation_result(&rule))
}

async fn switch_to_candidate_group(
    ctx: &AppContext,
    account_id: &str,
    key_id: &str,
    rule: &mut SubscriptionSwitchRuleRecord,
    target_group_id: i64,
    target_node_index: usize,
    trigger_reason: SubscriptionSwitchTriggerReason,
    skipped_candidate_diagnostic: Option<String>,
) -> Result<SubscriptionSwitchEvaluationResult> {
    update_key_group(ctx, account_id, key_id, target_group_id).await?;
    let now = now_storage_timestamp();
    if target_node_index == 0 {
        rule.runtime_state = SubscriptionSwitchRuntimeState::Idle;
        rule.active_target_group_id = None;
        rule.last_restored_at = Some(now.clone());
    } else {
        rule.runtime_state = SubscriptionSwitchRuntimeState::Switched;
        rule.active_target_group_id = Some(target_group_id);
        rule.last_switched_at = Some(now.clone());
    }
    rule.last_trigger_reason = Some(trigger_reason);
    rule.last_error = skipped_candidate_diagnostic;
    rule.updated_at = now;
    repositories::save_subscription_switch_rule(&ctx.db, rule)?;
    if let Err(error) = refresh_account_data_after_switch(ctx, account_id).await {
        // 上游分组已经写入且规则已持久化，刷新失败不能把真实切换状态覆盖为失败。
        log::warn!("subscription-switch post-write refresh failed for {account_id}: {error}");
    }
    Ok(to_evaluation_result(rule))
}

async fn restore_source_group(
    ctx: &AppContext,
    account_id: &str,
    key_id: &str,
    rule: &mut SubscriptionSwitchRuleRecord,
) -> Result<SubscriptionSwitchEvaluationResult> {
    update_key_group(ctx, account_id, key_id, rule.source_group_id).await?;
    rule.runtime_state = SubscriptionSwitchRuntimeState::Idle;
    rule.active_target_group_id = None;
    rule.last_trigger_reason = Some(SubscriptionSwitchTriggerReason::Restored);
    let now = now_storage_timestamp();
    rule.last_restored_at = Some(now.clone());
    rule.last_error = None;
    rule.updated_at = now;
    repositories::save_subscription_switch_rule(&ctx.db, rule)?;
    if let Err(error) = refresh_account_data_after_switch(ctx, account_id).await {
        // 回切已成功写入时，后续读取刷新失败只记录诊断，不回滚运行态。
        log::warn!("subscription-switch restore refresh failed for {account_id}: {error}");
    }
    Ok(to_evaluation_result(rule))
}

async fn refresh_account_data_after_switch(ctx: &AppContext, account_id: &str) -> Result<()> {
    // key 写入已经失效 subscriptions/summary；此处只刷新 keys，避免在持有候补 gate 时
    // 递归评估候补规则或强制读取第二份 subscriptions。
    data_center_service::sync_keys_scope(ctx, account_id, DataSyncTrigger::PostWrite).await?;
    Ok(())
}

async fn update_key_group(
    ctx: &AppContext,
    account_id: &str,
    key_id: &str,
    target_group_id: i64,
) -> Result<()> {
    keys_service::update_managed_key_raw(
        ctx,
        account_id,
        key_id,
        KeyPatchInput {
            group_id: Some(target_group_id),
            ..KeyPatchInput::default()
        },
    )
    .await
    .with_context(|| format!("切换密钥 {key_id} 的订阅分组时失败。"))?;
    Ok(())
}

async fn load_live_switch_edit_records(
    ctx: &AppContext,
    account_id: &str,
) -> Result<(Vec<GroupRecord>, Vec<ManagedKeyRecord>)> {
    let (groups, keys) = tokio::try_join!(
        data_center_service::fetch_groups_strict(ctx, account_id, UpstreamRequestPolicy::ReadOnly),
        ctx.live_resources
            .get_or_fetch(account_id, LiveResourceKind::Keys, true, || async {
                data_center_service::fetch_keys(ctx, account_id, UpstreamRequestPolicy::ReadOnly)
                    .await
            },),
    )?;
    Ok((groups, keys))
}

async fn load_live_switch_records(
    ctx: &AppContext,
    account_id: &str,
    force_resources: bool,
) -> Result<(
    Vec<GroupRecord>,
    Vec<ManagedKeyRecord>,
    Vec<SubscriptionRecord>,
)> {
    let (groups, keys, subscriptions, summary) = tokio::try_join!(
        data_center_service::fetch_groups_strict(ctx, account_id, UpstreamRequestPolicy::ReadOnly),
        ctx.live_resources.get_or_fetch(
            account_id,
            LiveResourceKind::Keys,
            force_resources,
            || async {
                data_center_service::fetch_keys(ctx, account_id, UpstreamRequestPolicy::ReadOnly)
                    .await
            },
        ),
        ctx.live_resources.get_or_fetch(
            account_id,
            LiveResourceKind::Subscriptions,
            force_resources,
            || async {
                data_center_service::fetch_subscriptions(
                    ctx,
                    account_id,
                    UpstreamRequestPolicy::ReadOnly,
                )
                .await
            },
        ),
        ctx.live_resources.get_or_fetch(
            account_id,
            LiveResourceKind::SubscriptionSummary,
            force_resources,
            || async {
                data_center_service::fetch_subscription_summary(
                    ctx,
                    account_id,
                    UpstreamRequestPolicy::ReadOnly,
                )
                .await
            },
        ),
    )?;
    let subscriptions = subscription_snapshot_service::merge_subscription_summary_daily_windows(
        &subscriptions,
        &summary,
    );
    Ok((groups, keys, subscriptions))
}

async fn load_live_switch_support_records(
    ctx: &AppContext,
    account_id: &str,
    force_resources: bool,
) -> Result<(Vec<GroupRecord>, Vec<ManagedKeyRecord>)> {
    tokio::try_join!(
        data_center_service::fetch_groups_strict(ctx, account_id, UpstreamRequestPolicy::ReadOnly),
        ctx.live_resources.get_or_fetch(
            account_id,
            LiveResourceKind::Keys,
            force_resources,
            || async {
                data_center_service::fetch_keys(ctx, account_id, UpstreamRequestPolicy::ReadOnly)
                    .await
            },
        ),
    )
}

fn validate_rule(
    groups: &[GroupRecord],
    keys: &[ManagedKeyRecord],
    key_id: &str,
    payload: &SubscriptionSwitchRuleUpsertInput,
) -> Result<i64> {
    let source_group = groups
        .iter()
        .find(|item| item.id == payload.source_group_id)
        .cloned()
        .context("源订阅分组不存在。")?;
    ensure_subscription_group(&source_group, "源订阅")?;
    validate_chain_nodes(groups, payload)?;

    let key = keys
        .iter()
        .find(|item| item.key.id == key_id)
        .context("存在未知密钥，无法保存规则。")?;
    let current_group_id = key
        .key
        .group_id
        .context("当前密钥没有所属分组，无法保存订阅链。")?;
    if !payload
        .chain_nodes
        .iter()
        .any(|node| node.group_id == current_group_id)
    {
        return Err(anyhow!("当前密钥所在订阅必须保留在订阅链中。"));
    }
    Ok(current_group_id)
}

/// 根据密钥真实所在节点计算保存后的运行态，避免链首调整后保留旧状态。
fn resolve_runtime_position(
    source_group_id: i64,
    current_group_id: i64,
) -> (SubscriptionSwitchRuntimeState, Option<i64>) {
    if current_group_id == source_group_id {
        (SubscriptionSwitchRuntimeState::Idle, None)
    } else {
        (
            SubscriptionSwitchRuntimeState::Switched,
            Some(current_group_id),
        )
    }
}

fn validate_chain_nodes(
    groups: &[GroupRecord],
    payload: &SubscriptionSwitchRuleUpsertInput,
) -> Result<()> {
    if payload.chain_nodes.len() < 2 {
        return Err(anyhow!("订阅链至少需要包含源订阅和 1 个候补订阅。"));
    }
    if payload.chain_nodes.first().map(|node| node.group_id) != Some(payload.source_group_id) {
        return Err(anyhow!("订阅链首节点必须是源订阅。"));
    }

    let mut seen_group_ids = std::collections::BTreeSet::new();
    for (index, node) in payload.chain_nodes.iter().enumerate() {
        if !seen_group_ids.insert(node.group_id) {
            return Err(anyhow!("订阅链里不能出现重复订阅。"));
        }
        let group = groups
            .iter()
            .find(|item| item.id == node.group_id)
            .cloned()
            .context(if index == 0 {
                "源订阅分组不存在。"
            } else {
                "候补订阅分组不存在。"
            })?;
        ensure_subscription_group(
            &group,
            if index == 0 {
                "源订阅"
            } else {
                "候补订阅"
            },
        )?;
        validate_node_threshold(node)?;
    }
    Ok(())
}

fn validate_node_threshold(node: &SubscriptionSwitchChainNode) -> Result<()> {
    if !node.threshold_value.is_finite() || node.threshold_value <= 0.0 {
        return Err(anyhow!("切换阈值必须是大于 0 的数字。"));
    }
    if matches!(
        node.threshold_mode,
        SubscriptionSwitchThresholdMode::UsagePercent
    ) && node.threshold_value > 100.0
    {
        return Err(anyhow!("百分比阈值不能超过 100%。"));
    }
    Ok(())
}

fn ensure_subscription_group(group: &GroupRecord, label: &str) -> Result<()> {
    let is_subscription = group
        .subscription_type
        .as_deref()
        .map(|value| value.trim().eq_ignore_ascii_case("subscription"))
        .unwrap_or(false);
    if !is_subscription {
        return Err(anyhow!("{label}必须是 subscription 分组。"));
    }
    Ok(())
}

fn validate_runtime_chain(rule: &SubscriptionSwitchRuleRecord) -> Result<()> {
    if rule.chain_nodes.len() < 2 {
        return Err(anyhow!("订阅链配置缺少候补订阅。"));
    }
    if rule.chain_nodes.first().map(|node| node.group_id) != Some(rule.source_group_id) {
        return Err(anyhow!("订阅链配置的源订阅不在链首。"));
    }
    let mut seen_group_ids = std::collections::BTreeSet::new();
    for node in &rule.chain_nodes {
        if !seen_group_ids.insert(node.group_id) {
            return Err(anyhow!("订阅链配置包含重复订阅。"));
        }
        validate_node_threshold(node)?;
    }
    Ok(())
}

fn resolve_node_trigger_reason(
    subscription: Option<&SubscriptionRecord>,
    node: &SubscriptionSwitchChainNode,
    is_source: bool,
) -> Option<SubscriptionSwitchTriggerReason> {
    let unavailable_reason = if is_source {
        SubscriptionSwitchTriggerReason::SourceSubscriptionUnavailable
    } else {
        SubscriptionSwitchTriggerReason::CandidateSubscriptionUnavailable
    };
    let quota_exhausted_reason = if is_source {
        SubscriptionSwitchTriggerReason::SourceSubscriptionQuotaExhausted
    } else {
        SubscriptionSwitchTriggerReason::CandidateSubscriptionQuotaExhausted
    };
    // 上游没有返回节点订阅时不能假定其可用，避免切到已删除或不可见的候补分组。
    let subscription = match subscription {
        Some(subscription) => subscription,
        None => return Some(unavailable_reason),
    };
    if !subscription.status.trim().eq_ignore_ascii_case("active") {
        return Some(unavailable_reason);
    }
    if [
        subscription.daily.as_ref(),
        subscription.weekly.as_ref(),
        subscription.monthly.as_ref(),
    ]
    .into_iter()
    .flatten()
    .any(is_window_exhausted)
    {
        return Some(quota_exhausted_reason);
    }

    let monitored = select_threshold_window(subscription)?;
    match node.threshold_mode {
        SubscriptionSwitchThresholdMode::AmountUsd if monitored.current >= node.threshold_value => {
            Some(if is_source {
                SubscriptionSwitchTriggerReason::SourceSubscriptionAmountThresholdReached
            } else {
                SubscriptionSwitchTriggerReason::CandidateSubscriptionAmountThresholdReached
            })
        }
        SubscriptionSwitchThresholdMode::UsagePercent
            if monitored.limit > 0.0
                && (monitored.current / monitored.limit) * 100.0 >= node.threshold_value =>
        {
            Some(if is_source {
                SubscriptionSwitchTriggerReason::SourceSubscriptionPercentThresholdReached
            } else {
                SubscriptionSwitchTriggerReason::CandidateSubscriptionPercentThresholdReached
            })
        }
        _ => None,
    }
}

/// 按调用方给定的有界索引顺序，选择第一个真实可用且低于自身阈值的节点。
fn find_first_eligible_chain_node(
    chain_nodes: &[SubscriptionSwitchChainNode],
    candidate_indexes: impl IntoIterator<Item = usize>,
    groups: &[GroupRecord],
    subscriptions: &[SubscriptionRecord],
) -> (
    Option<usize>,
    Option<(SubscriptionSwitchTriggerReason, String)>,
) {
    let mut last_failure = None;
    for candidate_index in candidate_indexes {
        let Some(candidate_node) = chain_nodes.get(candidate_index) else {
            continue;
        };
        if let Some(failure) = candidate_node_skip_diagnostic(groups, subscriptions, candidate_node)
        {
            last_failure = Some(failure);
            continue;
        }
        return (Some(candidate_index), last_failure);
    }
    (None, last_failure)
}

fn candidate_node_skip_diagnostic(
    groups: &[GroupRecord],
    subscriptions: &[SubscriptionRecord],
    candidate_node: &SubscriptionSwitchChainNode,
) -> Option<(SubscriptionSwitchTriggerReason, String)> {
    let candidate_group_id = candidate_node.group_id;
    let candidate_group = match groups.iter().find(|item| item.id == candidate_group_id) {
        Some(value) => value,
        None => {
            return Some((
                SubscriptionSwitchTriggerReason::CandidateSubscriptionUnavailable,
                format!("候补订阅分组 {candidate_group_id} 不存在。"),
            ));
        }
    };
    if ensure_subscription_group(candidate_group, "候补订阅").is_err() {
        return Some((
            SubscriptionSwitchTriggerReason::CandidateSubscriptionUnavailable,
            format!(
                "候补订阅 {} 已跳过: 分组类型不是 subscription。",
                candidate_group.name
            ),
        ));
    }

    let candidate_subscription = subscriptions
        .iter()
        .find(|item| item.group_id == Some(candidate_group_id));
    if let Some(reason) = resolve_node_trigger_reason(candidate_subscription, candidate_node, false)
    {
        return Some((
            reason.clone(),
            format!(
                "候补订阅 {} 已跳过: {}。",
                candidate_group.name,
                candidate_skip_reason_label(&reason)
            ),
        ));
    }
    if !has_evaluable_threshold_window(candidate_subscription) {
        return Some((
            SubscriptionSwitchTriggerReason::CandidateSubscriptionUnavailable,
            format!(
                "候补订阅 {} 已跳过: 缺少可用于阈值判断的额度窗口。",
                candidate_group.name
            ),
        ));
    }
    None
}

fn candidate_skip_reason_label(reason: &SubscriptionSwitchTriggerReason) -> &'static str {
    match reason {
        SubscriptionSwitchTriggerReason::CandidateSubscriptionUnavailable => "订阅不存在或不可用",
        SubscriptionSwitchTriggerReason::CandidateSubscriptionQuotaExhausted => "额度已耗尽",
        SubscriptionSwitchTriggerReason::CandidateSubscriptionAmountThresholdReached => {
            "已达到金额阈值"
        }
        SubscriptionSwitchTriggerReason::CandidateSubscriptionPercentThresholdReached => {
            "已达到百分比阈值"
        }
        _ => "当前不可切换",
    }
}

fn select_threshold_window(subscription: &SubscriptionRecord) -> Option<&SubscriptionQuotaWindow> {
    [
        subscription.daily.as_ref(),
        subscription.weekly.as_ref(),
        subscription.monthly.as_ref(),
    ]
    .into_iter()
    .flatten()
    .find(|window| window.limit > 0.0)
}

fn has_evaluable_threshold_window(subscription: Option<&SubscriptionRecord>) -> bool {
    subscription.is_some_and(|subscription| select_threshold_window(subscription).is_some())
}

fn is_window_exhausted(window: &SubscriptionQuotaWindow) -> bool {
    window.limit > 0.0 && window.current >= window.limit
}

fn to_evaluation_result(rule: &SubscriptionSwitchRuleRecord) -> SubscriptionSwitchEvaluationResult {
    SubscriptionSwitchEvaluationResult {
        account_id: rule.account_id.clone(),
        key_id: rule.key_id.clone(),
        source_group_id: rule.source_group_id,
        runtime_state: rule.runtime_state.clone(),
        active_target_group_id: rule.active_target_group_id,
        last_trigger_reason: rule.last_trigger_reason.clone(),
        last_error: rule.last_error.clone(),
    }
}

fn mark_rule_failed(
    ctx: &AppContext,
    mut rule: SubscriptionSwitchRuleRecord,
    error_message: String,
) -> Result<SubscriptionSwitchEvaluationResult> {
    rule.runtime_state = SubscriptionSwitchRuntimeState::Failed;
    rule.last_error = Some(error_message);
    rule.updated_at = now_storage_timestamp();
    repositories::save_subscription_switch_rule(&ctx.db, &rule)?;
    Ok(to_evaluation_result(&rule))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application::{context::SyncTaskHandle, AppContext};
    use crate::contracts::{
        AccountRecord, GroupRecord, KeyRecord, ManagedKeyRecord, SiteRecord, StoredSession,
    };
    use crate::infrastructure::files::AppPaths;
    use crate::infrastructure::sqlite::Database;
    use axum::{
        extract::Query,
        http::StatusCode,
        routing::{get, put},
        Json, Router,
    };
    use serde_json::json;
    use std::collections::HashMap;
    use std::sync::Arc;
    use tokio::sync::Mutex;

    fn build_test_db() -> Database {
        let db_path = std::env::temp_dir().join(format!(
            "api-token-subscription-switch-{}.db",
            uuid::Uuid::new_v4()
        ));
        let db = Database::new(db_path);
        let _ = db.connect().expect("init sqlite");
        db
    }

    fn build_test_context() -> AppContext {
        let root = std::env::temp_dir().join(format!(
            "api-token-subscription-switch-ctx-{}",
            uuid::Uuid::new_v4()
        ));
        let paths = AppPaths::from_root(root);
        paths.ensure().expect("ensure app paths");
        let db = Database::new(paths.db_path.clone());
        let _ = db.connect().expect("init sqlite");
        AppContext {
            runtime_coordination: crate::application::runtime_coordination_service::RuntimeCoordinationService::from_paths_for_test(&paths)
                .expect("initialize test runtime coordination"),
            paths,
            db,
            sync_tasks: Arc::new(Mutex::new(HashMap::<String, Arc<SyncTaskHandle>>::new())),
            live_resources: crate::application::resource_coordinator::ResourceCoordinator::default(
            ),
            native_notifications_enabled: false,
        }
    }

    fn seed_account(ctx: &AppContext, base_url: &str, balance_warning: f64) {
        repositories::insert_site(
            &ctx.db,
            &SiteRecord {
                id: "site-1".into(),
                name: "Test Site".into(),
                base_url: base_url.into(),
                created_at: "2026-07-01T00:00:00Z".into(),
                updated_at: "2026-07-01T00:00:00Z".into(),
                ..SiteRecord::default()
            },
        )
        .expect("insert site");
        repositories::insert_account(
            &ctx.db,
            &AccountRecord {
                id: "account-1".into(),
                site_id: "site-1".into(),
                label: "主账号".into(),
                email: "main@example.com".into(),
                balance_warning,
                last_login_at: None,
                created_at: "2026-07-01T00:00:00Z".into(),
                updated_at: "2026-07-01T00:00:00Z".into(),
            },
        )
        .expect("insert account");
        repositories::save_session(
            &ctx.db,
            "account-1",
            &StoredSession {
                saved_at: "2026-07-01T00:00:00Z".into(),
                access_token: Some("token".into()),
                refresh_token: None,
                token_type: Some("bearer".into()),
                cookie_jar_json: None,
            },
        )
        .expect("save session");
    }

    fn build_group(id: i64, name: &str, daily_limit_usd: f64) -> GroupRecord {
        GroupRecord {
            id,
            name: name.into(),
            description: None,
            platform: "openai".into(),
            rate_multiplier: 1.0,
            subscription_type: Some("subscription".into()),
            daily_limit_usd: Some(daily_limit_usd),
            weekly_limit_usd: None,
            monthly_limit_usd: None,
            allow_messages_dispatch: Some(true),
        }
    }

    fn build_key(id: &str) -> ManagedKeyRecord {
        ManagedKeyRecord {
            key: KeyRecord {
                id: id.into(),
                group_id: Some(1),
                name: format!("Key {id}"),
                status: "active".into(),
                platform: Some("openai".into()),
                group_name: Some("Source".into()),
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
            },
            api_key_id: None,
            raw_key: None,
            user_id: None,
            ip_whitelist: None,
            ip_blacklist: None,
            window5h_start: None,
            window1d_start: None,
            window7d_start: None,
        }
    }

    fn build_chain(
        source_group_id: i64,
        candidate_group_ids: &[i64],
    ) -> Vec<SubscriptionSwitchChainNode> {
        std::iter::once(SubscriptionSwitchChainNode {
            group_id: source_group_id,
            threshold_mode: SubscriptionSwitchThresholdMode::UsagePercent,
            threshold_value: 85.0,
        })
        .chain(
            candidate_group_ids
                .iter()
                .copied()
                .map(|group_id| SubscriptionSwitchChainNode {
                    group_id,
                    threshold_mode: SubscriptionSwitchThresholdMode::UsagePercent,
                    threshold_value: 85.0,
                }),
        )
        .collect()
    }

    fn build_subscription(
        group_id: i64,
        name: &str,
        status: &str,
        quota: Option<(f64, f64)>,
    ) -> SubscriptionRecord {
        SubscriptionRecord {
            id: format!("subscription-{group_id}"),
            subscription_key: format!("group:{group_id}"),
            identity_kind: crate::contracts::SubscriptionIdentityKind::Group,
            identity_ambiguous: false,
            upstream_subscription_id: Some(format!("subscription-{group_id}")),
            fallback_identity: format!("fallback:v1:openai|{name}|{name}"),
            group_id: Some(group_id),
            name: name.into(),
            status: status.into(),
            group_name: Some(name.into()),
            platform: Some("openai".into()),
            expires_at: None,
            daily: quota.map(|(current, limit)| SubscriptionQuotaWindow {
                current,
                limit,
                window_start: None,
            }),
            weekly: None,
            monthly: None,
        }
    }

    fn build_rule() -> SubscriptionSwitchRuleRecord {
        SubscriptionSwitchRuleRecord {
            account_id: "account-1".into(),
            key_id: "key-1".into(),
            source_group_id: 1,
            enabled: true,
            chain_nodes: build_chain(1, &[2]),
            auto_restore: true,
            strict_mode: false,
            runtime_state: SubscriptionSwitchRuntimeState::Idle,
            active_target_group_id: None,
            last_trigger_reason: None,
            last_switched_at: None,
            last_restored_at: None,
            last_error: None,
            updated_at: "2026-07-01T00:00:00Z".into(),
        }
    }

    fn build_upsert_input() -> SubscriptionSwitchRuleUpsertInput {
        SubscriptionSwitchRuleUpsertInput {
            enabled: true,
            source_group_id: 1,
            chain_nodes: build_chain(1, &[2]),
            auto_restore: true,
            strict_mode: false,
        }
    }

    #[test]
    fn missing_subscription_is_marked_unavailable() {
        let chain = build_chain(1, &[2]);

        assert_eq!(
            resolve_node_trigger_reason(None, &chain[0], true),
            Some(SubscriptionSwitchTriggerReason::SourceSubscriptionUnavailable)
        );
        assert_eq!(
            resolve_node_trigger_reason(None, &chain[1], false),
            Some(SubscriptionSwitchTriggerReason::CandidateSubscriptionUnavailable)
        );
    }

    #[tokio::test]
    async fn transient_group_read_error_does_not_mark_rule_failed() {
        let app = Router::new()
            .route(
                "/api/v1/groups/available",
                get(|| async {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "groups temporarily unavailable",
                    )
                }),
            )
            .route(
                "/api/v1/subscriptions",
                get(|| async { Json(json!({ "items": [] })) }),
            )
            .route(
                "/api/v1/keys",
                get(|| async { Json(json!({ "items": [] })) }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener addr");
        tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve test app");
        });

        let ctx = build_test_context();
        seed_account(&ctx, &format!("http://{address}"), 10.0);
        repositories::save_subscription_switch_rule(&ctx.db, &build_rule()).expect("save rule");

        assert!(evaluate_subscription_switch_rules(&ctx, "account-1")
            .await
            .is_err());
        let saved = repositories::list_subscription_switch_rules(&ctx.db, "account-1")
            .expect("read saved rule");
        assert_eq!(saved[0].runtime_state, SubscriptionSwitchRuntimeState::Idle);
        assert_eq!(saved[0].last_error, None);
    }

    #[tokio::test]
    async fn deleting_a_rule_waits_for_active_subscription_evaluation() {
        let ctx = build_test_context();
        seed_account(&ctx, "http://127.0.0.1:9", 10.0);
        repositories::save_subscription_switch_rule(&ctx.db, &build_rule()).expect("save rule");

        let evaluation_gate = ctx
            .live_resources
            .acquire_subscription_switch_account_gate("account-1")
            .await;
        let delete_ctx = ctx.clone();
        let mut delete_task = tokio::spawn(async move {
            delete_subscription_switch_rule(&delete_ctx, "account-1", "key-1").await
        });

        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), &mut delete_task)
                .await
                .is_err()
        );
        drop(evaluation_gate);
        assert!(delete_task
            .await
            .expect("delete task should join")
            .expect("delete rule"));
        assert!(
            repositories::list_subscription_switch_rules(&ctx.db, "account-1")
                .expect("list rules")
                .is_empty()
        );
    }

    #[test]
    fn validate_rule_rejects_duplicate_candidates() {
        let groups = vec![
            build_group(1, "Source", 10.0),
            build_group(2, "Backup", 20.0),
        ];
        let keys = vec![build_key("key-1")];
        let mut payload = build_upsert_input();
        payload.chain_nodes = build_chain(1, &[2, 2]);
        let result = validate_rule(&groups, &keys, "key-1", &payload);
        assert!(result.is_err());
    }

    #[test]
    fn validate_rule_allows_current_key_outside_chain_head() {
        let groups = vec![
            build_group(1, "Source", 10.0),
            build_group(2, "Backup", 20.0),
        ];
        let mut key = build_key("key-1");
        key.key.group_id = Some(2);
        let current_group_id = validate_rule(&groups, &[key], "key-1", &build_upsert_input())
            .expect("current key group may be a later chain node");
        assert_eq!(current_group_id, 2);
    }

    #[test]
    fn validate_rule_rejects_current_key_outside_chain() {
        let groups = vec![
            build_group(1, "Source", 10.0),
            build_group(2, "Current", 20.0),
            build_group(3, "Backup", 30.0),
        ];
        let mut key = build_key("key-1");
        key.key.group_id = Some(2);
        let mut payload = build_upsert_input();
        payload.chain_nodes = build_chain(1, &[3]);
        let error = validate_rule(&groups, &[key], "key-1", &payload)
            .expect_err("current key group must remain in the chain");
        assert!(error
            .to_string()
            .contains("当前密钥所在订阅必须保留在订阅链中"));
    }

    #[test]
    fn saved_runtime_position_follows_current_key_group() {
        assert_eq!(
            resolve_runtime_position(1, 1),
            (SubscriptionSwitchRuntimeState::Idle, None)
        );
        assert_eq!(
            resolve_runtime_position(1, 2),
            (SubscriptionSwitchRuntimeState::Switched, Some(2))
        );
    }

    #[test]
    fn repository_roundtrip_rule() {
        let db = build_test_db();
        repositories::insert_site(
            &db,
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
            &db,
            &AccountRecord {
                id: "account-1".into(),
                site_id: "site-1".into(),
                label: "主账号".into(),
                email: "main@example.com".into(),
                balance_warning: -1.0,
                last_login_at: None,
                created_at: "2026-07-01T00:00:00Z".into(),
                updated_at: "2026-07-01T00:00:00Z".into(),
            },
        )
        .expect("insert account");
        let now = "2026-07-01T00:00:00Z".to_string();
        repositories::save_subscription_switch_rule(
            &db,
            &SubscriptionSwitchRuleRecord {
                chain_nodes: build_chain(1, &[2, 3]),
                strict_mode: true,
                updated_at: now.clone(),
                ..build_rule()
            },
        )
        .expect("save rule");

        let rows =
            repositories::list_subscription_switch_rules(&db, "account-1").expect("list rules");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].key_id, "key-1");
        assert_eq!(
            rows[0]
                .chain_nodes
                .iter()
                .map(|node| node.group_id)
                .collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        assert_eq!(
            rows[0].chain_nodes[0].threshold_mode,
            SubscriptionSwitchThresholdMode::UsagePercent
        );
        assert!(rows[0].strict_mode);
    }

    #[test]
    fn strict_scan_selects_the_highest_priority_eligible_previous_node() {
        let chain = build_chain(1, &[2, 3, 4]);
        let groups = vec![
            build_group(1, "Source", 100.0),
            build_group(2, "Backup A", 100.0),
            build_group(3, "Backup B", 100.0),
            build_group(4, "Current", 100.0),
        ];
        let subscriptions = vec![
            build_subscription(1, "Source", "active", None),
            build_subscription(2, "Backup A", "active", Some((90.0, 100.0))),
            build_subscription(3, "Backup B", "active", Some((10.0, 100.0))),
            build_subscription(4, "Current", "active", Some((10.0, 100.0))),
        ];

        let (target, diagnostic) =
            find_first_eligible_chain_node(&chain, 0..3, &groups, &subscriptions);

        assert_eq!(target, Some(2));
        assert_eq!(
            diagnostic.map(|(reason, _)| reason),
            Some(SubscriptionSwitchTriggerReason::CandidateSubscriptionPercentThresholdReached)
        );
    }

    #[tokio::test]
    async fn strict_mode_reconciles_a_healthy_fourth_node_to_the_best_previous_node() {
        let group_writes = Arc::new(Mutex::new(Vec::<i64>::new()));
        let app = {
            let group_writes_for_write = Arc::clone(&group_writes);
            Router::new()
                .route(
                    "/api/v1/groups/available",
                    get(|| async {
                        Json(json!({
                            "items": [
                                { "id": 1, "name": "Source", "platform": "openai", "subscription_type": "subscription", "rate_multiplier": 1.0 },
                                { "id": 2, "name": "Backup A", "platform": "openai", "subscription_type": "subscription", "rate_multiplier": 1.0 },
                                { "id": 3, "name": "Backup B", "platform": "openai", "subscription_type": "subscription", "rate_multiplier": 1.0 },
                                { "id": 4, "name": "Current", "platform": "openai", "subscription_type": "subscription", "rate_multiplier": 1.0 }
                            ]
                        }))
                    }),
                )
                .route(
                    "/api/v1/keys",
                    get(|| async {
                        Json(json!({
                            "items": [
                                { "id": "key-1", "group_id": 3, "name": "主 Key", "status": "active", "platform": "openai", "group_name": "Backup B" }
                            ]
                        }))
                    }),
                )
                .route(
                    "/api/v1/keys/key-1",
                    put(move |Json(payload): Json<serde_json::Value>| {
                        let group_writes = Arc::clone(&group_writes_for_write);
                        async move {
                            let next_group = payload
                                .get("group_id")
                                .and_then(|value| value.as_i64())
                                .expect("group id is required");
                            group_writes.lock().await.push(next_group);
                            Json(json!({
                                "id": "key-1",
                                "group_id": next_group,
                                "name": "主 Key",
                                "status": "active",
                                "platform": "openai",
                                "group_name": "Backup B"
                            }))
                        }
                    }),
                )
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener addr");
        tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve test app");
        });

        let ctx = build_test_context();
        seed_account(&ctx, &format!("http://{address}"), 10.0);
        let groups = vec![
            build_group(1, "Source", 100.0),
            build_group(2, "Backup A", 100.0),
            build_group(3, "Backup B", 100.0),
            build_group(4, "Current", 100.0),
        ];
        let mut key = build_key("key-1");
        key.key.group_id = Some(4);
        key.key.group_name = Some("Current".into());
        let subscriptions = vec![
            build_subscription(1, "Source", "inactive", Some((10.0, 100.0))),
            build_subscription(2, "Backup A", "active", Some((90.0, 100.0))),
            build_subscription(3, "Backup B", "active", Some((10.0, 100.0))),
            build_subscription(4, "Current", "active", Some((10.0, 100.0))),
        ];
        let rule = SubscriptionSwitchRuleRecord {
            source_group_id: 1,
            chain_nodes: build_chain(1, &[2, 3, 4]),
            auto_restore: false,
            strict_mode: true,
            runtime_state: SubscriptionSwitchRuntimeState::Switched,
            active_target_group_id: Some(4),
            ..build_rule()
        };

        let result = evaluate_single_rule(&ctx, "account-1", &groups, &[key], &subscriptions, rule)
            .await
            .expect("strict mode should reconcile priority");

        assert_eq!(
            result.runtime_state,
            SubscriptionSwitchRuntimeState::Switched
        );
        assert_eq!(result.active_target_group_id, Some(3));
        assert_eq!(
            result.last_trigger_reason,
            Some(SubscriptionSwitchTriggerReason::StrictPriorityReconciled)
        );
        assert_eq!(*group_writes.lock().await, vec![3]);
    }

    #[tokio::test]
    async fn disabled_strict_mode_keeps_a_healthy_current_node() {
        let ctx = build_test_context();
        seed_account(&ctx, "http://127.0.0.1:9", 10.0);
        let groups = vec![
            build_group(1, "Source", 100.0),
            build_group(2, "Backup A", 100.0),
            build_group(3, "Backup B", 100.0),
            build_group(4, "Current", 100.0),
        ];
        let mut key = build_key("key-1");
        key.key.group_id = Some(4);
        let subscriptions = vec![
            build_subscription(1, "Source", "inactive", Some((10.0, 100.0))),
            build_subscription(2, "Backup A", "active", Some((90.0, 100.0))),
            build_subscription(3, "Backup B", "active", Some((10.0, 100.0))),
            build_subscription(4, "Current", "active", Some((10.0, 100.0))),
        ];
        let rule = SubscriptionSwitchRuleRecord {
            source_group_id: 1,
            chain_nodes: build_chain(1, &[2, 3, 4]),
            auto_restore: false,
            strict_mode: false,
            runtime_state: SubscriptionSwitchRuntimeState::Switched,
            active_target_group_id: Some(4),
            ..build_rule()
        };

        let result = evaluate_single_rule(&ctx, "account-1", &groups, &[key], &subscriptions, rule)
            .await
            .expect("normal mode should keep a healthy current node");

        assert_eq!(
            result.runtime_state,
            SubscriptionSwitchRuntimeState::Switched
        );
        assert_eq!(result.active_target_group_id, Some(4));
        assert_eq!(result.last_trigger_reason, None);
    }

    #[tokio::test]
    async fn marks_failed_only_after_the_bounded_full_cycle_has_no_candidate() {
        let ctx = build_test_context();
        seed_account(&ctx, "http://127.0.0.1:9", 10.0);
        let groups = vec![
            build_group(1, "Source", 100.0),
            build_group(2, "Backup A", 100.0),
            build_group(3, "Backup B", 100.0),
            build_group(4, "Current", 100.0),
        ];
        let mut key = build_key("key-1");
        key.key.group_id = Some(4);
        let subscriptions = vec![
            build_subscription(1, "Source", "active", Some((90.0, 100.0))),
            build_subscription(2, "Backup A", "inactive", Some((10.0, 100.0))),
            build_subscription(3, "Backup B", "active", None),
            build_subscription(4, "Current", "active", Some((90.0, 100.0))),
        ];
        let rule = SubscriptionSwitchRuleRecord {
            source_group_id: 1,
            chain_nodes: build_chain(1, &[2, 3, 4]),
            auto_restore: false,
            strict_mode: false,
            runtime_state: SubscriptionSwitchRuntimeState::Switched,
            active_target_group_id: Some(4),
            ..build_rule()
        };

        let result = evaluate_single_rule(&ctx, "account-1", &groups, &[key], &subscriptions, rule)
            .await
            .expect("a full unsuccessful cycle should persist failed state");

        assert_eq!(result.runtime_state, SubscriptionSwitchRuntimeState::Failed);
        assert_eq!(result.active_target_group_id, Some(4));
        assert!(result
            .last_error
            .as_deref()
            .is_some_and(|message| message.contains("缺少可用于阈值判断的额度窗口")));
    }

    #[tokio::test]
    async fn skips_candidate_that_reaches_its_own_threshold() {
        let app = Router::new()
            .route(
                "/api/v1/user/profile",
                get(|| async {
                    Json(json!({
                        "email": "demo@example.com",
                        "balance": 5.0
                    }))
                }),
            )
            .route("/api/v1/user/platform-quotas", get(|| async { Json(json!({ "platform_quotas": [] })) }))
            .route(
                "/api/v1/subscriptions",
                get(|| async {
                    Json(json!({
                        "items": [
                            { "id": "sub-1", "group_id": 3, "name": "Source", "group_name": "Source", "status": "active", "platform": "openai", "daily": { "current": 90.0, "limit": 100.0 } },
                            { "id": "sub-2", "group_id": 4, "name": "Backup A", "group_name": "Backup A", "status": "active", "platform": "openai", "daily": { "current": 90.0, "limit": 100.0 } },
                            { "id": "sub-3", "group_id": 5, "name": "Backup B", "group_name": "Backup B", "status": "active", "platform": "openai", "daily": { "current": 10.0, "limit": 100.0 } }
                        ]
                    }))
                }),
            )
            .route("/api/v1/subscriptions/summary", get(|| async { Json(json!({ "active_count": 3, "total_used_usd": 1.0, "subscriptions": [] })) }))
            .route(
                "/api/v1/groups/available",
                get(|| async {
                    Json(json!({
                        "items": [
                            { "id": 3, "name": "Source", "platform": "openai", "subscription_type": "subscription", "rate_multiplier": 1.0 },
                            { "id": 4, "name": "Backup A", "platform": "openai", "subscription_type": "subscription", "rate_multiplier": 1.0 },
                            { "id": 5, "name": "Backup B", "platform": "openai", "subscription_type": "subscription", "rate_multiplier": 1.0 }
                        ]
                    }))
                }),
            )
            .route(
                "/api/v1/keys",
                get(|| async {
                    Json(json!({
                        "items": [
                            { "id": "key-1", "group_id": 3, "name": "主 Key", "status": "active", "platform": "openai", "group_name": "Source" }
                        ]
                    }))
                }),
            )
            .route("/api/v1/keys/key-1", put(|| async { Json(json!({ "id": "key-1", "group_id": 5, "name": "主 Key", "status": "active", "platform": "openai", "group_name": "Backup B" })) }))
            .route(
                "/api/v1/usage",
                get(|Query(query): Query<HashMap<String, String>>| async move {
                    let page = query
                        .get("page")
                        .and_then(|value| value.parse::<i64>().ok())
                        .unwrap_or(1);
                    let page_size = query
                        .get("page_size")
                        .and_then(|value| value.parse::<i64>().ok())
                        .unwrap_or(1_000);
                    Json(json!({
                        "items": [],
                        "page": page,
                        "page_size": page_size,
                        "total": 0,
                        "pages": 1
                    }))
                }),
            );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener addr");
        tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve test app");
        });

        let ctx = build_test_context();
        seed_account(&ctx, &format!("http://{address}"), 10.0);
        repositories::save_subscription_switch_rule(
            &ctx.db,
            &SubscriptionSwitchRuleRecord {
                source_group_id: 3,
                chain_nodes: build_chain(3, &[4, 5]),
                ..build_rule()
            },
        )
        .expect("save rule");

        data_center_service::sync_account_data(
            &ctx,
            "account-1",
            crate::contracts::SyncAccountDataInput {
                scope: crate::contracts::DataSyncScope::Full,
                trigger_source: crate::contracts::DataSyncTrigger::Manual,
            },
        )
        .await
        .expect("seed full sync");

        let result = evaluate_subscription_switch_rules(&ctx, "account-1")
            .await
            .expect("evaluate rules");
        assert_eq!(result.len(), 1);
        assert_eq!(
            result[0].runtime_state,
            SubscriptionSwitchRuntimeState::Switched
        );
        assert_eq!(result[0].active_target_group_id, Some(5));
        assert_eq!(
            result[0].last_trigger_reason,
            Some(SubscriptionSwitchTriggerReason::SourceSubscriptionPercentThresholdReached)
        );
        assert_eq!(
            result[0].last_error.as_deref(),
            Some("候补订阅 Backup A 已跳过: 已达到百分比阈值。")
        );
    }

    #[tokio::test]
    async fn wraps_to_the_chain_head_after_the_tail_when_auto_restore_is_disabled() {
        let active_group_id = Arc::new(Mutex::new(4_i64));
        let candidate_a_usage = Arc::new(Mutex::new(90.0_f64));
        let candidate_b_usage = Arc::new(Mutex::new(10.0_f64));
        let group_writes = Arc::new(Mutex::new(Vec::<i64>::new()));

        let app = {
            let active_group_for_keys = Arc::clone(&active_group_id);
            let active_group_for_write = Arc::clone(&active_group_id);
            let candidate_a_usage_for_read = Arc::clone(&candidate_a_usage);
            let candidate_b_usage_for_read = Arc::clone(&candidate_b_usage);
            let group_writes_for_write = Arc::clone(&group_writes);
            Router::new()
                .route(
                    "/api/v1/user/profile",
                    get(|| async { Json(json!({ "email": "demo@example.com", "balance": 5.0 })) }),
                )
                .route(
                    "/api/v1/user/platform-quotas",
                    get(|| async { Json(json!({ "platform_quotas": [] })) }),
                )
                .route(
                    "/api/v1/subscriptions",
                    get(move || {
                        let candidate_a_usage = Arc::clone(&candidate_a_usage_for_read);
                        let candidate_b_usage = Arc::clone(&candidate_b_usage_for_read);
                        async move {
                            let candidate_a_current = *candidate_a_usage.lock().await;
                            let candidate_b_current = *candidate_b_usage.lock().await;
                            Json(json!({
                                "items": [
                                    { "id": "sub-1", "group_id": 3, "name": "Source", "group_name": "Source", "status": "active", "platform": "openai", "daily": { "current": 90.0, "limit": 100.0 } },
                                    { "id": "sub-2", "group_id": 4, "name": "Backup A", "group_name": "Backup A", "status": "active", "platform": "openai", "daily": { "current": candidate_a_current, "limit": 100.0 } },
                                    { "id": "sub-3", "group_id": 5, "name": "Backup B", "group_name": "Backup B", "status": "active", "platform": "openai", "daily": { "current": candidate_b_current, "limit": 100.0 } }
                                ]
                            }))
                        }
                    }),
                )
                .route(
                    "/api/v1/subscriptions/summary",
                    get(|| async {
                        Json(json!({ "active_count": 3, "total_used_usd": 1.0, "subscriptions": [] }))
                    }),
                )
                .route(
                    "/api/v1/groups/available",
                    get(|| async {
                        Json(json!({
                            "items": [
                                { "id": 3, "name": "Source", "platform": "openai", "subscription_type": "subscription", "rate_multiplier": 1.0 },
                                { "id": 4, "name": "Backup A", "platform": "openai", "subscription_type": "subscription", "rate_multiplier": 1.0 },
                                { "id": 5, "name": "Backup B", "platform": "openai", "subscription_type": "subscription", "rate_multiplier": 1.0 }
                            ]
                        }))
                    }),
                )
                .route(
                    "/api/v1/keys",
                    get(move || {
                        let active_group = Arc::clone(&active_group_for_keys);
                        async move {
                            let current_group = *active_group.lock().await;
                            let group_name = match current_group {
                                3 => "Source",
                                4 => "Backup A",
                                _ => "Backup B",
                            };
                            Json(json!({
                                "items": [
                                    { "id": "key-1", "group_id": current_group, "name": "主 Key", "status": "active", "platform": "openai", "group_name": group_name }
                                ]
                            }))
                        }
                    }),
                )
                .route(
                    "/api/v1/keys/key-1",
                    put(move |Json(payload): Json<serde_json::Value>| {
                        let active_group = Arc::clone(&active_group_for_write);
                        let group_writes = Arc::clone(&group_writes_for_write);
                        async move {
                            let next_group = payload
                                .get("group_id")
                                .and_then(|value| value.as_i64())
                                .expect("group id is required");
                            *active_group.lock().await = next_group;
                            group_writes.lock().await.push(next_group);
                            let group_name = match next_group {
                                3 => "Source",
                                4 => "Backup A",
                                _ => "Backup B",
                            };
                            Json(json!({
                                "id": "key-1",
                                "group_id": next_group,
                                "name": "主 Key",
                                "status": "active",
                                "platform": "openai",
                                "group_name": group_name
                            }))
                        }
                    }),
                )
                .route(
                    "/api/v1/usage",
                    get(|Query(query): Query<HashMap<String, String>>| async move {
                        let page = query
                            .get("page")
                            .and_then(|value| value.parse::<i64>().ok())
                            .unwrap_or(1);
                        let page_size = query
                            .get("page_size")
                            .and_then(|value| value.parse::<i64>().ok())
                            .unwrap_or(1_000);
                        Json(json!({
                            "items": [],
                            "page": page,
                            "page_size": page_size,
                            "total": 0,
                            "pages": 1
                        }))
                    }),
                )
        };

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener addr");
        tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve test app");
        });

        let ctx = build_test_context();
        seed_account(&ctx, &format!("http://{address}"), 10.0);
        repositories::save_subscription_switch_rule(
            &ctx.db,
            &SubscriptionSwitchRuleRecord {
                source_group_id: 3,
                chain_nodes: build_chain(3, &[4, 5]),
                auto_restore: false,
                runtime_state: SubscriptionSwitchRuntimeState::Switched,
                active_target_group_id: Some(4),
                ..build_rule()
            },
        )
        .expect("save switched rule");

        let advanced = evaluate_subscription_switch_rules(&ctx, "account-1")
            .await
            .expect("advance to later candidate");
        assert_eq!(
            advanced[0].runtime_state,
            SubscriptionSwitchRuntimeState::Switched
        );
        assert_eq!(advanced[0].active_target_group_id, Some(5));
        assert_eq!(
            advanced[0].last_trigger_reason,
            Some(SubscriptionSwitchTriggerReason::CandidateSubscriptionPercentThresholdReached)
        );
        assert_eq!(*active_group_id.lock().await, 5);
        assert_eq!(*group_writes.lock().await, vec![5]);

        // 链尾触发后先回到链首；链首仍达阈值时继续扫描到已经恢复的候补 A。
        *candidate_a_usage.lock().await = 10.0;
        *candidate_b_usage.lock().await = 90.0;
        let tail = evaluate_subscription_switch_rules(&ctx, "account-1")
            .await
            .expect("wrap from chain tail");
        assert_eq!(
            tail[0].runtime_state,
            SubscriptionSwitchRuntimeState::Switched
        );
        assert_eq!(tail[0].active_target_group_id, Some(4));
        assert_eq!(
            tail[0].last_trigger_reason,
            Some(SubscriptionSwitchTriggerReason::CandidateSubscriptionPercentThresholdReached)
        );
        assert_eq!(*active_group_id.lock().await, 4);
        assert_eq!(*group_writes.lock().await, vec![5, 4]);
    }

    #[tokio::test]
    async fn missing_quota_windows_do_not_trigger_auto_restore() {
        let ctx = build_test_context();
        let groups = vec![
            build_group(1, "Source", 100.0),
            build_group(2, "Backup", 100.0),
        ];
        let mut key = build_key("key-1");
        key.key.group_id = Some(2);
        key.key.group_name = Some("Backup".into());
        let subscription = |group_id: i64, name: &str| SubscriptionRecord {
            id: format!("subscription-{group_id}"),
            subscription_key: format!("group:{group_id}"),
            identity_kind: crate::contracts::SubscriptionIdentityKind::Group,
            identity_ambiguous: false,
            upstream_subscription_id: Some(format!("subscription-{group_id}")),
            fallback_identity: format!("fallback:v1:openai|{name}|{name}"),
            group_id: Some(group_id),
            name: name.into(),
            status: "active".into(),
            group_name: Some(name.into()),
            platform: Some("openai".into()),
            expires_at: None,
            daily: None,
            weekly: None,
            monthly: None,
        };
        let rule = SubscriptionSwitchRuleRecord {
            source_group_id: 1,
            chain_nodes: build_chain(1, &[2]),
            runtime_state: SubscriptionSwitchRuntimeState::Switched,
            active_target_group_id: Some(2),
            ..build_rule()
        };

        let result = evaluate_single_rule(
            &ctx,
            "account-1",
            &groups,
            &[key],
            &[subscription(1, "Source"), subscription(2, "Backup")],
            rule,
        )
        .await
        .expect("missing quota windows must preserve the current group");

        assert_eq!(
            result.runtime_state,
            SubscriptionSwitchRuntimeState::Switched
        );
        assert_eq!(result.active_target_group_id, Some(2));
        assert_eq!(result.last_trigger_reason, None);
    }

    #[tokio::test]
    async fn restores_rule_when_source_subscription_recovers() {
        let source_usage = Arc::new(Mutex::new(90.0_f64));
        let source_group_for_read = Arc::new(Mutex::new(3_i64));
        let source_group_for_write = Arc::clone(&source_group_for_read);

        let app = {
            let source_usage_for_summary = Arc::clone(&source_usage);
            let source_group_for_read_keys = Arc::clone(&source_group_for_read);
            Router::new()
                .route(
                    "/api/v1/user/profile",
                    get(|| async { Json(json!({ "email": "demo@example.com", "balance": 5.0 })) }),
                )
                .route("/api/v1/user/platform-quotas", get(|| async { Json(json!({ "platform_quotas": [] })) }))
                .route(
                    "/api/v1/subscriptions",
                    get(|| async {
                        Json(json!({
                            "items": [
                                { "id": "sub-1", "group_id": 3, "name": "Source", "group_name": "Source", "status": "active", "platform": "openai" },
                                { "id": "sub-2", "group_id": 4, "name": "Backup", "group_name": "Backup", "status": "active", "platform": "openai" }
                            ]
                        }))
                    }),
                )
                .route(
                    "/api/v1/subscriptions/summary",
                    get(move || {
                        let source_usage = Arc::clone(&source_usage_for_summary);
                        async move {
                            let current_usage = *source_usage.lock().await;
                            Json(json!({
                                "active_count": 2,
                                "total_used_usd": current_usage + 12.0,
                                "subscriptions": [
                                    { "id": 1, "group_id": 3, "group_name": "Source", "status": "active", "daily_used_usd": current_usage, "daily_limit_usd": 100.0 },
                                    { "id": 2, "group_id": 4, "group_name": "Backup", "status": "active", "daily_used_usd": 12.0, "daily_limit_usd": 100.0 }
                                ]
                            }))
                        }
                    }),
                )
                .route(
                    "/api/v1/groups/available",
                    get(|| async {
                        Json(json!({
                            "items": [
                                { "id": 3, "name": "Source", "platform": "openai", "subscription_type": "subscription", "rate_multiplier": 1.0 },
                                { "id": 4, "name": "Backup", "platform": "openai", "subscription_type": "subscription", "rate_multiplier": 1.0 }
                            ]
                        }))
                    }),
                )
                .route(
                    "/api/v1/keys",
                    get(move || {
                        let source_group_for_read = Arc::clone(&source_group_for_read_keys);
                        async move {
                            let current_group = *source_group_for_read.lock().await;
                            let group_name = if current_group == 3 { "Source" } else { "Backup" };
                            Json(json!({
                                "items": [
                                    { "id": "key-1", "group_id": current_group, "name": "主 Key", "status": "active", "platform": "openai", "group_name": group_name }
                                ]
                            }))
                        }
                    }),
                )
                .route(
                    "/api/v1/keys/key-1",
                    put(move |Json(payload): Json<serde_json::Value>| {
                        let source_group_for_write = Arc::clone(&source_group_for_write);
                        async move {
                            let next_group = payload.get("group_id").and_then(|value| value.as_i64()).unwrap_or(3);
                            *source_group_for_write.lock().await = next_group;
                            let group_name = if next_group == 3 { "Source" } else { "Backup" };
                            Json(json!({
                                "id": "key-1",
                                "group_id": next_group,
                                "name": "主 Key",
                                "status": "active",
                                "platform": "openai",
                                "group_name": group_name
                            }))
                        }
                    }),
                )
                .route(
                    "/api/v1/usage",
                    get(|Query(query): Query<HashMap<String, String>>| async move {
                        let page = query
                            .get("page")
                            .and_then(|value| value.parse::<i64>().ok())
                            .unwrap_or(1);
                        let page_size = query
                            .get("page_size")
                            .and_then(|value| value.parse::<i64>().ok())
                            .unwrap_or(1_000);
                        Json(json!({
                            "items": [],
                            "page": page,
                            "page_size": page_size,
                            "total": 0,
                            "pages": 1
                        }))
                    }),
                )
        };

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener addr");
        tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve test app");
        });

        let ctx = build_test_context();
        seed_account(&ctx, &format!("http://{address}"), 10.0);
        repositories::save_subscription_switch_rule(
            &ctx.db,
            &SubscriptionSwitchRuleRecord {
                source_group_id: 3,
                chain_nodes: build_chain(3, &[4]),
                ..build_rule()
            },
        )
        .expect("save rule");

        data_center_service::sync_account_data(
            &ctx,
            "account-1",
            crate::contracts::SyncAccountDataInput {
                scope: crate::contracts::DataSyncScope::Full,
                trigger_source: crate::contracts::DataSyncTrigger::Manual,
            },
        )
        .await
        .expect("seed full sync");
        assert_eq!(
            *source_group_for_read.lock().await,
            4,
            "full sync must evaluate the summary-enriched snapshot before the explicit evaluator"
        );

        let switched = evaluate_subscription_switch_rules(&ctx, "account-1")
            .await
            .expect("evaluate switched");
        assert_eq!(
            switched[0].runtime_state,
            SubscriptionSwitchRuntimeState::Switched
        );
        assert_eq!(switched[0].active_target_group_id, Some(4));

        *source_usage.lock().await = 40.0;
        data_center_service::sync_account_data(
            &ctx,
            "account-1",
            crate::contracts::SyncAccountDataInput {
                scope: crate::contracts::DataSyncScope::Full,
                trigger_source: crate::contracts::DataSyncTrigger::Manual,
            },
        )
        .await
        .expect("refresh after recovery");
        assert_eq!(
            *source_group_for_read.lock().await,
            3,
            "full sync must restore only after the summary usage falls below the threshold"
        );

        let restored = evaluate_subscription_switch_rules(&ctx, "account-1")
            .await
            .expect("evaluate restored");
        assert_eq!(
            restored[0].runtime_state,
            SubscriptionSwitchRuntimeState::Idle
        );
        assert_eq!(restored[0].active_target_group_id, None);
        assert_eq!(
            restored[0].last_trigger_reason,
            Some(SubscriptionSwitchTriggerReason::Restored)
        );
        assert_eq!(*source_group_for_read.lock().await, 3);
    }
}
