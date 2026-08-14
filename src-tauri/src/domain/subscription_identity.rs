use std::collections::HashMap;

use crate::contracts::{SubscriptionIdentityKind, SubscriptionRecord};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DerivedSubscriptionIdentity {
    pub subscription_key: String,
    pub identity_kind: SubscriptionIdentityKind,
    pub upstream_subscription_id: Option<String>,
    pub fallback_identity: String,
}

/// 按 group、上游 ID、版本化 fallback 的顺序生成可持久化订阅身份。
pub fn derive_subscription_identity(
    group_id: Option<i64>,
    upstream_subscription_id: Option<&str>,
    platform: Option<&str>,
    group_name: Option<&str>,
    name: &str,
) -> DerivedSubscriptionIdentity {
    let upstream_subscription_id = upstream_subscription_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let fallback_identity = format!(
        "fallback:v1:{}|{}|{}",
        encode_identity_segment(platform.unwrap_or_default()),
        encode_identity_segment(group_name.unwrap_or_default()),
        encode_identity_segment(name),
    );
    if let Some(group_id) = group_id {
        return DerivedSubscriptionIdentity {
            subscription_key: format!("group:{group_id}"),
            identity_kind: SubscriptionIdentityKind::Group,
            upstream_subscription_id,
            fallback_identity,
        };
    }
    if let Some(upstream_id) = upstream_subscription_id.as_deref() {
        return DerivedSubscriptionIdentity {
            subscription_key: format!("upstream:{}", encode_identity_segment(upstream_id)),
            identity_kind: SubscriptionIdentityKind::Upstream,
            upstream_subscription_id,
            fallback_identity,
        };
    }
    DerivedSubscriptionIdentity {
        subscription_key: fallback_identity.clone(),
        identity_kind: SubscriptionIdentityKind::Fallback,
        upstream_subscription_id: None,
        fallback_identity,
    }
}

/// 同一快照无法凭稳定字段区分的重复身份必须显式标记，禁止按列表顺序猜测。
pub fn mark_ambiguous_subscription_identities(subscriptions: &mut [SubscriptionRecord]) {
    let mut counts = HashMap::<String, usize>::new();
    for subscription in subscriptions.iter() {
        *counts
            .entry(subscription.subscription_key.clone())
            .or_default() += 1;
    }
    for subscription in subscriptions {
        subscription.identity_ambiguous = counts
            .get(subscription.subscription_key.as_str())
            .is_some_and(|count| *count > 1);
    }
}

fn encode_identity_segment(value: &str) -> String {
    let normalized = value.trim().to_lowercase();
    let mut encoded = String::with_capacity(normalized.len());
    for byte in normalized.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(char::from(*byte));
        } else {
            encoded.push('%');
            encoded.push_str(&format!("{byte:02X}"));
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_prefers_group_then_upstream_then_versioned_fallback() {
        let group = derive_subscription_identity(
            Some(42),
            Some("subscription/one"),
            Some("OpenAI"),
            Some("Main"),
            "Pro Plan",
        );
        assert_eq!(group.subscription_key, "group:42");
        assert_eq!(group.identity_kind, SubscriptionIdentityKind::Group);

        let upstream = derive_subscription_identity(
            None,
            Some("subscription/one"),
            Some("OpenAI"),
            Some("Main"),
            "Pro Plan",
        );
        assert_eq!(upstream.subscription_key, "upstream:subscription%2Fone");
        assert_eq!(upstream.identity_kind, SubscriptionIdentityKind::Upstream);

        let fallback =
            derive_subscription_identity(None, None, Some("OpenAI"), Some("主组"), "Pro Plan");
        assert_eq!(
            fallback.subscription_key,
            "fallback:v1:openai|%E4%B8%BB%E7%BB%84|pro%20plan"
        );
        assert_eq!(fallback.identity_kind, SubscriptionIdentityKind::Fallback);
    }
}
