import { Info } from "lucide-react";
import { createPortal } from "react-dom";
import { useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

const TOOLTIP_GAP = 8;
const VIEWPORT_MARGIN = 16;
const TOOLTIP_MAX_WIDTH = 320;

type TooltipPlacement = "top" | "bottom";

type TooltipPosition = {
  top: number;
  left: number;
  placement: TooltipPlacement;
};

/** 标题说明通过独立浮层呈现，避免被卡片容器的裁切边界截断。 */
export function TitleHint({ content, label }: { content: string; label: string }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const tooltipId = useId();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [position, setPosition] = useState<TooltipPosition | null>(null);
  const hasContent = content.trim().length > 0;
  const open = hasContent && !dismissed && (hovered || focused || pinned);

  useLayoutEffect(() => {
    if (!open || typeof window === "undefined") {
      setPosition(null);
      return;
    }

    const updatePosition = () => {
      const trigger = triggerRef.current;
      const tooltip = tooltipRef.current;
      if (!trigger || !tooltip) return;

      const triggerBounds = trigger.getBoundingClientRect();
      const tooltipBounds = tooltip.getBoundingClientRect();
      const viewportWidth = Math.max(1, document.documentElement.clientWidth, window.innerWidth);
      const viewportHeight = Math.max(1, document.documentElement.clientHeight, window.innerHeight);
      const tooltipWidth = Math.min(
        tooltipBounds.width || TOOLTIP_MAX_WIDTH,
        Math.max(1, viewportWidth - VIEWPORT_MARGIN * 2)
      );
      const tooltipHeight = tooltipBounds.height;
      const canFitBelow = triggerBounds.bottom + TOOLTIP_GAP + tooltipHeight <= viewportHeight - VIEWPORT_MARGIN;
      const canFitAbove = triggerBounds.top - TOOLTIP_GAP - tooltipHeight >= VIEWPORT_MARGIN;
      const placement: TooltipPlacement = canFitBelow || !canFitAbove ? "bottom" : "top";
      const desiredTop =
        placement === "bottom"
          ? triggerBounds.bottom + TOOLTIP_GAP
          : triggerBounds.top - tooltipHeight - TOOLTIP_GAP;
      const maxTop = Math.max(VIEWPORT_MARGIN, viewportHeight - tooltipHeight - VIEWPORT_MARGIN);
      const maxLeft = Math.max(VIEWPORT_MARGIN, viewportWidth - tooltipWidth - VIEWPORT_MARGIN);

      setPosition({
        top: Math.min(Math.max(desiredTop, VIEWPORT_MARGIN), maxTop),
        left: Math.min(
          Math.max(triggerBounds.left + triggerBounds.width / 2 - tooltipWidth / 2, VIEWPORT_MARGIN),
          maxLeft
        ),
        placement
      });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);

    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  if (!hasContent) return null;

  const tooltipStyle: CSSProperties = position
    ? { top: `${position.top}px`, left: `${position.left}px` }
    : { visibility: "hidden" };

  return (
    <span className="title-hint">
      <button
        ref={triggerRef}
        type="button"
        className="title-hint-trigger"
        aria-label={label}
        aria-controls={tooltipId}
        aria-describedby={open ? tooltipId : undefined}
        aria-expanded={open}
        onPointerEnter={(event) => {
          if (event.pointerType === "touch") return;
          setDismissed(false);
          setHovered(true);
        }}
        onPointerLeave={(event) => {
          if (event.pointerType !== "touch") {
            setHovered(false);
          }
        }}
        onFocus={() => {
          setDismissed(false);
          setFocused(true);
        }}
        onBlur={() => {
          setHovered(false);
          setFocused(false);
          setPinned(false);
          setDismissed(false);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          setHovered(false);
          setFocused(false);
          setPinned(false);
          setDismissed(true);
        }}
        onClick={() => {
          if (pinned) {
            setPinned(false);
            setDismissed(true);
            return;
          }
          setDismissed(false);
          setPinned(true);
        }}
      >
        <Info size={14} aria-hidden="true" />
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <span
              id={tooltipId}
              ref={tooltipRef}
              className="title-hint-tooltip"
              data-placement={position?.placement ?? "bottom"}
              role="tooltip"
              style={tooltipStyle}
            >
              {content}
            </span>,
            document.body
          )
        : null}
    </span>
  );
}
