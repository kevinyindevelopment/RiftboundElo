/**
 * Riftbound set releases. Pure logic (no DB) so the UI, queries, and scripts can
 * all bucket data by "which set was live when this was played".
 *
 * An event belongs to the latest set whose release date is on/before its play
 * date. The boundary calendar is locale-aware: China events use the China
 * release dates, everyone else uses the global (English) dates. From Set 4
 * (Vendetta) onward Riftbound normalized to a single same-day worldwide release,
 * so the two calendars converge.
 *
 * Pre-Origins events (prerelease / learn-to-play before the first release) fold
 * into Origins — it's the floor bucket.
 *
 * To add a set: append it to SET_ORDER and SET_DEFS and it flows everywhere
 * (tabs, badges, metagame filter). Keep chronological order.
 */

export const SET_ORDER = ["origins", "spiritforged", "unleashed", "vendetta"] as const;
export type SetCode = (typeof SET_ORDER)[number];

export type ReleaseCalendar = "global" | "china";

interface SetDef {
  name: string;
  setNumber: number;
  /** Release date per calendar, ISO `YYYY-MM-DD` (parsed as UTC midnight). */
  release: Record<ReleaseCalendar, string>;
}

export const SET_DEFS: Record<SetCode, SetDef> = {
  origins: {
    name: "Origins",
    setNumber: 1,
    release: { global: "2025-10-31", china: "2025-08-01" },
  },
  spiritforged: {
    name: "Spiritforged",
    setNumber: 2,
    release: { global: "2026-02-13", china: "2025-12-12" },
  },
  unleashed: {
    name: "Unleashed",
    setNumber: 3,
    release: { global: "2026-05-08", china: "2026-04-10" },
  },
  vendetta: {
    name: "Vendetta",
    setNumber: 4,
    // Set 4 onward: single worldwide same-day release (calendars converge).
    release: { global: "2026-07-31", china: "2026-07-31" },
  },
};

export const SET_LABELS: Record<SetCode, string> = Object.fromEntries(
  SET_ORDER.map((c) => [c, SET_DEFS[c].name]),
) as Record<SetCode, string>;

export function isSetCode(v: string | null | undefined): v is SetCode {
  return v != null && (SET_ORDER as readonly string[]).includes(v);
}

export function setLabel(code: string | null | undefined): string {
  return isSetCode(code) ? SET_LABELS[code] : "Unknown";
}

/** China releases use the China calendar; everyone else uses global/English. */
export function calendarForCountry(country?: string | null): ReleaseCalendar {
  return (country ?? "").trim().toUpperCase() === "CN" ? "china" : "global";
}

const releaseMs = (code: SetCode, cal: ReleaseCalendar) =>
  Date.parse(SET_DEFS[code].release[cal]);

/**
 * The set whose release window contains `date` for the given calendar. Dates
 * before the first release fold into Origins. Returns null only when `date` is
 * missing (so callers can exclude undateable rows from a set-specific view).
 */
export function setForDate(
  date: Date | string | null | undefined,
  calendar: ReleaseCalendar = "global",
): SetCode | null {
  if (!date) return null;
  const t = (typeof date === "string" ? new Date(date) : date).getTime();
  if (Number.isNaN(t)) return null;
  let chosen: SetCode = "origins";
  for (const code of SET_ORDER) {
    if (t >= releaseMs(code, calendar)) chosen = code;
    else break;
  }
  return chosen;
}

/** Bucket an event by its play date, using its store's locale calendar. */
export function setForEvent(ev: {
  startDatetime: Date | null;
  store?: { country?: string | null } | null;
}): SetCode | null {
  return setForDate(ev.startDatetime, calendarForCountry(ev.store?.country));
}
