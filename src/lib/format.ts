/**
 * Win rate as a score percentage: a draw counts as half a win (parity), not a
 * loss. (wins + 0.5·draws) / games. A 5-0-5 record reads 75%, not 50%.
 */
export function winRate(wins: number, losses: number, draws = 0): number {
  const total = wins + losses + draws;
  return total === 0 ? 0 : (wins + 0.5 * draws) / total;
}

export function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Date + local time, e.g. "Jun 30, 2026, 6:00 PM EDT". Used for upcoming
 *  events where the start time matters. Time zone is the viewer's (we don't
 *  store the event's local zone), so the tz label keeps it unambiguous. */
export function fmtDateTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

/** Compact date for chart axes, e.g. "Mar 3, '26". */
export function fmtDateShort(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  const md = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${md}, '${String(date.getFullYear()).slice(-2)}`;
}

export function parseDomains(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * Detect a team / multiplayer format from an event name, returning a short
 * label ("2v2", "3v3", "2HG", "Doubles", "Team") or null for a normal 1v1
 * event. carde doesn't tag team events structurally (gameplay_format is just
 * "OTHER"), so the name is the signal. Used only for labeling — team results
 * still feed the 1v1 ladder, but their standings records are team-shared, so
 * the UI flags them.
 */
export function teamFormat(name: string | null | undefined): string | null {
  const n = (name ?? "").toLowerCase();
  const m = n.match(/(\d)\s*v\s*(\d)/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    // "1v1" is standard single-player — only 2+ per side is a team format.
    if (a > 1 || b > 1) return `${a}v${b}`;
    return null;
  }
  if (/\b2hg\b|two[-\s]?headed/.test(n)) return "2HG";
  if (/\bdoubles\b/.test(n)) return "Doubles";
  if (/\bteams?\b/.test(n)) return "Team";
  return null;
}

export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
