import { ChevronRight } from "lucide-react";

import type { AccountRuntime, NavKey } from "../types";
import { NAV_ITEMS } from "./navigation";
import { maskEmail } from "../shared/lib/formatters";
import { StatusBadge } from "../shared/ui/StatusBadge";

export function RailNav({
  nav,
  isRailExpanded,
  railToggleTitle,
  onOpenOverview,
  onToggleRail,
  onNavChange,
  onNavIntent,
  projectLogo,
  selectedAccount,
  accounts,
  onAccountSelect
}: {
  nav: NavKey;
  isRailExpanded: boolean;
  railToggleTitle: string;
  onOpenOverview: () => void;
  onToggleRail: () => void;
  onNavChange: (key: NavKey) => void;
  onNavIntent?: (target: NavKey) => void;
  projectLogo: string;
  selectedAccount: AccountRuntime | null;
  accounts: AccountRuntime[];
  onAccountSelect: (account: AccountRuntime) => void;
}) {
  const handleNavIntent = (target: NavKey) => {
    if (target !== nav) {
      onNavIntent?.(target);
    }
  };

  return (
    <aside className={`rail ${isRailExpanded ? "expanded" : ""}`}>
      <div className="rail-content">
        <button className="brand-button" title="Input面板" aria-label="Input面板" onClick={onOpenOverview}>
          <img className="brand-glyph brand-logo" src={projectLogo} alt="" aria-hidden="true" />
          {isRailExpanded && (
            <span className="brand-copy">
              <span className="eyebrow">INPUT PANEL</span>
              <strong>Input面板</strong>
            </span>
          )}
        </button>
        <div className="rail-stack">
          {NAV_ITEMS.map(({ key, label, icon: Icon }) => {
            const active = nav === key;
            return (
              <button
                key={key}
                className={`rail-item ${active ? "active" : ""}`}
                onClick={() => onNavChange(key)}
                onPointerEnter={() => handleNavIntent(key)}
                onFocus={() => handleNavIntent(key)}
                title={label}
                aria-label={label}
              >
                <span className="rail-item-active-pill" aria-hidden="true" />
                <Icon size={18} />
                {isRailExpanded && <span className="rail-item-label">{label}</span>}
              </button>
            );
          })}
        </div>
        <div className="rail-stack rail-bottom">
          {accounts.length > 0 && (
            <div className="rail-account-switcher" aria-label="账号切换">
              {isRailExpanded && (
                <div className="rail-account-section-head">
                  <span>账号</span>
                  <strong>{accounts.length}</strong>
                </div>
              )}
              <div className="rail-account-list">
                {accounts.map((account) => {
                  const selected = selectedAccount?.id === account.id;
                  const accountLabel = account.label || maskEmail(account.email);
                  const accountSource = `${account.site?.name ?? "未知站点"} · ${account.email}`;
                  const avatarInitial = resolveAccountAvatarInitial(account);

                  return (
                    <button
                      key={account.id}
                      type="button"
                      className={`rail-account-option ${selected ? "selected" : ""}`}
                      onClick={() => onAccountSelect(account)}
                      title={`${accountLabel} ${accountSource}`}
                      aria-current={selected ? "true" : undefined}
                      aria-label={`切换到 ${accountLabel}`}
                    >
                      {isRailExpanded ? (
                        <>
                          <span className="rail-account-copy">
                            <strong>{accountLabel}</strong>
                            <span>{accountSource}</span>
                          </span>
                          <StatusBadge state={account.sessionState} />
                        </>
                      ) : (
                        avatarInitial
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
      <button
        type="button"
        className={`rail-toggle-handle ${isRailExpanded ? "open" : ""}`}
        onClick={onToggleRail}
        title={railToggleTitle}
        aria-label={railToggleTitle}
        aria-expanded={isRailExpanded}
      >
        <span className="rail-toggle-handle-grip" aria-hidden="true" />
        <ChevronRight size={16} />
      </button>
    </aside>
  );
}

function resolveAccountAvatarInitial(account: AccountRuntime) {
  const source = account.label.trim() || account.email.trim() || "账";
  const firstChar = Array.from(source)[0] ?? "账";
  return /^[a-z]$/i.test(firstChar) ? firstChar.toUpperCase() : firstChar;
}
