import { useDeferredValue, useEffect, useRef, useState } from "react";

import type { AccountRuntime } from "../types";

const RAIL_EXPANDED_BREAKPOINT = 960;

export function useShellWorkspace({ accounts }: { accounts: AccountRuntime[] }) {
  const [topbarAlertsExpanded, setTopbarAlertsExpanded] = useState(false);
  const [topbarSubscriptionsExpanded, setTopbarSubscriptionsExpanded] = useState(false);
  const [topbarAccountMenuOpen, setTopbarAccountMenuOpen] = useState(false);
  const [topbarAccountSearch, setTopbarAccountSearch] = useState("");
  const [isRailExpanded, setIsRailExpanded] = useState(() => !isCompactRailViewport());
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
    if (!topbarAlertsExpanded && !topbarSubscriptionsExpanded) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (topbarAlertsRef.current?.contains(target) || topbarSubscriptionsRef.current?.contains(target)) {
        return;
      }
      closeTopbarPeekPanels();
    }

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [topbarAlertsExpanded, topbarSubscriptionsExpanded]);

  const topbarFilteredAccounts = accounts.filter((item) => {
    if (!deferredTopbarAccountSearch) {
      return true;
    }
    return (
      item.label.toLowerCase().includes(deferredTopbarAccountSearch) ||
      item.email.toLowerCase().includes(deferredTopbarAccountSearch) ||
      item.site?.name.toLowerCase().includes(deferredTopbarAccountSearch)
    );
  });

  const railToggleTitle = isRailExpanded ? "收起导航" : "展开导航";

  function closeTopbarPeekPanels() {
    setTopbarAlertsExpanded(false);
    setTopbarSubscriptionsExpanded(false);
  }

  function closeTopbarAccountMenu() {
    setTopbarAccountMenuOpen(false);
    setTopbarAccountSearch("");
  }

  return {
    isRailExpanded,
    setIsRailExpanded,
    railToggleTitle,
    topbarAlertsExpanded,
    setTopbarAlertsExpanded,
    topbarSubscriptionsExpanded,
    setTopbarSubscriptionsExpanded,
    topbarAccountMenuOpen,
    setTopbarAccountMenuOpen,
    topbarAccountSearch,
    setTopbarAccountSearch,
    topbarAlertsRef,
    topbarSubscriptionsRef,
    topbarAccountMenuRef,
    topbarFilteredAccounts,
    closeTopbarPeekPanels,
    closeTopbarAccountMenu
  };
}

function isCompactRailViewport() {
  return typeof window !== "undefined" && window.innerWidth < RAIL_EXPANDED_BREAKPOINT;
}
