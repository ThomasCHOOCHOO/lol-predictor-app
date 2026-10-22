import { BookmakerOdds, OddsEvent } from './odds';

/**
 * Published board snapshot — the automated, no-API, no-token odds source.
 *
 * A browser task reads Pinnacle's public World Championship board (no
 * sign-in, no API key — the board loaded normally for a guest on
 * 2026-10-21) and writes the odds into public/odds-snapshot.json in the
 * app repo. GitHub Pages serves that file at
 * https://thomaschoochoo.github.io/lol-predictor-app/odds-snapshot.json
 * (CORS: *), so the Odds tab can fetch it at runtime on web and native
 * without any key, quota, or manual entry.
 *
 * Caveats, carried in the snapshot itself:
 * - Pinnacle says guest odds are DELAYED. This is a snapshot, not live
 *   odds — re-check before placing.
 * - Display times are as shown on the board. They differed in order
 *   from the LoL schedule order previously recorded, so verify start
 *   times on the official schedule before betting.
 * - If the board layout changes or Pinnacle starts blocking guests, this
 *   source fails with a clear error instead of showing stale odds as
 *   live — the tab must surface capturedAt and guestDelayed.
 */

export const BOARD_SNAPSHOT_URL =
  'https://thomaschoochoo.github.io/lol-predictor-app/odds-snapshot.json';

export interface BoardSnapshotMatch {
  homeTeam: string;
  awayTeam: string;
  commenceTime: string;
  homeAmerican: number;
  awayAmerican: number;
}

export interface BoardSnapshot {
  source: string;
  book: string;
  bookTitle: string;
  capturedAt: string;
  capturedAtLabel?: string;
  guestDelayed?: boolean;
  note?: string;
  matches: BoardSnapshotMatch[];
}

/** American odds -> decimal. -435 -> 1.2299, +323 -> 4.23. */
export function americanToDecimal(american: number): number | null {
  if (!Number.isFinite(american) || american === 0) return null;
  if (american < 0) return 1 + 100 / Math.abs(american);
  return 1 + american / 100;
}

export function boardSnapshotToEvents(snap: BoardSnapshot): OddsEvent[] {
  if (!snap || !Array.isArray(snap.matches)) return [];
  const book = (m: BoardSnapshotMatch): BookmakerOdds => {
    const home = americanToDecimal(m.homeAmerican);
    const away = americanToDecimal(m.awayAmerican);
    return {
      key: snap.book || 'pinnacle',
      title: snap.bookTitle || 'Pinnacle',
      home,
      away,
      lastUpdate: snap.capturedAt || null,
      source: 'board',
    };
  };
  return snap.matches
    .filter((m) => m && typeof m.homeTeam === 'string' && typeof m.awayTeam === 'string')
    .map((m) => ({
      id: `board:${m.homeTeam}-vs-${m.awayTeam}`,
      commenceTime: typeof m.commenceTime === 'string' ? m.commenceTime : '',
      homeTeam: m.homeTeam,
      awayTeam: m.awayTeam,
      bookmakers: [book(m)].filter((b) => b.home !== null || b.away !== null),
    }))
    .sort((a, b) => a.commenceTime.localeCompare(b.commenceTime));
}

export async function fetchBoardSnapshot(): Promise<{
  events: OddsEvent[];
  snapshot: BoardSnapshot;
}> {
  let r: Response;
  try {
    r = await fetch(BOARD_SNAPSHOT_URL);
  } catch {
    throw new Error('Could not reach the published board snapshot.');
  }
  if (!r.ok) throw new Error(`Board snapshot returned HTTP ${r.status}.`);
  let snap: BoardSnapshot;
  try {
    snap = await r.json();
  } catch {
    throw new Error('Could not parse the board snapshot.');
  }
  const events = boardSnapshotToEvents(snap);
  if (events.length === 0) throw new Error('Board snapshot contains no matches.');
  return { events, snapshot: snap };
}
