/**
 * Minimal client for the carde.io / UVS "Hydra" backend that powers the public
 * Riftbound Gaming Network locator (api.cloudflare.riftbound.uvsgames.com/hydraproxy).
 *
 * Public endpoints (no auth):
 *   - GET /api/magic-events/{id}/                  event detail + store + format + points
 *   - GET /api/v2/deckbuilder/decks/browse/        public decks (Legend/domains/cards)
 *
 * Auth-gated (need a personal carde.io token — supply CARDE_TOKEN or CARDE_EMAIL/PASSWORD):
 *   - POST /api/auth/token/login/                  -> { auth_token } (or similar)
 *   - GET  /api/magic-events/{id}/get_all_rounds/  rounds + matches/pairings
 *   - GET  /api/magic-events/{id}/full_tournament_context/
 *   - GET  /api/event-statuses/search/?event_id=   registrations / standings
 *
 * The exact field names of the auth-gated responses are not observable without a
 * token, so the parsers below are deliberately tolerant and log what they see.
 */

const BASE =
  process.env.CARDE_API_BASE ??
  "https://api.cloudflare.riftbound.uvsgames.com/hydraproxy";

const UA = "RiftboundElo/0.1 (personal use)";

export class CardeError extends Error {
  constructor(message: string, readonly status: number, readonly body?: unknown) {
    super(message);
    this.name = "CardeError";
  }
}

let cachedToken: string | null = process.env.CARDE_TOKEN?.trim() || null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- Throughput control --------------------------------------------------
// All requests pass through a global rate gate (spaces request *starts* to a
// target requests/sec) and an in-flight cap. Concurrency lets slow responses
// overlap; the rate gate keeps total throughput polite. Tune via env.
const RPS = Number(process.env.INGEST_RPS ?? 10); // requests per second
const MAX_CONCURRENCY = Number(process.env.INGEST_CONCURRENCY ?? 8);
const minInterval = RPS > 0 ? 1000 / RPS : 0;
let nextSlot = 0;
let active = 0;
const waiters: Array<() => void> = [];

async function acquireSlot() {
  if (active >= MAX_CONCURRENCY) {
    await new Promise<void>((res) => waiters.push(res));
  }
  active++;
  // Space out request starts to honor RPS.
  const now = Date.now();
  const slot = Math.max(now, nextSlot);
  nextSlot = slot + minInterval;
  const wait = slot - now;
  if (wait > 0) await sleep(wait);
}
function releaseSlot() {
  active--;
  waiters.shift()?.();
}

/** Run `worker` over `items` with bounded concurrency (rate gate handles RPS). */
export async function pool<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  concurrency = MAX_CONCURRENCY,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

async function request<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  await acquireSlot();
  try {
    return await doRequest<T>(path, init);
  } finally {
    releaseSlot();
  }
}

// Retry policy for transient failures. 429 (rate limited) and 5xx are worth
// retrying; 4xx (auth, not-found, bad request) are not — they won't fix
// themselves. Backoff is exponential with a small jitter, and we OBEY a
// server-sent `Retry-After` when present — backing off on demand is what keeps
// us from escalating a soft throttle into a hard block.
const MAX_RETRIES = Number(process.env.INGEST_MAX_RETRIES ?? 4);

/** Parse a Retry-After header (seconds, or an HTTP-date) into milliseconds. */
function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(header);
  return Number.isNaN(when) ? null : Math.max(0, when - Date.now());
}

function backoffMs(attempt: number): number {
  // 0.5s, 1s, 2s, 4s … capped at 30s, plus up to 250ms jitter.
  return Math.min(30_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

async function doRequest<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const url = path.startsWith("http") ? path : `${BASE}${path}`;
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": UA,
    ...(init.headers as Record<string, string> | undefined),
  };
  if (cachedToken && !headers.Authorization) {
    const scheme = (process.env.CARDE_AUTH_SCHEME ?? "Token").trim();
    headers.Authorization = `${scheme} ${cachedToken}`;
  }

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { ...init, headers });
    } catch (err) {
      // Network-level failure (reset/timeout/DNS). Retry a few times, then give up.
      if (attempt >= MAX_RETRIES) throw err;
      await sleep(backoffMs(attempt));
      continue;
    }

    const text = await res.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      /* non-JSON body */
    }

    if (res.ok) return json as T;

    // Retry only on rate-limit / server errors; other 4xx are permanent.
    const retriable = res.status === 429 || res.status >= 500;
    if (!retriable || attempt >= MAX_RETRIES) {
      throw new CardeError(
        `carde ${res.status} on ${path}`,
        res.status,
        json ?? text.slice(0, 300),
      );
    }
    const wait = retryAfterMs(res.headers.get("retry-after")) ?? backoffMs(attempt);
    await sleep(wait);
  }
}

/** Exchange email/password for an API token (DRF-style token auth). */
export async function login(email: string, password: string): Promise<string> {
  const data = await request<Record<string, unknown>>("/api/auth/token/login/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, username: email }),
  });
  const token =
    (data.auth_token as string) ||
    (data.token as string) ||
    (data.key as string) ||
    (data.access_token as string);
  if (!token) {
    throw new CardeError("login succeeded but no token field found", 200, data);
  }
  cachedToken = token;
  return token;
}

/** Ensure we have a token, logging in lazily from env credentials if needed. */
export async function ensureAuth(): Promise<boolean> {
  if (cachedToken) return true;
  const email = process.env.CARDE_EMAIL?.trim();
  const password = process.env.CARDE_PASSWORD?.trim();
  if (email && password) {
    await login(email, password);
    return true;
  }
  return false;
}

export function hasToken(): boolean {
  return Boolean(cachedToken);
}

// ---- Public: event detail ------------------------------------------------

export interface CardeEvent {
  id: number;
  name: string;
  format_pretty?: string;
  event_format?: string;
  game_type_pretty?: string;
  game_type?: string;
  event_lifecycle_status?: string;
  start_datetime?: string;
  end_datetime?: string;
  registered_user_count?: number;
  points_given_per_win?: number;
  points_given_per_loss?: number;
  points_given_per_draw?: number;
  game?: { name?: string; slug?: string } | null;
  store?: {
    id: number;
    name: string;
    country?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    full_address?: string | null;
  } | null;
  [k: string]: unknown;
}

export async function getEvent(eventId: number | string): Promise<CardeEvent> {
  return request<CardeEvent>(`/api/magic-events/${eventId}/`);
}

// ---- Public(ish): event search (v2) --------------------------------------

export interface V2Store {
  id: number;
  name: string;
  country?: string | null;
  state?: string | null;
  city?: string | null;
  full_address?: string | null;
  website?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

export interface V2Event {
  id: number;
  name: string;
  start_datetime?: string | null;
  end_datetime?: string | null;
  event_format?: string | null;
  gameplay_format?: string | null;
  event_type?: string | null;
  event_status?: string | null;
  display_status?: string | null;
  registered_user_count?: number;
  starting_player_count?: number;
  capacity?: number | null;
  cost_in_cents?: number | null;
  currency?: string | null;
  url?: string | null;
  event_is_online?: boolean;
  number_of_rounds?: number | null;
  top_cut_size?: number | null;
  rules_enforcement_level?: string | null;
  description?: string | null;
  updated_at?: string | null;
  tournament_phases?: Array<{
    id: number;
    phase_name?: string;
    rounds?: Array<{
      id: number;
      round_number: number;
      round_type?: string;
      status?: string;
      standings_status?: string;
      pairings_status?: string;
    }>;
  }>;
  store?: V2Store | null;
  [k: string]: unknown;
}

export interface Paginated<T> {
  count: number;
  total?: number;
  next?: string | null;
  results: T[];
}

export type DisplayStatus = "upcoming" | "inProgress" | "completed";

/** Search events; filter by store id and/or display status. Paginates one page. */
export async function searchEvents(opts: {
  storeId?: number | string;
  statuses?: DisplayStatus[];
  gameSlug?: string;
  startDateAfter?: string; // ISO — window events by start date (server-side)
  startDateBefore?: string;
  page?: number;
  pageSize?: number;
}): Promise<Paginated<V2Event>> {
  const q = new URLSearchParams();
  q.set("game_slug", opts.gameSlug ?? "riftbound");
  if (opts.storeId != null) q.set("store_id", String(opts.storeId));
  if (opts.startDateAfter) q.set("start_date_after", opts.startDateAfter);
  if (opts.startDateBefore) q.set("start_date_before", opts.startDateBefore);
  for (const s of opts.statuses ?? ["completed", "upcoming", "inProgress"]) {
    q.append("display_statuses", s);
  }
  q.set("page", String(opts.page ?? 1));
  q.set("page_size", String(opts.pageSize ?? 100));
  return request<Paginated<V2Event>>(`/api/v2/events/?${q}`);
}

/** Discover stores near a coordinate by scanning nearby events' store objects. */
export async function searchEventsNear(opts: {
  latitude: number;
  longitude: number;
  miles?: number;
  statuses?: DisplayStatus[];
  page?: number;
  pageSize?: number;
}): Promise<Paginated<V2Event>> {
  const q = new URLSearchParams();
  q.set("game_slug", "riftbound");
  q.set("latitude", String(opts.latitude));
  q.set("longitude", String(opts.longitude));
  q.set("num_miles", String(opts.miles ?? 50));
  for (const s of opts.statuses ?? ["completed", "upcoming", "inProgress"]) {
    q.append("display_statuses", s);
  }
  q.set("page", String(opts.page ?? 1));
  q.set("page_size", String(opts.pageSize ?? 50));
  return request<Paginated<V2Event>>(`/api/v2/events/?${q}`);
}

export interface V2Registration {
  id?: number;
  user?: { id: number; best_identifier?: string; first_name?: string; last_name?: string } | null;
  best_identifier?: string;
  [k: string]: unknown;
}

/** Event registrations (player roster) — often empty unless you're in the event. */
export async function getRegistrations(
  eventId: number | string,
): Promise<Paginated<V2Registration>> {
  return request(`/api/v2/events/${eventId}/registrations/?page_size=500`);
}

/**
 * Every registration across all pages (follows DRF `next`). Best-effort: returns
 * whatever pages succeed. `first_name`/`last_name` are populated only when the
 * caller is authorized for the event; otherwise entries carry `best_identifier`
 * (first name + last initial) at most — callers should fall back accordingly.
 */
export async function getAllRegistrations(
  eventId: number | string,
): Promise<V2Registration[]> {
  const out: V2Registration[] = [];
  let url: string | null = `/api/v2/events/${eventId}/registrations/?page_size=500`;
  for (let guard = 0; url && guard < 50; guard++) {
    const page: Paginated<V2Registration> = await request(url);
    if (page.results?.length) out.push(...page.results);
    url = page.next ?? null;
  }
  return out;
}

/**
 * A deck's auxiliary cards (Legend/Champion/Battlefields). Auth-gated: the
 * public deck detail endpoint omits these sections for imported decks.
 */
export async function getDeckAuxiliaryCards(
  deckId: string,
): Promise<CardeDeckCardSlot[]> {
  const res = await request<CardeDeckCardSlot[] | { results?: CardeDeckCardSlot[] }>(
    `/api/v2/deckbuilder/decks/${deckId}/auxiliary-cards/`,
  );
  return Array.isArray(res) ? res : (res.results ?? []);
}

/** Public decklist submissions for an event — often empty unless published. */
export async function getDeckSubmissions(eventId: number | string): Promise<{
  event_id: number;
  event_name?: string;
  total_submissions: number;
  submissions: unknown[];
}> {
  return request(`/api/v2/deckbuilder/deck-submissions/events/${eventId}/`);
}

export interface V2Standing {
  player: { id: number; best_identifier?: string };
  rank?: number;
  record?: string;
  match_points?: number;
  opponent_match_win_percentage?: number;
  game_win_percentage?: number;
  opponent_game_win_percentage?: number;
  user_event_status?: V2UserEventStatus;
}

/** Standings for a round id (public; empty unless the event published them). */
export async function getRoundStandings(
  roundId: number | string,
): Promise<{ standings: V2Standing[]; round_number?: number }> {
  return request(`/api/v2/tournament-rounds/${roundId}/standings/`);
}

// ---- Match results (available for events that published results) ---------

export interface V2UserRef {
  id: number;
  best_identifier?: string; // real name, e.g. "Alex V"
}

export interface V2UserEventStatus {
  id: number;
  best_identifier?: string; // gamer tag, e.g. "Str8 Camp1N"
  is_guest?: boolean;
  matches_won?: number;
  matches_lost?: number;
  matches_drawn?: number;
  total_match_points?: number;
  final_place_in_standings?: number;
  registration_status?: string;
  deck_defining_card?: { name?: string; image_url?: string } | null;
  special_user_identifier?: string | null;
  user?: V2UserRef;
}

export interface V2PMR {
  player_order: number; // 1 or 2
  is_starting_player?: boolean;
  player: V2UserRef;
  user_event_status?: V2UserEventStatus;
}

export interface V2Match {
  id: number;
  player_match_relationships: V2PMR[];
  winning_player?: number | { id: number } | null;
  games_won_by_winner?: number;
  games_won_by_loser?: number;
  games_drawn?: number;
  match_is_bye?: boolean;
  match_is_intentional_draw?: boolean;
  match_is_unintentional_draw?: boolean;
  match_is_loss?: boolean;
  status?: string;
  tournament_round?: number;
  created_at?: string;
}

/** Event detail (v2) including tournament_phases → rounds (with round ids). */
export async function getEventDetail(eventId: number | string): Promise<V2Event> {
  return request<V2Event>(`/api/v2/events/${eventId}/`);
}

/** All matches in a round (paginates internally). Empty unless results exist. */
export async function getRoundMatches(roundId: number | string): Promise<V2Match[]> {
  const out: V2Match[] = [];
  let page = 1;
  for (;;) {
    const res = await request<Paginated<V2Match>>(
      `/api/v2/tournament-rounds/${roundId}/matches/paginated/?page=${page}&page_size=100`,
    );
    out.push(...(res.results ?? []));
    if (!res.next || (res.results ?? []).length === 0) break;
    page++;
  }
  return out;
}

/** Pull a round id out of an event's tournament phases for actual play rounds. */
export function playRoundIds(ev: V2Event): number[] {
  const ids: number[] = [];
  for (const phase of ev.tournament_phases ?? []) {
    for (const r of phase.rounds ?? []) {
      if (/PLAY|SWISS|ELIM|DRAFT|POD|OPPONENT/i.test(r.round_type ?? "")) ids.push(r.id);
    }
  }
  return ids;
}

// ---- Auth-gated: rounds / matches / standings ----------------------------

/** Raw rounds payload (shape tolerated downstream). */
export async function getRounds(eventId: number | string): Promise<unknown> {
  return request(`/api/magic-events/${eventId}/get_all_rounds/`);
}

export async function getTournamentContext(
  eventId: number | string,
): Promise<unknown> {
  return request(`/api/magic-events/${eventId}/full_tournament_context/`);
}

export async function getEventStatuses(
  eventId: number | string,
): Promise<unknown> {
  return request(
    `/api/event-statuses/search/?event_id=${eventId}&page_size=500`,
  );
}

// ---- Public: deck browse -------------------------------------------------

export interface CardeCard {
  id: string;
  name: string;
  image_url?: string;
  domains?: string[];
  colors?: string[];
  color_identity?: string[];
}

export interface CardeDeckCardSlot {
  id: string;
  slot_number?: number;
  auxiliary_type?: {
    code?: string; // "legend" | "champion" | ...
    display_name?: string;
    is_deck_defining?: boolean;
  };
  card: CardeCard;
}

export interface CardeDeck {
  id: string;
  name: string;
  format?: string;
  format_id?: string;
  user?: { id: number; best_identifier?: string } | null;
  auxiliary_cards?: CardeDeckCardSlot[];
  preview_cards?: CardeDeckCardSlot[];
  [k: string]: unknown;
}

export interface DeckBrowsePage {
  total: number;
  results: CardeDeck[];
}

export async function browseDecks(
  params: { page?: number; pageSize?: number } = {},
): Promise<DeckBrowsePage> {
  const q = new URLSearchParams();
  if (params.page) q.set("page", String(params.page));
  if (params.pageSize) q.set("page_size", String(params.pageSize));
  const suffix = q.toString() ? `?${q}` : "";
  return request<DeckBrowsePage>(`/api/v2/deckbuilder/decks/browse/${suffix}`);
}

/** Pull the deck-defining Legend (and champion) out of a deck's card slots. */
export function extractLegend(deck: CardeDeck): {
  legend?: string;
  champion?: string;
  domains: string[];
} {
  const slots = [
    ...(deck.auxiliary_cards ?? []),
    ...(deck.preview_cards ?? []),
  ];
  let legend: string | undefined;
  let champion: string | undefined;
  const domains = new Set<string>();
  for (const slot of slots) {
    const code = slot.auxiliary_type?.code?.toLowerCase();
    if (code === "legend" && !legend) legend = slot.card?.name;
    if (code === "champion" && !champion) champion = slot.card?.name;
    for (const d of slot.card?.domains ?? []) domains.add(d);
  }
  return { legend, champion, domains: [...domains] };
}
