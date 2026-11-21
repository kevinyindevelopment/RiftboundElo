/** Source namespaces keep unrelated provider IDs (including large integers) distinct. */
export const PLAYRIFTBOUND_PREFIX = "playriftbound:";

/** The deployed router can retain the escaped namespace separator in params.
 * Normalize only that separator; provider IDs are not arbitrary URL paths.
 */
export function sourceIdFromRoute(id: string): string {
  return id.replace(/^playriftbound%3a/i, PLAYRIFTBOUND_PREFIX);
}

export function playRiftboundId(id: string): string {
  if (typeof id !== "string" || !id.trim()) throw new Error("Missing PlayRiftbound ID");
  return `${PLAYRIFTBOUND_PREFIX}${id}`;
}

export function eventSource(id: string) {
  return id.startsWith(PLAYRIFTBOUND_PREFIX) ? "PlayRiftbound" : "UVS (legacy)";
}

export function officialEventUrl(id: string): string {
  return id.startsWith(PLAYRIFTBOUND_PREFIX)
    ? `https://playriftbound.com/en-US/events/${encodeURIComponent(id.slice(PLAYRIFTBOUND_PREFIX.length))}`
    : `https://locator.riftbound.uvsgames.com/events/${encodeURIComponent(id)}`;
}
