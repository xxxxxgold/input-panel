use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};

use crate::contracts::{RuntimeCoordinationConfigPayload, UpstreamNetworkConfigPayload};
use crate::domain::site_url::canonicalize_site_base_url;
use crate::infrastructure::files::AppPaths;
use crate::infrastructure::runtime_coordination::{
    unix_time_ms, AccountSyncLease, AccountSyncLeaseGrant, CoordinationDecision, CoordinationKey,
    NewAccountSyncDemand, RuntimeCoordinationStore, RuntimeInstanceRegistration,
    SharedRuntimeCoordinationConfig, SiteCooldownState, SiteFailoverFailureCategory,
    SiteFailoverLease, SiteFailoverSnapshot, SiteFailoverTopology, SiteFailoverTransitionPage,
    SiteFailoverWinner, SiteRequestClass, SiteRequestCoordination, SiteRequestPermitGuard,
    UpstreamNetworkConfig, ACCOUNT_DEMAND_TTL_MS, RUNTIME_HEARTBEAT_INTERVAL_MS,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackgroundSyncWorkKind {
    FreshUsage,
    DueSubscriptions,
    HistoryMaintenance,
}

impl BackgroundSyncWorkKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::FreshUsage => "fresh_usage",
            Self::DueSubscriptions => "due_subscriptions",
            Self::HistoryMaintenance => "history_maintenance",
        }
    }

    fn priority(self) -> i64 {
        match self {
            Self::FreshUsage => 300,
            Self::DueSubscriptions => 200,
            Self::HistoryMaintenance => 100,
        }
    }

    fn from_str(value: &str) -> Result<Self> {
        match value {
            "fresh_usage" => Ok(Self::FreshUsage),
            "due_subscriptions" => Ok(Self::DueSubscriptions),
            "history_maintenance" => Ok(Self::HistoryMaintenance),
            _ => bail!("共享协调器返回了未知后台工作类型。"),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct BackgroundSyncDueWork {
    pub fresh_usage: bool,
    pub subscriptions: bool,
    pub history_maintenance: bool,
}

impl BackgroundSyncDueWork {
    pub fn is_empty(self) -> bool {
        !self.fresh_usage && !self.subscriptions && !self.history_maintenance
    }

    pub fn contains(self, work_kind: BackgroundSyncWorkKind) -> bool {
        match work_kind {
            BackgroundSyncWorkKind::FreshUsage => self.fresh_usage,
            BackgroundSyncWorkKind::DueSubscriptions => self.subscriptions,
            BackgroundSyncWorkKind::HistoryMaintenance => self.history_maintenance,
        }
    }

    pub fn insert(&mut self, work_kind: BackgroundSyncWorkKind) {
        match work_kind {
            BackgroundSyncWorkKind::FreshUsage => self.fresh_usage = true,
            BackgroundSyncWorkKind::DueSubscriptions => self.subscriptions = true,
            BackgroundSyncWorkKind::HistoryMaintenance => self.history_maintenance = true,
        }
    }

    fn work_kinds(self) -> impl Iterator<Item = BackgroundSyncWorkKind> {
        [
            BackgroundSyncWorkKind::FreshUsage,
            BackgroundSyncWorkKind::DueSubscriptions,
            BackgroundSyncWorkKind::HistoryMaintenance,
        ]
        .into_iter()
        .filter(move |work_kind| self.contains(*work_kind))
    }
}

#[derive(Debug)]
pub struct AccountDueWorkLease {
    pub lease: AccountLeaseGuard,
    pub due_work: BackgroundSyncDueWork,
}

struct RuntimeCoordinationInner {
    store: RuntimeCoordinationStore,
    registration: RuntimeInstanceRegistration,
    salt: [u8; 16],
    heartbeat_started: AtomicBool,
}

#[derive(Clone)]
pub struct RuntimeCoordinationService {
    inner: Arc<RuntimeCoordinationInner>,
}

#[derive(Clone)]
pub struct SiteFailoverIdentity {
    topology: SiteFailoverTopology,
    canonical_addresses: Vec<String>,
}

impl std::fmt::Debug for SiteFailoverIdentity {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SiteFailoverIdentity")
            .field("address_count", &self.canonical_addresses.len())
            .finish_non_exhaustive()
    }
}

impl SiteFailoverIdentity {
    pub fn topology(&self) -> &SiteFailoverTopology {
        &self.topology
    }

    pub fn canonical_addresses(&self) -> &[String] {
        &self.canonical_addresses
    }

    pub fn address_key_at(&self, index: usize) -> Option<CoordinationKey> {
        self.topology.address_keys.get(index).copied()
    }

    pub fn address_key_for_base_url(&self, base_url: &str) -> Result<CoordinationKey> {
        let canonical = canonicalize_site_base_url(base_url)?;
        self.canonical_addresses
            .iter()
            .position(|candidate| candidate == &canonical)
            .and_then(|index| self.address_key_at(index))
            .ok_or_else(|| anyhow::anyhow!("地址不属于当前站点故障转移拓扑。"))
    }

    pub fn base_url_for_key(&self, address_key: &CoordinationKey) -> Option<&str> {
        self.topology
            .address_keys
            .iter()
            .position(|candidate| candidate == address_key)
            .and_then(|index| self.canonical_addresses.get(index))
            .map(String::as_str)
    }
}

impl std::fmt::Debug for RuntimeCoordinationService {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RuntimeCoordinationService")
            .field("runtime_scope", &self.inner.registration.runtime_scope)
            .field("pid", &self.inner.registration.pid)
            .field("instance", &self.short_instance_id())
            .finish_non_exhaustive()
    }
}

impl RuntimeCoordinationService {
    /// 使用 AppPaths 的统一用户级协调库装配当前 runtime；初始化失败时直接返回错误。
    pub async fn from_paths(paths: &AppPaths) -> Result<Self> {
        let started_at_ms = unix_time_ms();
        let registration = RuntimeInstanceRegistration {
            instance_id: uuid::Uuid::new_v4().to_string(),
            runtime_scope: paths.runtime_scope.as_str().to_string(),
            pid: std::process::id(),
            started_at_ms,
        };
        let store = RuntimeCoordinationStore::new(paths.coordination_db_path.clone());
        let salt = store
            .initialize_and_register(&registration)
            .await
            .context("共享运行时协调器初始化失败，已阻止无协调直连")?;
        Ok(Self::from_initialized(store, registration, salt))
    }

    #[cfg(test)]
    pub(crate) fn from_paths_for_test(paths: &AppPaths) -> Result<Self> {
        let started_at_ms = unix_time_ms();
        let registration = RuntimeInstanceRegistration {
            instance_id: uuid::Uuid::new_v4().to_string(),
            runtime_scope: paths.runtime_scope.as_str().to_string(),
            pid: std::process::id(),
            started_at_ms,
        };
        let store = RuntimeCoordinationStore::new(paths.coordination_db_path.clone());
        let salt = store
            .initialize_and_register_for_test(&registration)
            .context("共享运行时协调器初始化失败，已阻止无协调直连")?;
        Ok(Self::from_initialized(store, registration, salt))
    }

    fn from_initialized(
        store: RuntimeCoordinationStore,
        registration: RuntimeInstanceRegistration,
        salt: [u8; 16],
    ) -> Self {
        let service = Self {
            inner: Arc::new(RuntimeCoordinationInner {
                store,
                registration,
                salt,
                heartbeat_started: AtomicBool::new(false),
            }),
        };
        service.ensure_heartbeat_started();
        service
    }

    pub fn instance_id(&self) -> &str {
        &self.inner.registration.instance_id
    }

    pub fn runtime_scope(&self) -> &str {
        &self.inner.registration.runtime_scope
    }

    pub fn coordination_db_path(&self) -> &std::path::Path {
        self.inner.store.path()
    }

    pub fn shares_instance_with(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }

    pub fn site_key(&self, base_url: &str) -> Result<CoordinationKey> {
        let canonical = canonicalize_base_url(base_url)?;
        Ok(hash_coordination_key(
            &self.inner.salt,
            b"site\0",
            &[canonical.as_bytes()],
        ))
    }

    /// 为同一逻辑站点派生稳定的主地址、候选集合和逐地址摘要。
    pub fn site_failover_identity(
        &self,
        primary_base_url: &str,
        fallback_base_urls: &[String],
    ) -> Result<SiteFailoverIdentity> {
        let primary = canonicalize_site_base_url(primary_base_url)?;
        let mut canonical_addresses = Vec::with_capacity(fallback_base_urls.len() + 1);
        canonical_addresses.push(primary.clone());
        let mut seen = std::collections::HashSet::with_capacity(fallback_base_urls.len() + 1);
        seen.insert(primary.clone());
        for fallback in fallback_base_urls {
            let fallback = canonicalize_site_base_url(fallback)?;
            if !seen.insert(fallback.clone()) {
                bail!("站点故障转移拓扑包含重复地址。")
            }
            canonical_addresses.push(fallback);
        }

        let site_key = hash_coordination_key(
            &self.inner.salt,
            b"failover-site/v1\0",
            &[primary.as_bytes()],
        );
        let address_keys = canonical_addresses
            .iter()
            .map(|address| {
                hash_coordination_key(
                    &self.inner.salt,
                    b"failover-address/v1\0",
                    &[site_key.as_slice(), address.as_bytes()],
                )
            })
            .collect::<Vec<_>>();
        let mut sorted_fallbacks = canonical_addresses[1..].to_vec();
        sorted_fallbacks.sort_unstable();
        let topology_key =
            hash_site_failover_topology(&self.inner.salt, &site_key, &sorted_fallbacks);
        Ok(SiteFailoverIdentity {
            topology: SiteFailoverTopology {
                site_key,
                topology_key,
                primary_address_key: address_keys[0],
                address_keys,
            },
            canonical_addresses,
        })
    }

    pub fn account_key(&self, base_url: &str, email: &str) -> Result<CoordinationKey> {
        let canonical = canonicalize_base_url(base_url)?;
        let normalized_email = email.trim().to_ascii_lowercase();
        if normalized_email.is_empty() {
            bail!("账号身份不能为空。");
        }
        Ok(hash_coordination_key(
            &self.inner.salt,
            b"account\0",
            &[canonical.as_bytes(), b"\0", normalized_email.as_bytes()],
        ))
    }

    pub async fn heartbeat_once(&self) -> Result<()> {
        self.inner
            .store
            .heartbeat(self.inner.registration.clone(), unix_time_ms())
            .await
    }

    /// 为当前 runtime 登记独立 demand，并只在它成为公平队首时获取账号租约。
    pub async fn try_acquire_account_lease(
        &self,
        base_url: &str,
        email: &str,
        work_kind: BackgroundSyncWorkKind,
    ) -> Result<CoordinationDecision<AccountLeaseGuard>> {
        self.ensure_heartbeat_started();
        let now_ms = unix_time_ms();
        let account_key = self.account_key(base_url, email)?;
        let demand_id = self
            .inner
            .store
            .enqueue_account_demand(
                NewAccountSyncDemand {
                    demand_id: uuid::Uuid::new_v4().to_string(),
                    account_key,
                    instance_id: self.instance_id().to_string(),
                    work_kind: work_kind.as_str().to_string(),
                    priority: work_kind.priority(),
                    not_before_ms: now_ms,
                    expires_at_ms: now_ms.saturating_add(ACCOUNT_DEMAND_TTL_MS),
                },
                now_ms,
            )
            .await?;
        match self
            .inner
            .store
            .try_acquire_account_lease(
                account_key,
                demand_id,
                self.instance_id().to_string(),
                now_ms,
            )
            .await?
        {
            CoordinationDecision::Acquired(lease) => Ok(CoordinationDecision::Acquired(
                AccountLeaseGuard::new(self.clone(), lease),
            )),
            CoordinationDecision::Waiting { wait_ms } => {
                Ok(CoordinationDecision::Waiting { wait_ms })
            }
        }
    }

    /// 原子登记当前账号已到期的工作，并返回当前 runtime 实际取得的整组工作。
    pub async fn try_acquire_due_work_lease(
        &self,
        base_url: &str,
        email: &str,
        due_work: BackgroundSyncDueWork,
    ) -> Result<CoordinationDecision<AccountDueWorkLease>> {
        if due_work.is_empty() {
            bail!("账号同步 due work 不能为空。");
        }
        self.ensure_heartbeat_started();
        let now_ms = unix_time_ms();
        let account_key = self.account_key(base_url, email)?;
        let demands = due_work
            .work_kinds()
            .map(|work_kind| NewAccountSyncDemand {
                demand_id: uuid::Uuid::new_v4().to_string(),
                account_key,
                instance_id: self.instance_id().to_string(),
                work_kind: work_kind.as_str().to_string(),
                priority: work_kind.priority(),
                not_before_ms: now_ms,
                expires_at_ms: now_ms.saturating_add(ACCOUNT_DEMAND_TTL_MS),
            })
            .collect::<Vec<_>>();
        match self
            .inner
            .store
            .enqueue_due_work_and_try_acquire_account_lease(demands, now_ms)
            .await?
        {
            CoordinationDecision::Acquired(AccountSyncLeaseGrant { lease, work_kinds }) => {
                let mut acquired_due_work = BackgroundSyncDueWork::default();
                for work_kind in work_kinds {
                    acquired_due_work.insert(BackgroundSyncWorkKind::from_str(&work_kind)?);
                }
                Ok(CoordinationDecision::Acquired(AccountDueWorkLease {
                    lease: AccountLeaseGuard::new(self.clone(), lease),
                    due_work: acquired_due_work,
                }))
            }
            CoordinationDecision::Waiting { wait_ms } => {
                Ok(CoordinationDecision::Waiting { wait_ms })
            }
        }
    }

    /// 进入共享站点队列并在有界时间内等待 permit；超时或协调库异常均 fail closed。
    pub async fn acquire_site_request_permit(
        &self,
        base_url: &str,
        endpoint_family: &str,
        request_class: SiteRequestClass,
    ) -> Result<SiteRequestPermitGuard> {
        self.site_request_coordination(base_url)?
            .acquire(endpoint_family, request_class)
            .await
    }

    /// 为 transport 构造只包含站点摘要与 runtime identity 的窄协调 handle。
    pub fn site_request_coordination(&self, base_url: &str) -> Result<SiteRequestCoordination> {
        self.ensure_heartbeat_started();
        Ok(SiteRequestCoordination::new(
            self.inner.store.clone(),
            self.site_key(base_url)?,
            self.instance_id().to_string(),
        ))
    }

    pub async fn set_site_cooldown(
        &self,
        base_url: &str,
        delay_ms: u64,
    ) -> Result<SiteCooldownState> {
        self.site_request_coordination(base_url)?
            .set_cooldown(delay_ms)
            .await
    }

    pub async fn load_site_failover(
        &self,
        identity: &SiteFailoverIdentity,
    ) -> Result<SiteFailoverSnapshot> {
        self.ensure_heartbeat_started();
        self.inner
            .store
            .load_or_initialize_site_failover(identity.topology.clone(), unix_time_ms())
            .await
    }

    pub async fn record_site_failover_failure(
        &self,
        identity: &SiteFailoverIdentity,
        address_key: CoordinationKey,
        expected_cooldown_revision: Option<i64>,
        cooldown_delay_ms: u64,
        category: SiteFailoverFailureCategory,
        http_status: Option<u16>,
    ) -> Result<(bool, SiteFailoverSnapshot)> {
        self.ensure_heartbeat_started();
        let now_ms = unix_time_ms();
        let cooldown_until_ms =
            now_ms.saturating_add(i64::try_from(cooldown_delay_ms).unwrap_or(i64::MAX));
        self.inner
            .store
            .record_site_failover_failure(
                identity.topology.clone(),
                address_key,
                expected_cooldown_revision,
                cooldown_until_ms,
                category,
                http_status,
                now_ms,
            )
            .await
    }

    pub async fn clear_site_failover_cooldown(
        &self,
        identity: &SiteFailoverIdentity,
        address_key: CoordinationKey,
    ) -> Result<SiteFailoverSnapshot> {
        self.ensure_heartbeat_started();
        self.inner
            .store
            .clear_site_failover_cooldown(identity.topology.clone(), address_key, unix_time_ms())
            .await
    }

    pub async fn try_acquire_site_failover_lease(
        &self,
        identity: &SiteFailoverIdentity,
    ) -> Result<CoordinationDecision<SiteFailoverLease>> {
        self.ensure_heartbeat_started();
        self.inner
            .store
            .try_acquire_site_failover_lease(
                identity.topology.clone(),
                self.instance_id().to_string(),
                unix_time_ms(),
            )
            .await
    }

    pub async fn renew_site_failover_lease(&self, lease: SiteFailoverLease) -> Result<bool> {
        self.inner
            .store
            .renew_site_failover_lease(lease, unix_time_ms())
            .await
    }

    pub async fn complete_site_failover_evaluation(
        &self,
        identity: &SiteFailoverIdentity,
        lease: SiteFailoverLease,
        winner: Option<SiteFailoverWinner>,
    ) -> Result<Option<SiteFailoverSnapshot>> {
        self.inner
            .store
            .complete_site_failover_evaluation(
                identity.topology.clone(),
                lease,
                winner,
                unix_time_ms(),
            )
            .await
    }

    pub async fn release_site_failover_lease(&self, lease: SiteFailoverLease) -> Result<bool> {
        self.inner.store.release_site_failover_lease(lease).await
    }

    pub async fn list_site_failover_transitions(
        &self,
        after_revision: i64,
    ) -> Result<SiteFailoverTransitionPage> {
        self.inner
            .store
            .list_site_failover_transitions(after_revision, 100)
            .await
    }

    pub async fn get_config(&self) -> Result<SharedRuntimeCoordinationConfig> {
        self.inner.store.get_config().await
    }

    pub async fn update_config(
        &self,
        config: SharedRuntimeCoordinationConfig,
    ) -> Result<SharedRuntimeCoordinationConfig> {
        self.inner.store.update_config(config, unix_time_ms()).await
    }

    pub async fn get_config_payload(&self) -> Result<RuntimeCoordinationConfigPayload> {
        Ok(runtime_coordination_config_payload(
            self.get_config().await?,
        ))
    }

    pub async fn update_config_payload(
        &self,
        payload: RuntimeCoordinationConfigPayload,
    ) -> Result<RuntimeCoordinationConfigPayload> {
        let config = SharedRuntimeCoordinationConfig {
            site_requests_per_second: payload.site_requests_per_second,
            site_max_in_flight: payload.site_max_in_flight,
            usage_page_max_in_flight: payload.usage_page_max_in_flight,
        };
        Ok(runtime_coordination_config_payload(
            self.update_config(config).await?,
        ))
    }

    /// 读取独立保存的上游网络设置，不影响共享请求预算配置。
    pub async fn get_upstream_network_config(&self) -> Result<UpstreamNetworkConfig> {
        self.inner.store.get_upstream_network_config().await
    }

    /// 更新独立保存的上游网络设置，不影响共享请求预算配置。
    pub async fn update_upstream_network_config(
        &self,
        config: UpstreamNetworkConfig,
    ) -> Result<UpstreamNetworkConfig> {
        self.inner
            .store
            .update_upstream_network_config(config, unix_time_ms())
            .await
    }

    pub async fn get_upstream_network_config_payload(
        &self,
    ) -> Result<UpstreamNetworkConfigPayload> {
        Ok(upstream_network_config_payload(
            self.get_upstream_network_config().await?,
        ))
    }

    pub async fn update_upstream_network_config_payload(
        &self,
        payload: UpstreamNetworkConfigPayload,
    ) -> Result<UpstreamNetworkConfigPayload> {
        let config = UpstreamNetworkConfig {
            use_system_proxy: payload.use_system_proxy,
        };
        Ok(upstream_network_config_payload(
            self.update_upstream_network_config(config).await?,
        ))
    }

    fn ensure_heartbeat_started(&self) {
        if self
            .inner
            .heartbeat_started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            self.inner.heartbeat_started.store(false, Ordering::Release);
            return;
        };
        let weak = Arc::downgrade(&self.inner);
        handle.spawn(async move {
            let mut interval =
                tokio::time::interval(Duration::from_millis(RUNTIME_HEARTBEAT_INTERVAL_MS as u64));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            interval.tick().await;
            loop {
                interval.tick().await;
                let Some(inner) = weak.upgrade() else {
                    break;
                };
                if let Err(error) = inner
                    .store
                    .heartbeat(inner.registration.clone(), unix_time_ms())
                    .await
                {
                    let short_instance = inner
                        .registration
                        .instance_id
                        .chars()
                        .take(8)
                        .collect::<String>();
                    log::warn!(
                        "共享协调 heartbeat 失败: runtime_scope={}, instance={}, error={}",
                        inner.registration.runtime_scope,
                        short_instance,
                        error
                    );
                }
            }
        });
    }

    fn short_instance_id(&self) -> String {
        self.instance_id().chars().take(8).collect()
    }
}

fn runtime_coordination_config_payload(
    config: SharedRuntimeCoordinationConfig,
) -> RuntimeCoordinationConfigPayload {
    RuntimeCoordinationConfigPayload {
        site_requests_per_second: config.site_requests_per_second,
        site_max_in_flight: config.site_max_in_flight,
        usage_page_max_in_flight: config.usage_page_max_in_flight,
    }
}

fn upstream_network_config_payload(config: UpstreamNetworkConfig) -> UpstreamNetworkConfigPayload {
    UpstreamNetworkConfigPayload {
        use_system_proxy: config.use_system_proxy,
    }
}

pub struct AccountLeaseGuard {
    service: RuntimeCoordinationService,
    lease: Option<AccountSyncLease>,
    active: Arc<AtomicBool>,
    still_owner: Arc<AtomicBool>,
}

impl std::fmt::Debug for AccountLeaseGuard {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AccountLeaseGuard")
            .field("runtime_scope", &self.service.runtime_scope())
            .field("still_owner", &self.is_still_owner())
            .finish_non_exhaustive()
    }
}

impl AccountLeaseGuard {
    fn new(service: RuntimeCoordinationService, lease: AccountSyncLease) -> Self {
        let active = Arc::new(AtomicBool::new(true));
        let still_owner = Arc::new(AtomicBool::new(true));
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            let active_for_task = Arc::clone(&active);
            let owner_for_task = Arc::clone(&still_owner);
            let service_for_task = service.clone();
            let lease_for_task = lease.clone();
            handle.spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_millis(
                    RUNTIME_HEARTBEAT_INTERVAL_MS as u64,
                ));
                interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                interval.tick().await;
                loop {
                    interval.tick().await;
                    if !active_for_task.load(Ordering::Acquire) {
                        break;
                    }
                    match service_for_task
                        .inner
                        .store
                        .renew_account_lease(lease_for_task.clone(), unix_time_ms())
                        .await
                    {
                        Ok(true) => {}
                        Ok(false) | Err(_) => {
                            owner_for_task.store(false, Ordering::Release);
                            break;
                        }
                    }
                }
            });
        }
        Self {
            service,
            lease: Some(lease),
            active,
            still_owner,
        }
    }

    pub fn is_still_owner(&self) -> bool {
        self.still_owner.load(Ordering::Acquire)
    }

    pub async fn should_yield_to_peer(&self) -> Result<bool> {
        let Some(lease) = self.lease.as_ref() else {
            return Ok(true);
        };
        if !self.is_still_owner() {
            return Ok(true);
        }
        self.service
            .inner
            .store
            .should_yield_account_lease(lease.clone(), unix_time_ms())
            .await
    }

    pub async fn release(mut self) -> Result<bool> {
        self.active.store(false, Ordering::Release);
        let Some(lease) = self.lease.take() else {
            return Ok(false);
        };
        let released = self
            .service
            .inner
            .store
            .release_account_lease(lease)
            .await?;
        self.still_owner.store(false, Ordering::Release);
        Ok(released)
    }
}

impl Drop for AccountLeaseGuard {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
        self.still_owner.store(false, Ordering::Release);
        let Some(lease) = self.lease.take() else {
            return;
        };
        let service = self.service.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let _ = service.inner.store.release_account_lease(lease).await;
            });
        }
    }
}

fn canonicalize_base_url(base_url: &str) -> Result<String> {
    canonicalize_site_base_url(base_url)
}

fn hash_coordination_key(salt: &[u8; 16], namespace: &[u8], parts: &[&[u8]]) -> CoordinationKey {
    let mut hasher = Sha256::new();
    hasher.update(salt);
    hasher.update(namespace);
    for part in parts {
        hasher.update(part);
    }
    hasher.finalize().into()
}

fn hash_site_failover_topology(
    salt: &[u8; 16],
    site_key: &CoordinationKey,
    sorted_fallbacks: &[String],
) -> CoordinationKey {
    let mut hasher = Sha256::new();
    hasher.update(salt);
    hasher.update(b"failover-topology/v1\0");
    hasher.update(site_key);
    for fallback in sorted_fallbacks {
        hasher.update((fallback.len() as u64).to_be_bytes());
        hasher.update(fallback.as_bytes());
    }
    hasher.finalize().into()
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::infrastructure::files::AppPaths;
    use crate::infrastructure::runtime_coordination::validate_endpoint_family;

    fn test_service(label: &str) -> (RuntimeCoordinationService, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "input-panel-runtime-coordination-service-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        let paths = AppPaths::from_root(root.clone());
        paths.ensure().expect("ensure service test paths");
        (
            RuntimeCoordinationService::from_paths_for_test(&paths).expect("initialize service"),
            root,
        )
    }

    #[test]
    fn canonical_identity_is_stable_without_storing_plain_values() {
        let (service, root) = test_service("identity");
        let invalid = service
            .account_key(
                "https://example.test/api/?token=not-part-of-identity#fragment",
                "private@example.test",
            )
            .expect_err("site identity must reject query parameters and fragments");
        assert_eq!(invalid.to_string(), "站点地址不能包含查询参数或片段。");
        let first = service
            .account_key("HTTPS://Example.Test:443/api/", "  Private@Example.Test ")
            .expect("first account key");
        let second = service
            .account_key("https://example.test/api", "private@example.test")
            .expect("second account key");
        let other = service
            .account_key("https://example.test/api", "other@example.test")
            .expect("other account key");

        assert_eq!(first, second);
        assert_ne!(first, other);
        let bytes = fs::read(service.coordination_db_path()).expect("read coordination database");
        let text = String::from_utf8_lossy(&bytes);
        assert!(!text.contains("private@example.test"));
        assert!(!text.contains("example.test"));
        drop(service);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn failover_identity_is_stable_across_runtime_and_fallback_order() {
        let root = std::env::temp_dir().join(format!(
            "input-panel-runtime-coordination-service-failover-{}",
            uuid::Uuid::new_v4()
        ));
        let paths = AppPaths::from_root(root.clone());
        paths.ensure().expect("ensure shared service paths");
        let first = RuntimeCoordinationService::from_paths_for_test(&paths)
            .expect("initialize first service");
        let second = RuntimeCoordinationService::from_paths_for_test(&paths)
            .expect("initialize second service");
        let ordered = vec![
            "https://input.codes/".to_string(),
            "https://eo.input.codes".to_string(),
        ];
        let reversed = vec![
            "https://eo.input.codes/".to_string(),
            "https://INPUT.CODES".to_string(),
        ];

        let first_identity = first
            .site_failover_identity("HTTPS://AI.INPUT.IM/", &ordered)
            .expect("derive first identity");
        let second_identity = second
            .site_failover_identity("https://ai.input.im", &reversed)
            .expect("derive second identity");

        assert_eq!(
            first_identity.topology.site_key,
            second_identity.topology.site_key
        );
        assert_eq!(
            first_identity.topology.topology_key,
            second_identity.topology.topology_key
        );
        assert_eq!(
            first_identity.topology.primary_address_key,
            second_identity.topology.primary_address_key
        );
        assert_eq!(
            first_identity
                .address_key_for_base_url("https://input.codes")
                .expect("lookup first fallback"),
            second_identity
                .address_key_for_base_url("https://input.codes/")
                .expect("lookup reordered fallback")
        );

        let changed_primary = first
            .site_failover_identity("https://other.test", &ordered)
            .expect("derive changed primary");
        assert_ne!(
            first_identity.topology.site_key,
            changed_primary.topology.site_key
        );
        drop(second);
        drop(first);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn cloned_service_keeps_one_runtime_identity_and_shared_config() {
        let (service, root) = test_service("clone");
        let cloned = service.clone();
        assert!(service.shares_instance_with(&cloned));
        assert_eq!(service.instance_id(), cloned.instance_id());

        let config = SharedRuntimeCoordinationConfig {
            site_requests_per_second: 4,
            site_max_in_flight: 2,
            usage_page_max_in_flight: 5,
        };
        service
            .update_config(config)
            .await
            .expect("update shared config");
        assert_eq!(
            cloned.get_config().await.expect("read shared config"),
            config
        );
        drop(cloned);
        drop(service);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn upstream_network_payload_round_trip_stays_separate_from_request_budget() {
        let (service, root) = test_service("upstream-network-payload");
        let request_budget = service
            .get_config_payload()
            .await
            .expect("read request budget payload");

        assert_eq!(
            service
                .get_upstream_network_config_payload()
                .await
                .expect("read direct upstream network default"),
            UpstreamNetworkConfigPayload {
                use_system_proxy: false,
            }
        );
        assert_eq!(
            service
                .update_upstream_network_config_payload(UpstreamNetworkConfigPayload {
                    use_system_proxy: true,
                })
                .await
                .expect("enable system proxy payload"),
            UpstreamNetworkConfigPayload {
                use_system_proxy: true,
            }
        );
        assert_eq!(
            service
                .get_upstream_network_config_payload()
                .await
                .expect("read persisted system proxy payload"),
            UpstreamNetworkConfigPayload {
                use_system_proxy: true,
            }
        );
        assert_eq!(
            service
                .get_config_payload()
                .await
                .expect("read unchanged request budget payload"),
            request_budget
        );

        drop(service);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn endpoint_family_rejects_urls_and_sensitive_labels() {
        assert!(validate_endpoint_family("usage_page").is_ok());
        assert!(validate_endpoint_family("https://example.test/api").is_err());
        assert!(validate_endpoint_family("token=secret").is_err());
    }
}
