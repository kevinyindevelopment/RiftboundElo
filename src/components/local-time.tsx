"use client";

import { useEffect, useState } from "react";

/**
 * Render a timestamp in the VISITOR's local time zone. Server rendering can't
 * know the browser's zone, so the server passes a pre-formatted `fallback`
 * (its own zone) which we show first — then, after mount, we reformat from the
 * epoch `ms` using the browser's zone. Initial render == fallback, so there's
 * no hydration mismatch; the correction happens client-side.
 */
export function LocalTime({
  ms,
  fallback,
  withTime = false,
}: {
  ms: number;
  fallback: string;
  withTime?: boolean;
}) {
  const [text, setText] = useState(fallback);
  useEffect(() => {
    setText(
      new Date(ms).toLocaleString(
        "en-US",
        withTime
          ? {
              year: "numeric",
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
              timeZoneName: "short",
            }
          : { year: "numeric", month: "short", day: "numeric" },
      ),
    );
  }, [ms, withTime]);
  return <span suppressHydrationWarning>{text}</span>;
}
