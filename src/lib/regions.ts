/**
 * Regional buckets. Pure logic (no DB) so it can be used by both the UI and the
 * ingest/region-assignment scripts. Each region has a city list (primary) and a
 * centroid + radius (fallback for stores whose city isn't listed).
 *
 * To add a region: add an entry to REGION_DEFS (and it flows everywhere — tabs,
 * home cards, store grouping, player assignment). Keep "other" last.
 */

export const REGION_ORDER = [
  "tri-cities",
  "flint",
  "detroit",
  "grand-rapids",
  "lansing",
  "ann-arbor",
  "los-angeles",
  "san-francisco",
  "san-diego",
  "sacramento",
  "central-valley",
  "other",
] as const;
export type Region = (typeof REGION_ORDER)[number];

interface RegionDef {
  label: string;
  subtitle: string;
  cities: string[]; // lowercased
  centroid: { lat: number; lon: number };
  radiusMiles: number; // coordinate fallback radius
}

// "other" is the implicit catch-all and has no definition.
const REGION_DEFS: Record<Exclude<Region, "other">, RegionDef> = {
  "tri-cities": {
    label: "MBS",
    subtitle: "Midland · Bay City · Saginaw",
    centroid: { lat: 43.577, lon: -84.033 },
    // 24mi reaches Frankenmuth (~22.8mi out); still short of Flint's scene.
    radiusMiles: 24,
    cities: [
      "bay city", "saginaw", "midland", "frankenmuth", "standish", "essexville",
      "freeland", "auburn", "bridgeport", "saginaw township", "zilwaukee",
      "carrollton", "kawkawlin", "munger", "pinconning",
    ],
  },
  flint: {
    label: "Flint",
    subtitle: "Flint & surrounding area",
    centroid: { lat: 43.009, lon: -83.69 },
    radiusMiles: 20,
    cities: [
      "flint", "grand blanc", "burton", "davison", "otisville", "columbiaville",
      "lapeer", "fenton", "flushing", "swartz creek", "clio", "mt morris",
      "mount morris", "goodrich", "montrose", "linden", "grand blanc township",
      "flint township", "flushing township",
    ],
  },
  detroit: {
    label: "Detroit",
    subtitle: "Metro Detroit",
    centroid: { lat: 42.3314, lon: -83.0458 },
    // Covers the metro out to the Oakland/Macomb/western Wayne suburbs; the
    // nearest-centroid rule hands boundary stores near A2 to Ann Arbor.
    radiusMiles: 35,
    cities: [
      "detroit", "warren", "sterling heights", "dearborn", "livonia", "troy",
      "southfield", "farmington hills", "farmington", "novi", "pontiac",
      "royal oak", "dearborn heights", "taylor", "st clair shores",
      "saint clair shores", "roseville", "madison heights", "oak park",
      "ferndale", "hazel park", "birmingham", "berkley", "clawson", "rochester",
      "rochester hills", "auburn hills", "waterford", "redford", "garden city",
      "westland", "wayne", "romulus", "canton", "plymouth", "northville",
      "wixom", "walled lake", "commerce", "west bloomfield", "bloomfield hills",
      "clinton township", "macomb", "utica", "fraser", "eastpointe",
      "harper woods", "grosse pointe", "hamtramck", "highland park",
      "allen park", "lincoln park", "wyandotte", "southgate", "riverview",
      "trenton", "melvindale", "inkster", "belleville", "shelby township",
    ],
  },
  "grand-rapids": {
    label: "Grand Rapids",
    subtitle: "West Michigan",
    centroid: { lat: 42.9634, lon: -85.6681 },
    radiusMiles: 35,
    cities: [
      "grand rapids", "wyoming", "kentwood", "grandville", "walker",
      "forest hills", "cascade", "rockford", "cedar springs", "comstock park",
      "jenison", "hudsonville", "byron center", "caledonia", "ada", "lowell",
      "greenville", "belding", "holland", "zeeland", "grand haven",
      "spring lake", "muskegon", "norton shores", "allendale", "coopersville",
    ],
  },
  lansing: {
    label: "Lansing",
    subtitle: "Lansing · East Lansing",
    centroid: { lat: 42.7325, lon: -84.5555 },
    radiusMiles: 30,
    cities: [
      "lansing", "east lansing", "okemos", "holt", "haslett", "mason",
      "grand ledge", "dewitt", "williamston", "charlotte", "st johns",
      "saint johns", "eaton rapids", "dimondale", "bath", "laingsburg",
    ],
  },
  "ann-arbor": {
    label: "Ann Arbor",
    subtitle: "Ann Arbor · Ypsilanti",
    centroid: { lat: 42.2808, lon: -83.743 },
    radiusMiles: 20,
    cities: [
      "ann arbor", "ypsilanti", "ypsilanti township", "saline", "dexter",
      "chelsea", "milan", "whitmore lake", "pinckney", "manchester",
    ],
  },
  "los-angeles": {
    label: "Los Angeles",
    subtitle: "LA & Orange County",
    centroid: { lat: 34.0522, lon: -118.2437 },
    radiusMiles: 45,
    cities: [
      "los angeles", "long beach", "anaheim", "santa ana", "irvine", "pasadena",
      "glendale", "burbank", "torrance", "santa monica", "pomona", "fullerton",
      "orange", "costa mesa", "huntington beach", "garden grove", "hollywood",
      "north hollywood", "inglewood", "el monte", "downey", "west covina",
      "norwalk", "culver city", "van nuys", "sherman oaks", "alhambra",
      "monterey park", "whittier", "lakewood", "bellflower", "buena park",
      "tustin", "cerritos", "montebello", "gardena", "carson", "hawthorne",
      "redondo beach", "manhattan beach", "el segundo", "westminster", "covina",
      "glendora", "arcadia", "rosemead", "south gate", "lynwood", "compton",
      "lakewood", "fountain valley", "la mirada", "brea", "yorba linda",
      "studio city", "encino", "woodland hills", "canoga park", "reseda",
    ],
  },
  "san-francisco": {
    label: "San Francisco",
    subtitle: "SF Bay Area",
    centroid: { lat: 37.7749, lon: -122.4194 },
    radiusMiles: 55,
    cities: [
      "san francisco", "oakland", "san jose", "berkeley", "fremont", "hayward",
      "sunnyvale", "santa clara", "mountain view", "palo alto", "redwood city",
      "san mateo", "daly city", "south san francisco", "richmond", "concord",
      "walnut creek", "alameda", "san leandro", "milpitas", "cupertino",
      "campbell", "san rafael", "novato", "vallejo", "dublin", "pleasanton",
      "livermore", "union city", "newark", "foster city", "burlingame",
      "menlo park", "los gatos", "san bruno", "san carlos", "belmont",
      "pacifica", "emeryville", "pittsburg", "antioch", "martinez", "fairfield",
      "morgan hill", "gilroy", "san ramon", "castro valley", "san pablo",
      "mountain view", "saratoga", "millbrae", "brentwood", "petaluma",
    ],
  },
  "san-diego": {
    label: "San Diego",
    subtitle: "San Diego County",
    centroid: { lat: 32.7157, lon: -117.1611 },
    radiusMiles: 45,
    cities: [
      "san diego", "chula vista", "el cajon", "oceanside", "escondido",
      "carlsbad", "vista", "san marcos", "encinitas", "la mesa", "santee",
      "poway", "national city", "coronado", "imperial beach", "lemon grove",
      "spring valley", "la jolla", "ramona", "lakeside",
    ],
  },
  sacramento: {
    label: "Sacramento",
    subtitle: "Greater Sacramento",
    centroid: { lat: 38.5816, lon: -121.4944 },
    radiusMiles: 45,
    cities: [
      "sacramento", "elk grove", "roseville", "folsom", "rancho cordova",
      "citrus heights", "davis", "woodland", "west sacramento", "rocklin",
      "lincoln", "fair oaks", "carmichael", "stockton", "lodi", "galt",
      "north highlands", "orangevale",
    ],
  },
  "central-valley": {
    label: "Central Valley",
    subtitle: "Fresno · Bakersfield",
    centroid: { lat: 36.0, lon: -119.4 },
    radiusMiles: 85,
    cities: [
      "fresno", "bakersfield", "visalia", "clovis", "madera", "hanford",
      "tulare", "porterville", "delano", "merced", "selma", "reedley",
      "lemoore", "sanger", "dinuba",
    ],
  },
};

export const REGION_LABELS: Record<Region, string> = {
  "tri-cities": REGION_DEFS["tri-cities"].label,
  flint: REGION_DEFS.flint.label,
  detroit: REGION_DEFS.detroit.label,
  "grand-rapids": REGION_DEFS["grand-rapids"].label,
  lansing: REGION_DEFS.lansing.label,
  "ann-arbor": REGION_DEFS["ann-arbor"].label,
  "los-angeles": REGION_DEFS["los-angeles"].label,
  "san-francisco": REGION_DEFS["san-francisco"].label,
  "san-diego": REGION_DEFS["san-diego"].label,
  sacramento: REGION_DEFS.sacramento.label,
  "central-valley": REGION_DEFS["central-valley"].label,
  other: "Other",
};

export const REGION_SUBTITLES: Record<Region, string> = {
  "tri-cities": REGION_DEFS["tri-cities"].subtitle,
  flint: REGION_DEFS.flint.subtitle,
  detroit: REGION_DEFS.detroit.subtitle,
  "grand-rapids": REGION_DEFS["grand-rapids"].subtitle,
  lansing: REGION_DEFS.lansing.subtitle,
  "ann-arbor": REGION_DEFS["ann-arbor"].subtitle,
  "los-angeles": REGION_DEFS["los-angeles"].subtitle,
  "san-francisco": REGION_DEFS["san-francisco"].subtitle,
  "san-diego": REGION_DEFS["san-diego"].subtitle,
  sacramento: REGION_DEFS.sacramento.subtitle,
  "central-valley": REGION_DEFS["central-valley"].subtitle,
  other: "Everywhere else",
};

export function isRegion(v: string | null | undefined): v is Region {
  return v != null && (REGION_ORDER as readonly string[]).includes(v);
}

export function regionLabel(r: string | null | undefined): string {
  return isRegion(r) ? REGION_LABELS[r] : "Other";
}

// Reverse city → region index for O(1) lookup.
const CITY_TO_REGION = new Map<string, Region>();
for (const key of Object.keys(REGION_DEFS) as Exclude<Region, "other">[]) {
  for (const city of REGION_DEFS[key].cities) CITY_TO_REGION.set(city, key);
}

function milesBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = (aLat - bLat) * 69;
  const dLon =
    (aLon - bLon) * Math.cos(((aLat + bLat) / 2) * (Math.PI / 180)) * 69;
  return Math.hypot(dLat, dLon);
}

/**
 * Classify a store into a region. Coordinates are authoritative (nearest
 * centroid within its radius) — city names collide across states (Auburn MI vs
 * Auburn CA), so the city list is only a fallback for stores missing coords.
 */
export function regionForStore(
  city?: string | null,
  lat?: number | null,
  lon?: number | null,
): Region {
  if (lat != null && lon != null) {
    let best: Region = "other";
    let bestD = Infinity;
    for (const key of Object.keys(REGION_DEFS) as Exclude<Region, "other">[]) {
      const def = REGION_DEFS[key];
      const d = milesBetween(lat, lon, def.centroid.lat, def.centroid.lon);
      if (d <= def.radiusMiles && d < bestD) {
        bestD = d;
        best = key;
      }
    }
    return best;
  }
  // No coordinates: fall back to the city-name index.
  return CITY_TO_REGION.get((city ?? "").trim().toLowerCase()) ?? "other";
}
