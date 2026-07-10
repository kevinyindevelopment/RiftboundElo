/**
 * "Pre-Rift" events are set pre-release events (e.g. "Unleashed Pre-Rift Event",
 * "Vendetta PreRift", "... Pre Rift"). They're played on an unreleased/unsettled
 * card pool rather than the live constructed metagame, so their results are
 * EXCLUDED from all Elo/Glicko calculations — ratings, records, peak, rating
 * history, rank, and the recompute gate. This module is the single source of
 * truth for how a pre-rift event is recognized.
 */

/** JS matcher over an event name. Matches "prerift", "pre-rift", "pre rift". */
export const PRE_RIFT_RE = /pre[-\s]?rift/i;

/**
 * Postgres case-insensitive regex (ARE) equivalent of {@link PRE_RIFT_RE}, for
 * `name ~* PRE_RIFT_SQL` WHERE clauses. Kept in lockstep with the JS version.
 */
export const PRE_RIFT_SQL = "pre[- ]?rift";

export function isPreRiftEvent(name: string | null | undefined): boolean {
  return !!name && PRE_RIFT_RE.test(name);
}
