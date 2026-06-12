import { useDeferredValue, useEffect, useState } from "react";

import type { SiteRecord, UsageHistoryRow } from "../../types";

export function useSettingsWorkspace({
  sites,
  visibleHistory
}: {
  sites: SiteRecord[];
  visibleHistory: UsageHistoryRow[];
}) {
  const [siteSearch, setSiteSearch] = useState("");
  const [selectedHistoryRow, setSelectedHistoryRow] = useState<UsageHistoryRow | null>(null);
  const deferredSiteSearch = useDeferredValue(siteSearch.trim().toLowerCase());

  useEffect(() => {
    if (!visibleHistory.length) {
      setSelectedHistoryRow(null);
      return;
    }
    setSelectedHistoryRow((current) => {
      if (current) {
        const matched = visibleHistory.find(
          (item) => item.id === current.id && item.firstSeenAt === current.firstSeenAt
        );
        if (matched) {
          return matched;
        }
      }
      return visibleHistory[0] ?? null;
    });
  }, [visibleHistory]);

  const filteredSites = sites.filter((item) => {
    if (!deferredSiteSearch) {
      return true;
    }
    return (
      item.name.toLowerCase().includes(deferredSiteSearch) ||
      item.baseUrl.toLowerCase().includes(deferredSiteSearch)
    );
  });

  const latestHistory = visibleHistory.filter((item) => item.isLatest);

  return {
    siteSearch,
    setSiteSearch,
    filteredSites,
    selectedHistoryRow,
    setSelectedHistoryRow,
    latestHistory
  };
}
