import { useRef, useState } from "react";
import { CalendarDays, ChevronDown, Plus, Search } from "lucide-react";

import type { GroupRecord, KeyMutationInput, ManagedKeyRecord, PaginatedResult, UserProfileRecord } from "../types";
import { formatSubscriptionTypeLabel, maskSecret, formatTime } from "../shared/lib/formatters";
import {
  buildKeyExpiryValue,
  inferKeyExpiryPreset,
  KEY_EXPIRY_PRESET_DAYS,
  parseOptionalNumberInput,
  type KeyExpiryPreset
} from "../shared/lib/key-utils";
import { EmptyState } from "../shared/ui/EmptyState";
import { Modal } from "../shared/ui/Modal";
import { SectionCard } from "../shared/ui/SectionCard";
import { StatusBadge } from "../shared/ui/StatusBadge";
import {
  createManagedKey,
  deleteManagedKey,
  getManagedKey,
  updateManagedKey
} from "../features/keys/client";

function isSubscriptionGroup(group: Pick<GroupRecord, "subscriptionType">) {
  return group.subscriptionType?.trim().toLowerCase() === "subscription";
}

function sortAvailableGroups(groups: GroupRecord[]) {
  return [...groups].sort((left, right) => Number(isSubscriptionGroup(right)) - Number(isSubscriptionGroup(left)));
}

function formatAvailableGroupTypeLabel(value?: string | null) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "standard") return "余额";
  return formatSubscriptionTypeLabel(value);
}

function formatAvailableGroupQuota(value: number) {
  if (Number.isInteger(value)) return `$${value.toFixed(0)}`;
  return `$${value.toFixed(2).replace(/\.?0+$/, "")}`;
}

function buildAvailableGroupQuotaItems(group: Pick<GroupRecord, "dailyLimitUsd" | "weeklyLimitUsd" | "monthlyLimitUsd">) {
  return [
    { label: "日", value: Number(group.dailyLimitUsd ?? 0) },
    { label: "周", value: Number(group.weeklyLimitUsd ?? 0) },
    { label: "月", value: Number(group.monthlyLimitUsd ?? 0) }
  ].filter((item) => item.value > 0);
}

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

export function KeysPage({
  managedKeys,
  groups,
  selectedAccountId,
  onRefresh,
  onError,
  onBusy
}: {
  managedKeys: PaginatedResult<ManagedKeyRecord> | null;
  groups: GroupRecord[];
  profileRecord: UserProfileRecord | null;
  selectedAccountId: string | null;
  onRefresh: () => void;
  onError: (message: string | null) => void;
  onBusy: (text: string | null) => void;
}) {
  const [keyModalOpen, setKeyModalOpen] = useState(false);
  const [editingKey, setEditingKey] = useState<ManagedKeyRecord | null>(null);
  const [keyGroupPickerOpen, setKeyGroupPickerOpen] = useState(false);
  const [keyGroupSearch, setKeyGroupSearch] = useState("");
  const [keyCustomKeyEnabled, setKeyCustomKeyEnabled] = useState(false);
  const [keyIpLimitEnabled, setKeyIpLimitEnabled] = useState(false);
  const [keyRateLimitEnabled, setKeyRateLimitEnabled] = useState(false);
  const [keyExpiryEnabled, setKeyExpiryEnabled] = useState(false);
  const [keyExpiryPreset, setKeyExpiryPreset] = useState<KeyExpiryPreset>("30d");
  const [keyExpiryDateTime, setKeyExpiryDateTime] = useState(buildKeyExpiryValue(30));
  const [copiedKeyId, setCopiedKeyId] = useState<string | null>(null);
  const copiedKeyTimerRef = useRef<number | null>(null);
  const [keyForm, setKeyForm] = useState<KeyMutationInput>({
    name: "",
    groupId: null,
    customKey: "",
    ipWhitelist: "",
    ipBlacklist: "",
    quota: null,
    expiresInDays: 30,
    status: "active",
    rateLimit5h: null,
    rateLimit1d: null,
    rateLimit7d: null
  });

  const orderedGroups = sortAvailableGroups(groups);

  const filteredKeyGroups = orderedGroups.filter((group) => {
    if (!keyGroupSearch.trim()) return true;
    const keyword = keyGroupSearch.trim().toLowerCase();
    return (
      group.name.toLowerCase().includes(keyword) ||
      group.platform.toLowerCase().includes(keyword) ||
      (group.subscriptionType ?? "").toLowerCase().includes(keyword)
    );
  });

  const selectedKeyGroup =
    groups.find((group) => group.id === keyForm.groupId) ??
    (editingKey && keyForm.groupId != null
      ? {
          id: keyForm.groupId,
          name: editingKey.groupName ?? `当前分组 #${keyForm.groupId}`,
          platform: editingKey.platform ?? "unknown",
          rateMultiplier: 1,
          subscriptionType: "unknown"
        }
      : null);

  function resetKeyForm(nextGroupId?: number | null) {
    setKeyForm({
      name: "",
      groupId: nextGroupId ?? orderedGroups[0]?.id ?? null,
      customKey: "",
      ipWhitelist: "",
      ipBlacklist: "",
      quota: null,
      expiresInDays: 30,
      status: "active",
      rateLimit5h: 0,
      rateLimit1d: 0,
      rateLimit7d: 0
    });
    setKeyGroupPickerOpen(false);
    setKeyGroupSearch("");
    setKeyCustomKeyEnabled(false);
    setKeyIpLimitEnabled(false);
    setKeyRateLimitEnabled(false);
    setKeyExpiryEnabled(false);
    setKeyExpiryPreset("30d");
    setKeyExpiryDateTime(buildKeyExpiryValue(30));
  }

  function openNewKey() {
    if (!selectedAccountId) {
      onError("请先选择一个账号，再新增密钥。");
      return;
    }
    onError(null);
    setEditingKey(null);
    resetKeyForm();
    setKeyModalOpen(true);
  }

  async function openEditKey(keyId: string) {
    if (!selectedAccountId) return;
    onBusy("正在加载密钥详情...");
    onError(null);
    try {
      const key = await getManagedKey(selectedAccountId, keyId);
      setEditingKey(key);
      setKeyForm({
        name: key.name,
        groupId: key.groupId ?? null,
        customKey: key.rawKey ?? "",
        ipWhitelist: key.ipWhitelist ?? "",
        ipBlacklist: key.ipBlacklist ?? "",
        quota: key.quota ?? 0,
        expiresInDays: null,
        status: key.status,
        rateLimit5h: key.rateLimit5h ?? 0,
        rateLimit1d: key.rateLimit1d ?? 0,
        rateLimit7d: key.rateLimit7d ?? 0
      });
      setKeyGroupPickerOpen(false);
      setKeyGroupSearch("");
      setKeyCustomKeyEnabled(Boolean(key.rawKey));
      setKeyIpLimitEnabled(Boolean((key.ipWhitelist ?? "").trim() || (key.ipBlacklist ?? "").trim()));
      setKeyRateLimitEnabled(Boolean((key.rateLimit5h ?? 0) || (key.rateLimit1d ?? 0) || (key.rateLimit7d ?? 0)));
      const expiryState = inferKeyExpiryPreset(key.expiresAt);
      setKeyExpiryEnabled(expiryState.enabled);
      setKeyExpiryPreset(expiryState.preset);
      setKeyExpiryDateTime(expiryState.value);
      setKeyModalOpen(true);
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      onBusy(null);
    }
  }

  function handleKeyExpiryPresetSelect(nextPreset: KeyExpiryPreset) {
    setKeyExpiryPreset(nextPreset);
    if (nextPreset === "custom") {
      if (!keyExpiryDateTime) {
        setKeyExpiryDateTime(buildKeyExpiryValue(30));
      }
      return;
    }
    const nextDays = Number(nextPreset.replace("d", ""));
    setKeyExpiryDateTime(buildKeyExpiryValue(nextDays));
  }

  async function submitKeyForm() {
    if (!selectedAccountId) {
      onError("请先选择一个账号，再提交密钥。");
      return;
    }
    if (!keyForm.name.trim()) {
      onError("请输入密钥名称。");
      return;
    }
    if (keyForm.groupId == null) {
      onError("请选择一个可用分组。");
      return;
    }
    if (keyCustomKeyEnabled) {
      const customKey = keyForm.customKey?.trim() || "";
      if (customKey.length < 16) {
        onError("自定义密钥至少需要 16 个字符。");
        return;
      }
    }
    if (keyExpiryEnabled && (!keyExpiryDateTime || Number.isNaN(new Date(keyExpiryDateTime).getTime()))) {
      onError("请选择有效的过期时间。");
      return;
    }

    onBusy(editingKey ? "正在更新密钥..." : "正在创建密钥...");
    onError(null);
    try {
      const normalizedCustomKey = keyCustomKeyEnabled ? keyForm.customKey?.trim() || "" : undefined;
      const normalizedIpWhitelist = keyIpLimitEnabled ? keyForm.ipWhitelist?.trim() || "" : "";
      const normalizedIpBlacklist = keyIpLimitEnabled ? keyForm.ipBlacklist?.trim() || "" : "";
      const normalizedExpiryDays = keyExpiryEnabled
        ? (keyExpiryPreset === "custom"
            ? Math.max(1, Math.ceil((new Date(keyExpiryDateTime).getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
            : Number(keyExpiryPreset.replace("d", "")))
        : null;
      const payload: KeyMutationInput = {
        ...keyForm,
        name: keyForm.name.trim(),
        customKey: normalizedCustomKey,
        ipWhitelist: normalizedIpWhitelist,
        ipBlacklist: normalizedIpBlacklist,
        expiresInDays: normalizedExpiryDays,
        rateLimit5h: keyRateLimitEnabled ? keyForm.rateLimit5h : 0,
        rateLimit1d: keyRateLimitEnabled ? keyForm.rateLimit1d : 0,
        rateLimit7d: keyRateLimitEnabled ? keyForm.rateLimit7d : 0
      };
      if (editingKey) {
        await updateManagedKey(selectedAccountId, editingKey.id, payload);
      } else {
        await createManagedKey(selectedAccountId, payload);
      }
      setKeyModalOpen(false);
      onRefresh();
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      onBusy(null);
    }
  }

  async function handleDeleteKey(keyId: string) {
    if (!selectedAccountId) return;
    onBusy("正在删除密钥...");
    onError(null);
    try {
      await deleteManagedKey(selectedAccountId, keyId);
      onRefresh();
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      onBusy(null);
    }
  }

  async function handleToggleKeyStatus(key: ManagedKeyRecord) {
    if (!selectedAccountId) return;
    onBusy(`正在${key.status === "active" ? "停用" : "启用"}密钥...`);
    onError(null);
    try {
      await updateManagedKey(selectedAccountId, key.id, {
        status: key.status === "active" ? "inactive" : "active"
      });
      onRefresh();
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      onBusy(null);
    }
  }

  async function handleResetQuota(key: ManagedKeyRecord) {
    if (!selectedAccountId) return;
    onBusy("正在重置已用额度...");
    onError(null);
    try {
      await updateManagedKey(selectedAccountId, key.id, { resetQuota: true });
      onRefresh();
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      onBusy(null);
    }
  }

  async function handleResetRateLimitUsage(key: ManagedKeyRecord) {
    if (!selectedAccountId) return;
    onBusy("正在重置限流用量...");
    onError(null);
    try {
      await updateManagedKey(selectedAccountId, key.id, { resetRateLimitUsage: true });
      onRefresh();
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      onBusy(null);
    }
  }

  async function handleCopyKey(key: ManagedKeyRecord) {
    const rawKey = key.rawKey?.trim();
    if (!rawKey) {
      onError("当前密钥未返回原始 Key, 无法复制。");
      return;
    }

    onError(null);
    try {
      await copyTextToClipboard(rawKey);
      setCopiedKeyId(key.id);
      if (copiedKeyTimerRef.current != null) {
        window.clearTimeout(copiedKeyTimerRef.current);
      }
      copiedKeyTimerRef.current = window.setTimeout(() => {
        setCopiedKeyId((current) => (current === key.id ? null : current));
      }, 1800);
    } catch (cause) {
      onError((cause as Error).message);
    }
  }

  return (
    <>
      <section className="stack-list keys-page-layout">
        <SectionCard title="可用分组" subtitle="当前账号真实可创建密钥的分组能力">
          <div className="stack-list">
            {orderedGroups.map((group) => {
              const platformTone = (group.platform ?? "unknown").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
              const subscriptionType = formatAvailableGroupTypeLabel(group.subscriptionType);
              const quotaItems = buildAvailableGroupQuotaItems(group);
              return (
                <div key={group.id} className="subscription-card available-group-card">
                  <div className="available-group-row">
                    <div className="available-group-copy">
                      <strong>{group.name}</strong>
                      <div className="available-group-tags">
                        <span className={`key-platform-pill ${platformTone}`}>{group.platform ?? "unknown"}</span>
                        <span className="subscription-type-pill">{subscriptionType}</span>
                      </div>
                    </div>
                    <div className="available-group-inline">
                      {quotaItems.length > 0 && (
                        <div className="available-group-quotas" aria-label="分组额度">
                          {quotaItems.map((item) => (
                            <span key={item.label} className="available-group-quota-pill">
                              <small>{item.label}</small>
                              <strong>{formatAvailableGroupQuota(item.value)}</strong>
                            </span>
                          ))}
                        </div>
                      )}
                      <span className="subscription-rate-pill">倍率: x{group.rateMultiplier.toFixed(2)}</span>
                      <span className={`available-group-dispatch-pill ${group.allowMessagesDispatch ? "ready" : "neutral"}`}>
                        {group.allowMessagesDispatch ? "支持调度" : "仅直连"}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
            {groups.length === 0 && (
              <EmptyState title="当前没有可用分组" detail="若网页版能创建密钥，这里应返回可用 groups。" compact />
            )}
          </div>
        </SectionCard>
        <SectionCard
          title="密钥管理"
          subtitle="统一管理密钥的创建、编辑、启停与重置操作"
          actions={
            <button className="primary-button" onClick={openNewKey}>
              <Plus size={16} />
              新增密钥
            </button>
          }
        >
          <div className="table-list wide">
            {managedKeys?.items.map((key) => {
              const platformTone = (key.platform ?? "unknown").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
              const maskedKey = key.rawKey ? maskSecret(key.rawKey) : "自定义密钥未暴露";
              const canCopyKey = Boolean(key.rawKey?.trim());
              const hasQuotaLimit = Number(key.quota ?? 0) > 0;
              return (
                <div key={key.id} className="table-row wide key-row">
                  <div className="row-main key-row-main">
                    <div className="key-heading-row">
                      <div className="key-title-cluster">
                        <StatusBadge state={key.status === "active" ? "ready" : "expired"} />
                        <strong>{key.name}</strong>
                      </div>
                      <div className="key-secret-line">
                        <span className="key-context-name">{key.groupName ?? "未分组"}</span>
                        <span className={`key-platform-pill ${platformTone}`}>{key.platform ?? "unknown"}</span>
                      </div>
                    </div>
                    <div className="key-secret-row">
                      <small className="key-secret-text">{maskedKey}</small>
                      <button
                        type="button"
                        className={`key-copy-button ${copiedKeyId === key.id ? "copied" : ""}`}
                        onClick={() => handleCopyKey(key)}
                        disabled={!canCopyKey}
                      >
                        {copiedKeyId === key.id ? "已复制" : "复制"}
                      </button>
                    </div>
                    <div className="row-meta key-row-meta">
                      {hasQuotaLimit && <span>限制额度 ${Number(key.quota ?? 0).toFixed(2)}</span>}
                      <span>{key.lastUsedAt ? `最后使用时间：${formatTime(key.lastUsedAt)}` : "最近未使用"}</span>
                    </div>
                  </div>
                  <div className="row-actions wrap-actions key-row-actions">
                    <div className="key-action-cluster">
                      <button className="inline-text-button" type="button" onClick={() => openEditKey(key.id)}>
                        编辑
                      </button>
                      <button className="inline-text-button" type="button" onClick={() => handleToggleKeyStatus(key)}>
                        {key.status === "active" ? "停用" : "启用"}
                      </button>
                      <button className="inline-text-button danger" type="button" onClick={() => handleDeleteKey(key.id)}>
                        删除
                      </button>
                    </div>
                    <div className="key-action-cluster secondary">
                      <button className="inline-text-button" type="button" onClick={() => handleResetRateLimitUsage(key)}>
                        重置限流
                      </button>
                      <button className="inline-text-button" type="button" onClick={() => handleResetQuota(key)}>
                        重置额度
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
            {(!managedKeys || managedKeys.items.length === 0) && (
              <EmptyState title="当前没有密钥数据" detail="先登录并刷新当前账号后再管理密钥。" compact />
            )}
          </div>
        </SectionCard>
      </section>

      {keyModalOpen && (
        <Modal
          title={editingKey ? "编辑密钥" : "创建密钥"}
          onClose={() => setKeyModalOpen(false)}
          onSubmit={() => submitKeyForm()}
          submitText={editingKey ? "更新密钥" : "创建密钥"}
          size="wide"
          className="key-modal"
          bodyClassName="key-modal-body"
          footerClassName="key-modal-footer"
          headerClassName="key-modal-header"
          closeText={null}
        >
          <div className="key-modal-shell">
            <section className="key-modal-section">
              <label className="field key-modal-field">
                <span>名称</span>
                <input
                  value={keyForm.name}
                  onChange={(event) => setKeyForm((prev) => ({ ...prev, name: event.target.value }))}
                  placeholder="我的 API 密钥"
                />
              </label>
              <div className="field key-modal-field">
                <span>分组</span>
                <div className="key-group-picker">
                  <button
                    type="button"
                    className={`key-group-trigger ${keyGroupPickerOpen ? "open" : ""}`}
                    onClick={() => {
                      if (groups.length === 0) return;
                      setKeyGroupPickerOpen((prev) => !prev);
                    }}
                    disabled={groups.length === 0}
                    aria-expanded={keyGroupPickerOpen}
                    aria-label="选择分组"
                  >
                    <div className="key-group-trigger-copy">
                      <strong>{selectedKeyGroup?.name ?? "选择分组"}</strong>
                      <span>{selectedKeyGroup ? `${selectedKeyGroup.platform} / x${selectedKeyGroup.rateMultiplier.toFixed(1)}` : ""}</span>
                    </div>
                    <ChevronDown size={18} className={`site-picker-icon ${keyGroupPickerOpen ? "open" : ""}`} />
                  </button>
                  {keyGroupPickerOpen && groups.length > 0 && (
                    <div className="key-group-dropdown">
                      <label className="key-group-search">
                        <Search size={16} />
                        <input
                          value={keyGroupSearch}
                          onChange={(event) => setKeyGroupSearch(event.target.value)}
                          placeholder="搜索分组..."
                        />
                      </label>
                      <div className="key-group-list">
                        {filteredKeyGroups.map((group) => (
                          <button
                            key={group.id}
                            type="button"
                            className={`key-group-option ${group.id === keyForm.groupId ? "selected" : ""}`}
                            onClick={() => {
                              setKeyForm((prev) => ({ ...prev, groupId: group.id }));
                              setKeyGroupPickerOpen(false);
                              setKeyGroupSearch("");
                            }}
                          >
                            <div className="key-group-option-main">
                              <span className={`key-group-platform ${group.platform}`}>{group.platform}</span>
                              <strong>{group.name}</strong>
                            </div>
                            <span className="key-group-rate">{`${group.rateMultiplier.toFixed(group.rateMultiplier < 1 ? 1 : 0)}x 倍率`}</span>
                          </button>
                        ))}
                        {filteredKeyGroups.length === 0 && <div className="key-group-empty">没有匹配的分组</div>}
                      </div>
                    </div>
                  )}
                </div>
                {groups.length === 0 && <p className="field-help">当前账号没有返回可用分组，先刷新账号后再创建密钥。</p>}
              </div>
            </section>

            <section className="key-modal-section">
              <div className="key-switch-row">
                <div>
                  <strong>自定义密钥</strong>
                  <p>仅允许字母、数字、下划线和连字符，最少16个字符。</p>
                </div>
                <button
                  type="button"
                  className={`switch-pill ${keyCustomKeyEnabled ? "on" : ""}`}
                  onClick={() => setKeyCustomKeyEnabled((prev) => !prev)}
                  aria-pressed={keyCustomKeyEnabled}
                >
                  <span />
                </button>
              </div>
              {keyCustomKeyEnabled && (
                <label className="field key-modal-field">
                  <span>自定义密钥</span>
                  <input
                    value={keyForm.customKey ?? ""}
                    onChange={(event) => setKeyForm((prev) => ({ ...prev, customKey: event.target.value }))}
                    placeholder="输入自定义密钥 (至少16个字符)"
                  />
                  <p className="field-help">仅允许字母、数字、下划线和连字符，最少16个字符。</p>
                </label>
              )}
            </section>

            <section className="key-modal-section">
              <div className="key-switch-row">
                <div>
                  <strong>IP 限制</strong>
                  <p>开启后可按白名单和黑名单限制此密钥的来源 IP。</p>
                </div>
                <button
                  type="button"
                  className={`switch-pill ${keyIpLimitEnabled ? "on" : ""}`}
                  onClick={() => setKeyIpLimitEnabled((prev) => !prev)}
                  aria-pressed={keyIpLimitEnabled}
                >
                  <span />
                </button>
              </div>
              {keyIpLimitEnabled && (
                <>
                  <label className="field key-modal-field">
                    <span>IP 白名单</span>
                    <textarea
                      value={keyForm.ipWhitelist ?? ""}
                      onChange={(event) => setKeyForm((prev) => ({ ...prev, ipWhitelist: event.target.value }))}
                      placeholder={"192.168.1.100\n10.0.0.0/8"}
                      rows={4}
                    />
                    <p className="field-help">每行一个 IP 或 CIDR。设置后仅允许这些 IP 使用此密钥</p>
                  </label>
                  <label className="field key-modal-field">
                    <span>IP 黑名单</span>
                    <textarea
                      value={keyForm.ipBlacklist ?? ""}
                      onChange={(event) => setKeyForm((prev) => ({ ...prev, ipBlacklist: event.target.value }))}
                      placeholder={"1.2.3.4\n5.6.0.0/16"}
                      rows={4}
                    />
                    <p className="field-help">每行一个 IP 或 CIDR。这些 IP 将被禁止使用此密钥</p>
                  </label>
                </>
              )}
            </section>

            <section className="key-modal-section">
              <label className="field key-modal-field">
                <span>额度限制</span>
                <div className="money-input">
                  <span>$</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={keyForm.quota ?? ""}
                    onChange={(event) =>
                      setKeyForm((prev) => ({ ...prev, quota: parseOptionalNumberInput(event.target.value) }))
                    }
                    placeholder="输入 USD 额度限制"
                  />
                </div>
                <p className="field-help">设置此密钥可消耗的最大金额。0 = 无限制。</p>
              </label>
            </section>

            <section className="key-modal-section">
              <div className="key-switch-row">
                <div>
                  <strong>速率限制</strong>
                  <p>设置此密钥在指定时间窗口内的最大消费额。0 = 无限制。</p>
                </div>
                <button
                  type="button"
                  className={`switch-pill ${keyRateLimitEnabled ? "on" : ""}`}
                  onClick={() => setKeyRateLimitEnabled((prev) => !prev)}
                  aria-pressed={keyRateLimitEnabled}
                >
                  <span />
                </button>
              </div>
              {keyRateLimitEnabled && (
                <div className="key-rate-grid">
                  <label className="field key-modal-field">
                    <span>5小时限额 (USD)</span>
                    <div className="money-input">
                      <span>$</span>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={keyForm.rateLimit5h ?? ""}
                        onChange={(event) =>
                          setKeyForm((prev) => ({ ...prev, rateLimit5h: parseOptionalNumberInput(event.target.value) }))
                        }
                        placeholder="0"
                      />
                    </div>
                  </label>
                  <label className="field key-modal-field">
                    <span>日限额 (USD)</span>
                    <div className="money-input">
                      <span>$</span>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={keyForm.rateLimit1d ?? ""}
                        onChange={(event) =>
                          setKeyForm((prev) => ({ ...prev, rateLimit1d: parseOptionalNumberInput(event.target.value) }))
                        }
                        placeholder="0"
                      />
                    </div>
                  </label>
                  <label className="field key-modal-field">
                    <span>周限额 (USD)</span>
                    <div className="money-input">
                      <span>$</span>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={keyForm.rateLimit7d ?? ""}
                        onChange={(event) =>
                          setKeyForm((prev) => ({ ...prev, rateLimit7d: parseOptionalNumberInput(event.target.value) }))
                        }
                        placeholder="0"
                      />
                    </div>
                  </label>
                </div>
              )}
            </section>

            <section className="key-modal-section">
              <div className="key-switch-row">
                <div>
                  <strong>密钥有效期</strong>
                  <p>默认关闭。开启后可快速选择 7 天、30 天、90 天或自定义过期时间。</p>
                </div>
                <button
                  type="button"
                  className={`switch-pill ${keyExpiryEnabled ? "on" : ""}`}
                  onClick={() => setKeyExpiryEnabled((prev) => !prev)}
                  aria-pressed={keyExpiryEnabled}
                >
                  <span />
                </button>
              </div>
              {keyExpiryEnabled && (
                <>
                  <div className="expiry-preset-row">
                    {KEY_EXPIRY_PRESET_DAYS.map((days) => {
                      const presetKey = `${days}d` as KeyExpiryPreset;
                      return (
                        <button
                          key={days}
                          type="button"
                          className={`expiry-pill ${keyExpiryPreset === presetKey ? "active" : ""}`}
                          onClick={() => handleKeyExpiryPresetSelect(presetKey)}
                        >
                          {days}天
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      className={`expiry-pill ${keyExpiryPreset === "custom" ? "active" : ""}`}
                      onClick={() => handleKeyExpiryPresetSelect("custom")}
                    >
                      自定义
                    </button>
                  </div>
                  <label className="field key-modal-field">
                    <span>过期时间</span>
                    <div className="date-input-shell">
                      <input
                        type="datetime-local"
                        value={keyExpiryDateTime}
                        onChange={(event) => {
                          setKeyExpiryDateTime(event.target.value);
                          setKeyExpiryPreset("custom");
                        }}
                      />
                      <CalendarDays size={18} />
                    </div>
                    <p className="field-help">选择此 API 密钥的过期时间。</p>
                  </label>
                </>
              )}
            </section>
          </div>
        </Modal>
      )}
    </>
  );
}
