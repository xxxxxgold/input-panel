import { useEffect, useRef, useState } from "react";

import { formatTime, maskSecret } from "../../../shared/lib/formatters";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { StatusBadge } from "../../../shared/ui/StatusBadge";
import type { KeyRecord } from "../../../types";
import "./ApiKeyList.css";

export type ApiKeyListRecord = KeyRecord & {
  rawKey?: string | null;
  apiKeyId?: number | null;
  accountId?: string | null;
  siteName?: string | null;
  accountLabel?: string | null;
};

type CopyFeedback = {
  keyId: string;
  state: "copied" | "failed";
} | null;

async function copyTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();

  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);

  if (!copied) {
    throw new Error("当前环境不支持复制到剪贴板。");
  }
}

function resolveKeySecretDisplay(key: ApiKeyListRecord) {
  const rawKey = key.rawKey?.trim();
  if (rawKey) {
    return {
      label: maskSecret(rawKey),
      copyValue: rawKey,
      canCopy: true
    };
  }

  return {
    label: "原始密钥未返回",
    copyValue: "",
    canCopy: false
  };
}

function resolveKeyAccountLabel(key: ApiKeyListRecord) {
  const label = key.accountLabel?.trim();
  return label ? label : null;
}

export function ApiKeyList({ keys }: { keys: ApiKeyListRecord[] }) {
  const [copyFeedback, setCopyFeedback] = useState<CopyFeedback>(null);
  const copyFeedbackTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyFeedbackTimerRef.current != null) {
        window.clearTimeout(copyFeedbackTimerRef.current);
      }
    };
  }, []);

  async function handleCopyKey(key: ApiKeyListRecord) {
    const secret = resolveKeySecretDisplay(key);
    if (!secret.canCopy) {
      return;
    }

    try {
      await copyTextToClipboard(secret.copyValue);
      setCopyFeedback({ keyId: key.id, state: "copied" });
    } catch {
      setCopyFeedback({ keyId: key.id, state: "failed" });
    }

    if (copyFeedbackTimerRef.current != null) {
      window.clearTimeout(copyFeedbackTimerRef.current);
    }
    copyFeedbackTimerRef.current = window.setTimeout(() => {
      setCopyFeedback((current) => (current?.keyId === key.id ? null : current));
    }, 1800);
  }

  if (keys.length === 0) {
    return <EmptyState title="当前没有密钥" detail="这个账号暂时没有可展示的密钥列表。" compact />;
  }
  return (
    <div className="table-list wide api-key-summary-list">
      {keys.map((key) => {
        const platformTone = (key.platform ?? "unknown").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
        const statusState = key.status === "active" ? "ready" : "expired";
        const secret = resolveKeySecretDisplay(key);
        const accountLabel = resolveKeyAccountLabel(key);
        const feedbackState = copyFeedback?.keyId === key.id ? copyFeedback.state : null;
        return (
          <div key={key.id} className="table-row wide key-row api-key-summary-row">
            <div className="row-main key-row-main">
              <div className="key-heading-row">
                <div className="key-title-cluster">
                  <strong>{key.name}</strong>
                  <StatusBadge state={statusState} />
                </div>
                <div className="key-secret-line api-key-summary-context">
                  {accountLabel ? <span className="api-key-summary-account-pill">{accountLabel}</span> : null}
                  <span className="key-context-name">{key.groupName ?? "未分组"}</span>
                  <span className={`key-platform-pill ${platformTone}`}>{key.platform ?? "unknown"}</span>
                </div>
              </div>
              <div className="key-secret-row api-key-summary-secret-row">
                <small className="key-secret-text">{secret.label}</small>
                <button
                  type="button"
                  className={`key-copy-button api-key-summary-copy-button ${
                    feedbackState === "copied" ? "copied" : ""
                  }`}
                  onClick={() => void handleCopyKey(key)}
                  disabled={!secret.canCopy}
                >
                  {feedbackState === "copied" ? "已复制" : feedbackState === "failed" ? "复制失败" : "复制"}
                </button>
                <span className="row-meta key-row-meta api-key-summary-meta">
                  {key.lastUsedAt ? `最后使用时间：${formatTime(key.lastUsedAt)}` : "最近未使用"}
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
