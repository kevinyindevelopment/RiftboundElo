/**
 * Probe what the current token can access. Reports, per event id, the HTTP
 * status + payload size + whether match data is parseable for each endpoint.
 *
 *   npm run probe -- --from 193100 --to 193160
 *   npm run probe -- --event 193148
 *
 * Helps locate events whose RESULTS are reachable with your account, without
 * hunting through the web UI.
 */
import "dotenv/config";
import { ensureAuth, hasToken, CardeError } from "../src/lib/carde";

const BASE =
  process.env.CARDE_API_BASE ??
  "https://api.cloudflare.riftbound.uvsgames.com/hydraproxy";

const SCHEME = (process.env.CARDE_AUTH_SCHEME ?? "Token").trim(); // or "Bearer"
const token = process.env.CARDE_TOKEN?.trim();

/**
 * A decoded JSON value of unknown shape. This is a shape-discovery tool pointed
 * at an API whose payloads vary between endpoints, so the response really is
 * unknown — `unknown` says that honestly, where `any` silently disabled every
 * check below.
 */
type Json = unknown;

/** Narrow a JSON value to an indexable object, or null. */
function asObj(v: Json): Record<string, Json> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, Json>)
    : null;
}

/** Read `key` off a JSON value, or undefined if it isn't an object. */
function prop(v: Json, key: string): Json {
  return asObj(v)?.[key];
}

/** Length of `v[key]` when it is an array, else 0. */
function arrayLen(v: Json, key: string): number {
  const a = prop(v, key);
  return Array.isArray(a) ? a.length : 0;
}

async function hit(path: string) {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `${SCHEME} ${token}`;
  try {
    const res = await fetch(`${BASE}${path}`, { headers });
    const text = await res.text();
    let json: Json;
    try {
      json = JSON.parse(text);
    } catch {
      /* */
    }
    return { status: res.status, size: text.length, json };
  } catch (e) {
    return { status: -1, size: 0, json: { error: String(e) } as Json };
  }
}

function summarizeRounds(json: Json): string {
  if (!json) return "no json";
  const arr = Array.isArray(json)
    ? json
    : prop(json, "results") ?? prop(json, "rounds") ?? prop(json, "data") ?? [];
  if (!Array.isArray(arr)) return "non-array";
  const matches = arr.reduce(
    (n: number, r: Json) => n + (arrayLen(r, "matches") || arrayLen(r, "pairings")),
    0,
  );
  return `${arr.length} round(s), ${matches} match-ish entries`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function probe(id: number) {
  const ev = await hit(`/api/magic-events/${id}/`);
  const name = prop(ev.json, "name") ?? "(404)";
  const players = prop(ev.json, "registered_user_count") ?? "?";
  console.log(`\n● event ${id}  [${ev.status}]  "${name}"  players=${players}`);
  if (ev.status !== 200) return;

  const endpoints = [
    ["get_all_rounds", `/api/magic-events/${id}/get_all_rounds/`],
    ["full_tournament_context", `/api/magic-events/${id}/full_tournament_context/`],
    ["event-statuses/search", `/api/event-statuses/search/?event_id=${id}&page_size=500`],
  ] as const;

  for (const [label, path] of endpoints) {
    const r = await hit(path);
    let note = "";
    if (r.status === 200) {
      note =
        label === "get_all_rounds" ? `  → ${summarizeRounds(r.json)}` : `  → ${r.size}B`;
    } else if (prop(r.json, "error")) {
      note = `  (${JSON.stringify(r.json).slice(0, 80)})`;
    }
    console.log(`    ${label.padEnd(26)} [${r.status}] ${r.size}B${note}`);
    await sleep(400);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  await ensureAuth().catch(() => {});
  console.log(
    hasToken()
      ? `Token present (scheme: ${SCHEME}). Probing…`
      : "WARNING: no token — set CARDE_TOKEN in .env. Probing public only.",
  );

  const ids: number[] = [];
  const ev = argv.indexOf("--event");
  if (ev >= 0) ids.push(Number(argv[ev + 1]));
  const from = argv.indexOf("--from");
  if (from >= 0) {
    const f = Number(argv[from + 1]);
    const t = Number(argv[argv.indexOf("--to") + 1] ?? f);
    for (let i = f; i <= t; i++) ids.push(i);
  }
  if (!ids.length) {
    console.log("Usage: npm run probe -- --event <id>  |  --from <id> --to <id>");
    return;
  }

  for (const id of ids) {
    await probe(id).catch((e) =>
      console.log(`event ${id}: ${e instanceof CardeError ? e.status : e}`),
    );
    await sleep(400);
  }
  console.log("\nDone. Endpoints returning [200] with match data are ingestable.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
