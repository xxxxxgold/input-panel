import { useEffect, useState } from "react";

const MOTION_MEDIA_QUERY = "(prefers-reduced-motion: reduce)";

function getInitialReducedMotionPreference() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(MOTION_MEDIA_QUERY).matches;
}

export function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(getInitialReducedMotionPreference);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const mediaQuery = window.matchMedia(MOTION_MEDIA_QUERY);
    const handleChange = () => {
      setPrefersReducedMotion(mediaQuery.matches);
    };

    handleChange();
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  return prefersReducedMotion;
}

function extractNumericValue(value: string) {
  const trimmed = value.trim();
  const prefixMatch = trimmed.match(/^[^\d.-]+/);
  const suffixMatch = trimmed.match(/[^\d.,-]+$/);
  const numericPortion = trimmed.replace(/^[^\d.-]+/, "").replace(/[^\d.,-]+$/, "");
  const parsed = Number(numericPortion.replace(/,/g, ""));

  if (!Number.isFinite(parsed)) {
    return null;
  }

  const decimalMatch = numericPortion.match(/\.(\d+)/);

  return {
    prefix: prefixMatch?.[0] ?? "",
    suffix: suffixMatch?.[0] ?? "",
    value: parsed,
    decimals: decimalMatch?.[1]?.length ?? 0,
    integerDigits: Math.max(1, numericPortion.split(".")[0].replace(/[^0-9]/g, "").length)
  };
}

function formatAnimatedNumber(
  value: number,
  {
    prefix,
    suffix,
    decimals,
    integerDigits
  }: {
    prefix: string;
    suffix: string;
    decimals: number;
    integerDigits: number;
  }
) {
  const formatter = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    minimumIntegerDigits: integerDigits
  });
  return `${prefix}${formatter.format(value)}${suffix}`;
}

export function useAnimatedDisplayValue(value: string, animationKey: string, durationMs = 520) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [displayValue, setDisplayValue] = useState(value);

  useEffect(() => {
    if (prefersReducedMotion) {
      setDisplayValue(value);
      return;
    }

    const parsed = extractNumericValue(value);
    if (!parsed || typeof window === "undefined") {
      setDisplayValue(value);
      return;
    }

    const startValue = 0;
    const startedAt = performance.now();
    let frameId = 0;

    const tick = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / durationMs);
      const eased = 1 - Math.pow(1 - progress, 3);
      const currentValue = startValue + (parsed.value - startValue) * eased;
      setDisplayValue(formatAnimatedNumber(currentValue, parsed));

      if (progress < 1) {
        frameId = window.requestAnimationFrame(tick);
      } else {
        setDisplayValue(value);
      }
    };

    frameId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frameId);
  }, [animationKey, durationMs, prefersReducedMotion, value]);

  return displayValue;
}
