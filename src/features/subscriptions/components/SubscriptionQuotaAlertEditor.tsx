import { Bell, LoaderCircle, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type {
  SubscriptionQuotaAlertConfig,
  SubscriptionQuotaAlertRule,
  SubscriptionQuotaAlertThresholdMode
} from "../../../types";
import { upsertSubscriptionQuotaAlert } from "../quota-alert-client";

type QuotaAlertDraft = Pick<
  SubscriptionQuotaAlertRule,
  "enabled" | "thresholdMode" | "thresholdValue"
>;

type QuotaAlertSaveFeedback = {
  tone: "success" | "error";
  title: string;
  message: string;
};

export function SubscriptionQuotaAlertEditor({
  accountId,
  subscriptionKey,
  identityAmbiguous,
  rule,
  onSaved,
  onSaveFeedback
}: {
  accountId: string | null;
  subscriptionKey: string;
  identityAmbiguous: boolean;
  rule: SubscriptionQuotaAlertRule;
  onSaved?: (
    saved: SubscriptionQuotaAlertConfig,
    accountId: string
  ) => Promise<unknown> | unknown;
  onSaveFeedback: (feedback: QuotaAlertSaveFeedback) => void;
}) {
  const [draft, setDraft] = useState<QuotaAlertDraft>(() => toDraft(rule));
  const [baseline, setBaseline] = useState<QuotaAlertDraft>(() => toDraft(rule));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const next = toDraft(rule);
    setDraft(next);
    setBaseline(next);
  }, [rule, subscriptionKey]);

  const validationError = useMemo(() => validateDraft(draft), [draft]);
  const dirty = !sameDraft(draft, baseline);
  const unavailableReason = !accountId
    ? "当前未选中账号，无法保存额度提醒。"
    : identityAmbiguous || !subscriptionKey
      ? "当前订阅缺少可唯一识别的稳定身份，暂时不能保存独立配置。"
      : null;
  const controlsDisabled = saving || Boolean(unavailableReason);

  const updateDraft = (next: Partial<QuotaAlertDraft>) => {
    setDraft((current) => ({ ...current, ...next }));
  };

  const handleSave = async () => {
    if (!accountId || unavailableReason || validationError || !dirty || saving) {
      return;
    }
    setSaving(true);
    try {
      const saved = await upsertSubscriptionQuotaAlert(accountId, {
        subscriptionKey,
        enabled: draft.enabled,
        thresholdMode: draft.thresholdMode,
        thresholdValue: draft.thresholdValue
      });
      const savedDraft = toDraft(saved.rule);
      setDraft(savedDraft);
      setBaseline(savedDraft);
      try {
        await onSaved?.(saved, accountId);
        onSaveFeedback({
          tone: "success",
          title: "保存成功",
          message: "额度提醒配置已保存。"
        });
      } catch (cause) {
        onSaveFeedback({
          tone: "error",
          title: "刷新失败",
          message: `额度提醒配置已保存，但刷新显示失败: ${(cause as Error)?.message?.trim() || "请稍后重试。"}`
        });
      }
    } catch (cause) {
      onSaveFeedback({
        tone: "error",
        title: "保存失败",
        message: (cause as Error)?.message?.trim() || "额度提醒配置保存失败。"
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="subscription-quota-alert-editor" aria-labelledby="subscription-quota-alert-title">
      <header className="subscription-quota-alert-editor-head">
        <div className="subscription-quota-alert-editor-title">
          <Bell aria-hidden="true" size={18} strokeWidth={1.8} />
          <div>
            <h3 id="subscription-quota-alert-title">额度提醒</h3>
          </div>
        </div>
        <label className="toggle-field subscription-quota-alert-toggle">
          <span>启用提醒</span>
          <span className="subscription-switch-toggle-control">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => updateDraft({ enabled: event.target.checked })}
              disabled={controlsDisabled}
            />
            <span className="subscription-switch-toggle-track" aria-hidden="true" />
          </span>
        </label>
      </header>

      <div className="subscription-quota-alert-controls">
        <fieldset className="subscription-quota-alert-mode" disabled={controlsDisabled || !draft.enabled}>
          <legend>提醒条件</legend>
          <div className="subscription-quota-alert-segmented">
            <QuotaAlertModeOption
              mode="usage_percent"
              label="已用百分比"
              checked={draft.thresholdMode === "usage_percent"}
              onChange={(mode) => updateDraft({ thresholdMode: mode })}
            />
            <QuotaAlertModeOption
              mode="amount_usd"
              label="已用美元"
              checked={draft.thresholdMode === "amount_usd"}
              onChange={(mode) => updateDraft({ thresholdMode: mode })}
            />
          </div>
        </fieldset>

        <label className="field subscription-quota-alert-value">
          <span>{draft.thresholdMode === "usage_percent" ? "达到百分比" : "达到金额"}</span>
          <div className="subscription-quota-alert-input-shell">
            <span aria-hidden="true">{draft.thresholdMode === "usage_percent" ? "%" : "$"}</span>
            <input
              type="number"
              aria-label={draft.thresholdMode === "usage_percent" ? "达到百分比" : "达到金额"}
              min="0.01"
              max={draft.thresholdMode === "usage_percent" ? "100" : undefined}
              step="0.01"
              value={Number.isFinite(draft.thresholdValue) ? draft.thresholdValue : ""}
              onChange={(event) => updateDraft({ thresholdValue: event.target.valueAsNumber })}
              disabled={controlsDisabled || !draft.enabled}
              aria-invalid={Boolean(validationError)}
            />
          </div>
        </label>

        <button
          type="button"
          className="primary-button subscription-quota-alert-save"
          onClick={() => void handleSave()}
          disabled={controlsDisabled || Boolean(validationError) || !dirty}
          title="保存额度提醒配置"
        >
          {saving ? (
            <LoaderCircle className="spin" aria-hidden="true" size={16} />
          ) : (
            <Save aria-hidden="true" size={16} />
          )}
          <span>{saving ? "保存中" : "保存"}</span>
        </button>
      </div>

      <div
        className="subscription-quota-alert-feedback"
        aria-live="polite"
      >
        {unavailableReason ?? validationError ?? ""}
      </div>
    </section>
  );
}

function QuotaAlertModeOption({
  mode,
  label,
  checked,
  onChange
}: {
  mode: SubscriptionQuotaAlertThresholdMode;
  label: string;
  checked: boolean;
  onChange: (mode: SubscriptionQuotaAlertThresholdMode) => void;
}) {
  return (
    <label className={checked ? "active" : ""}>
      <input
        type="radio"
        name="subscription-quota-alert-mode"
        value={mode}
        checked={checked}
        onChange={() => onChange(mode)}
      />
      <span>{label}</span>
    </label>
  );
}

function toDraft(rule: SubscriptionQuotaAlertRule): QuotaAlertDraft {
  return {
    enabled: rule.enabled,
    thresholdMode: rule.thresholdMode,
    thresholdValue: rule.thresholdValue
  };
}

function sameDraft(left: QuotaAlertDraft, right: QuotaAlertDraft) {
  return left.enabled === right.enabled
    && left.thresholdMode === right.thresholdMode
    && left.thresholdValue === right.thresholdValue;
}

function validateDraft(draft: QuotaAlertDraft) {
  if (!Number.isFinite(draft.thresholdValue) || draft.thresholdValue <= 0) {
    return "提醒阈值必须是大于 0 的数字。";
  }
  if (draft.thresholdMode === "usage_percent" && draft.thresholdValue > 100) {
    return "百分比提醒阈值不能超过 100%。";
  }
  return null;
}
