"use client";

import { useCallback, useSyncExternalStore } from "react";

const DATE_ONLY: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
};
const DATE_TIME: Intl.DateTimeFormatOptions = {
  ...DATE_ONLY,
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
};

/** Never changes — the browser's time zone is fixed for the page's lifetime. */
const subscribe = () => () => {};

/**
 * Render a timestamp in the VISITOR's local time zone.
 *
 * The server can't know the browser's zone, so it renders a pre-formatted
 * `fallback` (its own zone) and the client re-renders from the epoch `ms`.
 * That is what `useSyncExternalStore` is for: `getServerSnapshot` supplies the
 * fallback for SSR and hydration, `getSnapshot` supplies the browser-formatted
 * value immediately afterwards. (The previous version did this with
 * setState-inside-useEffect, which trips `react-hooks/set-state-in-effect` and
 * costs an extra render pass. `suppressHydrationWarning` alone is NOT an
 * alternative: it silences the warning but React keeps the server text, so the
 * visitor's zone would never actually be applied.)
 *
 * `withTime="auto"` includes the time of day only for timestamps in the FUTURE,
 * decided against the viewer's clock at render time. That matters because pages
 * are ISR-cached: a server-side `Date.now()` would be frozen into the cached
 * HTML for the whole revalidation window, so an event could be described using
 * a stale notion of "now". The client's clock is always current.
 */
export function LocalTime({
  ms,
  fallback,
  withTime = false,
}: {
  ms: number;
  fallback: string;
  withTime?: boolean | "auto";
}) {
  const getSnapshot = useCallback(() => {
    const showTime = withTime === "auto" ? ms > Date.now() : withTime;
    return new Date(ms).toLocaleString("en-US", showTime ? DATE_TIME : DATE_ONLY);
  }, [ms, withTime]);

  // getSnapshot returns a fresh string each call, but React compares snapshots
  // with Object.is and equal strings are Object.is-equal, so this is stable.
  const text = useSyncExternalStore(subscribe, getSnapshot, () => fallback);

  return <span suppressHydrationWarning>{text}</span>;
}
