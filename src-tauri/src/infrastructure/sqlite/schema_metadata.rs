use std::collections::{HashMap, HashSet};

use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection};

const SCHEMA_REVISION: i64 = 7;

#[derive(Clone, Copy)]
struct ColumnDocumentation {
    name: &'static str,
    description_zh: &'static str,
}

#[derive(Clone, Copy)]
struct TableDocumentation {
    name: &'static str,
    description_zh: &'static str,
    columns: &'static [ColumnDocumentation],
}

struct MetadataEntry {
    description_zh: String,
    schema_revision: i64,
}

macro_rules! table_documentation {
    ($name:literal, $description:literal, [$(($column:literal, $column_description:literal)),+ $(,)?]) => {
        TableDocumentation {
            name: $name,
            description_zh: $description,
            columns: &[
                $(ColumnDocumentation { name: $column, description_zh: $column_description }),+
            ],
        }
    };
}

const TABLE_DOCUMENTATION: &[TableDocumentation] = &[
    table_documentation!(
        "schema_table_metadata",
        "数据库表中文说明",
        [
            ("table_name", "数据表名称"),
            ("description_zh", "数据表中文说明"),
            ("schema_revision", "结构说明版本"),
        ]
    ),
    table_documentation!(
        "schema_column_metadata",
        "数据库字段中文说明",
        [
            ("table_name", "所属数据表名称"),
            ("column_name", "字段名称"),
            ("description_zh", "字段中文说明"),
            ("schema_revision", "结构说明版本"),
        ]
    ),
    table_documentation!(
        "app_settings",
        "应用运行设置",
        [("key", "设置键"), ("value", "设置值"),]
    ),
    table_documentation!(
        "sites",
        "上游站点配置",
        [
            ("id", "站点唯一标识"),
            ("name", "站点名称"),
            ("base_url", "站点基础地址"),
            ("failover_cooldown_seconds", "站点地址故障冷却时长秒数"),
            ("max_attempts_per_address", "单次业务请求每个地址最大访问次数"),
            ("created_at", "创建时间"),
            ("updated_at", "更新时间"),
        ]
    ),
    table_documentation!(
        "site_fallback_base_urls",
        "站点备用基础地址",
        [
            ("site_id", "所属站点标识"),
            ("position", "备用地址排序位置"),
            ("base_url", "备用基础地址"),
        ]
    ),
    table_documentation!(
        "site_public_endpoint_cache",
        "站点公开接口缓存",
        [
            ("site_id", "所属站点标识"),
            ("api_base_url", "公开接口基础地址"),
            ("custom_endpoints_json", "自定义公开接口记录 JSON 数组"),
            ("fetched_at", "缓存获取时间"),
            ("last_error", "最近获取错误"),
        ]
    ),
    table_documentation!(
        "codex_radar_iq_cache",
        "模型智商雷达缓存",
        [
            ("id", "单例记录标识"),
            ("payload_json", "模型智商雷达响应快照 JSON"),
            ("source_updated_at", "上游来源标注的更新时间文本"),
            ("fetched_at", "缓存获取时间"),
            ("last_error", "最近获取错误"),
        ]
    ),
    table_documentation!(
        "codex_radar_intelligence_cache",
        "模型综合能力雷达缓存",
        [
            ("id", "单例记录标识"),
            ("payload_json", "模型综合能力雷达响应快照 JSON"),
            ("source_updated_at", "上游来源标注的更新时间文本"),
            ("fetched_at", "缓存获取时间"),
            ("last_error", "最近获取错误"),
        ]
    ),
    table_documentation!(
        "codex_radar_fast_cache",
        "模型快速雷达缓存",
        [
            ("id", "单例记录标识"),
            ("payload_json", "模型快速雷达响应快照 JSON"),
            ("source_updated_at", "上游来源标注的更新时间文本"),
            ("fetched_at", "缓存获取时间"),
            ("last_error", "最近获取错误"),
        ]
    ),
    table_documentation!(
        "codex_radar_insights_cache",
        "模型场景推荐与降智预警缓存",
        [
            ("id", "单例记录标识"),
            ("payload_json", "场景推荐与降智预警响应快照 JSON 对象"),
            ("source_updated_at", "上游来源标注的更新时间文本"),
            ("fetched_at", "缓存获取时间"),
            ("last_error", "最近获取错误"),
        ]
    ),
    table_documentation!(
        "accounts",
        "本地账号配置",
        [
            ("id", "账号唯一标识"),
            ("site_id", "所属站点标识"),
            ("label", "账号显示名称"),
            ("email", "账号邮箱"),
            ("balance_warning", "余额预警阈值; -1 表示关闭余额预警"),
            ("last_login_at", "最近登录时间"),
            ("created_at", "创建时间"),
            ("updated_at", "更新时间"),
        ]
    ),
    table_documentation!(
        "credentials",
        "账号可恢复登录凭据",
        [
            ("account_id", "所属账号标识"),
            ("email", "登录邮箱"),
            ("password", "登录密码明文"),
            ("saved_at", "凭据保存时间"),
        ]
    ),
    table_documentation!(
        "sessions",
        "账号登录会话",
        [
            ("account_id", "所属账号标识"),
            ("access_token", "访问令牌"),
            ("refresh_token", "刷新令牌"),
            ("token_type", "令牌类型"),
            ("cookie_jar_json", "会话 Cookie 集合 JSON"),
            ("saved_at", "会话保存时间"),
        ]
    ),
    table_documentation!(
        "account_key_subscription_switch_rules",
        "账号密钥订阅切换规则",
        [
            ("account_id", "所属账号标识"),
            ("key_id", "密钥标识"),
            ("source_group_id", "来源分组标识"),
            ("enabled", "规则是否启用"),
            (
                "candidate_group_ids_json",
                "候选分组标识 JSON 数组, 用于旧规则兼容"
            ),
            ("chain_nodes_json", "完整订阅切换链节点配置 JSON 数组"),
            ("auto_restore", "是否自动回切"),
            ("strict_mode", "是否启用严格优先级模式; 1=启用, 0=关闭"),
            (
                "threshold_mode",
                "源订阅节点切换阈值模式: amount_usd=金额, usage_percent=使用率"
            ),
            (
                "threshold_value",
                "源订阅节点切换阈值; 单位由阈值模式决定, 为 USD 或百分比"
            ),
            (
                "runtime_state",
                "规则运行状态: idle=待机, switched=已切换, failed=失败"
            ),
            ("active_target_group_id", "当前目标分组标识"),
            ("last_trigger_reason", "最近触发原因"),
            ("last_switched_at", "最近切换时间"),
            ("last_restored_at", "最近回切时间"),
            ("last_error", "最近执行错误"),
            ("updated_at", "规则更新时间"),
        ]
    ),
    table_documentation!(
        "usage_notification_outbox",
        "用量通知待确认队列",
        [
            ("sequence", "通知队列顺序"),
            ("account_id", "所属账号标识"),
            ("id", "通知唯一标识"),
            ("dedupe_key", "通知去重键"),
            ("payload_json", "用量通知载荷 JSON"),
            ("created_at", "通知创建时间"),
        ]
    ),
    table_documentation!(
        "subscription_quota_alert_subjects",
        "订阅额度提醒对象身份映射",
        [
            ("subject_id", "额度提醒对象内部唯一标识"),
            ("account_id", "所属账号标识"),
            ("subscription_key", "账号内当前订阅身份键"),
            (
                "identity_kind",
                "订阅身份类型: group=分组, upstream=上游标识, fallback=稳定回退标识"
            ),
            ("group_id", "可选的上游订阅分组标识"),
            ("upstream_subscription_id", "可选的上游订阅原始标识"),
            ("fallback_identity", "可选的版本化订阅回退身份"),
            ("name_snapshot", "最近观察到的订阅名称"),
            ("platform_snapshot", "最近观察到的订阅平台"),
            ("created_at", "提醒对象创建时间"),
            ("updated_at", "提醒对象更新时间"),
        ]
    ),
    table_documentation!(
        "subscription_quota_alert_configs",
        "订阅额度提醒自定义配置",
        [
            ("subject_id", "关联的额度提醒对象标识"),
            ("enabled", "额度提醒是否启用"),
            (
                "threshold_mode",
                "提醒阈值模式: amount_usd=已用金额, usage_percent=已用百分比"
            ),
            ("threshold_value", "提醒阈值, 单位为 USD 或百分比"),
            ("revision", "有效配置变更版本"),
            ("created_at", "自定义配置创建时间"),
            ("updated_at", "自定义配置更新时间"),
        ]
    ),
    table_documentation!(
        "subscription_quota_alert_window_states",
        "订阅额度窗口提醒触发状态",
        [
            ("subject_id", "关联的额度提醒对象标识"),
            ("window_kind", "额度窗口类型: daily=每日, weekly=每周, monthly=每月"),
            ("config_revision", "本状态对应的有效配置版本"),
            ("period_key", "上游提供的非空额度周期起点"),
            ("state", "窗口触发状态: armed=待命, triggered=已触发"),
            ("trigger_sequence", "该窗口累计触发序号"),
            ("last_current", "最近一次有效已用额度"),
            ("last_limit", "最近一次有效额度上限"),
            ("last_event_id", "最近一次关联提醒事件标识"),
            ("last_evaluated_at", "最近一次有效求值时间"),
            ("updated_at", "窗口状态更新时间"),
        ]
    ),
    table_documentation!(
        "subscription_quota_alert_events",
        "订阅额度提醒双通道投递事件",
        [
            ("id", "额度提醒事件唯一标识"),
            ("subject_id", "关联的额度提醒对象标识"),
            ("dedupe_key", "跨通道稳定事件去重键"),
            ("config_revision", "事件触发时的有效配置版本"),
            ("triggered_windows_json", "本次触发额度窗口快照 JSON 数组"),
            ("payload_json", "额度提醒完整载荷 JSON 对象"),
            (
                "business_status",
                "应用内消息投递状态: pending=待投递, delivering=投递中, sent=成功, unsupported=不支持"
            ),
            (
                "windows_status",
                "Windows 通知投递状态: pending=待投递, delivering=投递中, sent=成功, unsupported=不支持"
            ),
            ("business_attempts", "应用内消息投递尝试次数"),
            ("windows_attempts", "Windows 通知投递尝试次数"),
            ("business_next_attempt_at", "应用内消息下次允许重试时间"),
            ("windows_next_attempt_at", "Windows 通知下次允许重试时间"),
            ("business_lease_id", "应用内消息当前投递租约标识"),
            ("windows_lease_id", "Windows 通知当前投递租约标识"),
            ("business_lease_until", "应用内消息投递租约到期时间"),
            ("windows_lease_until", "Windows 通知投递租约到期时间"),
            ("business_last_error", "应用内消息最近投递错误"),
            ("windows_last_error", "Windows 通知最近投递错误"),
            ("created_at", "提醒事件创建时间"),
            ("business_sent_at", "应用内消息成功投递时间"),
            ("windows_sent_at", "Windows 通知成功投递时间"),
            ("completed_at", "全部可用通道完成时间"),
            ("updated_at", "提醒事件更新时间"),
        ]
    ),
    table_documentation!(
        "account_usage_history_states",
        "账号用量历史同步检查点",
        [
            ("account_id", "所属账号标识"),
            (
                "state",
                "历史同步状态: pending=待处理, backfilling=回填中, needs_audit=待审计, converged=已收敛, degraded=已降级"
            ),
            ("earliest_date", "已发现最早业务日期"),
            ("completed_through_date", "已完成同步截止日期"),
            ("active_date", "当前处理业务日期"),
            ("audit_cursor_date", "历史审计游标日期"),
            ("recent_reconciled_at", "近期数据核对时间"),
            (
                "last_startup_recent_four_day_read_date",
                "最近完成启动近四日用量读取的日期, 格式 YYYY-MM-DD"
            ),
            ("heartbeat_at", "同步心跳时间"),
            ("last_error", "最近同步错误"),
            ("updated_at", "检查点更新时间"),
        ]
    ),
    table_documentation!(
        "account_usage_daily_rollup",
        "账号用量每日汇总",
        [
            ("account_id", "所属账号标识"),
            ("usage_date", "用量业务日期"),
            ("model", "调用模型名称"),
            ("platform", "调用平台"),
            ("requests", "请求次数"),
            ("input_tokens", "输入 Token 总数"),
            ("output_tokens", "输出 Token 总数"),
            ("cache_creation_tokens", "缓存创建 Token 总数"),
            ("cache_read_tokens", "缓存读取 Token 总数"),
            ("total_cost", "标准总费用合计"),
            ("actual_cost", "实际结算费用合计"),
            ("duration_ms_sum", "请求耗时毫秒合计"),
            ("duration_ms_count", "耗时有效样本数"),
        ]
    ),
    table_documentation!(
        "account_usage_row_cache",
        "账号用量明细缓存",
        [
            ("account_id", "所属账号标识"),
            ("usage_id", "上游用量记录标识"),
            ("api_key_id", "上游密钥数值标识"),
            ("upstream_user_id", "上游用户标识"),
            ("upstream_account_id", "上游账号标识"),
            ("request_id", "上游请求标识"),
            ("model", "调用模型名称"),
            ("reasoning_effort", "推理强度"),
            ("endpoint", "本地请求端点"),
            ("upstream_endpoint", "上游请求端点"),
            ("group_id", "分组标识"),
            ("subscription_id", "订阅标识"),
            ("input_tokens", "输入 Token 数"),
            ("output_tokens", "输出 Token 数"),
            ("cache_creation_tokens", "缓存创建 Token 数"),
            ("cache_read_tokens", "缓存读取 Token 数"),
            ("cache_creation_5m_tokens", "五分钟缓存创建 Token 数"),
            ("cache_creation_1h_tokens", "一小时缓存创建 Token 数"),
            ("input_cost", "输入标准费用"),
            ("output_cost", "输出标准费用"),
            ("cache_creation_cost", "缓存创建费用"),
            ("cache_read_cost", "缓存读取费用"),
            ("total_cost", "标准总费用"),
            ("actual_cost", "实际结算费用"),
            ("rate_multiplier", "费率倍率"),
            ("billing_type", "上游计费类型数值编码"),
            ("service_tier", "服务档位"),
            ("long_context_billing_applied", "是否应用长上下文计费"),
            ("request_type", "请求类型"),
            ("stream", "是否流式请求"),
            ("openai_ws_mode", "是否使用 OpenAI WebSocket 模式"),
            ("duration_ms", "请求总耗时毫秒"),
            ("first_token_ms", "首个 Token 耗时毫秒"),
            ("image_count", "图片数量"),
            ("image_input_tokens", "图片输入 Token 数"),
            ("image_size", "图片尺寸"),
            ("image_input_size", "输入图片尺寸"),
            ("image_output_size", "输出图片尺寸"),
            ("image_output_tokens", "图片输出 Token 数"),
            ("image_input_cost", "图片输入费用"),
            ("image_output_cost", "图片输出费用"),
            ("image_size_source", "图片尺寸来源"),
            ("image_size_breakdown", "图片尺寸数量分布 JSON"),
            ("media_type", "媒体类型"),
            ("user_agent", "客户端标识"),
            ("ip_address", "请求 IP 地址"),
            ("cache_ttl_overridden", "是否覆盖缓存有效期"),
            ("billing_mode", "计费模式"),
            ("platform", "调用平台"),
            ("api_key_name", "密钥名称"),
            ("group_name", "分组名称"),
            ("subscription_name", "订阅名称"),
            ("subscription_type", "订阅类型"),
            ("occurred_at", "用量发生时间"),
            ("updated_at", "上游记录更新时间"),
            ("first_seen_at", "本地首次发现时间"),
            ("last_seen_at", "本地最近发现时间"),
        ]
    ),
    table_documentation!(
        "account_usage_user_agent_fts",
        "账号用量 User-Agent 全文检索索引",
        [("user_agent", "用于 Token 和前缀匹配的 User-Agent 索引文本")]
    ),
];

pub(super) fn sync(conn: &mut Connection) -> Result<()> {
    validate_manifest()?;
    let transaction = conn.transaction().context("无法开始结构元数据事务")?;
    transaction.execute("DELETE FROM schema_column_metadata", [])?;
    transaction.execute("DELETE FROM schema_table_metadata", [])?;
    for table in TABLE_DOCUMENTATION {
        transaction.execute(
            "INSERT INTO schema_table_metadata (table_name, description_zh, schema_revision)
             VALUES (?1, ?2, ?3)",
            params![table.name, table.description_zh, SCHEMA_REVISION],
        )?;
        for column in table.columns {
            transaction.execute(
                "INSERT INTO schema_column_metadata
                   (table_name, column_name, description_zh, schema_revision)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    table.name,
                    column.name,
                    column.description_zh,
                    SCHEMA_REVISION
                ],
            )?;
        }
    }
    transaction.commit().context("无法提交结构元数据事务")?;
    Ok(())
}

pub(super) fn verify(conn: &Connection, strict: bool) -> Result<()> {
    validate_manifest()?;
    let expected_tables = TABLE_DOCUMENTATION
        .iter()
        .map(|table| table.name.to_string())
        .collect::<HashSet<_>>();
    let actual_tables = load_actual_tables(conn)?;
    if strict && actual_tables != expected_tables {
        bail!(
            "数据库现役表集合与结构说明不一致: 期望 {:?}, 实际 {:?}",
            expected_tables,
            actual_tables
        );
    }
    if !expected_tables.is_subset(&actual_tables) {
        bail!("数据库缺少已登记中文说明的现役表。");
    }

    let metadata_tables = load_table_metadata(conn)?;
    if metadata_tables.keys().cloned().collect::<HashSet<_>>() != expected_tables {
        bail!("schema_table_metadata 与现役表集合不一致。");
    }
    let metadata_columns = load_column_metadata(conn)?;

    let mut expected_columns = HashSet::new();
    for table in TABLE_DOCUMENTATION {
        let actual_columns = load_actual_columns(conn, table.name)?;
        let documented_columns = table
            .columns
            .iter()
            .map(|column| column.name.to_string())
            .collect::<HashSet<_>>();
        if actual_columns != documented_columns {
            bail!("表 {} 的实际字段与中文说明字段不一致。", table.name);
        }
        for column in table.columns {
            expected_columns.insert((table.name.to_string(), column.name.to_string()));
        }
    }
    if metadata_columns.keys().cloned().collect::<HashSet<_>>() != expected_columns {
        bail!("schema_column_metadata 与现役字段集合不一致。");
    }

    for metadata in metadata_tables.values().chain(metadata_columns.values()) {
        if metadata.schema_revision != SCHEMA_REVISION {
            bail!(
                "数据库结构说明版本不一致: 期望 {}, 实际 {}。",
                SCHEMA_REVISION,
                metadata.schema_revision
            );
        }
        if !is_human_readable_chinese(&metadata.description_zh) {
            bail!("数据库结构说明必须是非空中文文案。");
        }
    }
    Ok(())
}

fn validate_manifest() -> Result<()> {
    let mut tables = HashSet::new();
    let mut columns = HashSet::new();
    for table in TABLE_DOCUMENTATION {
        if !tables.insert(table.name) {
            bail!("结构说明重复登记数据表 {}。", table.name);
        }
        if !is_human_readable_chinese(table.description_zh) {
            bail!("数据表 {} 缺少可读中文说明。", table.name);
        }
        for column in table.columns {
            if !columns.insert((table.name, column.name)) {
                bail!("结构说明重复登记字段 {}.{}。", table.name, column.name);
            }
            if !is_human_readable_chinese(column.description_zh) {
                bail!("字段 {}.{} 缺少可读中文说明。", table.name, column.name);
            }
        }
    }
    Ok(())
}

fn load_actual_tables(conn: &Connection) -> Result<HashSet<String>> {
    let mut stmt = conn.prepare(
        "SELECT name FROM pragma_table_list
         WHERE schema = 'main'
           AND type IN ('table', 'virtual')
           AND name NOT LIKE 'sqlite_%'",
    )?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    let mut values = HashSet::new();
    for row in rows {
        values.insert(row?);
    }
    Ok(values)
}

fn load_actual_columns(conn: &Connection, table_name: &str) -> Result<HashSet<String>> {
    let escaped = table_name.replace('"', "\"\"");
    let mut stmt = conn.prepare(&format!("PRAGMA table_info(\"{escaped}\")"))?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
    let mut values = HashSet::new();
    for row in rows {
        values.insert(row?);
    }
    Ok(values)
}

fn load_table_metadata(conn: &Connection) -> Result<HashMap<String, MetadataEntry>> {
    let mut stmt = conn
        .prepare("SELECT table_name, description_zh, schema_revision FROM schema_table_metadata")?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get(0)?,
            MetadataEntry {
                description_zh: row.get(1)?,
                schema_revision: row.get(2)?,
            },
        ))
    })?;
    let mut values = HashMap::new();
    for row in rows {
        let (name, metadata) = row?;
        if values.insert(name, metadata).is_some() {
            bail!("schema_table_metadata 存在重复表说明。");
        }
    }
    Ok(values)
}

fn load_column_metadata(conn: &Connection) -> Result<HashMap<(String, String), MetadataEntry>> {
    let mut stmt = conn.prepare(
        "SELECT table_name, column_name, description_zh, schema_revision
         FROM schema_column_metadata",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            (row.get(0)?, row.get(1)?),
            MetadataEntry {
                description_zh: row.get(2)?,
                schema_revision: row.get(3)?,
            },
        ))
    })?;
    let mut values = HashMap::new();
    for row in rows {
        let (key, metadata) = row?;
        if values.insert(key, metadata).is_some() {
            bail!("schema_column_metadata 存在重复字段说明。");
        }
    }
    Ok(values)
}

fn is_human_readable_chinese(value: &str) -> bool {
    !value.trim().is_empty()
        && value
            .chars()
            .any(|character| ('\u{4e00}'..='\u{9fff}').contains(&character))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 返回清单中的指定字段说明，字段名称写错时立即终止测试。
    fn column_description(table_name: &str, column_name: &str) -> &'static str {
        let table = TABLE_DOCUMENTATION
            .iter()
            .find(|table| table.name == table_name)
            .unwrap_or_else(|| panic!("missing table documentation for {table_name}"));
        table
            .columns
            .iter()
            .find(|column| column.name == column_name)
            .unwrap_or_else(|| {
                panic!("missing column documentation for {table_name}.{column_name}")
            })
            .description_zh
    }

    /// 断言字段说明包含当前存储契约不可缺少的语义片段。
    fn assert_column_description_contains(
        table_name: &str,
        column_name: &str,
        required_fragments: &[&str],
    ) {
        let description = column_description(table_name, column_name);
        for fragment in required_fragments {
            assert!(
                description.contains(*fragment),
                "{table_name}.{column_name} description must contain {fragment:?}: {description}"
            );
        }
    }

    /// 严格比对数据库中的说明、版本和清单，防止同步后仍保留旧文案。
    fn assert_persisted_metadata_matches_manifest(conn: &Connection) {
        verify(conn, true).expect("verify persisted schema documentation");

        let table_metadata = load_table_metadata(conn).expect("load persisted table metadata");
        let column_metadata = load_column_metadata(conn).expect("load persisted column metadata");
        let expected_column_count = TABLE_DOCUMENTATION
            .iter()
            .map(|table| table.columns.len())
            .sum::<usize>();

        assert_eq!(table_metadata.len(), TABLE_DOCUMENTATION.len());
        assert_eq!(column_metadata.len(), expected_column_count);

        for table in TABLE_DOCUMENTATION {
            let persisted_table = table_metadata
                .get(table.name)
                .unwrap_or_else(|| panic!("missing persisted metadata for {}", table.name));
            assert_eq!(persisted_table.description_zh, table.description_zh);
            assert_eq!(persisted_table.schema_revision, SCHEMA_REVISION);

            for column in table.columns {
                let key = (table.name.to_string(), column.name.to_string());
                let persisted_column = column_metadata.get(&key).unwrap_or_else(|| {
                    panic!(
                        "missing persisted metadata for {}.{}",
                        table.name, column.name
                    )
                });
                assert_eq!(persisted_column.description_zh, column.description_zh);
                assert_eq!(persisted_column.schema_revision, SCHEMA_REVISION);
            }
        }
    }

    #[test]
    fn manifest_has_unique_human_readable_descriptions() {
        validate_manifest().expect("validate schema documentation manifest");
    }

    #[test]
    fn json_storage_fields_explicitly_document_their_format() {
        for table in TABLE_DOCUMENTATION {
            for column in table.columns {
                if column.name.ends_with("_json") {
                    assert!(
                        column.description_zh.contains("JSON"),
                        "{}.{} must explicitly document JSON storage: {}",
                        table.name,
                        column.name,
                        column.description_zh
                    );
                }
            }
        }

        assert_column_description_contains(
            "account_usage_row_cache",
            "image_size_breakdown",
            &["JSON"],
        );
    }

    #[test]
    fn known_json_value_shapes_are_documented() {
        let cases: &[(&str, &str, &[&str])] = &[
            (
                "site_public_endpoint_cache",
                "custom_endpoints_json",
                &["JSON", "数组"],
            ),
            (
                "codex_radar_iq_cache",
                "payload_json",
                &["响应快照", "JSON"],
            ),
            (
                "codex_radar_intelligence_cache",
                "payload_json",
                &["响应快照", "JSON"],
            ),
            (
                "codex_radar_fast_cache",
                "payload_json",
                &["响应快照", "JSON"],
            ),
            (
                "codex_radar_insights_cache",
                "payload_json",
                &["响应快照", "JSON", "对象"],
            ),
            ("sessions", "cookie_jar_json", &["Cookie", "集合", "JSON"]),
            (
                "account_key_subscription_switch_rules",
                "candidate_group_ids_json",
                &["JSON", "数组", "旧规则兼容"],
            ),
            (
                "account_key_subscription_switch_rules",
                "chain_nodes_json",
                &["完整", "JSON", "数组"],
            ),
            (
                "usage_notification_outbox",
                "payload_json",
                &["载荷", "JSON"],
            ),
            (
                "account_usage_row_cache",
                "image_size_breakdown",
                &["分布", "JSON"],
            ),
        ];

        for (table_name, column_name, required_fragments) in cases {
            assert_column_description_contains(table_name, column_name, required_fragments);
        }
    }

    #[test]
    fn key_sentinel_enum_unit_and_date_semantics_are_documented() {
        let cases: &[(&str, &str, &[&str])] = &[
            ("accounts", "balance_warning", &["-1", "关闭"]),
            (
                "account_key_subscription_switch_rules",
                "threshold_mode",
                &["amount_usd", "usage_percent"],
            ),
            (
                "account_key_subscription_switch_rules",
                "threshold_value",
                &["USD", "百分比"],
            ),
            (
                "account_key_subscription_switch_rules",
                "runtime_state",
                &["idle", "switched", "failed"],
            ),
            (
                "account_usage_history_states",
                "state",
                &[
                    "pending",
                    "backfilling",
                    "needs_audit",
                    "converged",
                    "degraded",
                ],
            ),
            (
                "account_usage_history_states",
                "last_startup_recent_four_day_read_date",
                &["启动近四日", "YYYY-MM-DD"],
            ),
            (
                "account_usage_row_cache",
                "billing_type",
                &["上游", "数值编码"],
            ),
        ];

        for (table_name, column_name, required_fragments) in cases {
            assert_column_description_contains(table_name, column_name, required_fragments);
        }

        for table_name in [
            "codex_radar_iq_cache",
            "codex_radar_intelligence_cache",
            "codex_radar_fast_cache",
            "codex_radar_insights_cache",
        ] {
            assert_column_description_contains(table_name, "source_updated_at", &["上游", "文本"]);
        }
    }

    #[test]
    fn new_database_persists_the_current_documentation_manifest() {
        let mut conn = Connection::open_in_memory().expect("open new sqlite database");

        crate::infrastructure::sqlite::schema::apply(&mut conn)
            .expect("initialize schema and documentation");

        assert_persisted_metadata_matches_manifest(&conn);
    }

    #[test]
    fn existing_database_refreshes_stale_documentation_manifest() {
        let mut conn = Connection::open_in_memory().expect("open existing sqlite database");
        crate::infrastructure::sqlite::schema::apply(&mut conn)
            .expect("initialize existing schema fixture");
        let previous_revision = SCHEMA_REVISION - 1;
        conn.execute(
            "UPDATE schema_table_metadata
             SET description_zh = '旧版数据表说明', schema_revision = ?1",
            [previous_revision],
        )
        .expect("downgrade table documentation fixture");
        conn.execute(
            "UPDATE schema_column_metadata
             SET description_zh = '旧版字段说明', schema_revision = ?1",
            [previous_revision],
        )
        .expect("downgrade column documentation fixture");

        crate::infrastructure::sqlite::schema::apply(&mut conn)
            .expect("refresh stale schema documentation");

        assert_persisted_metadata_matches_manifest(&conn);
        let stale_entry_count = conn
            .query_row(
                "SELECT
                   (SELECT COUNT(*) FROM schema_table_metadata
                    WHERE description_zh = '旧版数据表说明')
                   +
                   (SELECT COUNT(*) FROM schema_column_metadata
                    WHERE description_zh = '旧版字段说明')",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("count stale documentation entries");
        assert_eq!(stale_entry_count, 0);
    }

    #[test]
    fn verification_rejects_metadata_revision_drift() {
        let mut conn = Connection::open_in_memory().expect("open sqlite");
        crate::infrastructure::sqlite::schema::apply(&mut conn).expect("create current schema");
        conn.execute(
            "UPDATE schema_table_metadata SET schema_revision = 999 WHERE table_name = 'sites'",
            [],
        )
        .expect("drift metadata revision");

        let error = verify(&conn, true).expect_err("revision drift should fail verification");

        assert!(error.to_string().contains("结构说明版本不一致"));
    }

    #[test]
    fn verification_rejects_missing_and_stale_metadata_entries() {
        let mut missing_conn = Connection::open_in_memory().expect("open missing metadata sqlite");
        crate::infrastructure::sqlite::schema::apply(&mut missing_conn)
            .expect("create schema for missing metadata");
        missing_conn
            .execute(
                "DELETE FROM schema_column_metadata
                 WHERE table_name = 'sites' AND column_name = 'name'",
                [],
            )
            .expect("remove one column description");
        let missing_error = verify(&missing_conn, true)
            .expect_err("missing column metadata should fail verification");
        assert!(missing_error
            .to_string()
            .contains("schema_column_metadata 与现役字段集合不一致"));

        let mut stale_conn = Connection::open_in_memory().expect("open stale metadata sqlite");
        crate::infrastructure::sqlite::schema::apply(&mut stale_conn)
            .expect("create schema for stale metadata");
        stale_conn
            .execute(
                "INSERT INTO schema_table_metadata
                   (table_name, description_zh, schema_revision)
                 VALUES ('stale_table', '过期数据表说明', ?1)",
                [SCHEMA_REVISION],
            )
            .expect("insert stale table description");
        let stale_error =
            verify(&stale_conn, true).expect_err("stale table metadata should fail verification");
        assert!(stale_error
            .to_string()
            .contains("schema_table_metadata 与现役表集合不一致"));
    }

    #[test]
    fn verification_rejects_non_chinese_metadata_description() {
        let mut conn = Connection::open_in_memory().expect("open sqlite");
        crate::infrastructure::sqlite::schema::apply(&mut conn)
            .expect("create schema for unreadable metadata");
        conn.execute(
            "UPDATE schema_table_metadata
             SET description_zh = 'plain english'
             WHERE table_name = 'sites'",
            [],
        )
        .expect("replace table description");

        let error = verify(&conn, true).expect_err("non-Chinese metadata should fail verification");

        assert!(error.to_string().contains("必须是非空中文文案"));
    }
}
