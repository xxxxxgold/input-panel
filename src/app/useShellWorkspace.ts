import { useDeferredValue, useEffect, useRef, useState } from "react";

import type { AccountRuntime } from "../types";
import {
  clearTopbarPeekPreviewState,
  CLOSED_TOPBAR_PEEK_STATE,
  isTopbarPeekExpanded,
  previewTopbarPeekState,
  toggleTopbarPeekState,
  type TopbarPeekKey,
  type TopbarPeekState
} from "./topbar-peek-state";

const RAIL_EXPANDED_BREAKPOINT = 960;

export function useShellWorkspace({ accounts }: { accounts: AccountRuntime[] }) {
  const [topbarPeekState, setTopbarPeekState] = useState<TopbarPeekState>(CLOSED_TOPBAR_PEEK_STATE);
  const [topbarAccountMenuOpen, setTopbarAccountMenuOpen] = useState(false);
  const [topbarAccountSearch, setTopbarAccountSearch] = useState("");
  const [isRailExpanded, setIsRailExpanded] = useState(() => !isCompactRailViewport());
  const topbarServiceStatusRef = useRef<HTMLDivElement | null>(null);
  const topbarSiteEndpointsRef = useRef<HTMLDivElement | null>(null);
  const topbarAlertsRef = useRef<HTMLDivElement | null>(null);
  const topbarSubscriptionsRef = useRef<HTMLDivElement | null>(null);
  const topbarAccountMenuRef = useRef<HTMLDivElement | null>(null);
  const deferredTopbarAccountSearch = useDeferredValue(topbarAccountSearch.trim().toLowerCase());

  useEffect(() => {
    let previousCompact = isCompactRailViewport();
    setIsRailExpanded(!previousCompact);

    function handleResize() {
      const nextCompact = isCompactRailViewport();
      if (nextCompact !== previousCompact) {
        setIsRailExpanded(!nextCompact);
        previousCompact = nextCompact;
      }
    }

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    if (!topbarAccountMenuOpen) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      if (!topbarAccountMenuRef.current) {
        return;
      }
      if (topbarAccountMenuRef.current.contains(event.target as Node)) {
        return;
      }
      closeTopbarAccountMenu();
    }

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [topbarAccountMenuOpen]);

  useEffect(() => {
    if (topbarPeekState.pinned === null) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (
        topbarSiteEndpointsRef.current?.contains(target)
        || topbarServiceStatusRef.current?.contains(target)
        || topbarAlertsRef.current?.contains(target)
        || topbarSubscriptionsRef.current?.contains(target)
      ) {
        return;
      }
      closeTopbarPeekPanels();
    }

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [topbarPeekState.pinned]);

  const topbarFilteredAccounts = accounts.filter((item) => {
    if (!deferredTopbarAccountSearch) {
      return true;
    }
    return (
      item.label.toLowerCase().includes(deferredTopbarAccountSearch) ||
      item.email.toLowerCase().includes(deferredTopbarAccountSearch) ||
      item.site?.name?.toLowerCase().includes(deferredTopbarAccountSearch)
    );
  });

  const railToggleTitle = isRailExpanded ? "收起导航" : "展开导航";

  function closeTopbarPeekPanels() {
    setTopbarPeekState(CLOSED_TOPBAR_PEEK_STATE);
  }

  function closeTopbarAccountMenu() {
    setTopbarAccountMenuOpen(false);
    setTopbarAccountSearch("");
  }

  function previewTopbarPeek(key: TopbarPeekKey) {
    setTopbarPeekState((current) => previewTopbarPeekState(current, key));
  }

  function clearTopbarPeekPreview(key: TopbarPeekKey) {
    setTopbarPeekState((current) => clearTopbarPeekPreviewState(current, key));
  }

  function toggleTopbarPeek(key: TopbarPeekKey) {
    closeTopbarAccountMenu();
    setTopbarPeekState((current) => toggleTopbarPeekState(current, key));
  }

  const topbarServiceStatusExpanded = isTopbarPeekExpanded(topbarPeekState, "serviceStatus");
  const topbarSiteEndpointsExpanded = isTopbarPeekExpanded(topbarPeekState, "siteEndpoints");
  const topbarAlertsExpanded = isTopbarPeekExpanded(topbarPeekState, "alerts");
  const topbarSubscriptionsExpanded = isTopbarPeekExpanded(topbarPeekState, "subscriptions");

  return {
    isRailExpanded,
    setIsRailExpanded,
    railToggleTitle,
    topbarSiteEndpointsExpanded,
    topbarServiceStatusExpanded,
    setTopbarServiceStatusExpanded: (value: boolean) => {
      if (value) {
        toggleTopbarPeek("serviceStatus");
        return;
      }
      closeTopbarPeekPanels();
    },
    topbarAlertsExpanded,
    setTopbarAlertsExpanded: (value: boolean) => {
      if (value) {
        toggleTopbarPeek("alerts");
        return;
      }
      closeTopbarPeekPanels();
    },
    topbarSubscriptionsExpanded,
    setTopbarSubscriptionsExpanded: (value: boolean) => {
      if (value) {
        toggleTopbarPeek("subscriptions");
        return;
      }
      closeTopbarPeekPanels();
    },
    topbarAccountMenuOpen,
    setTopbarAccountMenuOpen,
    topbarAccountSearch,
    setTopbarAccountSearch,
    topbarSiteEndpointsRef,
    topbarServiceStatusRef,
    topbarAlertsRef,
    topbarSubscriptionsRef,
    topbarAccountMenuRef,
    topbarFilteredAccounts,
    previewTopbarPeek,
    clearTopbarPeekPreview,
    toggleTopbarPeek,
    closeTopbarPeekPanels,
    closeTopbarAccountMenu
  };
}

function isCompactRailViewport() {
  return typeof window !== "undefined" && window.innerWidth < RAIL_EXPANDED_BREAKPOINT;
}
