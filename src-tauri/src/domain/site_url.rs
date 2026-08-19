use anyhow::{bail, Context, Result};

/// 将站点 Base URL 规范化为可稳定比较和派生协调键的形式。
pub fn canonicalize_site_base_url(base_url: &str) -> Result<String> {
    let parsed = reqwest::Url::parse(base_url.trim()).context("站点地址格式无效。")?;
    if !matches!(parsed.scheme(), "http" | "https") {
        bail!("站点地址仅支持 http 或 https。")
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        bail!("站点地址不能包含用户名或密码。")
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        bail!("站点地址不能包含查询参数或片段。")
    }

    let host = parsed.host_str().context("站点地址缺少主机名。")?;
    let host = if host.starts_with('[') && host.ends_with(']') {
        host.to_ascii_lowercase()
    } else if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_ascii_lowercase()
    };
    let port = parsed
        .port()
        .map(|value| format!(":{value}"))
        .unwrap_or_default();
    let path = parsed.path().trim_end_matches('/');
    Ok(format!(
        "{}://{}{}{}",
        parsed.scheme().to_ascii_lowercase(),
        host,
        port,
        path
    ))
}

#[cfg(test)]
mod tests {
    use super::canonicalize_site_base_url;

    #[test]
    fn canonicalizes_equivalent_site_urls() {
        assert_eq!(
            canonicalize_site_base_url(" HTTPS://Example.COM:443/api/// ")
                .expect("canonicalize url"),
            "https://example.com/api"
        );
        assert_eq!(
            canonicalize_site_base_url("http://[::1]:80/").expect("canonicalize ipv6"),
            "http://[::1]"
        );
    }

    #[test]
    fn rejects_unsupported_or_identity_bearing_urls() {
        for value in [
            "ftp://example.com",
            "https://user@example.com",
            "https://example.com?token=secret",
            "https://example.com/#fragment",
            "not-a-url",
        ] {
            assert!(
                canonicalize_site_base_url(value).is_err(),
                "{value} should be rejected"
            );
        }
    }
}
