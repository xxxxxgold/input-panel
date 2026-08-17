use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, Context, Result};
use rusqlite::{
    params, Connection, ErrorCode, OptionalExtension, Transaction, TransactionBehavior,
};

pub const DEFAULT_SITE_REQUESTS_PER_SECOND: u32 = 3;
pub const DEFAULT_SITE_MAX_IN_FLIGHT: u32 = 3;
pub const DEFAULT_USAGE_PAGE_MAX_IN_FLIGHT: u32 = 6;
pub const MIN_SITE_REQUESTS_PER_SECOND: u32 = 1;
pub const MAX_SITE_REQUESTS_PER_SECOND: u32 = 10;
pub const MIN_SITE_MAX_IN_FLIGHT: u32 = 1;
pub const MAX_SITE_MAX_IN_FLIGHT: u32 = 8;
pub const MIN_USAGE_PAGE_MAX_IN_FLIGHT: u32 = 1;
pub const MAX_USAGE_PAGE_MAX_IN_FLIGHT: u32 = 16;

pub const RUNTIME_HEARTBEAT_INTERVAL_MS: i64 = 2_000;
pub const RUNTIME_STALE_AFTER_MS: i64 = 30_000;
pub const ACCOUNT_LEASE_TTL_MS: i64 = 8_000;
pub const REQUEST_PERMIT_TTL_MS: i64 = 20_000;
pub const DEMAND_AGING_AFTER_MS: i64 = 8_000;
pub const ACCOUNT_DEMAND_TTL_MS: i64 = 60_000;
pub const REQUEST_DEMAND_TTL_MS: i64 = 120_000;
pub const USAGE_PAGE_ENDPOINT_FAMILY: &str = "usage_page";
pub const SITE_FAILOVER_LEASE_TTL_MS: i64 = 20_000;

const REQUEST_QUEUE_MAX_WAIT_MS: i64 = 30_000;
const REQUEST_QUEUE_POLL_MAX_MS: u64 = 500;
const SQLITE_BUSY_TIMEOUT_MS: u64 = 250;
const SQLITE_BUSY_RETRY_COUNT: usize = 3;
const SQLITE_BUSY_RETRY_MIN_MS: u64 = 20;
const SQLITE_BUSY_RETRY_JITTER_MS: u64 = 30;
const COORDINATION_SALT_KEY: &str = "coordination_salt";
const LOGICAL_CLOCK_KEY: &str = "logical_clock_ms";
const SITE_FAILOVER_TRANSITION_RETENTION: i64 = 512;
const SITE_FAILOVER_STATE_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SiteRequestClass {
    Interactive,
    Auth,
    Write,
    FreshUsage,
    Subscriptions,
    HistoryMaintenance,
}

impl SiteRequestClass {
    fn as_str(self) -> &'static str {
        match self {
            Self::Interactive => "interactive",
            Self::Auth => "auth",
            Self::Write => "write",
            Self::FreshUsage => "fresh_usage",
            Self::Subscriptions => "subscriptions",
            Self::HistoryMaintenance => "history_maintenance",
        }
    }

    fn priority(self) -> i64 {
        match self {
            Self::Interactive | Self::Auth | Self::Write => 400,
            Self::FreshUsage => 300,
            Self::Subscriptions => 200,
            Self::HistoryMaintenance => 100,
        }
    }
}

const COORDINATION_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS coordination_metadata (
  key TEXT PRIMARY KEY,
  value BLOB NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS coordination_config (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  site_requests_per_second INTEGER NOT NULL,
  site_max_in_flight INTEGER NOT NULL,
  usage_page_max_in_flight INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS upstream_network_config (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  use_system_proxy INTEGER NOT NULL CHECK (use_system_proxy IN (0, 1)),
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_instances (
  instance_id TEXT PRIMARY KEY,
  runtime_scope TEXT NOT NULL,
  pid INTEGER NOT NULL,
  started_at_ms INTEGER NOT NULL,
  heartbeat_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS account_sync_demands (
  demand_id TEXT PRIMARY KEY,
  account_key BLOB NOT NULL,
  instance_id TEXT NOT NULL,
  work_kind TEXT NOT NULL,
  priority INTEGER NOT NULL,
  enqueued_at_ms INTEGER NOT NULL,
  not_before_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  UNIQUE (account_key, instance_id, work_kind),
  FOREIGN KEY (instance_id) REFERENCES runtime_instances(instance_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS account_sync_leases (
  account_key BLOB PRIMARY KEY,
  demand_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  work_kind TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  priority INTEGER NOT NULL,
  acquired_at_ms INTEGER NOT NULL,
  heartbeat_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  FOREIGN KEY (instance_id) REFERENCES runtime_instances(instance_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS site_request_schedule (
  site_key BLOB PRIMARY KEY,
  next_allowed_at_ms INTEGER NOT NULL,
  cooldown_until_ms INTEGER NOT NULL,
  cooldown_revision INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS site_request_demands (
  request_id TEXT PRIMARY KEY,
  site_key BLOB NOT NULL,
  instance_id TEXT NOT NULL,
  endpoint_family TEXT NOT NULL,
  request_class TEXT NOT NULL,
  priority INTEGER NOT NULL,
  enqueued_at_ms INTEGER NOT NULL,
  not_before_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  FOREIGN KEY (instance_id) REFERENCES runtime_instances(instance_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS site_request_leases (
  request_id TEXT PRIMARY KEY,
  site_key BLOB NOT NULL,
  instance_id TEXT NOT NULL,
  endpoint_family TEXT NOT NULL,
  permit_token TEXT NOT NULL,
  acquired_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  FOREIGN KEY (instance_id) REFERENCES runtime_instances(instance_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS site_failover_states (
  site_key BLOB NOT NULL,
  topology_key BLOB NOT NULL,
  primary_address_key BLOB NOT NULL,
  active_address_key BLOB NOT NULL,
  evaluation_revision INTEGER NOT NULL DEFAULT 0,
  transition_revision INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (site_key, topology_key)
);

CREATE TABLE IF NOT EXISTS site_failover_address_states (
  site_key BLOB NOT NULL,
  topology_key BLOB NOT NULL,
  address_key BLOB NOT NULL,
  cooldown_until_ms INTEGER NOT NULL DEFAULT 0,
  cooldown_revision INTEGER NOT NULL DEFAULT 0,
  probe_required INTEGER NOT NULL DEFAULT 1,
  last_failure_category TEXT NULL,
  last_http_status INTEGER NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (site_key, topology_key, address_key),
  FOREIGN KEY (site_key, topology_key)
    REFERENCES site_failover_states(site_key, topology_key) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS site_failover_leases (
  site_key BLOB NOT NULL,
  topology_key BLOB NOT NULL,
  instance_id TEXT NOT NULL REFERENCES runtime_instances(instance_id) ON DELETE CASCADE,
  lease_token TEXT NOT NULL,
  observed_evaluation_revision INTEGER NOT NULL,
  acquired_at_ms INTEGER NOT NULL,
  heartbeat_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY (site_key, topology_key)
);

CREATE TABLE IF NOT EXISTS site_failover_transitions (
  revision INTEGER PRIMARY KEY AUTOINCREMENT,
  site_key BLOB NOT NULL,
  topology_key BLOB NOT NULL,
  from_address_key BLOB NOT NULL,
  to_address_key BLOB NOT NULL,
  kind TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_account_sync_demands_fairness
  ON account_sync_demands (account_key, priority DESC, enqueued_at_ms ASC);
CREATE INDEX IF NOT EXISTS idx_site_request_demands_fairness
  ON site_request_demands (site_key, priority DESC, enqueued_at_ms ASC);
CREATE INDEX IF NOT EXISTS idx_site_request_leases_limits
  ON site_request_leases (site_key, expires_at_ms, endpoint_family);
CREATE INDEX IF NOT EXISTS idx_site_failover_address_cooldowns
  ON site_failover_address_states (site_key, topology_key, cooldown_until_ms);
CREATE INDEX IF NOT EXISTS idx_site_failover_leases_expiration
  ON site_failover_leases (expires_at_ms);
CREATE INDEX IF NOT EXISTS idx_site_failover_state_cleanup
  ON site_failover_states (updated_at_ms);
"#;

pub type CoordinationKey = [u8; 32];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SharedRuntimeCoordinationConfig {
    pub site_requests_per_second: u32,
    pub site_max_in_flight: u32,
    pub usage_page_max_in_flight: u32,
}

impl Default for SharedRuntimeCoordinationConfig {
    fn default() -> Self {
        Self {
            site_requests_per_second: DEFAULT_SITE_REQUESTS_PER_SECOND,
            site_max_in_flight: DEFAULT_SITE_MAX_IN_FLIGHT,
            usage_page_max_in_flight: DEFAULT_USAGE_PAGE_MAX_IN_FLIGHT,
        }
    }
}

impl SharedRuntimeCoordinationConfig {
    pub fn validate(self) -> Result<Self> {
        if !(MIN_SITE_REQUESTS_PER_SECOND..=MAX_SITE_REQUESTS_PER_SECOND)
            .contains(&self.site_requests_per_second)
        {
            bail!(
                "站点每秒请求数必须在 {MIN_SITE_REQUESTS_PER_SECOND} 到 {MAX_SITE_REQUESTS_PER_SECOND} 之间。"
            );
        }
        if !(MIN_SITE_MAX_IN_FLIGHT..=MAX_SITE_MAX_IN_FLIGHT).contains(&self.site_max_in_flight) {
            bail!(
                "站点并发请求数必须在 {MIN_SITE_MAX_IN_FLIGHT} 到 {MAX_SITE_MAX_IN_FLIGHT} 之间。"
            );
        }
        if !(MIN_USAGE_PAGE_MAX_IN_FLIGHT..=MAX_USAGE_PAGE_MAX_IN_FLIGHT)
            .contains(&self.usage_page_max_in_flight)
        {
            bail!(
                "Usage 分页并发数必须在 {MIN_USAGE_PAGE_MAX_IN_FLIGHT} 到 {MAX_USAGE_PAGE_MAX_IN_FLIGHT} 之间。"
            );
        }
        Ok(self)
    }
}

/// Web 与 Desktop 共用的外部上游网络模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UpstreamNetworkConfig {
    pub use_system_proxy: bool,
}

impl Default for UpstreamNetworkConfig {
    fn default() -> Self {
        Self {
            use_system_proxy: false,
        }
    }
}

#[derive(Debug, Clone)]
pub struct RuntimeInstanceRegistration {
    pub instance_id: String,
    pub runtime_scope: String,
    pub pid: u32,
    pub started_at_ms: i64,
}

#[derive(Debug, Clone)]
pub struct NewAccountSyncDemand {
    pub demand_id: String,
    pub account_key: CoordinationKey,
    pub instance_id: String,
    pub work_kind: String,
    pub priority: i64,
    pub not_before_ms: i64,
    pub expires_at_ms: i64,
}

#[derive(Clone)]
pub struct AccountSyncLease {
    pub account_key: CoordinationKey,
    pub demand_id: String,
    pub instance_id: String,
    pub work_kind: String,
    pub lease_token: String,
    pub priority: i64,
    pub acquired_at_ms: i64,
    pub expires_at_ms: i64,
}

#[derive(Clone)]
pub struct AccountSyncLeaseGrant {
    pub lease: AccountSyncLease,
    pub work_kinds: Vec<String>,
}

impl std::fmt::Debug for AccountSyncLeaseGrant {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AccountSyncLeaseGrant")
            .field("lease", &self.lease)
            .field("work_kinds", &self.work_kinds)
            .finish()
    }
}

impl std::fmt::Debug for AccountSyncLease {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AccountSyncLease")
            .field("demand_id", &self.demand_id)
            .field("instance_id", &self.instance_id)
            .field("work_kind", &self.work_kind)
            .field("priority", &self.priority)
            .field("acquired_at_ms", &self.acquired_at_ms)
            .field("expires_at_ms", &self.expires_at_ms)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone)]
pub struct NewSiteRequestDemand {
    pub request_id: String,
    pub site_key: CoordinationKey,
    pub instance_id: String,
    pub endpoint_family: String,
    pub request_class: String,
    pub priority: i64,
    pub not_before_ms: i64,
    pub expires_at_ms: i64,
}

#[derive(Clone)]
pub struct SiteRequestPermit {
    pub request_id: String,
    pub site_key: CoordinationKey,
    pub instance_id: String,
    pub endpoint_family: String,
    pub permit_token: String,
    pub acquired_at_ms: i64,
    pub expires_at_ms: i64,
}

impl std::fmt::Debug for SiteRequestPermit {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SiteRequestPermit")
            .field("request_id", &self.request_id)
            .field("instance_id", &self.instance_id)
            .field("endpoint_family", &self.endpoint_family)
            .field("acquired_at_ms", &self.acquired_at_ms)
            .field("expires_at_ms", &self.expires_at_ms)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoordinationDecision<T> {
    Acquired(T),
    Waiting { wait_ms: u64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SiteCooldownState {
    pub cooldown_until_ms: i64,
    pub revision: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SiteFailoverTopology {
    pub site_key: CoordinationKey,
    pub topology_key: CoordinationKey,
    pub primary_address_key: CoordinationKey,
    pub address_keys: Vec<CoordinationKey>,
}

impl SiteFailoverTopology {
    fn validate(&self) -> Result<()> {
        if self.address_keys.is_empty()
            || self.address_keys.first() != Some(&self.primary_address_key)
        {
            bail!("站点故障转移拓扑必须以主地址开始。")
        }
        let unique = self
            .address_keys
            .iter()
            .copied()
            .collect::<std::collections::HashSet<_>>();
        if unique.len() != self.address_keys.len() {
            bail!("站点故障转移拓扑包含重复地址。")
        }
        Ok(())
    }

    pub fn contains_address(&self, address_key: &CoordinationKey) -> bool {
        self.address_keys.contains(address_key)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SiteFailoverAddressState {
    pub address_key: CoordinationKey,
    pub cooldown_until_ms: i64,
    pub cooldown_revision: i64,
    pub probe_required: bool,
    pub last_failure_category: Option<String>,
    pub last_http_status: Option<u16>,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SiteFailoverSnapshot {
    pub site_key: CoordinationKey,
    pub topology_key: CoordinationKey,
    pub primary_address_key: CoordinationKey,
    pub active_address_key: CoordinationKey,
    pub evaluation_revision: i64,
    pub transition_revision: i64,
    pub updated_at_ms: i64,
    pub addresses: Vec<SiteFailoverAddressState>,
}

impl SiteFailoverSnapshot {
    pub fn address(&self, address_key: &CoordinationKey) -> Option<&SiteFailoverAddressState> {
        self.addresses
            .iter()
            .find(|address| &address.address_key == address_key)
    }

    pub fn earliest_cooldown_until_ms(&self, now_ms: i64) -> Option<i64> {
        self.addresses
            .iter()
            .filter_map(|address| {
                (address.cooldown_until_ms > now_ms).then_some(address.cooldown_until_ms)
            })
            .min()
    }
}

#[derive(Clone)]
pub struct SiteFailoverLease {
    pub site_key: CoordinationKey,
    pub topology_key: CoordinationKey,
    pub instance_id: String,
    pub lease_token: String,
    pub observed_evaluation_revision: i64,
    pub acquired_at_ms: i64,
    pub expires_at_ms: i64,
}

impl std::fmt::Debug for SiteFailoverLease {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SiteFailoverLease")
            .field("instance_id", &self.instance_id)
            .field(
                "observed_evaluation_revision",
                &self.observed_evaluation_revision,
            )
            .field("acquired_at_ms", &self.acquired_at_ms)
            .field("expires_at_ms", &self.expires_at_ms)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SiteFailoverTransitionKind {
    SwitchedToFallback,
    PrimaryRestored,
}

impl SiteFailoverTransitionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SwitchedToFallback => "switched_to_fallback",
            Self::PrimaryRestored => "primary_restored",
        }
    }

    fn from_str(value: &str) -> Result<Self> {
        match value {
            "switched_to_fallback" => Ok(Self::SwitchedToFallback),
            "primary_restored" => Ok(Self::PrimaryRestored),
            _ => bail!("共享协调库包含未知的站点切换事件类型。"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SiteFailoverTransitionRecord {
    pub revision: i64,
    pub site_key: CoordinationKey,
    pub topology_key: CoordinationKey,
    pub from_address_key: CoordinationKey,
    pub to_address_key: CoordinationKey,
    pub kind: SiteFailoverTransitionKind,
    pub occurred_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SiteFailoverTransitionPage {
    pub latest_revision: i64,
    pub reset_required: bool,
    pub events: Vec<SiteFailoverTransitionRecord>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SiteFailoverFailureCategory {
    Timeout,
    Transport,
    RateLimited,
    BadGateway,
    ServiceUnavailable,
    GatewayTimeout,
}

impl SiteFailoverFailureCategory {
    fn as_str(self) -> &'static str {
        match self {
            Self::Timeout => "timeout",
            Self::Transport => "transport",
            Self::RateLimited => "rate_limited",
            Self::BadGateway => "http_502",
            Self::ServiceUnavailable => "http_503",
            Self::GatewayTimeout => "http_504",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SiteFailoverWinner {
    pub address_key: CoordinationKey,
    pub observed_cooldown_revision: i64,
}

#[derive(Debug, Clone)]
pub struct RuntimeCoordinationStore {
    db_path: Arc<PathBuf>,
    /// 先收敛同一进程内的连接竞争，再由 SQLite 仲裁跨进程写事务。
    local_operation_gate: Arc<tokio::sync::Mutex<()>>,
}

impl RuntimeCoordinationStore {
    pub fn new(db_path: PathBuf) -> Self {
        Self {
            db_path: Arc::new(db_path),
            local_operation_gate: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    pub fn path(&self) -> &Path {
        self.db_path.as_path()
    }

    /// 启动时在 blocking pool 初始化轻量协调库并注册本次进程。
    pub async fn initialize_and_register(
        &self,
        registration: &RuntimeInstanceRegistration,
    ) -> Result<[u8; 16]> {
        let seed = *uuid::Uuid::new_v4().as_bytes();
        let registration = registration.clone();
        self.run("初始化共享协调库", move |conn| {
            initialize_and_register_connection(conn, &registration, seed)
        })
        .await
    }

    #[cfg(test)]
    pub(crate) fn initialize_and_register_for_test(
        &self,
        registration: &RuntimeInstanceRegistration,
    ) -> Result<[u8; 16]> {
        let seed = *uuid::Uuid::new_v4().as_bytes();
        let registration = registration.clone();
        execute_with_busy_retry(self.path(), "初始化共享协调库", move |conn| {
            initialize_and_register_connection(conn, &registration, seed)
        })
    }

    pub async fn heartbeat(
        &self,
        registration: RuntimeInstanceRegistration,
        wall_now_ms: i64,
    ) -> Result<()> {
        self.run("更新 runtime heartbeat", move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let now_ms = clamp_now(&tx, wall_now_ms)?;
            cleanup_expired(&tx, now_ms, &registration.instance_id)?;
            register_runtime(&tx, &registration, now_ms)?;
            tx.commit()?;
            Ok(())
        })
        .await
    }

    pub async fn enqueue_account_demand(
        &self,
        demand: NewAccountSyncDemand,
        wall_now_ms: i64,
    ) -> Result<String> {
        self.run("登记账号同步 demand", move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let now_ms = clamp_now(&tx, wall_now_ms)?;
            cleanup_expired(&tx, now_ms, &demand.instance_id)?;
            tx.execute(
                "INSERT INTO account_sync_demands (
                   demand_id, account_key, instance_id, work_kind, priority,
                   enqueued_at_ms, not_before_ms, expires_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(account_key, instance_id, work_kind) DO UPDATE SET
                   priority = MAX(priority, excluded.priority),
                   not_before_ms = MIN(not_before_ms, excluded.not_before_ms),
                   expires_at_ms = excluded.expires_at_ms",
                params![
                    demand.demand_id,
                    demand.account_key.as_slice(),
                    demand.instance_id,
                    demand.work_kind,
                    demand.priority,
                    now_ms,
                    demand.not_before_ms.max(now_ms),
                    demand.expires_at_ms.max(now_ms + 1)
                ],
            )?;
            let demand_id = tx.query_row(
                "SELECT demand_id FROM account_sync_demands
                 WHERE account_key = ?1 AND instance_id = ?2 AND work_kind = ?3",
                params![
                    demand.account_key.as_slice(),
                    demand.instance_id,
                    demand.work_kind
                ],
                |row| row.get(0),
            )?;
            tx.commit()?;
            Ok(demand_id)
        })
        .await
    }

    pub async fn try_acquire_account_lease(
        &self,
        account_key: CoordinationKey,
        demand_id: String,
        instance_id: String,
        wall_now_ms: i64,
    ) -> Result<CoordinationDecision<AccountSyncLease>> {
        let lease_token = uuid::Uuid::new_v4().to_string();
        self.run("获取账号同步 lease", move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let now_ms = clamp_now(&tx, wall_now_ms)?;
            cleanup_expired(&tx, now_ms, &instance_id)?;

            let active_lease = tx
                .query_row(
                    "SELECT expires_at_ms FROM account_sync_leases
                     WHERE account_key = ?1 AND expires_at_ms > ?2",
                    params![account_key.as_slice(), now_ms],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?;
            if let Some(expires_at_ms) = active_lease {
                tx.commit()?;
                return Ok(CoordinationDecision::Waiting {
                    wait_ms: bounded_wait_ms(expires_at_ms.saturating_sub(now_ms)),
                });
            }

            let aged_before_ms = now_ms.saturating_sub(DEMAND_AGING_AFTER_MS);
            let candidate = tx
                .query_row(
                    "SELECT demand_id
                     FROM account_sync_demands
                     WHERE account_key = ?1
                       AND not_before_ms <= ?2
                       AND expires_at_ms > ?2
                     ORDER BY
                       CASE WHEN enqueued_at_ms <= ?3 THEN 0 ELSE 1 END ASC,
                       CASE WHEN enqueued_at_ms <= ?3 THEN enqueued_at_ms END ASC,
                       CASE WHEN enqueued_at_ms > ?3 THEN priority END DESC,
                       enqueued_at_ms ASC,
                       demand_id ASC
                     LIMIT 1",
                    params![account_key.as_slice(), now_ms, aged_before_ms],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            if candidate.as_deref() != Some(demand_id.as_str()) {
                let next_due = tx
                    .query_row(
                        "SELECT not_before_ms FROM account_sync_demands WHERE demand_id = ?1",
                        params![demand_id],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()?;
                tx.commit()?;
                return Ok(CoordinationDecision::Waiting {
                    wait_ms: next_due
                        .map(|due| bounded_wait_ms(due.saturating_sub(now_ms)))
                        .unwrap_or(25),
                });
            }

            let (work_kind, priority) = tx.query_row(
                "SELECT work_kind, priority FROM account_sync_demands
                 WHERE demand_id = ?1 AND instance_id = ?2",
                params![demand_id, instance_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )?;
            let expires_at_ms = now_ms.saturating_add(ACCOUNT_LEASE_TTL_MS);
            tx.execute(
                "INSERT INTO account_sync_leases (
                   account_key, demand_id, instance_id, work_kind, lease_token,
                   priority, acquired_at_ms, heartbeat_at_ms, expires_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8)",
                params![
                    account_key.as_slice(),
                    demand_id,
                    instance_id,
                    work_kind,
                    lease_token,
                    priority,
                    now_ms,
                    expires_at_ms
                ],
            )?;
            if tx.execute(
                "DELETE FROM account_sync_demands WHERE demand_id = ?1 AND instance_id = ?2",
                params![demand_id, instance_id],
            )? != 1
            {
                bail!("账号同步 demand 在 lease 提交前已失效。");
            }
            tx.commit()?;
            Ok(CoordinationDecision::Acquired(AccountSyncLease {
                account_key,
                demand_id: demand_id.clone(),
                instance_id: instance_id.clone(),
                work_kind,
                lease_token: lease_token.clone(),
                priority,
                acquired_at_ms: now_ms,
                expires_at_ms,
            }))
        })
        .await
    }

    /// 原子登记当前 runtime 的一组到期工作，并在公平队首属于当前 runtime 时授予一个账号租约。
    pub async fn enqueue_due_work_and_try_acquire_account_lease(
        &self,
        demands: Vec<NewAccountSyncDemand>,
        wall_now_ms: i64,
    ) -> Result<CoordinationDecision<AccountSyncLeaseGrant>> {
        let Some(first) = demands.first() else {
            bail!("账号同步 due work 不能为空。");
        };
        let account_key = first.account_key;
        let instance_id = first.instance_id.clone();
        if demands
            .iter()
            .any(|demand| demand.account_key != account_key || demand.instance_id != instance_id)
        {
            bail!("同一批账号同步 due work 必须属于同一账号和 runtime。");
        }
        let lease_token = uuid::Uuid::new_v4().to_string();
        self.run("登记并获取账号同步 due work lease", move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let now_ms = clamp_now(&tx, wall_now_ms)?;
            cleanup_expired(&tx, now_ms, &instance_id)?;

            for demand in &demands {
                tx.execute(
                    "INSERT INTO account_sync_demands (
                       demand_id, account_key, instance_id, work_kind, priority,
                       enqueued_at_ms, not_before_ms, expires_at_ms
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                     ON CONFLICT(account_key, instance_id, work_kind) DO UPDATE SET
                       priority = MAX(priority, excluded.priority),
                       not_before_ms = MIN(not_before_ms, excluded.not_before_ms),
                       expires_at_ms = excluded.expires_at_ms",
                    params![
                        demand.demand_id,
                        demand.account_key.as_slice(),
                        demand.instance_id,
                        demand.work_kind,
                        demand.priority,
                        now_ms,
                        demand.not_before_ms.max(now_ms),
                        demand.expires_at_ms.max(now_ms + 1)
                    ],
                )?;
            }

            let active_lease = tx
                .query_row(
                    "SELECT expires_at_ms FROM account_sync_leases
                     WHERE account_key = ?1 AND expires_at_ms > ?2",
                    params![account_key.as_slice(), now_ms],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?;
            if let Some(expires_at_ms) = active_lease {
                tx.commit()?;
                return Ok(CoordinationDecision::Waiting {
                    wait_ms: bounded_wait_ms(expires_at_ms.saturating_sub(now_ms)),
                });
            }

            let aged_before_ms = now_ms.saturating_sub(DEMAND_AGING_AFTER_MS);
            let candidate = tx
                .query_row(
                    "SELECT demand_id, instance_id, work_kind, priority
                     FROM account_sync_demands
                     WHERE account_key = ?1
                       AND not_before_ms <= ?2
                       AND expires_at_ms > ?2
                     ORDER BY
                       CASE WHEN enqueued_at_ms <= ?3 THEN 0 ELSE 1 END ASC,
                       CASE WHEN enqueued_at_ms <= ?3 THEN enqueued_at_ms END ASC,
                       CASE WHEN enqueued_at_ms > ?3 THEN priority END DESC,
                       enqueued_at_ms ASC,
                       demand_id ASC
                     LIMIT 1",
                    params![account_key.as_slice(), now_ms, aged_before_ms],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, i64>(3)?,
                        ))
                    },
                )
                .optional()?;
            let Some((demand_id, candidate_instance_id, work_kind, priority)) = candidate else {
                tx.commit()?;
                return Ok(CoordinationDecision::Waiting { wait_ms: 25 });
            };
            if candidate_instance_id != instance_id {
                tx.commit()?;
                return Ok(CoordinationDecision::Waiting { wait_ms: 25 });
            }

            let consumed_demands = {
                let mut statement = tx.prepare(
                    "SELECT demand_id, work_kind
                     FROM account_sync_demands
                     WHERE account_key = ?1 AND instance_id = ?2
                       AND not_before_ms <= ?3 AND expires_at_ms > ?3
                     ORDER BY priority DESC, enqueued_at_ms ASC, demand_id ASC",
                )?;
                let rows = statement
                    .query_map(
                        params![account_key.as_slice(), instance_id, now_ms],
                        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                    )?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                rows
            };
            if consumed_demands.is_empty() {
                bail!("账号同步 due work 在 lease 提交前已失效。");
            }

            let expires_at_ms = now_ms.saturating_add(ACCOUNT_LEASE_TTL_MS);
            tx.execute(
                "INSERT INTO account_sync_leases (
                   account_key, demand_id, instance_id, work_kind, lease_token,
                   priority, acquired_at_ms, heartbeat_at_ms, expires_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8)",
                params![
                    account_key.as_slice(),
                    demand_id,
                    instance_id,
                    work_kind,
                    lease_token,
                    priority,
                    now_ms,
                    expires_at_ms
                ],
            )?;
            for (consumed_demand_id, _) in &consumed_demands {
                if tx.execute(
                    "DELETE FROM account_sync_demands
                     WHERE demand_id = ?1 AND instance_id = ?2",
                    params![consumed_demand_id, instance_id],
                )? != 1
                {
                    bail!("账号同步 due work 在 lease 提交前已失效。");
                }
            }
            let work_kinds = consumed_demands
                .into_iter()
                .map(|(_, work_kind)| work_kind)
                .collect();
            tx.commit()?;
            Ok(CoordinationDecision::Acquired(AccountSyncLeaseGrant {
                lease: AccountSyncLease {
                    account_key,
                    demand_id: demand_id.clone(),
                    instance_id: instance_id.clone(),
                    work_kind,
                    lease_token: lease_token.clone(),
                    priority,
                    acquired_at_ms: now_ms,
                    expires_at_ms,
                },
                work_kinds,
            }))
        })
        .await
    }

    /// 长任务只在存在更高优先级或已老化的 peer demand 时主动让行。
    pub async fn should_yield_account_lease(
        &self,
        lease: AccountSyncLease,
        wall_now_ms: i64,
    ) -> Result<bool> {
        self.run("检查账号同步 lease 是否需要让行", move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let now_ms = clamp_now(&tx, wall_now_ms)?;
            cleanup_expired(&tx, now_ms, &lease.instance_id)?;
            let still_owner = tx.query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM account_sync_leases
                   WHERE account_key = ?1 AND instance_id = ?2 AND lease_token = ?3
                     AND expires_at_ms > ?4
                 )",
                params![
                    lease.account_key.as_slice(),
                    lease.instance_id,
                    lease.lease_token,
                    now_ms
                ],
                |row| row.get::<_, i64>(0),
            )? == 1;
            if !still_owner {
                tx.commit()?;
                return Ok(true);
            }
            let aged_before_ms = now_ms.saturating_sub(DEMAND_AGING_AFTER_MS);
            let should_yield = tx.query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM account_sync_demands
                   WHERE account_key = ?1 AND instance_id <> ?2
                     AND not_before_ms <= ?3 AND expires_at_ms > ?3
                     AND (priority > ?4 OR enqueued_at_ms <= ?5)
                 )",
                params![
                    lease.account_key.as_slice(),
                    lease.instance_id,
                    now_ms,
                    lease.priority,
                    aged_before_ms
                ],
                |row| row.get::<_, i64>(0),
            )? == 1;
            tx.commit()?;
            Ok(should_yield)
        })
        .await
    }

    pub async fn renew_account_lease(
        &self,
        lease: AccountSyncLease,
        wall_now_ms: i64,
    ) -> Result<bool> {
        self.run("续租账号同步 lease", move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let now_ms = clamp_now(&tx, wall_now_ms)?;
            cleanup_expired(&tx, now_ms, &lease.instance_id)?;
            let updated = tx.execute(
                "UPDATE account_sync_leases
                 SET heartbeat_at_ms = ?1, expires_at_ms = ?2
                 WHERE account_key = ?3 AND instance_id = ?4 AND lease_token = ?5",
                params![
                    now_ms,
                    now_ms.saturating_add(ACCOUNT_LEASE_TTL_MS),
                    lease.account_key.as_slice(),
                    lease.instance_id,
                    lease.lease_token
                ],
            )? == 1;
            tx.commit()?;
            Ok(updated)
        })
        .await
    }

    pub async fn release_account_lease(&self, lease: AccountSyncLease) -> Result<bool> {
        self.run("释放账号同步 lease", move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let released = tx.execute(
                "DELETE FROM account_sync_leases
                 WHERE account_key = ?1 AND instance_id = ?2 AND lease_token = ?3",
                params![
                    lease.account_key.as_slice(),
                    lease.instance_id,
                    lease.lease_token
                ],
            )? == 1;
            tx.commit()?;
            Ok(released)
        })
        .await
    }

    pub async fn enqueue_site_request_demand(
        &self,
        demand: NewSiteRequestDemand,
        wall_now_ms: i64,
    ) -> Result<()> {
        self.run("登记站点请求 demand", move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let now_ms = clamp_now(&tx, wall_now_ms)?;
            cleanup_expired(&tx, now_ms, &demand.instance_id)?;
            tx.execute(
                "INSERT INTO site_request_demands (
                   request_id, site_key, instance_id, endpoint_family, request_class,
                   priority, enqueued_at_ms, not_before_ms, expires_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(request_id) DO UPDATE SET
                   not_before_ms = MIN(not_before_ms, excluded.not_before_ms),
                   expires_at_ms = excluded.expires_at_ms",
                params![
                    demand.request_id,
                    demand.site_key.as_slice(),
                    demand.instance_id,
                    demand.endpoint_family,
                    demand.request_class,
                    demand.priority,
                    now_ms,
                    demand.not_before_ms.max(now_ms),
                    demand.expires_at_ms.max(now_ms + 1)
                ],
            )?;
            tx.commit()?;
            Ok(())
        })
        .await
    }

    pub async fn try_acquire_site_request_permit(
        &self,
        site_key: CoordinationKey,
        request_id: String,
        instance_id: String,
        wall_now_ms: i64,
    ) -> Result<CoordinationDecision<SiteRequestPermit>> {
        let permit_token = uuid::Uuid::new_v4().to_string();
        self.run("获取站点请求 permit", move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let now_ms = clamp_now(&tx, wall_now_ms)?;
            cleanup_expired(&tx, now_ms, &instance_id)?;
            let config = read_config(&tx)?;
            ensure_site_schedule(&tx, &site_key, now_ms)?;

            let aged_before_ms = now_ms.saturating_sub(DEMAND_AGING_AFTER_MS);
            let candidate = tx
                .query_row(
                    "SELECT request_id
                     FROM site_request_demands
                     WHERE site_key = ?1
                       AND not_before_ms <= ?2
                       AND expires_at_ms > ?2
                     ORDER BY
                       CASE WHEN enqueued_at_ms <= ?3 THEN 0 ELSE 1 END ASC,
                       CASE WHEN enqueued_at_ms <= ?3 THEN enqueued_at_ms END ASC,
                       CASE WHEN enqueued_at_ms > ?3 THEN priority END DESC,
                       enqueued_at_ms ASC,
                       request_id ASC
                     LIMIT 1",
                    params![site_key.as_slice(), now_ms, aged_before_ms],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            if candidate.as_deref() != Some(request_id.as_str()) {
                tx.commit()?;
                return Ok(CoordinationDecision::Waiting { wait_ms: 25 });
            }

            let (endpoint_family, _request_class) = tx.query_row(
                "SELECT endpoint_family, request_class FROM site_request_demands
                 WHERE request_id = ?1 AND instance_id = ?2",
                params![request_id, instance_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )?;
            let total_in_flight = tx.query_row(
                "SELECT COUNT(*) FROM site_request_leases
                 WHERE site_key = ?1 AND expires_at_ms > ?2",
                params![site_key.as_slice(), now_ms],
                |row| row.get::<_, i64>(0),
            )?;
            if total_in_flight >= i64::from(config.site_max_in_flight) {
                tx.commit()?;
                return Ok(CoordinationDecision::Waiting { wait_ms: 25 });
            }
            if endpoint_family == USAGE_PAGE_ENDPOINT_FAMILY {
                let usage_in_flight = tx.query_row(
                    "SELECT COUNT(*) FROM site_request_leases
                     WHERE site_key = ?1 AND endpoint_family = ?2 AND expires_at_ms > ?3",
                    params![site_key.as_slice(), USAGE_PAGE_ENDPOINT_FAMILY, now_ms],
                    |row| row.get::<_, i64>(0),
                )?;
                if usage_in_flight >= i64::from(config.usage_page_max_in_flight) {
                    tx.commit()?;
                    return Ok(CoordinationDecision::Waiting { wait_ms: 25 });
                }
            }

            let (next_allowed_at_ms, cooldown_until_ms) = tx.query_row(
                "SELECT next_allowed_at_ms, cooldown_until_ms FROM site_request_schedule
                 WHERE site_key = ?1",
                params![site_key.as_slice()],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )?;
            let ready_at_ms = next_allowed_at_ms.max(cooldown_until_ms);
            if ready_at_ms > now_ms {
                tx.commit()?;
                return Ok(CoordinationDecision::Waiting {
                    wait_ms: bounded_wait_ms(ready_at_ms.saturating_sub(now_ms)),
                });
            }

            let spacing_ms = (1_000_i64 + i64::from(config.site_requests_per_second) - 1)
                / i64::from(config.site_requests_per_second);
            tx.execute(
                "UPDATE site_request_schedule
                 SET next_allowed_at_ms = ?1, updated_at_ms = ?2
                 WHERE site_key = ?3",
                params![
                    now_ms.saturating_add(spacing_ms),
                    now_ms,
                    site_key.as_slice()
                ],
            )?;
            let expires_at_ms = now_ms.saturating_add(REQUEST_PERMIT_TTL_MS);
            tx.execute(
                "INSERT INTO site_request_leases (
                   request_id, site_key, instance_id, endpoint_family, permit_token,
                   acquired_at_ms, expires_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    request_id,
                    site_key.as_slice(),
                    instance_id,
                    endpoint_family,
                    permit_token,
                    now_ms,
                    expires_at_ms
                ],
            )?;
            if tx.execute(
                "DELETE FROM site_request_demands WHERE request_id = ?1 AND instance_id = ?2",
                params![request_id, instance_id],
            )? != 1
            {
                bail!("站点请求 demand 在 permit 提交前已失效。");
            }
            tx.commit()?;
            Ok(CoordinationDecision::Acquired(SiteRequestPermit {
                request_id: request_id.clone(),
                site_key,
                instance_id: instance_id.clone(),
                endpoint_family,
                permit_token: permit_token.clone(),
                acquired_at_ms: now_ms,
                expires_at_ms,
            }))
        })
        .await
    }

    pub async fn cancel_site_request_demand(
        &self,
        request_id: String,
        instance_id: String,
    ) -> Result<bool> {
        self.run("取消站点请求 demand", move |conn| {
            let deleted = conn.execute(
                "DELETE FROM site_request_demands WHERE request_id = ?1 AND instance_id = ?2",
                params![request_id, instance_id],
            )? == 1;
            Ok(deleted)
        })
        .await
    }

    pub async fn release_site_request_permit(&self, permit: SiteRequestPermit) -> Result<bool> {
        self.run("释放站点请求 permit", move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let released = tx.execute(
                "DELETE FROM site_request_leases
                 WHERE request_id = ?1 AND instance_id = ?2 AND permit_token = ?3",
                params![permit.request_id, permit.instance_id, permit.permit_token],
            )? == 1;
            tx.commit()?;
            Ok(released)
        })
        .await
    }

    pub async fn set_site_cooldown(
        &self,
        site_key: CoordinationKey,
        delay_ms: u64,
        wall_now_ms: i64,
    ) -> Result<SiteCooldownState> {
        self.run("更新站点 cooldown", move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let now_ms = clamp_now(&tx, wall_now_ms)?;
            ensure_site_schedule(&tx, &site_key, now_ms)?;
            let requested_until =
                now_ms.saturating_add(i64::try_from(delay_ms).unwrap_or(i64::MAX));
            tx.execute(
                "UPDATE site_request_schedule
                 SET cooldown_until_ms = MAX(cooldown_until_ms, ?1),
                     cooldown_revision = cooldown_revision + 1,
                     updated_at_ms = ?2
                 WHERE site_key = ?3",
                params![requested_until, now_ms, site_key.as_slice()],
            )?;
            let state = tx.query_row(
                "SELECT cooldown_until_ms, cooldown_revision FROM site_request_schedule
                 WHERE site_key = ?1",
                params![site_key.as_slice()],
                |row| {
                    Ok(SiteCooldownState {
                        cooldown_until_ms: row.get(0)?,
                        revision: row.get(1)?,
                    })
                },
            )?;
            tx.commit()?;
            Ok(state)
        })
        .await
    }

    pub async fn load_or_initialize_site_failover(
        &self,
        topology: SiteFailoverTopology,
        wall_now_ms: i64,
    ) -> Result<SiteFailoverSnapshot> {
        topology.validate()?;
        self.run("读取站点故障转移状态", move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let now_ms = clamp_now(&tx, wall_now_ms)?;
            ensure_site_failover_topology(&tx, &topology, now_ms)?;
            let snapshot = read_site_failover_snapshot(&tx, &topology)?;
            tx.commit()?;
            Ok(snapshot)
        })
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn record_site_failover_failure(
        &self,
        topology: SiteFailoverTopology,
        address_key: CoordinationKey,
        expected_cooldown_revision: Option<i64>,
        cooldown_until_ms: i64,
        failure_category: SiteFailoverFailureCategory,
        http_status: Option<u16>,
        wall_now_ms: i64,
    ) -> Result<(bool, SiteFailoverSnapshot)> {
        topology.validate()?;
        if !topology.contains_address(&address_key) {
            bail!("待冷却地址不属于当前站点故障转移拓扑。")
        }
        self.run("记录站点地址故障", move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let now_ms = clamp_now(&tx, wall_now_ms)?;
            ensure_site_failover_topology(&tx, &topology, now_ms)?;
            let requested_until_ms = cooldown_until_ms.max(now_ms);
            let changed = match expected_cooldown_revision {
                Some(expected_revision) => {
                    tx.execute(
                        "UPDATE site_failover_address_states
                     SET cooldown_until_ms = MAX(cooldown_until_ms, ?1),
                         cooldown_revision = cooldown_revision + 1,
                         probe_required = 1,
                         last_failure_category = ?2,
                         last_http_status = ?3,
                         updated_at_ms = ?4
                     WHERE site_key = ?5 AND topology_key = ?6 AND address_key = ?7
                       AND cooldown_revision = ?8",
                        params![
                            requested_until_ms,
                            failure_category.as_str(),
                            http_status.map(i64::from),
                            now_ms,
                            topology.site_key.as_slice(),
                            topology.topology_key.as_slice(),
                            address_key.as_slice(),
                            expected_revision
                        ],
                    )? == 1
                }
                None => {
                    tx.execute(
                        "UPDATE site_failover_address_states
                     SET cooldown_until_ms = MAX(cooldown_until_ms, ?1),
                         cooldown_revision = cooldown_revision + 1,
                         probe_required = 1,
                         last_failure_category = ?2,
                         last_http_status = ?3,
                         updated_at_ms = ?4
                     WHERE site_key = ?5 AND topology_key = ?6 AND address_key = ?7",
                        params![
                            requested_until_ms,
                            failure_category.as_str(),
                            http_status.map(i64::from),
                            now_ms,
                            topology.site_key.as_slice(),
                            topology.topology_key.as_slice(),
                            address_key.as_slice()
                        ],
                    )? == 1
                }
            };
            if changed {
                tx.execute(
                    "UPDATE site_failover_states SET updated_at_ms = ?1
                     WHERE site_key = ?2 AND topology_key = ?3",
                    params![
                        now_ms,
                        topology.site_key.as_slice(),
                        topology.topology_key.as_slice()
                    ],
                )?;
            }
            let snapshot = read_site_failover_snapshot(&tx, &topology)?;
            tx.commit()?;
            Ok((changed, snapshot))
        })
        .await
    }

    pub async fn clear_site_failover_cooldown(
        &self,
        topology: SiteFailoverTopology,
        address_key: CoordinationKey,
        wall_now_ms: i64,
    ) -> Result<SiteFailoverSnapshot> {
        topology.validate()?;
        if !topology.contains_address(&address_key) {
            bail!("待解除冷却地址不属于当前站点故障转移拓扑。")
        }
        self.run("解除站点地址冷却", move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let now_ms = clamp_now(&tx, wall_now_ms)?;
            ensure_site_failover_topology(&tx, &topology, now_ms)?;
            tx.execute(
                "UPDATE site_failover_address_states
                 SET cooldown_until_ms = 0,
                     cooldown_revision = cooldown_revision + 1,
                     probe_required = 1,
                     last_failure_category = NULL,
                     last_http_status = NULL,
                     updated_at_ms = ?1
                 WHERE site_key = ?2 AND topology_key = ?3 AND address_key = ?4",
                params![
                    now_ms,
                    topology.site_key.as_slice(),
                    topology.topology_key.as_slice(),
                    address_key.as_slice()
                ],
            )?;
            tx.execute(
                "UPDATE site_failover_states SET updated_at_ms = ?1
                 WHERE site_key = ?2 AND topology_key = ?3",
                params![
                    now_ms,
                    topology.site_key.as_slice(),
                    topology.topology_key.as_slice()
                ],
            )?;
            let snapshot = read_site_failover_snapshot(&tx, &topology)?;
            tx.commit()?;
            Ok(snapshot)
        })
        .await
    }

    pub async fn try_acquire_site_failover_lease(
        &self,
        topology: SiteFailoverTopology,
        instance_id: String,
        wall_now_ms: i64,
    ) -> Result<CoordinationDecision<SiteFailoverLease>> {
        topology.validate()?;
        let lease_token = uuid::Uuid::new_v4().to_string();
        self.run("获取站点故障转移 lease", move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let now_ms = clamp_now(&tx, wall_now_ms)?;
            cleanup_expired(&tx, now_ms, &instance_id)?;
            ensure_site_failover_topology(&tx, &topology, now_ms)?;
            let existing_expiry = tx
                .query_row(
                    "SELECT expires_at_ms FROM site_failover_leases
                     WHERE site_key = ?1 AND topology_key = ?2",
                    params![
                        topology.site_key.as_slice(),
                        topology.topology_key.as_slice()
                    ],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?;
            if let Some(expires_at_ms) = existing_expiry {
                tx.commit()?;
                return Ok(CoordinationDecision::Waiting {
                    wait_ms: bounded_wait_ms(expires_at_ms.saturating_sub(now_ms)),
                });
            }

            let observed_evaluation_revision = tx.query_row(
                "SELECT evaluation_revision FROM site_failover_states
                 WHERE site_key = ?1 AND topology_key = ?2",
                params![
                    topology.site_key.as_slice(),
                    topology.topology_key.as_slice()
                ],
                |row| row.get::<_, i64>(0),
            )?;
            let expires_at_ms = now_ms.saturating_add(SITE_FAILOVER_LEASE_TTL_MS);
            tx.execute(
                "INSERT INTO site_failover_leases (
                   site_key, topology_key, instance_id, lease_token,
                   observed_evaluation_revision, acquired_at_ms, heartbeat_at_ms, expires_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7)",
                params![
                    topology.site_key.as_slice(),
                    topology.topology_key.as_slice(),
                    instance_id,
                    lease_token,
                    observed_evaluation_revision,
                    now_ms,
                    expires_at_ms
                ],
            )?;
            tx.commit()?;
            Ok(CoordinationDecision::Acquired(SiteFailoverLease {
                site_key: topology.site_key,
                topology_key: topology.topology_key,
                instance_id: instance_id.clone(),
                lease_token: lease_token.clone(),
                observed_evaluation_revision,
                acquired_at_ms: now_ms,
                expires_at_ms,
            }))
        })
        .await
    }

    pub async fn renew_site_failover_lease(
        &self,
        lease: SiteFailoverLease,
        wall_now_ms: i64,
    ) -> Result<bool> {
        self.run("续租站点故障转移 lease", move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let now_ms = clamp_now(&tx, wall_now_ms)?;
            cleanup_expired(&tx, now_ms, &lease.instance_id)?;
            let renewed = tx.execute(
                "UPDATE site_failover_leases
                 SET heartbeat_at_ms = ?1, expires_at_ms = ?2
                 WHERE site_key = ?3 AND topology_key = ?4
                   AND instance_id = ?5 AND lease_token = ?6
                   AND observed_evaluation_revision = ?7 AND expires_at_ms > ?1",
                params![
                    now_ms,
                    now_ms.saturating_add(SITE_FAILOVER_LEASE_TTL_MS),
                    lease.site_key.as_slice(),
                    lease.topology_key.as_slice(),
                    lease.instance_id,
                    lease.lease_token,
                    lease.observed_evaluation_revision
                ],
            )? == 1;
            tx.commit()?;
            Ok(renewed)
        })
        .await
    }

    pub async fn complete_site_failover_evaluation(
        &self,
        topology: SiteFailoverTopology,
        lease: SiteFailoverLease,
        winner: Option<SiteFailoverWinner>,
        wall_now_ms: i64,
    ) -> Result<Option<SiteFailoverSnapshot>> {
        topology.validate()?;
        if lease.site_key != topology.site_key || lease.topology_key != topology.topology_key {
            bail!("站点故障转移 lease 与当前拓扑不匹配。")
        }
        if winner
            .as_ref()
            .is_some_and(|winner| !topology.contains_address(&winner.address_key))
        {
            bail!("站点故障转移 winner 不属于当前拓扑。")
        }
        self.run("提交站点故障转移结果", move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let now_ms = clamp_now(&tx, wall_now_ms)?;
            cleanup_expired(&tx, now_ms, &lease.instance_id)?;
            ensure_site_failover_topology(&tx, &topology, now_ms)?;
            let valid_lease = tx
                .query_row(
                    "SELECT observed_evaluation_revision FROM site_failover_leases
                     WHERE site_key = ?1 AND topology_key = ?2
                       AND instance_id = ?3 AND lease_token = ?4 AND expires_at_ms > ?5",
                    params![
                        lease.site_key.as_slice(),
                        lease.topology_key.as_slice(),
                        lease.instance_id,
                        lease.lease_token,
                        now_ms
                    ],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?;
            let current_evaluation_revision = tx.query_row(
                "SELECT evaluation_revision FROM site_failover_states
                 WHERE site_key = ?1 AND topology_key = ?2",
                params![topology.site_key.as_slice(), topology.topology_key.as_slice()],
                |row| row.get::<_, i64>(0),
            )?;
            if valid_lease != Some(lease.observed_evaluation_revision)
                || current_evaluation_revision != lease.observed_evaluation_revision
            {
                tx.commit()?;
                return Ok(None);
            }

            let previous_active = tx.query_row(
                "SELECT active_address_key FROM site_failover_states
                 WHERE site_key = ?1 AND topology_key = ?2",
                params![topology.site_key.as_slice(), topology.topology_key.as_slice()],
                |row| row.get::<_, Vec<u8>>(0),
            )?;
            let previous_active = coordination_key_from_blob(previous_active)?;
            let accepted_winner = match winner {
                Some(winner) => {
                    let updated = tx.execute(
                        "UPDATE site_failover_address_states
                         SET cooldown_until_ms = 0,
                             cooldown_revision = cooldown_revision + 1,
                             probe_required = 0,
                             last_failure_category = NULL,
                             last_http_status = NULL,
                             updated_at_ms = ?1
                         WHERE site_key = ?2 AND topology_key = ?3 AND address_key = ?4
                           AND cooldown_revision = ?5",
                        params![
                            now_ms,
                            topology.site_key.as_slice(),
                            topology.topology_key.as_slice(),
                            winner.address_key.as_slice(),
                            winner.observed_cooldown_revision
                        ],
                    )? == 1;
                    updated.then_some(winner.address_key)
                }
                None => None,
            };

            let next_active = accepted_winner.unwrap_or(previous_active);
            let mut transition_revision = None;
            if next_active != previous_active {
                let kind = if next_active == topology.primary_address_key {
                    SiteFailoverTransitionKind::PrimaryRestored
                } else {
                    SiteFailoverTransitionKind::SwitchedToFallback
                };
                tx.execute(
                    "INSERT INTO site_failover_transitions (
                       site_key, topology_key, from_address_key, to_address_key, kind, occurred_at_ms
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        topology.site_key.as_slice(),
                        topology.topology_key.as_slice(),
                        previous_active.as_slice(),
                        next_active.as_slice(),
                        kind.as_str(),
                        now_ms
                    ],
                )?;
                transition_revision = Some(tx.last_insert_rowid());
            }

            tx.execute(
                "UPDATE site_failover_states
                 SET active_address_key = ?1,
                     evaluation_revision = evaluation_revision + 1,
                     transition_revision = COALESCE(?2, transition_revision),
                     updated_at_ms = ?3
                 WHERE site_key = ?4 AND topology_key = ?5",
                params![
                    next_active.as_slice(),
                    transition_revision,
                    now_ms,
                    topology.site_key.as_slice(),
                    topology.topology_key.as_slice()
                ],
            )?;
            tx.execute(
                "DELETE FROM site_failover_leases
                 WHERE site_key = ?1 AND topology_key = ?2
                   AND instance_id = ?3 AND lease_token = ?4",
                params![
                    lease.site_key.as_slice(),
                    lease.topology_key.as_slice(),
                    lease.instance_id,
                    lease.lease_token
                ],
            )?;
            prune_site_failover_transitions(&tx)?;
            let snapshot = read_site_failover_snapshot(&tx, &topology)?;
            tx.commit()?;
            Ok(Some(snapshot))
        })
        .await
    }

    pub async fn release_site_failover_lease(&self, lease: SiteFailoverLease) -> Result<bool> {
        self.run("释放站点故障转移 lease", move |conn| {
            let released = conn.execute(
                "DELETE FROM site_failover_leases
                 WHERE site_key = ?1 AND topology_key = ?2
                   AND instance_id = ?3 AND lease_token = ?4",
                params![
                    lease.site_key.as_slice(),
                    lease.topology_key.as_slice(),
                    lease.instance_id,
                    lease.lease_token
                ],
            )? == 1;
            Ok(released)
        })
        .await
    }

    pub async fn list_site_failover_transitions(
        &self,
        after_revision: i64,
        limit: usize,
    ) -> Result<SiteFailoverTransitionPage> {
        let after_revision = after_revision.max(0);
        let limit = limit.clamp(1, 100) as i64;
        self.run("读取站点故障转移事件", move |conn| {
            let (oldest_revision, latest_revision) = conn.query_row(
                "SELECT COALESCE(MIN(revision), 0), COALESCE(MAX(revision), 0)
                 FROM site_failover_transitions",
                [],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )?;
            let reset_required = after_revision > 0
                && oldest_revision > 0
                && after_revision < oldest_revision.saturating_sub(1);
            if reset_required {
                return Ok(SiteFailoverTransitionPage {
                    latest_revision,
                    reset_required: true,
                    events: Vec::new(),
                });
            }
            let mut stmt = conn.prepare(
                "SELECT revision, site_key, topology_key, from_address_key, to_address_key,
                        kind, occurred_at_ms
                 FROM site_failover_transitions
                 WHERE revision > ?1
                 ORDER BY revision ASC
                 LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![after_revision, limit], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Vec<u8>>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                    row.get::<_, Vec<u8>>(3)?,
                    row.get::<_, Vec<u8>>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, i64>(6)?,
                ))
            })?;
            let mut events = Vec::new();
            for row in rows {
                let (revision, site_key, topology_key, from_key, to_key, kind, occurred_at_ms) =
                    row?;
                events.push(SiteFailoverTransitionRecord {
                    revision,
                    site_key: coordination_key_from_blob(site_key)?,
                    topology_key: coordination_key_from_blob(topology_key)?,
                    from_address_key: coordination_key_from_blob(from_key)?,
                    to_address_key: coordination_key_from_blob(to_key)?,
                    kind: SiteFailoverTransitionKind::from_str(&kind)?,
                    occurred_at_ms,
                });
            }
            Ok(SiteFailoverTransitionPage {
                latest_revision,
                reset_required: false,
                events,
            })
        })
        .await
    }

    pub async fn get_config(&self) -> Result<SharedRuntimeCoordinationConfig> {
        self.run("读取共享协调配置", move |conn| read_config(conn))
            .await
    }

    pub async fn update_config(
        &self,
        config: SharedRuntimeCoordinationConfig,
        wall_now_ms: i64,
    ) -> Result<SharedRuntimeCoordinationConfig> {
        let config = config.validate()?;
        self.run("更新共享协调配置", move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let now_ms = clamp_now(&tx, wall_now_ms)?;
            tx.execute(
                "UPDATE coordination_config
                 SET site_requests_per_second = ?1,
                     site_max_in_flight = ?2,
                     usage_page_max_in_flight = ?3,
                     updated_at_ms = ?4
                 WHERE singleton_id = 1",
                params![
                    config.site_requests_per_second,
                    config.site_max_in_flight,
                    config.usage_page_max_in_flight,
                    now_ms
                ],
            )?;
            tx.commit()?;
            Ok(config)
        })
        .await
    }

    /// 读取当前上游网络模式，缺失或损坏配置按错误处理，不擅自改变请求路径。
    pub async fn get_upstream_network_config(&self) -> Result<UpstreamNetworkConfig> {
        self.run("读取上游网络配置", move |conn| {
            read_upstream_network_config(conn)
        })
        .await
    }

    /// 原子更新 Web 与 Desktop 共用的上游网络模式。
    pub async fn update_upstream_network_config(
        &self,
        config: UpstreamNetworkConfig,
        wall_now_ms: i64,
    ) -> Result<UpstreamNetworkConfig> {
        self.run("更新上游网络配置", move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let now_ms = clamp_now(&tx, wall_now_ms)?;
            let affected = tx.execute(
                "UPDATE upstream_network_config
                 SET use_system_proxy = ?1, updated_at_ms = ?2
                 WHERE singleton_id = 1",
                params![i64::from(config.use_system_proxy), now_ms],
            )?;
            if affected != 1 {
                bail!("上游网络配置记录缺失。")
            }
            tx.commit()?;
            Ok(config)
        })
        .await
    }

    async fn run<T, F>(&self, operation: &'static str, action: F) -> Result<T>
    where
        T: Send + 'static,
        F: Fn(&mut Connection) -> Result<T> + Send + 'static,
    {
        let _local_operation_guard = self.local_operation_gate.lock().await;
        let db_path = Arc::clone(&self.db_path);
        tokio::task::spawn_blocking(move || {
            execute_with_busy_retry(db_path.as_path(), operation, action)
        })
        .await
        .with_context(|| format!("共享协调数据库后台任务异常: {operation}"))?
    }
}

fn initialize_and_register_connection(
    conn: &mut Connection,
    registration: &RuntimeInstanceRegistration,
    seed: [u8; 16],
) -> Result<[u8; 16]> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.execute_batch(COORDINATION_SCHEMA)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let now_ms = clamp_now(&tx, registration.started_at_ms)?;
    tx.execute(
        "INSERT OR IGNORE INTO coordination_metadata (key, value, updated_at_ms)
         VALUES (?1, ?2, ?3)",
        params![COORDINATION_SALT_KEY, seed.as_slice(), now_ms],
    )?;
    tx.execute(
        "INSERT OR IGNORE INTO coordination_config (
           singleton_id, site_requests_per_second, site_max_in_flight,
           usage_page_max_in_flight, updated_at_ms
         ) VALUES (1, ?1, ?2, ?3, ?4)",
        params![
            DEFAULT_SITE_REQUESTS_PER_SECOND,
            DEFAULT_SITE_MAX_IN_FLIGHT,
            DEFAULT_USAGE_PAGE_MAX_IN_FLIGHT,
            now_ms
        ],
    )?;
    tx.execute(
        "INSERT OR IGNORE INTO upstream_network_config (
           singleton_id, use_system_proxy, updated_at_ms
         ) VALUES (1, 0, ?1)",
        params![now_ms],
    )?;
    register_runtime(&tx, registration, now_ms)?;
    let salt = tx.query_row(
        "SELECT value FROM coordination_metadata WHERE key = ?1",
        params![COORDINATION_SALT_KEY],
        |row| row.get::<_, Vec<u8>>(0),
    )?;
    let salt: [u8; 16] = salt
        .try_into()
        .map_err(|value: Vec<u8>| anyhow!("共享协调库 salt 长度无效: {}", value.len()))?;
    tx.commit()?;
    Ok(salt)
}

/// 单个站点的跨进程请求协调 handle，不携带明文 URL 或账号身份。
#[derive(Clone)]
pub struct SiteRequestCoordination {
    store: RuntimeCoordinationStore,
    site_key: CoordinationKey,
    instance_id: String,
}

impl std::fmt::Debug for SiteRequestCoordination {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SiteRequestCoordination")
            .field(
                "instance",
                &self.instance_id.chars().take(8).collect::<String>(),
            )
            .finish_non_exhaustive()
    }
}

impl SiteRequestCoordination {
    pub fn new(
        store: RuntimeCoordinationStore,
        site_key: CoordinationKey,
        instance_id: String,
    ) -> Self {
        Self {
            store,
            site_key,
            instance_id,
        }
    }

    /// 进入共享站点队列并在有界时间内等待 permit；异常时 fail closed。
    pub async fn acquire(
        &self,
        endpoint_family: &str,
        request_class: SiteRequestClass,
    ) -> Result<SiteRequestPermitGuard> {
        validate_endpoint_family(endpoint_family)?;
        let request_id = uuid::Uuid::new_v4().to_string();
        let started_at_ms = unix_time_ms();
        let deadline_ms = started_at_ms.saturating_add(REQUEST_QUEUE_MAX_WAIT_MS);
        let mut demand_guard = SiteRequestDemandGuard::new(self.clone(), request_id.clone());
        self.store
            .enqueue_site_request_demand(
                NewSiteRequestDemand {
                    request_id: request_id.clone(),
                    site_key: self.site_key,
                    instance_id: self.instance_id.clone(),
                    endpoint_family: endpoint_family.to_string(),
                    request_class: request_class.as_str().to_string(),
                    priority: request_class.priority(),
                    not_before_ms: started_at_ms,
                    expires_at_ms: started_at_ms.saturating_add(REQUEST_DEMAND_TTL_MS),
                },
                started_at_ms,
            )
            .await?;

        loop {
            let now_ms = unix_time_ms();
            if now_ms >= deadline_ms {
                demand_guard.cancel().await?;
                bail!("等待共享上游请求预算超时，请稍后重试。");
            }
            match self
                .store
                .try_acquire_site_request_permit(
                    self.site_key,
                    request_id.clone(),
                    self.instance_id.clone(),
                    now_ms,
                )
                .await?
            {
                CoordinationDecision::Acquired(permit) => {
                    demand_guard.mark_granted();
                    return Ok(SiteRequestPermitGuard::new(self.clone(), permit));
                }
                CoordinationDecision::Waiting { wait_ms } => {
                    let remaining_ms =
                        u64::try_from(deadline_ms.saturating_sub(now_ms)).unwrap_or(u64::MAX);
                    tokio::time::sleep(Duration::from_millis(
                        wait_ms
                            .min(REQUEST_QUEUE_POLL_MAX_MS)
                            .min(remaining_ms)
                            .max(1),
                    ))
                    .await;
                }
            }
        }
    }

    pub async fn set_cooldown(&self, delay_ms: u64) -> Result<SiteCooldownState> {
        self.store
            .set_site_cooldown(self.site_key, delay_ms, unix_time_ms())
            .await
    }
}

pub struct SiteRequestPermitGuard {
    coordination: SiteRequestCoordination,
    permit: Option<SiteRequestPermit>,
}

impl std::fmt::Debug for SiteRequestPermitGuard {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SiteRequestPermitGuard")
            .field(
                "endpoint_family",
                &self.permit.as_ref().map(|permit| &permit.endpoint_family),
            )
            .finish_non_exhaustive()
    }
}

impl SiteRequestPermitGuard {
    fn new(coordination: SiteRequestCoordination, permit: SiteRequestPermit) -> Self {
        Self {
            coordination,
            permit: Some(permit),
        }
    }

    pub async fn release(mut self) -> Result<bool> {
        let Some(permit) = self.permit.take() else {
            return Ok(false);
        };
        self.coordination
            .store
            .release_site_request_permit(permit)
            .await
    }
}

impl Drop for SiteRequestPermitGuard {
    fn drop(&mut self) {
        let Some(permit) = self.permit.take() else {
            return;
        };
        let coordination = self.coordination.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let _ = coordination.store.release_site_request_permit(permit).await;
            });
        }
    }
}

struct SiteRequestDemandGuard {
    coordination: SiteRequestCoordination,
    request_id: Option<String>,
}

impl SiteRequestDemandGuard {
    fn new(coordination: SiteRequestCoordination, request_id: String) -> Self {
        Self {
            coordination,
            request_id: Some(request_id),
        }
    }

    fn mark_granted(&mut self) {
        self.request_id = None;
    }

    async fn cancel(&mut self) -> Result<bool> {
        let Some(request_id) = self.request_id.take() else {
            return Ok(false);
        };
        self.coordination
            .store
            .cancel_site_request_demand(request_id, self.coordination.instance_id.clone())
            .await
    }
}

impl Drop for SiteRequestDemandGuard {
    fn drop(&mut self) {
        let Some(request_id) = self.request_id.take() else {
            return;
        };
        let coordination = self.coordination.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let _ = coordination
                    .store
                    .cancel_site_request_demand(request_id, coordination.instance_id.clone())
                    .await;
            });
        }
    }
}

pub(crate) fn validate_endpoint_family(endpoint_family: &str) -> Result<()> {
    let valid = !endpoint_family.is_empty()
        && endpoint_family.len() <= 64
        && endpoint_family.bytes().all(|value| {
            value.is_ascii_lowercase() || value.is_ascii_digit() || b"_-".contains(&value)
        });
    if !valid {
        bail!("endpoint family 必须是安全的短标识，不能包含 URL 或凭据。");
    }
    Ok(())
}

pub fn unix_time_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

fn execute_with_busy_retry<T, F>(db_path: &Path, operation: &str, action: F) -> Result<T>
where
    F: Fn(&mut Connection) -> Result<T>,
{
    let mut last_error = None;
    for attempt in 0..=SQLITE_BUSY_RETRY_COUNT {
        let result = (|| {
            let mut conn = open_connection(db_path)?;
            action(&mut conn)
        })();
        match result {
            Ok(value) => return Ok(value),
            Err(error) if is_sqlite_busy(&error) && attempt < SQLITE_BUSY_RETRY_COUNT => {
                last_error = Some(error);
                let jitter = u64::from(uuid::Uuid::new_v4().as_bytes()[0])
                    % (SQLITE_BUSY_RETRY_JITTER_MS + 1);
                std::thread::sleep(Duration::from_millis(SQLITE_BUSY_RETRY_MIN_MS + jitter));
            }
            Err(error) => {
                return Err(error).with_context(|| format!("共享协调数据库操作失败: {operation}"));
            }
        }
    }
    Err(last_error.unwrap_or_else(|| anyhow!("共享协调数据库操作失败")))
        .with_context(|| format!("共享协调数据库操作失败: {operation}"))
}

fn open_connection(db_path: &Path) -> Result<Connection> {
    let conn = Connection::open(db_path)
        .with_context(|| format!("无法打开共享协调数据库 {}", db_path.display()))?;
    // PRAGMA 配置不参与写锁排队，避免一次重试同时消耗两段 busy timeout。
    conn.busy_timeout(Duration::ZERO)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "synchronous", "FULL")?;
    conn.busy_timeout(Duration::from_millis(SQLITE_BUSY_TIMEOUT_MS))?;
    Ok(conn)
}

fn is_sqlite_busy(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<rusqlite::Error>()
            .is_some_and(|sqlite_error| match sqlite_error {
                rusqlite::Error::SqliteFailure(details, _) => matches!(
                    details.code,
                    ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked
                ),
                _ => false,
            })
    })
}

fn clamp_now(tx: &Transaction<'_>, wall_now_ms: i64) -> Result<i64> {
    let previous = tx
        .query_row(
            "SELECT CAST(value AS INTEGER) FROM coordination_metadata WHERE key = ?1",
            params![LOGICAL_CLOCK_KEY],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .unwrap_or(wall_now_ms);
    let clamped = wall_now_ms.max(previous);
    tx.execute(
        "INSERT INTO coordination_metadata (key, value, updated_at_ms)
         VALUES (?1, ?2, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms",
        params![LOGICAL_CLOCK_KEY, clamped],
    )?;
    Ok(clamped)
}

fn register_runtime(
    tx: &Transaction<'_>,
    registration: &RuntimeInstanceRegistration,
    now_ms: i64,
) -> Result<()> {
    tx.execute(
        "INSERT INTO runtime_instances (
           instance_id, runtime_scope, pid, started_at_ms, heartbeat_at_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(instance_id) DO UPDATE SET
           runtime_scope = excluded.runtime_scope,
           pid = excluded.pid,
           heartbeat_at_ms = excluded.heartbeat_at_ms",
        params![
            registration.instance_id,
            registration.runtime_scope,
            registration.pid,
            registration.started_at_ms.min(now_ms),
            now_ms
        ],
    )?;
    Ok(())
}

fn cleanup_expired(tx: &Transaction<'_>, now_ms: i64, current_instance_id: &str) -> Result<()> {
    tx.execute(
        "DELETE FROM account_sync_leases WHERE expires_at_ms <= ?1",
        params![now_ms],
    )?;
    tx.execute(
        "DELETE FROM site_request_leases WHERE expires_at_ms <= ?1",
        params![now_ms],
    )?;
    tx.execute(
        "DELETE FROM site_failover_leases WHERE expires_at_ms <= ?1",
        params![now_ms],
    )?;
    tx.execute(
        "DELETE FROM account_sync_demands WHERE expires_at_ms <= ?1",
        params![now_ms],
    )?;
    tx.execute(
        "DELETE FROM site_request_demands WHERE expires_at_ms <= ?1",
        params![now_ms],
    )?;
    tx.execute(
        "DELETE FROM runtime_instances
         WHERE instance_id <> ?1 AND heartbeat_at_ms <= ?2",
        params![
            current_instance_id,
            now_ms.saturating_sub(RUNTIME_STALE_AFTER_MS)
        ],
    )?;
    tx.execute(
        "DELETE FROM site_failover_states
         WHERE updated_at_ms <= ?1
           AND NOT EXISTS (
             SELECT 1 FROM site_failover_leases l
             WHERE l.site_key = site_failover_states.site_key
               AND l.topology_key = site_failover_states.topology_key
           )",
        params![now_ms.saturating_sub(SITE_FAILOVER_STATE_RETENTION_MS)],
    )?;
    Ok(())
}

fn ensure_site_failover_topology(
    tx: &Transaction<'_>,
    topology: &SiteFailoverTopology,
    now_ms: i64,
) -> Result<()> {
    topology.validate()?;
    tx.execute(
        "INSERT OR IGNORE INTO site_failover_states (
           site_key, topology_key, primary_address_key, active_address_key,
           evaluation_revision, transition_revision, updated_at_ms
         ) VALUES (?1, ?2, ?3, ?3, 0, 0, ?4)",
        params![
            topology.site_key.as_slice(),
            topology.topology_key.as_slice(),
            topology.primary_address_key.as_slice(),
            now_ms
        ],
    )?;
    let (stored_primary, stored_active) = tx.query_row(
        "SELECT primary_address_key, active_address_key
         FROM site_failover_states WHERE site_key = ?1 AND topology_key = ?2",
        params![
            topology.site_key.as_slice(),
            topology.topology_key.as_slice()
        ],
        |row| Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, Vec<u8>>(1)?)),
    )?;
    let stored_primary = coordination_key_from_blob(stored_primary)?;
    let stored_active = coordination_key_from_blob(stored_active)?;
    if stored_primary != topology.primary_address_key {
        bail!("共享协调库中的站点主地址身份与当前拓扑不一致。")
    }
    if !topology.contains_address(&stored_active) {
        bail!("共享协调库中的活动地址不属于当前站点拓扑。")
    }

    for address_key in &topology.address_keys {
        tx.execute(
            "INSERT OR IGNORE INTO site_failover_address_states (
               site_key, topology_key, address_key, cooldown_until_ms,
               cooldown_revision, probe_required, updated_at_ms
             ) VALUES (?1, ?2, ?3, 0, 0, 1, ?4)",
            params![
                topology.site_key.as_slice(),
                topology.topology_key.as_slice(),
                address_key.as_slice(),
                now_ms
            ],
        )?;
    }
    let stored_address_count = tx.query_row(
        "SELECT COUNT(*) FROM site_failover_address_states
         WHERE site_key = ?1 AND topology_key = ?2",
        params![
            topology.site_key.as_slice(),
            topology.topology_key.as_slice()
        ],
        |row| row.get::<_, i64>(0),
    )?;
    if stored_address_count != topology.address_keys.len() as i64 {
        bail!("共享协调库中的站点地址集合与当前拓扑不一致。")
    }
    Ok(())
}

fn read_site_failover_snapshot(
    tx: &Transaction<'_>,
    topology: &SiteFailoverTopology,
) -> Result<SiteFailoverSnapshot> {
    let (
        primary_address_key,
        active_address_key,
        evaluation_revision,
        transition_revision,
        updated_at_ms,
    ) = tx.query_row(
        "SELECT primary_address_key, active_address_key, evaluation_revision,
                transition_revision, updated_at_ms
         FROM site_failover_states WHERE site_key = ?1 AND topology_key = ?2",
        params![
            topology.site_key.as_slice(),
            topology.topology_key.as_slice()
        ],
        |row| {
            Ok((
                row.get::<_, Vec<u8>>(0)?,
                row.get::<_, Vec<u8>>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
            ))
        },
    )?;
    let primary_address_key = coordination_key_from_blob(primary_address_key)?;
    let active_address_key = coordination_key_from_blob(active_address_key)?;

    let mut stmt = tx.prepare(
        "SELECT address_key, cooldown_until_ms, cooldown_revision, probe_required,
                last_failure_category, last_http_status, updated_at_ms
         FROM site_failover_address_states
         WHERE site_key = ?1 AND topology_key = ?2",
    )?;
    let rows = stmt.query_map(
        params![
            topology.site_key.as_slice(),
            topology.topology_key.as_slice()
        ],
        |row| {
            Ok((
                row.get::<_, Vec<u8>>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<i64>>(5)?,
                row.get::<_, i64>(6)?,
            ))
        },
    )?;
    let mut by_key = std::collections::HashMap::new();
    for row in rows {
        let (
            address_key,
            cooldown_until_ms,
            cooldown_revision,
            probe_required,
            last_failure_category,
            last_http_status,
            address_updated_at_ms,
        ) = row?;
        let address_key = coordination_key_from_blob(address_key)?;
        let last_http_status = last_http_status
            .map(|status| {
                u16::try_from(status)
                    .map_err(|_| anyhow!("共享协调库中的 HTTP 状态码超出可表示范围。"))
            })
            .transpose()?;
        by_key.insert(
            address_key,
            SiteFailoverAddressState {
                address_key,
                cooldown_until_ms,
                cooldown_revision,
                probe_required: probe_required != 0,
                last_failure_category,
                last_http_status,
                updated_at_ms: address_updated_at_ms,
            },
        );
    }
    drop(stmt);
    let mut addresses = Vec::with_capacity(topology.address_keys.len());
    for address_key in &topology.address_keys {
        addresses.push(
            by_key
                .remove(address_key)
                .ok_or_else(|| anyhow!("共享协调库缺少当前拓扑的地址状态。"))?,
        );
    }
    if !by_key.is_empty() {
        bail!("共享协调库包含当前拓扑之外的地址状态。")
    }

    Ok(SiteFailoverSnapshot {
        site_key: topology.site_key,
        topology_key: topology.topology_key,
        primary_address_key,
        active_address_key,
        evaluation_revision,
        transition_revision,
        updated_at_ms,
        addresses,
    })
}

fn coordination_key_from_blob(value: Vec<u8>) -> Result<CoordinationKey> {
    value
        .try_into()
        .map_err(|value: Vec<u8>| anyhow!("共享协调库中的协调键长度无效: {}", value.len()))
}

fn prune_site_failover_transitions(tx: &Transaction<'_>) -> Result<()> {
    let latest_revision = tx.query_row(
        "SELECT COALESCE(MAX(revision), 0) FROM site_failover_transitions",
        [],
        |row| row.get::<_, i64>(0),
    )?;
    let keep_after = latest_revision.saturating_sub(SITE_FAILOVER_TRANSITION_RETENTION);
    tx.execute(
        "DELETE FROM site_failover_transitions WHERE revision <= ?1",
        params![keep_after],
    )?;
    Ok(())
}

fn ensure_site_schedule(
    tx: &Transaction<'_>,
    site_key: &CoordinationKey,
    now_ms: i64,
) -> Result<()> {
    tx.execute(
        "INSERT OR IGNORE INTO site_request_schedule (
           site_key, next_allowed_at_ms, cooldown_until_ms, cooldown_revision, updated_at_ms
         ) VALUES (?1, 0, 0, 0, ?2)",
        params![site_key.as_slice(), now_ms],
    )?;
    Ok(())
}

fn read_config(conn: &Connection) -> Result<SharedRuntimeCoordinationConfig> {
    let config = conn.query_row(
        "SELECT site_requests_per_second, site_max_in_flight, usage_page_max_in_flight
         FROM coordination_config WHERE singleton_id = 1",
        [],
        |row| {
            Ok(SharedRuntimeCoordinationConfig {
                site_requests_per_second: row.get(0)?,
                site_max_in_flight: row.get(1)?,
                usage_page_max_in_flight: row.get(2)?,
            })
        },
    )?;
    config.validate()
}

fn read_upstream_network_config(conn: &Connection) -> Result<UpstreamNetworkConfig> {
    let use_system_proxy = conn.query_row(
        "SELECT use_system_proxy FROM upstream_network_config WHERE singleton_id = 1",
        [],
        |row| row.get::<_, i64>(0),
    )?;
    match use_system_proxy {
        0 => Ok(UpstreamNetworkConfig {
            use_system_proxy: false,
        }),
        1 => Ok(UpstreamNetworkConfig {
            use_system_proxy: true,
        }),
        value => bail!("上游网络配置值无效: {value}。"),
    }
}

fn bounded_wait_ms(delta_ms: i64) -> u64 {
    u64::try_from(delta_ms.max(25)).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::Instant;

    use super::*;

    fn test_store(label: &str) -> (RuntimeCoordinationStore, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "input-panel-runtime-coordination-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("create coordination test root");
        let path = root.join("runtime-coordination.sqlite");
        (RuntimeCoordinationStore::new(path), root)
    }

    fn registration(instance_id: &str, started_at_ms: i64) -> RuntimeInstanceRegistration {
        RuntimeInstanceRegistration {
            instance_id: instance_id.into(),
            runtime_scope: "isolated".into(),
            pid: 100,
            started_at_ms,
        }
    }

    #[tokio::test]
    async fn upstream_network_config_defaults_to_direct_and_is_shared_across_instances() {
        let (first, root) = test_store("upstream-network-shared");
        let second = RuntimeCoordinationStore::new(first.path().to_path_buf());
        first
            .initialize_and_register_for_test(&registration("web-instance", 1_000))
            .expect("initialize first runtime");
        second
            .initialize_and_register_for_test(&registration("desktop-instance", 1_000))
            .expect("initialize second runtime");

        assert_eq!(
            first
                .get_upstream_network_config()
                .await
                .expect("read direct default"),
            UpstreamNetworkConfig::default()
        );
        let system_proxy = UpstreamNetworkConfig {
            use_system_proxy: true,
        };
        first
            .update_upstream_network_config(system_proxy, 1_001)
            .await
            .expect("enable system proxy");
        assert_eq!(
            second
                .get_upstream_network_config()
                .await
                .expect("read shared system proxy mode"),
            system_proxy
        );

        second
            .update_upstream_network_config(UpstreamNetworkConfig::default(), 1_002)
            .await
            .expect("restore direct mode");
        assert_eq!(
            first
                .get_upstream_network_config()
                .await
                .expect("read shared direct mode"),
            UpstreamNetworkConfig::default()
        );

        drop(second);
        drop(first);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn legacy_coordination_database_gains_the_direct_upstream_network_default() {
        let (store, root) = test_store("upstream-network-upgrade");
        let legacy = Connection::open(store.path()).expect("open legacy coordination database");
        legacy
            .execute_batch(
                "CREATE TABLE coordination_metadata (
                   key TEXT PRIMARY KEY,
                   value BLOB NOT NULL,
                   updated_at_ms INTEGER NOT NULL
                 );
                 CREATE TABLE coordination_config (
                   singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
                   site_requests_per_second INTEGER NOT NULL,
                   site_max_in_flight INTEGER NOT NULL,
                   usage_page_max_in_flight INTEGER NOT NULL,
                   updated_at_ms INTEGER NOT NULL
                 );",
            )
            .expect("seed legacy coordination schema");
        drop(legacy);

        store
            .initialize_and_register_for_test(&registration("upgraded-instance", 1_000))
            .expect("upgrade legacy coordination database");
        assert_eq!(
            store
                .get_upstream_network_config()
                .await
                .expect("read upgraded direct default"),
            UpstreamNetworkConfig::default()
        );

        let conn = Connection::open(store.path()).expect("inspect upgraded coordination database");
        let rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM upstream_network_config
                 WHERE singleton_id = 1 AND use_system_proxy = 0",
                [],
                |row| row.get(0),
            )
            .expect("read upgraded upstream network row");
        assert_eq!(rows, 1);
        drop(conn);
        drop(store);
        let _ = fs::remove_dir_all(root);
    }

    fn account_demand(
        instance_id: &str,
        demand_id: &str,
        account_key: CoordinationKey,
        priority: i64,
        not_before_ms: i64,
    ) -> NewAccountSyncDemand {
        NewAccountSyncDemand {
            demand_id: demand_id.into(),
            account_key,
            instance_id: instance_id.into(),
            work_kind: "fresh_usage".into(),
            priority,
            not_before_ms,
            expires_at_ms: not_before_ms + ACCOUNT_DEMAND_TTL_MS,
        }
    }

    fn request_demand(
        instance_id: &str,
        request_id: &str,
        site_key: CoordinationKey,
        endpoint_family: &str,
        now_ms: i64,
    ) -> NewSiteRequestDemand {
        NewSiteRequestDemand {
            request_id: request_id.into(),
            site_key,
            instance_id: instance_id.into(),
            endpoint_family: endpoint_family.into(),
            request_class: "fresh_usage".into(),
            priority: 300,
            not_before_ms: now_ms,
            expires_at_ms: now_ms + REQUEST_DEMAND_TTL_MS,
        }
    }

    fn failover_topology() -> SiteFailoverTopology {
        SiteFailoverTopology {
            site_key: [21; 32],
            topology_key: [22; 32],
            primary_address_key: [23; 32],
            address_keys: vec![[23; 32], [24; 32], [25; 32]],
        }
    }

    #[tokio::test]
    async fn independent_connections_grant_only_one_account_lease_and_keep_peer_demand() {
        let (first, root) = test_store("account-race");
        let second = RuntimeCoordinationStore::new(first.path().to_path_buf());
        first
            .initialize_and_register_for_test(&registration("web-instance", 1_000))
            .expect("initialize first runtime");
        second
            .initialize_and_register_for_test(&registration("desktop-instance", 1_000))
            .expect("initialize second runtime");
        let key = [7; 32];
        let web_demand = first
            .enqueue_account_demand(
                account_demand("web-instance", "web-demand", key, 300, 1_000),
                1_000,
            )
            .await
            .expect("enqueue web demand");
        let desktop_demand = second
            .enqueue_account_demand(
                account_demand("desktop-instance", "desktop-demand", key, 300, 1_000),
                1_000,
            )
            .await
            .expect("enqueue desktop demand");

        let (web, desktop) = tokio::join!(
            first.try_acquire_account_lease(key, web_demand, "web-instance".into(), 1_000),
            second.try_acquire_account_lease(key, desktop_demand, "desktop-instance".into(), 1_000)
        );
        let acquired = [
            web.expect("web decision"),
            desktop.expect("desktop decision"),
        ]
        .into_iter()
        .filter(|decision| matches!(decision, CoordinationDecision::Acquired(_)))
        .count();
        assert_eq!(acquired, 1);

        let conn = Connection::open(first.path()).expect("inspect coordination database");
        let queued: i64 = conn
            .query_row("SELECT COUNT(*) FROM account_sync_demands", [], |row| {
                row.get(0)
            })
            .expect("count peer demand");
        assert_eq!(queued, 1, "winner must not delete peer runtime demand");
        drop(conn);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn due_work_bundle_consumes_only_the_winner_runtime_demands() {
        let (store, root) = test_store("account-due-bundle");
        store
            .initialize_and_register_for_test(&registration("web-instance", 1_000))
            .expect("register web runtime");
        store
            .initialize_and_register_for_test(&registration("desktop-instance", 1_000))
            .expect("register desktop runtime");
        let key = [17; 32];
        let mut peer = account_demand("desktop-instance", "desktop-subscriptions", key, 200, 1_000);
        peer.work_kind = "due_subscriptions".into();
        store
            .enqueue_account_demand(peer, 1_000)
            .await
            .expect("enqueue peer demand");
        let mut subscriptions =
            account_demand("web-instance", "web-subscriptions", key, 200, 1_000);
        subscriptions.work_kind = "due_subscriptions".into();

        let grant = match store
            .enqueue_due_work_and_try_acquire_account_lease(
                vec![
                    account_demand("web-instance", "web-fresh", key, 300, 1_000),
                    subscriptions,
                ],
                1_000,
            )
            .await
            .expect("acquire due work bundle")
        {
            CoordinationDecision::Acquired(grant) => grant,
            CoordinationDecision::Waiting { .. } => panic!("web fresh demand should win"),
        };

        assert_eq!(
            grant.work_kinds,
            ["fresh_usage".to_string(), "due_subscriptions".to_string()]
        );
        let conn = Connection::open(store.path()).expect("inspect coordination database");
        let remaining = conn
            .prepare(
                "SELECT instance_id, work_kind FROM account_sync_demands
                 ORDER BY instance_id, work_kind",
            )
            .expect("prepare remaining demand query")
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .expect("query remaining demands")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("collect remaining demands");
        assert_eq!(
            remaining,
            [(
                "desktop-instance".to_string(),
                "due_subscriptions".to_string()
            )]
        );
        drop(conn);
        assert!(store
            .release_account_lease(grant.lease)
            .await
            .expect("release bundled lease"));
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn history_lease_yields_to_a_fresh_peer_demand() {
        let (store, root) = test_store("account-history-yield");
        store
            .initialize_and_register_for_test(&registration("history-instance", 1_000))
            .expect("register history runtime");
        store
            .initialize_and_register_for_test(&registration("fresh-instance", 1_000))
            .expect("register fresh runtime");
        let key = [18; 32];
        let mut history = account_demand("history-instance", "history-demand", key, 100, 1_000);
        history.work_kind = "history_maintenance".into();
        let history_id = store
            .enqueue_account_demand(history, 1_000)
            .await
            .expect("enqueue history demand");
        let history_lease = match store
            .try_acquire_account_lease(key, history_id, "history-instance".into(), 1_000)
            .await
            .expect("acquire history lease")
        {
            CoordinationDecision::Acquired(lease) => lease,
            CoordinationDecision::Waiting { .. } => panic!("history runtime should acquire"),
        };
        store
            .enqueue_account_demand(
                account_demand("fresh-instance", "fresh-demand", key, 300, 1_100),
                1_100,
            )
            .await
            .expect("enqueue fresh peer demand");

        assert!(store
            .should_yield_account_lease(history_lease.clone(), 1_100)
            .await
            .expect("check peer pressure"));
        assert!(store
            .release_account_lease(history_lease)
            .await
            .expect("release history lease"));
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn aged_account_demand_uses_fifo_and_cannot_be_starved_by_fresh_priority() {
        let (store, root) = test_store("account-aging");
        store
            .initialize_and_register_for_test(&registration("old-instance", 1_000))
            .expect("register old runtime");
        store
            .initialize_and_register_for_test(&registration("fresh-instance", 1_000))
            .expect("register fresh runtime");
        let key = [8; 32];
        let old_id = store
            .enqueue_account_demand(
                account_demand("old-instance", "old-demand", key, 100, 1_000),
                1_000,
            )
            .await
            .expect("enqueue old demand");
        let fresh_id = store
            .enqueue_account_demand(
                account_demand("fresh-instance", "fresh-demand", key, 300, 10_000),
                10_000,
            )
            .await
            .expect("enqueue fresh demand");

        let fresh = store
            .try_acquire_account_lease(key, fresh_id, "fresh-instance".into(), 10_000)
            .await
            .expect("fresh decision");
        assert!(matches!(fresh, CoordinationDecision::Waiting { .. }));
        let old = store
            .try_acquire_account_lease(key, old_id, "old-instance".into(), 10_000)
            .await
            .expect("old decision");
        assert!(matches!(old, CoordinationDecision::Acquired(_)));
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn expired_owner_is_replaced_and_old_token_cannot_release_new_lease() {
        let (store, root) = test_store("account-takeover");
        store
            .initialize_and_register_for_test(&registration("first-instance", 1_000))
            .expect("register first runtime");
        store
            .initialize_and_register_for_test(&registration("second-instance", 1_000))
            .expect("register second runtime");
        let key = [9; 32];
        let first_demand = store
            .enqueue_account_demand(
                account_demand("first-instance", "first-demand", key, 300, 1_000),
                1_000,
            )
            .await
            .expect("enqueue first demand");
        let first_lease = match store
            .try_acquire_account_lease(key, first_demand, "first-instance".into(), 1_000)
            .await
            .expect("first decision")
        {
            CoordinationDecision::Acquired(lease) => lease,
            CoordinationDecision::Waiting { .. } => panic!("first runtime should acquire"),
        };
        let takeover_at = 1_000 + ACCOUNT_LEASE_TTL_MS;
        let second_demand = store
            .enqueue_account_demand(
                account_demand("second-instance", "second-demand", key, 300, takeover_at),
                takeover_at,
            )
            .await
            .expect("enqueue second demand");
        let second_lease = match store
            .try_acquire_account_lease(key, second_demand, "second-instance".into(), takeover_at)
            .await
            .expect("takeover decision")
        {
            CoordinationDecision::Acquired(lease) => lease,
            CoordinationDecision::Waiting { .. } => panic!("expired owner should be replaced"),
        };

        assert!(!store
            .release_account_lease(first_lease)
            .await
            .expect("old release result"));
        assert!(store
            .release_account_lease(second_lease)
            .await
            .expect("new release result"));
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn request_permits_enforce_rps_total_and_usage_in_flight_limits() {
        let (store, root) = test_store("request-limits");
        store
            .initialize_and_register_for_test(&registration("runtime", 1_000))
            .expect("register runtime");
        store
            .update_config(
                SharedRuntimeCoordinationConfig {
                    site_requests_per_second: 2,
                    site_max_in_flight: 2,
                    usage_page_max_in_flight: 1,
                },
                1_000,
            )
            .await
            .expect("update config");
        let site = [3; 32];

        store
            .enqueue_site_request_demand(
                request_demand(
                    "runtime",
                    "usage-1",
                    site,
                    USAGE_PAGE_ENDPOINT_FAMILY,
                    1_000,
                ),
                1_000,
            )
            .await
            .expect("enqueue first usage request");
        let usage_1 = match store
            .try_acquire_site_request_permit(site, "usage-1".into(), "runtime".into(), 1_000)
            .await
            .expect("first usage decision")
        {
            CoordinationDecision::Acquired(permit) => permit,
            CoordinationDecision::Waiting { .. } => panic!("first request should acquire"),
        };
        store
            .enqueue_site_request_demand(
                request_demand(
                    "runtime",
                    "usage-2",
                    site,
                    USAGE_PAGE_ENDPOINT_FAMILY,
                    1_500,
                ),
                1_500,
            )
            .await
            .expect("enqueue second usage request");
        assert!(matches!(
            store
                .try_acquire_site_request_permit(site, "usage-2".into(), "runtime".into(), 1_500)
                .await
                .expect("second usage decision"),
            CoordinationDecision::Waiting { .. }
        ));

        store
            .enqueue_site_request_demand(
                request_demand("runtime", "profile-1", site, "profile", 1_500),
                1_500,
            )
            .await
            .expect("enqueue profile request");
        let profile = match store
            .try_acquire_site_request_permit(site, "profile-1".into(), "runtime".into(), 1_500)
            .await
            .expect("profile decision")
        {
            CoordinationDecision::Acquired(permit) => permit,
            CoordinationDecision::Waiting { .. } => panic!("non-usage request should acquire"),
        };
        store
            .enqueue_site_request_demand(
                request_demand("runtime", "profile-2", site, "profile", 2_000),
                2_000,
            )
            .await
            .expect("enqueue second profile request");
        assert!(matches!(
            store
                .try_acquire_site_request_permit(site, "profile-2".into(), "runtime".into(), 2_000)
                .await
                .expect("total limit decision"),
            CoordinationDecision::Waiting { .. }
        ));

        store
            .release_site_request_permit(usage_1)
            .await
            .expect("release first usage permit");
        store
            .release_site_request_permit(profile)
            .await
            .expect("release profile permit");
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn request_permit_waits_for_the_shared_rps_schedule() {
        let (store, root) = test_store("request-rps");
        store
            .initialize_and_register_for_test(&registration("runtime", 1_000))
            .expect("register runtime");
        let site = [4; 32];
        store
            .enqueue_site_request_demand(
                request_demand("runtime", "first", site, "profile", 1_000),
                1_000,
            )
            .await
            .expect("enqueue first request");
        let first = match store
            .try_acquire_site_request_permit(site, "first".into(), "runtime".into(), 1_000)
            .await
            .expect("first permit decision")
        {
            CoordinationDecision::Acquired(permit) => permit,
            CoordinationDecision::Waiting { .. } => panic!("first request should acquire"),
        };
        store
            .enqueue_site_request_demand(
                request_demand("runtime", "second", site, "profile", 1_000),
                1_000,
            )
            .await
            .expect("enqueue second request");

        let early = store
            .try_acquire_site_request_permit(site, "second".into(), "runtime".into(), 1_333)
            .await
            .expect("early permit decision");
        assert!(matches!(
            early,
            CoordinationDecision::Waiting { wait_ms: 25 }
        ));
        let due = store
            .try_acquire_site_request_permit(site, "second".into(), "runtime".into(), 1_334)
            .await
            .expect("due permit decision");
        assert!(matches!(due, CoordinationDecision::Acquired(_)));

        store
            .release_site_request_permit(first)
            .await
            .expect("release first permit");
        if let CoordinationDecision::Acquired(second) = due {
            store
                .release_site_request_permit(second)
                .await
                .expect("release second permit");
        }
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn failover_cooldown_is_independent_monotonic_and_cas_protected() {
        let (store, root) = test_store("failover-cooldown");
        store
            .initialize_and_register_for_test(&registration("runtime", 1_000))
            .expect("register runtime");
        let topology = failover_topology();
        let initial = store
            .load_or_initialize_site_failover(topology.clone(), 1_000)
            .await
            .expect("initialize failover state");
        assert_eq!(initial.active_address_key, topology.primary_address_key);
        assert!(initial
            .addresses
            .iter()
            .all(|address| address.probe_required));

        let (changed, failed) = store
            .record_site_failover_failure(
                topology.clone(),
                topology.primary_address_key,
                Some(0),
                5_000,
                SiteFailoverFailureCategory::Timeout,
                None,
                1_000,
            )
            .await
            .expect("record primary failure");
        assert!(changed);
        let primary = failed
            .address(&topology.primary_address_key)
            .expect("primary state");
        assert_eq!(primary.cooldown_until_ms, 5_000);
        assert_eq!(primary.cooldown_revision, 1);
        assert_eq!(
            failed
                .address(&topology.address_keys[1])
                .expect("fallback")
                .cooldown_until_ms,
            0
        );

        let (changed, stale) = store
            .record_site_failover_failure(
                topology.clone(),
                topology.primary_address_key,
                Some(0),
                9_000,
                SiteFailoverFailureCategory::Transport,
                None,
                2_000,
            )
            .await
            .expect("reject stale failure");
        assert!(!changed);
        assert_eq!(
            stale
                .address(&topology.primary_address_key)
                .expect("primary")
                .cooldown_until_ms,
            5_000
        );

        let (changed, extended) = store
            .record_site_failover_failure(
                topology.clone(),
                topology.primary_address_key,
                Some(1),
                4_000,
                SiteFailoverFailureCategory::RateLimited,
                Some(429),
                2_000,
            )
            .await
            .expect("record newer failure without shortening cooldown");
        assert!(changed);
        assert_eq!(
            extended
                .address(&topology.primary_address_key)
                .expect("primary")
                .cooldown_until_ms,
            5_000
        );

        let cleared = store
            .clear_site_failover_cooldown(topology.clone(), topology.primary_address_key, 2_500)
            .await
            .expect("clear primary cooldown");
        let primary = cleared
            .address(&topology.primary_address_key)
            .expect("cleared primary");
        assert_eq!(primary.cooldown_until_ms, 0);
        assert!(primary.probe_required);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn failover_lease_fences_stale_owner_and_records_only_real_transitions() {
        let (first, root) = test_store("failover-lease");
        let second = RuntimeCoordinationStore::new(first.path().to_path_buf());
        first
            .initialize_and_register_for_test(&registration("web", 1_000))
            .expect("register web runtime");
        second
            .initialize_and_register_for_test(&registration("desktop", 1_000))
            .expect("register desktop runtime");
        let topology = failover_topology();
        let initial = first
            .load_or_initialize_site_failover(topology.clone(), 1_000)
            .await
            .expect("initialize failover state");
        let old_lease = match first
            .try_acquire_site_failover_lease(topology.clone(), "web".into(), 1_000)
            .await
            .expect("acquire first lease")
        {
            CoordinationDecision::Acquired(lease) => lease,
            CoordinationDecision::Waiting { .. } => panic!("first runtime should acquire"),
        };
        assert!(matches!(
            second
                .try_acquire_site_failover_lease(topology.clone(), "desktop".into(), 1_000)
                .await
                .expect("peer lease decision"),
            CoordinationDecision::Waiting { .. }
        ));

        let takeover_at = 1_000 + SITE_FAILOVER_LEASE_TTL_MS + 1;
        let new_lease = match second
            .try_acquire_site_failover_lease(topology.clone(), "desktop".into(), takeover_at)
            .await
            .expect("take over expired lease")
        {
            CoordinationDecision::Acquired(lease) => lease,
            CoordinationDecision::Waiting { .. } => panic!("expired lease should be replaceable"),
        };
        let fallback_key = topology.address_keys[1];
        let fallback_revision = initial
            .address(&fallback_key)
            .expect("fallback state")
            .cooldown_revision;
        assert!(first
            .complete_site_failover_evaluation(
                topology.clone(),
                old_lease,
                Some(SiteFailoverWinner {
                    address_key: fallback_key,
                    observed_cooldown_revision: fallback_revision,
                }),
                takeover_at + 1,
            )
            .await
            .expect("reject stale owner")
            .is_none());
        let switched = second
            .complete_site_failover_evaluation(
                topology.clone(),
                new_lease,
                Some(SiteFailoverWinner {
                    address_key: fallback_key,
                    observed_cooldown_revision: fallback_revision,
                }),
                takeover_at + 1,
            )
            .await
            .expect("commit fallback winner")
            .expect("current owner commits");
        assert_eq!(switched.active_address_key, fallback_key);
        assert_eq!(switched.evaluation_revision, 1);

        let repeated_lease = match second
            .try_acquire_site_failover_lease(topology.clone(), "desktop".into(), takeover_at + 2)
            .await
            .expect("acquire repeated evaluation")
        {
            CoordinationDecision::Acquired(lease) => lease,
            CoordinationDecision::Waiting { .. } => panic!("released lease should be available"),
        };
        let repeated_revision = switched
            .address(&fallback_key)
            .expect("active fallback")
            .cooldown_revision;
        second
            .complete_site_failover_evaluation(
                topology.clone(),
                repeated_lease,
                Some(SiteFailoverWinner {
                    address_key: fallback_key,
                    observed_cooldown_revision: repeated_revision,
                }),
                takeover_at + 3,
            )
            .await
            .expect("commit repeated winner")
            .expect("owner remains current");

        let primary_lease = match first
            .try_acquire_site_failover_lease(topology.clone(), "web".into(), takeover_at + 4)
            .await
            .expect("acquire primary recovery evaluation")
        {
            CoordinationDecision::Acquired(lease) => lease,
            CoordinationDecision::Waiting { .. } => panic!("lease should be available"),
        };
        let latest = first
            .load_or_initialize_site_failover(topology.clone(), takeover_at + 4)
            .await
            .expect("load latest snapshot");
        let primary_revision = latest
            .address(&topology.primary_address_key)
            .expect("primary state")
            .cooldown_revision;
        first
            .complete_site_failover_evaluation(
                topology.clone(),
                primary_lease,
                Some(SiteFailoverWinner {
                    address_key: topology.primary_address_key,
                    observed_cooldown_revision: primary_revision,
                }),
                takeover_at + 5,
            )
            .await
            .expect("commit primary recovery")
            .expect("owner remains current");

        let transitions = first
            .list_site_failover_transitions(0, 100)
            .await
            .expect("list transitions");
        assert_eq!(transitions.events.len(), 2);
        assert_eq!(
            transitions.events[0].kind,
            SiteFailoverTransitionKind::SwitchedToFallback
        );
        assert_eq!(
            transitions.events[1].kind,
            SiteFailoverTransitionKind::PrimaryRestored
        );

        drop(first);
        let restarted = RuntimeCoordinationStore::new(second.path().to_path_buf());
        restarted
            .initialize_and_register_for_test(&registration("restart", takeover_at + 6))
            .expect("register restarted runtime");
        let persisted = restarted
            .load_or_initialize_site_failover(topology.clone(), takeover_at + 6)
            .await
            .expect("load persisted state");
        assert_eq!(persisted.active_address_key, topology.primary_address_key);
        assert_eq!(persisted.evaluation_revision, 3);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn busy_database_returns_within_bounded_time() {
        let (store, root) = test_store("busy-bound");
        store
            .initialize_and_register_for_test(&registration("runtime", 1_000))
            .expect("register runtime");
        let lock = Connection::open(store.path()).expect("open lock connection");
        lock.busy_timeout(Duration::from_millis(SQLITE_BUSY_TIMEOUT_MS))
            .expect("configure lock timeout");
        lock.execute_batch("BEGIN IMMEDIATE")
            .expect("hold coordination write lock");
        let started = Instant::now();

        let error = store
            .update_config(SharedRuntimeCoordinationConfig::default(), 2_000)
            .await
            .expect_err("busy database should fail closed");

        let retry_budget = Duration::from_millis(
            SQLITE_BUSY_TIMEOUT_MS * (SQLITE_BUSY_RETRY_COUNT as u64 + 1)
                + (SQLITE_BUSY_RETRY_MIN_MS + SQLITE_BUSY_RETRY_JITTER_MS)
                    * SQLITE_BUSY_RETRY_COUNT as u64,
        );
        let elapsed = started.elapsed();
        assert!(
            elapsed < retry_budget + Duration::from_secs(2),
            "busy database response exceeded bounded retry budget: {elapsed:?}"
        );
        assert!(format!("{error:#}").contains("共享协调数据库"));
        lock.execute_batch("ROLLBACK").expect("release write lock");
        drop(lock);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn corrupted_database_fails_closed_without_replacing_file() {
        let (store, root) = test_store("corrupted");
        let original = b"not a sqlite database";
        fs::write(store.path(), original).expect("seed corrupted coordination database");

        let error = store
            .initialize_and_register_for_test(&registration("runtime", 1_000))
            .expect_err("corrupted coordination database must fail startup");

        assert!(format!("{error:#}").contains("共享协调数据库"));
        assert_eq!(
            fs::read(store.path()).expect("read corrupted file"),
            original
        );
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn coordination_files_do_not_store_plain_identity_or_credentials() {
        let (store, root) = test_store("redaction");
        store
            .initialize_and_register_for_test(&registration("runtime", 1_000))
            .expect("register runtime");
        let account_key = [11; 32];
        store
            .enqueue_account_demand(
                account_demand("runtime", "redacted-demand", account_key, 300, 1_000),
                1_000,
            )
            .await
            .expect("enqueue redacted demand");
        let conn = Connection::open(store.path()).expect("open coordination database");
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .expect("checkpoint coordination database");
        drop(conn);

        let forbidden = [
            "private@example.test",
            "secret-token",
            "password-value",
            "Cookie:",
            "https://example.test/api?token=secret-token",
        ];
        for entry in fs::read_dir(&root).expect("list coordination files") {
            let entry = entry.expect("read coordination entry");
            if !entry.path().is_file() {
                continue;
            }
            let bytes = fs::read(entry.path()).expect("read coordination artifact");
            let text = String::from_utf8_lossy(&bytes);
            for secret in forbidden {
                assert!(
                    !text.contains(secret),
                    "coordination artifact leaked {secret}"
                );
            }
        }
        let _ = fs::remove_dir_all(root);
    }
}
