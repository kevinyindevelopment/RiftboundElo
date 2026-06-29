/**
 * Regional buckets for the local scene. Pure logic (no DB) so it can be used by
 * both the UI and the ingest/region-assignment scripts.
 */

export const REGION_ORDER = ["tri-cities", "flint", "other"] as const;
export type Region = (typeof REGION_ORDER)[number];

export const REGION_LABELS: Record<Region, string> = {
  "tri-cities": "Tri Cities",
  flint: "Flint",
  other: "Other",
};

export const REGION_SUBTITLES: Record<Region, string> = {
  "tri-cities": "Bay City · Saginaw · Midland",
  flint: "Flint & surrounding area",
  other: "Everywhere else",
};

export function isRegion(v: string | null | undefined): v is Region {
  return v != null && (REGION_ORDER as readonly string[]).includes(v);
}

export function regionLabel(r: string | null | undefined): string {
  return isRegion(r) ? REGION_LABELS[r] : "Other";
}

// City names that belong to each region (lowercased). Surrounding towns included.
const TRI_CITIES = new Set([
  "bay city", "saginaw", "midland", "frankenmuth", "standish", "essexville",
  "freeland", "auburn", "bridgeport", "saginaw township", "zilwaukee",
  "carrollton", "kawkawlin", "munger", "pinconning",
]);
const FLINT = new Set([
  "flint", "grand blanc", "burton", "davison", "otisville", "columbiaville",
  "lapeer", "fenton", "flushing", "swartz creek", "clio", "mt morris",
  "mount morris", "goodrich", "montrose", "linden", "grand blanc township",
  "flint township", "flushing township",
]);

// Region centroids for coordinate-based fallback (when a city isn't listed).
const CENTROIDS: Record<"tri-cities" | "flint", { lat: number; lon: number }> = {
  "tri-cities": { lat: 43.577, lon: -84.033 }, // avg of Bay City/Saginaw/Midland
  flint: { lat: 43.009, lon: -83.69 },
};
const MAX_MILES = 20; // beyond this from both centroids => "other"

function milesBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = (aLat - bLat) * 69;
  const dLon =
    (aLon - bLon) * Math.cos(((aLat + bLat) / 2) * (Math.PI / 180)) * 69;
  return Math.hypot(dLat, dLon);
}

/** Classify a store into a region by city name, falling back to coordinates. */
export function regionForStore(
  city?: string | null,
  lat?: number | null,
  lon?: number | null,
): Region {
  const c = (city ?? "").trim().toLowerCase();
  if (TRI_CITIES.has(c)) return "tri-cities";
  if (FLINT.has(c)) return "flint";

  if (lat != null && lon != null) {
    let best: "tri-cities" | "flint" | null = null;
    let bestD = Infinity;
    for (const k of ["tri-cities", "flint"] as const) {
      const d = milesBetween(lat, lon, CENTROIDS[k].lat, CENTROIDS[k].lon);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    if (best && bestD <= MAX_MILES) return best;
  }
  return "other";
}
