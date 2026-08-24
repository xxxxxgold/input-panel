use axum::Router;
use tokio::{
    net::TcpListener,
    sync::{oneshot, watch},
    task::JoinHandle,
};

/// 测试专用的 Axum 服务守卫，正常路径会等待所有连接任务完成。
pub(crate) struct TestAxumServer {
    base_url: String,
    shutdown_tx: watch::Sender<bool>,
    task: Option<JoinHandle<()>>,
}

impl TestAxumServer {
    /// 启动具备显式 shutdown 信号的 mock；路由可订阅该信号以结束慢请求。
    pub(crate) async fn start(build_router: impl FnOnce(watch::Receiver<bool>) -> Router) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test Axum listener");
        let address = listener
            .local_addr()
            .expect("read test Axum listener address");
        let (shutdown_tx, mut server_shutdown) = watch::channel(false);
        let app = build_router(shutdown_tx.subscribe());
        let (ready_tx, ready_rx) = oneshot::channel();
        let task = tokio::spawn(async move {
            let _ = ready_tx.send(());
            axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    wait_for_shutdown(&mut server_shutdown).await;
                })
                .await
                .expect("serve test Axum app");
        });

        ready_rx.await.expect("start test Axum task");
        Self {
            base_url: format!("http://{address}"),
            shutdown_tx,
            task: Some(task),
        }
    }

    pub(crate) fn base_url(&self) -> &str {
        &self.base_url
    }

    /// 正常结束时先停止接收新连接，再等待活动请求完成。
    pub(crate) async fn shutdown(mut self) {
        let _ = self.shutdown_tx.send(true);
        if let Some(task) = self.task.take() {
            task.await.expect("join test Axum server");
        }
    }
}

impl Drop for TestAxumServer {
    fn drop(&mut self) {
        let _ = self.shutdown_tx.send(true);
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

async fn wait_for_shutdown(shutdown: &mut watch::Receiver<bool>) {
    if !*shutdown.borrow() {
        let _ = shutdown.changed().await;
    }
}
