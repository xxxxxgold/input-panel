use reqwest::ClientBuilder;

/// 根据已保存的网络模式构造外部上游请求客户端。
pub fn upstream_http_client_builder(use_system_proxy: bool) -> ClientBuilder {
    let builder = reqwest::Client::builder();
    if use_system_proxy {
        builder
    } else {
        builder.no_proxy()
    }
}
