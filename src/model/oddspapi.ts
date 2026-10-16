import { BookmakerOdds, OddsApiError, OddsEvent, storeDelete, storeGet, storeSet } from './odds';

/**
 * OddsPapi (api.oddspapi.io) — second odds aggregator for League of Legends.
 *
 * Why a second source: The Odds API returns [] for esports_lol (no LoL events
 * listed), and OddsPapi lists Worlds fixtures but attaches no odds to Play-In
 * yet. Neither source alone covers LoL reliably today, so the Odds tab merges
 * both (see mergeOddsEvents in odds.ts). OddsPapi's LoL catalog includes all
 * five of the user's books: Pinnacle, bet365, Betway, BetRivers, DraftKings.
 *
 * Flow (all reads, manual refresh only):
 *   1. GET /v4/fixtures?sportId=18&from=<today>&to=<today+3>&hasOdds=true
 *   2. For each fixture with odds: GET /v4/odds?fixtureId=<id>
 *
 * Market mapping (verified against a live Demacia Cup fixture 2026-10-15):
 *   - Market "181" is the match moneyline for every book. Pinnacle's own
 *     bookmakerMarketId for it ends in "/0/moneyline", confirming it.
 *   - In market 181, outcome "181" is participant1 and "182" is participant2
 *     (confirmed via Pinnacle's home/away outcome labels on match + map markets).
 *   - Map markets (1847/1849/1851/1853/1855) are NOT used by the Odds tab,
 *     which is match (series) moneylines only, same as The Odds API h2h.
 *
 * Quota: free tier ~200-250 requests/month. One refresh costs 1 + N requests
 * (N = fixtures with odds, capped at 12). The app NEVER auto-polls.
 */

const ODDS_PAPI_BASE = 'https://api.oddspapi.io/v4';
const LOL_SPORT_ID = 18;
const FIXTURE_WINDOW_DAYS = 3;
const MAX_ODDS_CALLS = 12;

/** Display titles: the odds payload carries slugs, not names. */
const BOOK_TITLES: Record<string, string> = {
  pinnacle: 'Pinnacle',
  bet365: 'Bet365',
  betway: 'Betway',
  betrivers: 'BetRivers',
  draftkings: 'DraftKings',
  fanduel: 'FanDuel',
  betmgm: 'BetMGM',
  caesars: 'Caesars',
  pointsbet: 'PointsBet',
  fanatics: 'Fanatics',
  betonlineag: 'BetOnline',
  bovada: 'Bovada',
  unibet: 'Unibet',
  williamhill: 'William Hill',
  betfair: 'Betfair',
  betsson: 'Betsson',
  coolbet: 'Coolbet',
  marathonbet: 'Marathonbet',
  '1xbet': '1xBet',
  stake: 'Stake',
  cloudbet: 'Cloudbet',
};

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 1 ? v : null;
}

/** OddsPapi fixture names -> model team names, for names the alias table lacks. */
const NAME_FIXES: Record<string, string> = {
  'furia esports': 'FURIA',
  'bnk fearx': 'BNK FEARX',
  'team we': 'Team WE',
  'ok brion': 'HANJIN BRION',
};

function normalizeTeamName(name: string): string {
  return NAME_FIXES[name.trim().toLowerCase()] ?? name;
}

function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Price for one outcome player, or null when inactive / missing / invalid. */
function outcomePrice(outcome: any): { price: number | null; changedAt: string | null } {
  const player = outcome?.players?.['0'];
  if (!player || player.active === false) return { price: null, changedAt: null };
  return {
    price: numOrNull(player.price),
    changedAt: typeof player.changedAt === 'string' ? player.changedAt : null,
  };
}

function parseBook(slug: string, entry: any): BookmakerOdds | null {
  if (!entry || entry.suspended === true) return null;
  const markets = entry.markets;
  const m = markets?.['181'];
  if (!m || m.marketActive === false) return null;
  const outcomes = m.outcomes ?? {};
  const p1 = outcomePrice(outcomes['181']);
  const p2 = outcomePrice(outcomes['182']);
  if (p1.price === null && p2.price === null) return null;
  const stamps = [p1.changedAt, p2.changedAt].filter((s): s is string => s !== null);
  stamps.sort();
  return {
    key: slug,
    title: BOOK_TITLES[slug] ?? slug,
    home: p1.price,
    away: p2.price,
    lastUpdate: stamps.length > 0 ? stamps[stamps.length - 1] : null,
    source: 'oddspapi',
  };
}

/**
 * Pure parse path (no network): one fixtures-list entry + its /odds payload
 * become one OddsEvent. participant1 -> home slot, participant2 -> away slot,
 * same convention as The Odds API's home_team / away_team.
 */
export function parseOddsPapiEvent(fixture: any, oddsJson: any): OddsEvent | null {
  if (!fixture || typeof fixture.participant1Name !== 'string' || typeof fixture.participant2Name !== 'string')
    return null;
  const bookmakerOdds = oddsJson?.bookmakerOdds;
  if (!bookmakerOdds || typeof bookmakerOdds !== 'object') return null;
  const bookmakers = Object.entries(bookmakerOdds)
    .map(([slug, entry]) => parseBook(slug, entry))
    .filter((b): b is BookmakerOdds => b !== null)
    .filter((b) => b.home !== null || b.away !== null);
  return {
    id: `oddspapi:${String(fixture.fixtureId ?? `${fixture.participant1Name}-vs-${fixture.participant2Name}`)}`,
    commenceTime: typeof fixture.startTime === 'string' ? fixture.startTime : '',
    homeTeam: normalizeTeamName(fixture.participant1Name),
    awayTeam: normalizeTeamName(fixture.participant2Name),
    bookmakers,
  };
}

async function fetchJson(url: string): Promise<any> {
  let r: Response;
  try {
    r = await fetch(url);
  } catch {
    throw new OddsApiError(0, 'Network error — check your connection and try again.');
  }
  if (!r.ok) {
    if (r.status === 401 || r.status === 403)
      throw new OddsApiError(r.status, 'Invalid OddsPapi key — check the key in settings.');
    if (r.status === 429)
      throw new OddsApiError(429, 'OddsPapi rate limited or monthly quota exhausted.');
    throw new OddsApiError(r.status, `OddsPapi returned HTTP ${r.status}.`);
  }
  try {
    return await r.json();
  } catch {
    throw new OddsApiError(r.status, 'Could not parse the OddsPapi response.');
  }
}

/**
 * One manual fetch: fixtures with odds in the next few days, then one odds
 * call per fixture (sequential, capped). Throws OddsApiError on failure.
 */
export async function fetchOddsPapi(
  apiKey: string,
): Promise<{ events: OddsEvent[]; requestsUsed: number }> {
  const now = new Date();
  const to = new Date(now.getTime() + FIXTURE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const fixturesUrl =
    `${ODDS_PAPI_BASE}/fixtures?apiKey=${encodeURIComponent(apiKey)}` +
    `&sportId=${LOL_SPORT_ID}&from=${dateStr(now)}&to=${dateStr(to)}&hasOdds=true`;
  const fixturesJson = await fetchJson(fixturesUrl);
  let requestsUsed = 1;
  const fixtures = (Array.isArray(fixturesJson) ? fixturesJson : []).filter(
    (f) => f?.hasOdds === true,
  );
  const events: OddsEvent[] = [];
  for (const fixture of fixtures.slice(0, MAX_ODDS_CALLS)) {
    const oddsUrl =
      `${ODDS_PAPI_BASE}/odds?apiKey=${encodeURIComponent(apiKey)}` +
      `&fixtureId=${encodeURIComponent(String(fixture.fixtureId))}`;
    const oddsJson = await fetchJson(oddsUrl);
    requestsUsed += 1;
    const event = parseOddsPapiEvent(fixture, oddsJson);
    if (event) events.push(event);
  }
  events.sort((a, b) => a.commenceTime.localeCompare(b.commenceTime));
  return { events, requestsUsed };
}

/* ------------------------- secure settings ------------------------- */

const KEY_SLOT = 'oddspapi_api_key';

export async function getOddsPapiKey(): Promise<string | null> {
  try {
    return await storeGet(KEY_SLOT);
  } catch {
    return null;
  }
}

/** Persisted in the device keychain (native) or localStorage (web) — never logged. */
export async function setOddsPapiKey(key: string): Promise<void> {
  await storeSet(KEY_SLOT, key.trim());
}

export async function clearOddsPapiKey(): Promise<void> {
  try {
    await storeDelete(KEY_SLOT);
  } catch {
    /* already gone */
  }
}
