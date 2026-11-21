/** Explicit, owner-confirmed identity links. Never infer identity from a name.
 * Keys are stable provider IDs; values are the existing canonical profile IDs.
 * Apply scripts/link-player-identities.ts and recompute after adding a link.
 */
export const PLAYER_IDENTITY_LINKS: Readonly<Record<string, string>> = {
  // Confirmed by the owner: UVS pure (Kevin Y) = Riot pure#00000.
  "playriftbound:01a0a1d7-e1d7-771a-85b5-d96837e2d893": "411127",
};

export function canonicalPlayerId(id: string): string {
  return PLAYER_IDENTITY_LINKS[id] ?? id;
}
