use std::any::Any;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use tokio::sync::{
    oneshot, Mutex, OwnedMutexGuard, OwnedRwLockReadGuard, OwnedRwLockWriteGuard,
    OwnedSemaphorePermit, RwLock, Semaphore,
};

const DEFAULT_RESOURCE_TTL: Duration = Duration::from_secs(30);
pub(crate) const MAX_USAGE_PAGE_SLOTS: usize = 16;
const MAX_USAGE_WRITERS: usize = 1;

type ErasedResource = Arc<dyn Any + Send + Sync>;
type ResourceWaiter = oneshot::Sender<Result<ErasedResource, String>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LiveResourceKind {
    DashboardStats,
    Groups,
    Keys,
    PlatformQuotas,
    Profile,
    Subscriptions,
    SubscriptionSummary,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct LiveResourceKey {
    account_id: String,
    kind: LiveResourceKind,
}

struct CachedResource {
    value: ErasedResource,
    fetched_at: Instant,
}

#[derive(Default)]
struct ResourceEntry {
    cached: Option<CachedResource>,
    in_flight_generation: Option<u64>,
    generation: u64,
    waiters: Vec<ResourceWaiter>,
}

#[derive(Clone)]
pub struct ResourceCoordinator {
    entries: Arc<Mutex<HashMap<LiveResourceKey, ResourceEntry>>>,
    ttl: Duration,
    usage_page_slots: Arc<Semaphore>,
    usage_writer_slots: Arc<Semaphore>,
    auth_recovery_account_gates: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    usage_account_gates: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    subscription_switch_account_gates: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    subscription_quota_alert_account_gates: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    subscription_quota_alert_delivery_gate: Arc<RwLock<()>>,
    completed_usage_sync_accounts: Arc<Mutex<HashSet<String>>>,
}

impl Default for ResourceCoordinator {
    fn default() -> Self {
        Self::new(DEFAULT_RESOURCE_TTL)
    }
}

impl ResourceCoordinator {
    pub fn new(ttl: Duration) -> Self {
        Self {
            entries: Arc::new(Mutex::new(HashMap::new())),
            ttl,
            usage_page_slots: Arc::new(Semaphore::new(MAX_USAGE_PAGE_SLOTS)),
            usage_writer_slots: Arc::new(Semaphore::new(MAX_USAGE_WRITERS)),
            auth_recovery_account_gates: Arc::new(Mutex::new(HashMap::new())),
            usage_account_gates: Arc::new(Mutex::new(HashMap::new())),
            subscription_switch_account_gates: Arc::new(Mutex::new(HashMap::new())),
            subscription_quota_alert_account_gates: Arc::new(Mutex::new(HashMap::new())),
            subscription_quota_alert_delivery_gate: Arc::new(RwLock::new(())),
            completed_usage_sync_accounts: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    pub async fn acquire_usage_page_slot(&self) -> Result<OwnedSemaphorePermit> {
        Arc::clone(&self.usage_page_slots)
            .acquire_owned()
            .await
            .map_err(|_| anyhow!("用量页面并发控制器已关闭。"))
    }

    pub fn try_acquire_usage_page_slot(&self) -> Result<Option<OwnedSemaphorePermit>> {
        match Arc::clone(&self.usage_page_slots).try_acquire_owned() {
            Ok(permit) => Ok(Some(permit)),
            Err(tokio::sync::TryAcquireError::NoPermits) => Ok(None),
            Err(tokio::sync::TryAcquireError::Closed) => Err(anyhow!("用量页面并发控制器已关闭。")),
        }
    }

    pub async fn acquire_usage_writer_slot(&self) -> Result<OwnedSemaphorePermit> {
        Arc::clone(&self.usage_writer_slots)
            .acquire_owned()
            .await
            .map_err(|_| anyhow!("用量写入控制器已关闭。"))
    }

    /// 串行化同账号的 token 刷新和凭据重登，避免并发 401 重复恢复。
    pub async fn acquire_auth_recovery_account_gate(
        &self,
        account_id: &str,
    ) -> OwnedMutexGuard<()> {
        self.auth_recovery_account_gate(account_id)
            .await
            .lock_owned()
            .await
    }

    pub async fn acquire_usage_account_gate(&self, account_id: &str) -> OwnedMutexGuard<()> {
        self.usage_account_gate(account_id).await.lock_owned().await
    }

    pub async fn try_acquire_usage_account_gate(
        &self,
        account_id: &str,
    ) -> Option<OwnedMutexGuard<()>> {
        self.usage_account_gate(account_id)
            .await
            .try_lock_owned()
            .ok()
    }

    /// 串行化同账号的订阅链评估，避免不同入口写入互相覆盖。
    pub async fn acquire_subscription_switch_account_gate(
        &self,
        account_id: &str,
    ) -> OwnedMutexGuard<()> {
        self.subscription_switch_account_gate(account_id)
            .await
            .lock_owned()
            .await
    }

    pub async fn try_acquire_subscription_switch_account_gate(
        &self,
        account_id: &str,
    ) -> Option<OwnedMutexGuard<()>> {
        self.subscription_switch_account_gate(account_id)
            .await
            .try_lock_owned()
            .ok()
    }

    /// 串行化同账号的额度提醒配置写入和窗口状态转换。
    pub async fn acquire_subscription_quota_alert_account_gate(
        &self,
        account_id: &str,
    ) -> OwnedMutexGuard<()> {
        self.subscription_quota_alert_account_gate(account_id)
            .await
            .lock_owned()
            .await
    }

    /// 将额度提醒的单次认领和投递视为可等待的读操作。
    pub async fn acquire_subscription_quota_alert_delivery_read_gate(
        &self,
    ) -> OwnedRwLockReadGuard<()> {
        Arc::clone(&self.subscription_quota_alert_delivery_gate)
            .read_owned()
            .await
    }

    /// 在删除站点或清理运行数据期间阻止新的额度提醒投递。
    pub async fn acquire_subscription_quota_alert_delivery_write_gate(
        &self,
    ) -> OwnedRwLockWriteGuard<()> {
        Arc::clone(&self.subscription_quota_alert_delivery_gate)
            .write_owned()
            .await
    }

    pub async fn complete_usage_sync_and_should_notify(&self, account_id: &str) -> bool {
        let mut completed_accounts = self.completed_usage_sync_accounts.lock().await;
        !completed_accounts.insert(account_id.to_string())
    }

    pub async fn get_or_fetch<T, F, Fut>(
        &self,
        account_id: &str,
        kind: LiveResourceKind,
        force: bool,
        fetch: F,
    ) -> Result<T>
    where
        T: Clone + Send + Sync + 'static,
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T>>,
    {
        let key = LiveResourceKey {
            account_id: account_id.to_string(),
            kind,
        };

        let (wait_for_existing, generation) = {
            let mut entries = self.entries.lock().await;
            let entry = entries.entry(key.clone()).or_default();
            if !force {
                if let Some(cached) = &entry.cached {
                    if cached.fetched_at.elapsed() < self.ttl {
                        return clone_erased_resource::<T>(&cached.value);
                    }
                }
            }

            if entry.in_flight_generation.is_some() {
                let (sender, receiver) = oneshot::channel();
                entry.waiters.push(sender);
                (Some(receiver), entry.generation)
            } else {
                entry.in_flight_generation = Some(entry.generation);
                (None, entry.generation)
            }
        };

        if let Some(receiver) = wait_for_existing {
            let shared = receiver
                .await
                .map_err(|_| anyhow!("实时资源请求协调器提前关闭。"))?
                .map_err(anyhow::Error::msg)?;
            return clone_erased_resource::<T>(&shared);
        }

        let mut leader_guard = InFlightLeaderGuard::new(self.clone(), key.clone(), generation);
        let result = fetch().await;
        let shared_result = result
            .as_ref()
            .map(|value| Arc::new(value.clone()) as ErasedResource)
            .map_err(|error| error.to_string());

        let waiters = self.complete_fetch(key, generation, &shared_result).await;
        leader_guard.disarm();

        for waiter in waiters {
            let _ = waiter.send(shared_result.clone());
        }

        result
    }

    pub async fn invalidate(&self, account_id: &str, kind: LiveResourceKind) {
        let key = LiveResourceKey {
            account_id: account_id.to_string(),
            kind,
        };
        let waiters = {
            let mut entries = self.entries.lock().await;
            let entry = entries.entry(key).or_default();
            entry.cached = None;
            entry.generation = entry.generation.wrapping_add(1);
            entry.in_flight_generation = None;
            std::mem::take(&mut entry.waiters)
        };
        release_invalidated_waiters(waiters);
    }

    pub async fn invalidate_account(&self, account_id: &str) {
        let waiters = {
            let mut entries = self.entries.lock().await;
            let mut waiters = Vec::new();
            for (key, entry) in entries.iter_mut() {
                if key.account_id == account_id {
                    entry.cached = None;
                    entry.generation = entry.generation.wrapping_add(1);
                    entry.in_flight_generation = None;
                    waiters.extend(std::mem::take(&mut entry.waiters));
                }
            }
            waiters
        };
        release_invalidated_waiters(waiters);
    }

    async fn complete_fetch(
        &self,
        key: LiveResourceKey,
        generation: u64,
        result: &Result<ErasedResource, String>,
    ) -> Vec<ResourceWaiter> {
        let mut entries = self.entries.lock().await;
        let entry = entries.entry(key).or_default();
        if entry.in_flight_generation != Some(generation) {
            return Vec::new();
        }
        entry.in_flight_generation = None;
        if entry.generation == generation {
            if let Ok(value) = result {
                entry.cached = Some(CachedResource {
                    value: Arc::clone(value),
                    fetched_at: Instant::now(),
                });
            }
        }
        std::mem::take(&mut entry.waiters)
    }

    async fn usage_account_gate(&self, account_id: &str) -> Arc<Mutex<()>> {
        let mut gates = self.usage_account_gates.lock().await;
        Arc::clone(
            gates
                .entry(account_id.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(()))),
        )
    }

    async fn auth_recovery_account_gate(&self, account_id: &str) -> Arc<Mutex<()>> {
        let mut gates = self.auth_recovery_account_gates.lock().await;
        Arc::clone(
            gates
                .entry(account_id.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(()))),
        )
    }

    async fn subscription_switch_account_gate(&self, account_id: &str) -> Arc<Mutex<()>> {
        let mut gates = self.subscription_switch_account_gates.lock().await;
        Arc::clone(
            gates
                .entry(account_id.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(()))),
        )
    }

    async fn subscription_quota_alert_account_gate(&self, account_id: &str) -> Arc<Mutex<()>> {
        let mut gates = self.subscription_quota_alert_account_gates.lock().await;
        Arc::clone(
            gates
                .entry(account_id.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(()))),
        )
    }
}

fn release_invalidated_waiters(waiters: Vec<ResourceWaiter>) {
    for waiter in waiters {
        let _ = waiter.send(Err("实时资源已失效，请重试。".to_string()));
    }
}

struct InFlightLeaderGuard {
    coordinator: ResourceCoordinator,
    key: Option<LiveResourceKey>,
    generation: u64,
}

impl InFlightLeaderGuard {
    fn new(coordinator: ResourceCoordinator, key: LiveResourceKey, generation: u64) -> Self {
        Self {
            coordinator,
            key: Some(key),
            generation,
        }
    }

    fn disarm(&mut self) {
        self.key = None;
    }
}

impl Drop for InFlightLeaderGuard {
    fn drop(&mut self) {
        let Some(key) = self.key.take() else {
            return;
        };
        let coordinator = self.coordinator.clone();
        let generation = self.generation;
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let result = Err("实时资源请求已取消。".to_string());
                let waiters = coordinator.complete_fetch(key, generation, &result).await;
                for waiter in waiters {
                    let _ = waiter.send(result.clone());
                }
            });
        }
    }
}

fn clone_erased_resource<T>(value: &ErasedResource) -> Result<T>
where
    T: Clone + Send + Sync + 'static,
{
    value
        .as_ref()
        .downcast_ref::<T>()
        .cloned()
        .ok_or_else(|| anyhow!("实时资源缓存类型不匹配。"))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    use super::{LiveResourceKind, ResourceCoordinator};

    #[tokio::test]
    async fn fresh_success_is_reused_within_ttl() {
        let coordinator = ResourceCoordinator::new(Duration::from_secs(30));
        let calls = Arc::new(AtomicUsize::new(0));

        for _ in 0..2 {
            let calls = Arc::clone(&calls);
            let value = coordinator
                .get_or_fetch(
                    "account-1",
                    LiveResourceKind::Keys,
                    false,
                    move || async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        Ok::<_, anyhow::Error>(vec!["key-1".to_string()])
                    },
                )
                .await
                .expect("load keys");
            assert_eq!(value, vec!["key-1"]);
        }

        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn concurrent_force_requests_join_the_same_in_flight_fetch() {
        let coordinator = ResourceCoordinator::new(Duration::from_secs(30));
        let calls = Arc::new(AtomicUsize::new(0));
        let (started_sender, started_receiver) = tokio::sync::oneshot::channel();
        let (release_sender, release_receiver) = tokio::sync::oneshot::channel();

        let first = {
            let coordinator = coordinator.clone();
            let calls = Arc::clone(&calls);
            tokio::spawn(async move {
                coordinator
                    .get_or_fetch(
                        "account-1",
                        LiveResourceKind::Profile,
                        true,
                        move || async move {
                            calls.fetch_add(1, Ordering::SeqCst);
                            let _ = started_sender.send(());
                            let _ = release_receiver.await;
                            Ok::<_, anyhow::Error>("profile".to_string())
                        },
                    )
                    .await
            })
        };

        started_receiver.await.expect("first fetch started");
        let second = {
            let coordinator = coordinator.clone();
            let calls = Arc::clone(&calls);
            tokio::spawn(async move {
                coordinator
                    .get_or_fetch(
                        "account-1",
                        LiveResourceKind::Profile,
                        true,
                        move || async move {
                            calls.fetch_add(1, Ordering::SeqCst);
                            Ok::<_, anyhow::Error>("unexpected".to_string())
                        },
                    )
                    .await
            })
        };

        release_sender.send(()).expect("release first fetch");
        assert_eq!(
            first.await.expect("first task").expect("first value"),
            "profile"
        );
        assert_eq!(
            second.await.expect("second task").expect("second value"),
            "profile"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn force_bypasses_a_completed_snapshot() {
        let coordinator = ResourceCoordinator::new(Duration::from_secs(30));
        let calls = Arc::new(AtomicUsize::new(0));

        for force in [false, true] {
            let calls = Arc::clone(&calls);
            coordinator
                .get_or_fetch("account-1", LiveResourceKind::DashboardStats, force, move || async move {
                    Ok::<_, anyhow::Error>(calls.fetch_add(1, Ordering::SeqCst))
                })
                .await
                .expect("load dashboard stats");
        }

        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn invalidation_prevents_in_flight_data_from_becoming_the_next_snapshot() {
        let coordinator = ResourceCoordinator::new(Duration::from_secs(30));
        let (started_sender, started_receiver) = tokio::sync::oneshot::channel();
        let (release_sender, release_receiver) = tokio::sync::oneshot::channel();
        let first = {
            let coordinator = coordinator.clone();
            tokio::spawn(async move {
                coordinator
                    .get_or_fetch(
                        "account-1",
                        LiveResourceKind::Subscriptions,
                        false,
                        move || async move {
                            let _ = started_sender.send(());
                            let _ = release_receiver.await;
                            Ok::<_, anyhow::Error>("stale".to_string())
                        },
                    )
                    .await
            })
        };

        started_receiver.await.expect("first fetch started");
        coordinator
            .invalidate("account-1", LiveResourceKind::Subscriptions)
            .await;

        let next = coordinator
            .get_or_fetch(
                "account-1",
                LiveResourceKind::Subscriptions,
                false,
                || async { Ok::<_, anyhow::Error>("fresh".to_string()) },
            )
            .await
            .expect("fresh value");
        assert_eq!(next, "fresh");

        release_sender.send(()).expect("release first fetch");
        assert_eq!(
            first.await.expect("first task").expect("first value"),
            "stale"
        );
    }

    #[tokio::test]
    async fn cancelling_the_leader_releases_waiters_and_allows_a_retry() {
        let coordinator = ResourceCoordinator::new(Duration::from_secs(30));
        let (started_sender, started_receiver) = tokio::sync::oneshot::channel();
        let leader = {
            let coordinator = coordinator.clone();
            tokio::spawn(async move {
                coordinator
                    .get_or_fetch(
                        "account-1",
                        LiveResourceKind::Keys,
                        false,
                        move || async move {
                            let _ = started_sender.send(());
                            std::future::pending::<anyhow::Result<String>>().await
                        },
                    )
                    .await
            })
        };
        started_receiver.await.expect("leader started");

        let waiter = {
            let coordinator = coordinator.clone();
            tokio::spawn(async move {
                coordinator
                    .get_or_fetch("account-1", LiveResourceKind::Keys, false, || async {
                        Ok::<_, anyhow::Error>("unexpected".to_string())
                    })
                    .await
            })
        };

        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let registered = coordinator
                    .entries
                    .lock()
                    .await
                    .values()
                    .any(|entry| !entry.waiters.is_empty());
                if registered {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("waiter registered");
        leader.abort();
        let waiter_result = tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .expect("waiter released")
            .expect("waiter task");
        assert!(waiter_result.is_err());

        let retry = coordinator
            .get_or_fetch("account-1", LiveResourceKind::Keys, false, || async {
                Ok::<_, anyhow::Error>("fresh".to_string())
            })
            .await
            .expect("retry succeeds");
        assert_eq!(retry, "fresh");
    }

    #[tokio::test]
    async fn auth_recovery_account_gates_are_serialized_isolated_and_independent_from_usage() {
        let coordinator = ResourceCoordinator::default();
        let first_gate = coordinator
            .acquire_auth_recovery_account_gate("account-1")
            .await;

        assert!(tokio::time::timeout(
            Duration::from_millis(50),
            coordinator.acquire_auth_recovery_account_gate("account-1"),
        )
        .await
        .is_err());

        let other_account_gate = tokio::time::timeout(
            Duration::from_secs(1),
            coordinator.acquire_auth_recovery_account_gate("account-2"),
        )
        .await
        .expect("different account auth gate must remain available");
        drop(other_account_gate);
        drop(first_gate);

        let released_gate = tokio::time::timeout(
            Duration::from_secs(1),
            coordinator.acquire_auth_recovery_account_gate("account-1"),
        )
        .await
        .expect("same account auth gate must be released");
        drop(released_gate);

        let usage_gate = coordinator.acquire_usage_account_gate("account-1").await;
        let auth_gate = tokio::time::timeout(
            Duration::from_secs(1),
            coordinator.acquire_auth_recovery_account_gate("account-1"),
        )
        .await
        .expect("auth recovery gate must not reuse the usage gate");
        drop(auth_gate);
        drop(usage_gate);
    }

    #[tokio::test]
    async fn usage_page_slots_and_account_gates_are_shared_and_bounded() {
        let coordinator = ResourceCoordinator::default();
        let mut permits = Vec::new();
        for _ in 0..16 {
            permits.push(
                coordinator
                    .try_acquire_usage_page_slot()
                    .expect("acquire page slot")
                    .expect("page slot available"),
            );
        }
        assert!(coordinator
            .try_acquire_usage_page_slot()
            .expect("read exhausted page slot")
            .is_none());
        drop(permits.pop());
        assert!(coordinator
            .try_acquire_usage_page_slot()
            .expect("read released page slot")
            .is_some());

        let first_gate = coordinator.acquire_usage_account_gate("account-1").await;
        assert!(coordinator
            .try_acquire_usage_account_gate("account-1")
            .await
            .is_none());
        drop(first_gate);
        assert!(coordinator
            .try_acquire_usage_account_gate("account-1")
            .await
            .is_some());

        let first_subscription_gate = coordinator
            .acquire_subscription_switch_account_gate("account-1")
            .await;
        assert!(coordinator
            .try_acquire_subscription_switch_account_gate("account-1")
            .await
            .is_none());
        drop(first_subscription_gate);
        assert!(coordinator
            .try_acquire_subscription_switch_account_gate("account-1")
            .await
            .is_some());
    }

    #[tokio::test]
    async fn quota_alert_delivery_lifecycle_waits_for_dispatch_and_blocks_new_dispatches() {
        let coordinator = ResourceCoordinator::default();
        let dispatch_guard = coordinator
            .acquire_subscription_quota_alert_delivery_read_gate()
            .await;
        let concurrent_dispatch_guard = tokio::time::timeout(
            Duration::from_secs(1),
            coordinator.acquire_subscription_quota_alert_delivery_read_gate(),
        )
        .await
        .expect("independent deliveries share the lifecycle read gate");
        drop(concurrent_dispatch_guard);
        let (writer_acquired_sender, mut writer_acquired_receiver) =
            tokio::sync::oneshot::channel();
        let (release_writer_sender, release_writer_receiver) = tokio::sync::oneshot::channel();
        let writer = {
            let coordinator = coordinator.clone();
            tokio::spawn(async move {
                let _writer_guard = coordinator
                    .acquire_subscription_quota_alert_delivery_write_gate()
                    .await;
                let _ = writer_acquired_sender.send(());
                let _ = release_writer_receiver.await;
            })
        };

        assert!(
            tokio::time::timeout(Duration::from_millis(50), &mut writer_acquired_receiver,)
                .await
                .is_err()
        );

        drop(dispatch_guard);
        tokio::time::timeout(Duration::from_secs(1), &mut writer_acquired_receiver)
            .await
            .expect("destructive writer acquires after active dispatch completes")
            .expect("destructive writer signals acquisition");

        let mut late_dispatch = {
            let coordinator = coordinator.clone();
            tokio::spawn(async move {
                let _dispatch_guard = coordinator
                    .acquire_subscription_quota_alert_delivery_read_gate()
                    .await;
            })
        };
        assert!(
            tokio::time::timeout(Duration::from_millis(50), &mut late_dispatch)
                .await
                .is_err()
        );

        release_writer_sender
            .send(())
            .expect("release destructive writer");
        writer.await.expect("destructive writer task");
        tokio::time::timeout(Duration::from_secs(1), &mut late_dispatch)
            .await
            .expect("new dispatch resumes after destructive write")
            .expect("new dispatch task");
    }

    #[tokio::test]
    async fn first_completed_usage_sync_is_silent_per_account() {
        let coordinator = ResourceCoordinator::default();

        assert!(
            !coordinator
                .complete_usage_sync_and_should_notify("account-1")
                .await
        );
        assert!(
            coordinator
                .complete_usage_sync_and_should_notify("account-1")
                .await
        );
        assert!(
            !coordinator
                .complete_usage_sync_and_should_notify("account-2")
                .await
        );
    }
}
