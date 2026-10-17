import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/* Web has no SecureStore: fall back to localStorage (less hardened, but the
   key only ever lives on the user's own device). Native keeps the keychain. */
const IS_WEB = Platform.OS === 'web';

export async function storeGet(key: string): Promise<string | null> {
  if (IS_WEB) {
    try {
      return window.localStorage.getItem('lolpredictor:' + key);
    } catch {
      return null;
    }
  }
  return SecureStore.getItemAsync(key);
}

export async function storeSet(key: string, value: string): Promise<void> {
  if (IS_WEB) {
    try {
      window.localStorage.setItem('lolpredictor:' + key, value);
    } catch {
      /* storage unavailable */
    }
    return;
  }
  return SecureStore.setItemAsync(key, value);
}

export async function storeDelete(key: string): Promise<void> {
  if (IS_WEB) {
    try {
      window.localStorage.removeItem('lolpredictor:' + key);
    } catch {
      /* already gone */
    }
    return;
  }
  return SecureStore.deleteItemAsync(key);
}
import { TEAM_ALIASES } from './artifacts';

/**
 * The Odds API (the-odds-api.com) — sportsbook odds for League of Legends.
 *
 * Endpoint: GET https://api.the-odds-api.com/v4/sports/esports_lol/odds
 *   ?apiKey=<key>&regions=us,uk,eu,au&markets=h2h&oddsFormat=decimal
 *
 * Expected response shape (array of events):
 * [
 *   {
 *     "id": "9b7b2d2e...",
 *     "sport_key": "esports_lol",
 *     "sport_title": "League of Legends",
 *     "commence_time": "2026-10-16T12:00:00Z",
 *     "home_team": "T1",
 *     "away_team": "Gen.G",
 *     "bookmakers": [
 *       {
 *         "key": "bet365",
 *         "title": "Bet365",
 *         "last_update": "2026-10-16T11:58:00Z",
 *         "markets": [
 *           {
 *             "key": "h2h",
 *             "outcomes": [
 *               { "name": "T1", "price": 1.72 },
 *               { "name": "Gen.G", "price": 2.05 }
 *             ]
 *           }
 *         ]
 *       }
 *     ]
 *   }
 * ]
 *
 * Notes:
 * - outcome `name` matches `home_team`/`away_team` (matched by name, not order).
 * - Quota: free tier = 500 requests/month. Response headers carry
 *   `x-requests-remaining` / `x-requests-used`. The app NEVER auto-polls —
 *   every request comes from an explicit user refresh tap.
 * - Regions list intentionally broad; the bookmaker filter in the UI narrows
 *   the display to the books the user actually has accounts with.
 */

const ODDS_BASE = 'https://api.the-odds-api.com/v4/sports/esports_lol/odds';
const REGIONS = 'us,uk,eu,au';

export interface BookmakerOdds {
  key: string;
  title: string;
  home: number | null; // decimal odds on home_team
  away: number | null; // decimal odds on away_team
  lastUpdate: string | null;
  /** Which aggregator this row came from. Undefined = The Odds API (legacy rows). */
  source?: 'oddsapi' | 'oddspapi';
}

export interface OddsEvent {
  id: string;
  commenceTime: string;
  homeTeam: string;
  awayTeam: string;
  bookmakers: BookmakerOdds[];
}

export interface OddsResult {
  events: OddsEvent[];
  /** Requests remaining this month, from the x-requests-remaining header. */
  remaining: number | null;
}

export class OddsApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 1 ? v : null;
}

function parseBookmaker(b: any): BookmakerOdds | null {
  if (!b || typeof b.key !== 'string') return null;
  const markets: any[] = Array.isArray(b?.markets) ? b.markets : [];
  const h2h = markets.find((m) => m?.key === 'h2h');
  const outcomes: any[] = Array.isArray(h2h?.outcomes) ? h2h.outcomes : [];
  const homeName = String((b as any)._home ?? '');
  const awayName = String((b as any)._away ?? '');
  let home: number | null = null;
  let away: number | null = null;
  for (const o of outcomes) {
    if (o?.name === homeName) home = numOrNull(o.price);
    else if (o?.name === awayName) away = numOrNull(o.price);
  }
  return {
    key: b.key,
    title: typeof b.title === 'string' ? b.title : b.key,
    home,
    away,
    lastUpdate: typeof b.last_update === 'string' ? b.last_update : null,
    source: 'oddsapi',
  };
}

function parseEvent(e: any): OddsEvent | null {
  if (!e || typeof e.home_team !== 'string' || typeof e.away_team !== 'string') return null;
  const raw: any[] = Array.isArray(e.bookmakers) ? e.bookmakers : [];
  // stash team names on each bookmaker so parseBookmaker can match by name
  const bookmakers = raw
    .map((b) => parseBookmaker({ ...b, _home: e.home_team, _away: e.away_team }))
    .filter((b): b is BookmakerOdds => b !== null)
    .filter((b) => b.home !== null || b.away !== null);
  return {
    id: String(e.id ?? `${e.home_team}-vs-${e.away_team}`),
    commenceTime: typeof e.commence_time === 'string' ? e.commence_time : '',
    homeTeam: e.home_team,
    awayTeam: e.away_team,
    bookmakers,
  };
}

/** One manual fetch. Throws OddsApiError on non-2xx (401 = bad key, 429 = quota). */
export async function fetchOdds(apiKey: string): Promise<OddsResult> {
  const url =
    `${ODDS_BASE}?apiKey=${encodeURIComponent(apiKey)}` +
    `&regions=${REGIONS}&markets=h2h&oddsFormat=decimal`;
  let r: Response;
  try {
    r = await fetch(url);
  } catch {
    throw new OddsApiError(0, 'Network error — check your connection and try again.');
  }
  const remainingRaw = r.headers.get('x-requests-remaining');
  const remaining = remainingRaw !== null ? parseInt(remainingRaw, 10) : null;
  if (!r.ok) {
    if (r.status === 401 || r.status === 403)
      throw new OddsApiError(r.status, 'Invalid API key — check the key in settings.');
    if (r.status === 429)
      throw new OddsApiError(429, 'Rate limited or monthly quota exhausted.');
    throw new OddsApiError(r.status, `The Odds API returned HTTP ${r.status}.`);
  }
  let j: any;
  try {
    j = await r.json();
  } catch {
    throw new OddsApiError(r.status, 'Could not parse the odds response.');
  }
  const events = (Array.isArray(j) ? j : [])
    .map(parseEvent)
    .filter((e): e is OddsEvent => e !== null)
    .sort((a, b) => a.commenceTime.localeCompare(b.commenceTime));
  return { events, remaining: Number.isFinite(remaining) ? remaining : null };
}

/* ------------------------- team mapping ------------------------- */

/**
 * Map an Odds API team name (e.g. "T1", "Bilibili Gaming") to a model team
 * name via team_aliases. Returns null when unmapped — the UI then shows the
 * odds but disables the Kelly handoff with a note.
 */
export function mapOddsTeamName(name: string): string | null {
  if (!name) return null;
  const key = name.trim().toLowerCase();
  return TEAM_ALIASES[key] ?? null;
}

/* ------------------------- secure settings ------------------------- */

const KEY_SLOT = 'odds_api_key';
const BOOKS_SLOT = 'odds_my_books'; // JSON array of bookmaker keys

export async function getOddsApiKey(): Promise<string | null> {
  try {
    return await storeGet(KEY_SLOT);
  } catch {
    return null;
  }
}

/** Persisted in the device keychain (native) or localStorage (web) — never logged. */
export async function setOddsApiKey(key: string): Promise<void> {
  await storeSet(KEY_SLOT, key.trim());
}

export async function clearOddsApiKey(): Promise<void> {
  try {
    await storeDelete(KEY_SLOT);
  } catch {
    /* already gone */
  }
}

export async function getMyBooks(): Promise<string[] | null> {
  try {
    const raw = await storeGet(BOOKS_SLOT);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : null;
  } catch {
    return null;
  }
}

export async function setMyBooks(keys: string[]): Promise<void> {
  await storeSet(BOOKS_SLOT, JSON.stringify(keys));
}

/* ------------------------- arbitrage ------------------------- */

export interface ArbLeg {
  price: number;
  bookKey: string;
  bookTitle: string;
}

export interface ArbOpportunity {
  home: ArbLeg;
  away: ArbLeg;
  /** Guaranteed profit as a fraction of total staked, e.g. 0.023 = 2.3%. */
  profitPct: number;
}

/** Best available decimal price per side across the given books (with source). */
export function bestPrices(books: BookmakerOdds[]): { home: ArbLeg | null; away: ArbLeg | null } {
  let home: ArbLeg | null = null;
  let away: ArbLeg | null = null;
  for (const b of books) {
    if (b.home !== null && (home === null || b.home > home.price))
      home = { price: b.home, bookKey: b.key, bookTitle: b.title };
    if (b.away !== null && (away === null || b.away > away.price))
      away = { price: b.away, bookKey: b.key, bookTitle: b.title };
  }
  return { home, away };
}

/**
 * Cross-book arbitrage: take the best price per side (legs may sit at
 * different books). An arb exists when 1/bestA + 1/bestB < 1; the profit is
 * locked regardless of outcome IF both legs get placed at the quoted prices.
 * Returns null when there is no arb.
 */
export function detectArb(books: BookmakerOdds[]): ArbOpportunity | null {
  const { home, away } = bestPrices(books);
  return arbFromBestLegs(home, away);
}

/**
 * Split a total stake across the two arb legs so the payout is identical
 * either way: stake_i = total × (1/odds_i) / (1/oddsA + 1/oddsB).
 * Guaranteed return = total × (1 + profitPct).
 */
export function splitStake(total: number, priceA: number, priceB: number): { stakeA: number; stakeB: number } {
  const invA = 1 / priceA;
  const invB = 1 / priceB;
  const denom = invA + invB;
  return { stakeA: (total * invA) / denom, stakeB: (total * invB) / denom };
}

export const ARB_CAVEAT =
  'Arb windows close in seconds and books may void palpable-error lines — ' +
  'confirm both legs are actually placed at these prices before counting the profit';

/**
 * Arb alert bar: the saved-pull banner only surfaces arbs at or above this
 * guaranteed-profit fraction (1%). Matches the edge-watch arb alert bar.
 */
export const ARB_ALERT_BAR = 0.01;

/**
 * Arbitrage from the two best legs, however they were obtained (live board
 * or a saved pull's best legs). An arb exists when 1/bestA + 1/bestB < 1;
 * the profit is locked regardless of outcome IF both legs get placed at the
 * quoted prices. Returns null when there is no arb. Single source of the
 * arb-existence / profit formula — detectArb and the saved-pull banner
 * both go through here.
 */
export function arbFromBestLegs(home: ArbLeg | null, away: ArbLeg | null): ArbOpportunity | null {
  if (!home || !away) return null;
  const inv = 1 / home.price + 1 / away.price;
  if (!(inv < 1)) return null;
  return { home, away, profitPct: 1 - inv };
}

/* ------------------------- test helper ------------------------- */

/** Pure parse path used by the parity test (no network). */
export function parseOddsResponse(j: any): OddsEvent[] {
  return (Array.isArray(j) ? j : [])
    .map(parseEvent)
    .filter((e): e is OddsEvent => e !== null);
}

/* ------------------------- multi-source merge ------------------------- */

/**
 * Merge two event lists (e.g. The Odds API + OddsPapi) into one.
 * Events match when the team pair (order-insensitive) and the UTC date agree.
 * When the same book appears from both sources, the fresher lastUpdate wins;
 * on a tie or missing timestamps, OddsPapi wins (broader LoL coverage).
 */
export function mergeOddsEvents(a: OddsEvent[], b: OddsEvent[]): OddsEvent[] {
  const keyOf = (e: OddsEvent): string => {
    const teams = [e.homeTeam.trim().toLowerCase(), e.awayTeam.trim().toLowerCase()].sort();
    const day = e.commenceTime.slice(0, 10);
    return `${teams[0]}|${teams[1]}|${day}`;
  };
  const pickBook = (x: BookmakerOdds, y: BookmakerOdds): BookmakerOdds => {
    const tx = x.lastUpdate ? Date.parse(x.lastUpdate) : NaN;
    const ty = y.lastUpdate ? Date.parse(y.lastUpdate) : NaN;
    if (Number.isFinite(ty) && (!Number.isFinite(tx) || ty >= tx)) return y;
    if (Number.isFinite(tx) && !Number.isFinite(ty)) return x;
    // Tie / both missing: OddsPapi wins.
    return y.source === 'oddspapi' ? y : x.source === 'oddspapi' ? x : y;
  };
  const merged = new Map<string, OddsEvent>();
  for (const e of [...a, ...b]) {
    const k = keyOf(e);
    const existing = merged.get(k);
    if (!existing) {
      merged.set(k, { ...e, bookmakers: [...e.bookmakers] });
      continue;
    }
    for (const book of e.bookmakers) {
      const idx = existing.bookmakers.findIndex((x) => x.key === book.key);
      if (idx === -1) existing.bookmakers.push(book);
      else existing.bookmakers[idx] = pickBook(existing.bookmakers[idx], book);
    }
    // Keep the earliest commenceTime for a matched pair.
    if (e.commenceTime && (!existing.commenceTime || e.commenceTime < existing.commenceTime))
      existing.commenceTime = e.commenceTime;
  }
  return [...merged.values()].sort((x, y) => x.commenceTime.localeCompare(y.commenceTime));
}
