import { useDeferredValue, useState } from "react";

import type { SiteRecord } from "../../types";

export function useSettingsWorkspace({
  sites
}: {
  sites: SiteRecord[];
}) {
  const [siteSearch, setSiteSearch] = useState("");
  const deferredSiteSearch = useDeferredValue(siteSearch.trim().toLowerCase());

  const filteredSites = sites.filter((item) => {
    if (!deferredSiteSearch) {
      return true;
    }
    return (
      item.name.toLowerCase().includes(deferredSiteSearch) ||
      item.baseUrl.toLowerCase().includes(deferredSiteSearch)
    );
  });

  return {
    siteSearch,
    setSiteSearch,
    filteredSites
  };
}
