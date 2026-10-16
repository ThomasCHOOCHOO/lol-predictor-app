import AsyncStorage from '@react-native-async-storage/async-storage';
import { BookmakerOdds, OddsEvent } from './odds';

/**
 * Saved OddsPapi pull history.
 *
 * Every OddsPapi refresh appends one snapshot per match: the user's own books'
 * prices plus the best price per side across all books. The history powers two
 * analyses the tab shows directly:
 *   - per-book average margin (1/home + 1/away - 1): the lowest-margin books
 *     are the sharpest / cheapest to bet at.
 *   - cross-book arb pairs: how often taking one side at book A and the other
 *     side at book B would have locked in a guaranteed profit, and the best
 *     such edge seen.
 *
 * Storage: AsyncStorage (localStorage on web). Capped at 100 snapshots —
 * oldest pruned first — so it stays small. Snapshots only keep the user's
 * books + best legs, never the full 100+ book board from a pull.
 */

const HISTORY_KEY = 'odds_history_v1';
const MAX_SNAPSHOTS = 100;

export interface SnapshotBook {
  key: string;
  title: string;
  home: number | null;
  away: number | null;
}

export interface OddsSnapshot {
  ts: string; // ISO timestamp of the pull
  source: 'oddspapi';
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  commenceTime: string;
  books: SnapshotBook[];
  bestHome: { price: number; bookKey: string } | null;
  bestAway: { price: number; bookKey: string } | null;
}

export interface BookStat {
  key: string;
  title: string;
  n: number;
  avgMargin: number; // mean (1/home + 1/away - 1); lower = tighter spread
  bestMargin: number;
}

export interface ArbPairStat {
  bookA: string;
  titleA: string;
  bookB: string;
  titleB: string;
  arbCount: number;
  bestArbPct: number; // best guaranteed profit seen, as a fraction
  n: number; // snapshots where both books priced both sides
}

function bestLeg(books: BookmakerOdds[], side: 'home' | 'away'): { price: number; bookKey: string } | null {
  let best: { price: number; bookKey: string } | null = null;
  for (const b of books) {
    const p = side === 'home' ? b.home : b.away;
    if (p !== null && (best === null || p > best.price)) best = { price: p, bookKey: b.key };
  }
  return best;
}

/**
 * Build snapshots from one OddsPapi pull. keepKeys = the user's selected
 * books; only those books' rows are stored, plus the best legs across all
 * books. Returns [] when there is nothing worth saving.
 */
export function buildSnapshots(events: OddsEvent[], keepKeys: Set<string>): OddsSnapshot[] {
  const ts = new Date().toISOString();
  const out: OddsSnapshot[] = [];
  for (const e of events) {
    const papiBooks = e.bookmakers.filter((b) => b.source === 'oddspapi');
    if (papiBooks.length === 0) continue;
    const books: SnapshotBook[] = papiBooks
      .filter((b) => keepKeys.has(b.key))
      .map((b) => ({ key: b.key, title: b.title, home: b.home, away: b.away }));
    if (books.length === 0) continue;
    out.push({
      ts,
      source: 'oddspapi',
      eventId: e.id,
      homeTeam: e.homeTeam,
      awayTeam: e.awayTeam,
      commenceTime: e.commenceTime,
      books,
      bestHome: bestLeg(papiBooks, 'home'),
      bestAway: bestLeg(papiBooks, 'away'),
    });
  }
  return out;
}

export async function loadOddsHistory(): Promise<OddsSnapshot[]> {
  try {
    const raw = await AsyncStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as OddsSnapshot[]) : [];
  } catch {
    return [];
  }
}

export async function appendOddsSnapshots(snapshots: OddsSnapshot[]): Promise<OddsSnapshot[]> {
  if (snapshots.length === 0) return loadOddsHistory();
  const prev = await loadOddsHistory();
  const next = [...prev, ...snapshots].slice(-MAX_SNAPSHOTS);
  try {
    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    /* storage full/unavailable — history is best-effort, never blocks the pull */
  }
  return next;
}

export async function clearOddsHistory(): Promise<void> {
  try {
    await AsyncStorage.removeItem(HISTORY_KEY);
  } catch {
    /* already gone */
  }
}

/** Per-book average margin, lowest first. Needs both sides priced to count. */
export function computeBookStats(snapshots: OddsSnapshot[]): BookStat[] {
  const byBook = new Map<string, { title: string; margins: number[] }>();
  for (const s of snapshots) {
    for (const b of s.books) {
      if (b.home === null || b.away === null) continue;
      const margin = 1 / b.home + 1 / b.away - 1;
      const entry = byBook.get(b.key) ?? { title: b.title, margins: [] };
      entry.margins.push(margin);
      byBook.set(b.key, entry);
    }
  }
  const stats: BookStat[] = [];
  for (const [key, entry] of byBook) {
    const sum = entry.margins.reduce((a, m) => a + m, 0);
    stats.push({
      key,
      title: entry.title,
      n: entry.margins.length,
      avgMargin: sum / entry.margins.length,
      bestMargin: Math.min(...entry.margins),
    });
  }
  return stats.sort((a, b) => a.avgMargin - b.avgMargin);
}

/**
 * Cross-book arb pairs. For a pair (A, B), an arb exists in a snapshot when
 * 1/A.home + 1/B.away < 1 (home at A, away at B) or the mirror. Only pairs
 * where both books priced both sides in that snapshot are counted.
 */
export function computeArbPairs(snapshots: OddsSnapshot[]): ArbPairStat[] {
  const pairs = new Map<string, ArbPairStat & { bestInv: number }>();
  for (const s of snapshots) {
    const priced = s.books.filter((b) => b.home !== null && b.away !== null);
    for (let i = 0; i < priced.length; i++) {
      for (let j = i + 1; j < priced.length; j++) {
        const A = priced[i];
        const B = priced[j];
        const inv1 = 1 / (A.home as number) + 1 / (B.away as number);
        const inv2 = 1 / (A.away as number) + 1 / (B.home as number);
        const inv = Math.min(inv1, inv2);
        const key = [A.key, B.key].sort().join('|');
        const entry =
          pairs.get(key) ??
          ({ bookA: A.key, titleA: A.title, bookB: B.key, titleB: B.title, arbCount: 0, bestArbPct: 0, n: 0, bestInv: Infinity } as ArbPairStat & { bestInv: number });
        entry.n += 1;
        if (inv < 1) {
          entry.arbCount += 1;
          if (inv < entry.bestInv) {
            entry.bestInv = inv;
            entry.bestArbPct = 1 - inv;
          }
        }
        pairs.set(key, entry);
      }
    }
  }
  return [...pairs.values()]
    .map(({ bestInv: _ignored, ...rest }) => rest)
    .sort((a, b) => b.arbCount - a.arbCount || b.bestArbPct - a.bestArbPct);
}
