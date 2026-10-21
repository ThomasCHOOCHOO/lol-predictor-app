/**
 * Parlay EV engine.
 *
 * A parlay is a single ticket at a SINGLE book: legs must share a book to be
 * combinable (cross-book parlays can't be placed). Combos are therefore built
 * per book. EV per $1 staked = P*D - 1, where P is the product of model win
 * probabilities and D the product of decimal odds — the book's compounded
 * hold is inside D, so this EV is net of holds.
 *
 * Cross-match legs are treated as independent (noted in the UI). Same-match
 * legs never get an independence EV — see sameMatchNotes() for the structural
 * correlation treatment.
 */
import { binNForP, recommendKelly, type KellyRecommendation } from './kelly';

export type LegKind = 'ml' | 'totals';

export interface ParlayLeg {
  id: string;
  kind: LegKind;
  /** Groups legs from the same match, e.g. "T1 vs Gen.G". */
  matchKey: string;
  /** Display label, e.g. "T1 ML" or "Over 4.5 maps". */
  label: string;
  /** Model team name (ML legs). */
  team: string;
  /** Model opponent name (ML legs). */
  opponent: string;
  /** Model win probability for `team` (ML legs only). */
  p: number;
  book: string;
  /** Decimal odds for this leg at `book`. */
  odds: number;
  /** Opponent's decimal odds at the same book (optional; used to pick the favorite). */
  oppOdds: number | null;
  /** Totals legs only. */
  totalsDir?: 'over' | 'under';
  /** Totals line in maps, e.g. 4.5. */
  totalsLine?: number;
}

export interface ParlayCombo {
  legs: ParlayLeg[];
  book: string;
  /** Joint win probability under independence. */
  P: number;
  /** Parlay decimal odds (product of leg odds). */
  D: number;
  /** Expected value per $1 staked, net of the compounded hold. */
  ev: number;
  /** P - 1/D. */
  edge: number;
  /** Full-Kelly fraction of bankroll: (P*D - 1) / (D - 1). */
  fStar: number;
  rec: KellyRecommendation;
  /** EV > 0. */
  value: boolean;
}

function* combinations<T>(arr: T[], k: number, start = 0, acc: T[] = []): Generator<T[]> {
  if (acc.length === k) {
    yield [...acc];
    return;
  }
  for (let i = start; i < arr.length; i++) {
    acc.push(arr[i]);
    yield* combinations(arr, k, i + 1, acc);
    acc.pop();
  }
}

const validLeg = (l: ParlayLeg): boolean =>
  l.kind === 'ml' &&
  Number.isFinite(l.p) &&
  l.p >= 0.05 &&
  l.p < 1 &&
  Number.isFinite(l.odds) &&
  l.odds > 1;

export function comboStats(legs: ParlayLeg[]): ParlayCombo {
  const P = legs.reduce((a, l) => a * l.p, 1);
  const D = legs.reduce((a, l) => a * l.odds, 1);
  const ev = P * D - 1;
  const edge = P - 1 / D;
  const fStar = (P * D - 1) / (D - 1);
  const rec = recommendKelly(edge, binNForP(P));
  return { legs, book: legs[0].book, P, D, ev, edge, fStar, rec, value: ev > 0 };
}

/**
 * Top-10 combos of `size` legs by EV. Legs must be ML, share one book (a
 * parlay is a single ticket), and come from distinct matches. Totals legs
 * never enter auto-combos — the model has no totals distribution.
 */
export function rankParlays(legs: ParlayLeg[], size: 2 | 3): ParlayCombo[] {
  const byBook = new Map<string, ParlayLeg[]>();
  for (const l of legs) {
    if (!validLeg(l)) continue;
    const arr = byBook.get(l.book) ?? [];
    arr.push(l);
    byBook.set(l.book, arr);
  }
  const out: ParlayCombo[] = [];
  for (const [, bl] of byBook) {
    for (const combo of combinations(bl, size)) {
      const keys = new Set(combo.map((l) => l.matchKey));
      if (keys.size !== combo.length) continue; // same-match legs: not independent
      out.push(comboStats(combo));
    }
  }
  return out.sort((a, b) => b.ev - a.ev).slice(0, 10);
}

/* ------------------------- correlation engine ------------------------- */

export interface SameMatchNote {
  matchKey: string;
  /** 'value' = structural edge for the bettor (unquantified); 'avoid' = book underpays; 'info' = mechanics. */
  kind: 'value' | 'avoid' | 'info';
  title: string;
  text: string;
}

/**
 * Structural correlation notes for legs from the SAME match. The model has no
 * map-total distribution, so these are directional only — never a number.
 *
 * Logic: a favorite winning usually means a stomp (fewer maps); an underdog
 * winning usually means a long, close series (more maps).
 */
export function sameMatchNotes(legs: ParlayLeg[]): SameMatchNote[] {
  const groups = new Map<string, ParlayLeg[]>();
  for (const l of legs) {
    const arr = groups.get(l.matchKey) ?? [];
    arr.push(l);
    groups.set(l.matchKey, arr);
  }
  const notes: SameMatchNote[] = [];
  for (const [matchKey, g] of groups) {
    if (g.length < 2) continue;
    const mls = g.filter((l) => l.kind === 'ml');
    const totals = g.filter((l) => l.kind === 'totals');
    if (mls.length >= 2) {
      notes.push({
        matchKey,
        kind: 'info',
        title: 'Same-match moneylines excluded',
        text:
          'Two moneyline legs from one match are never combined in the rankings — ' +
          'they are not independent, and the product-of-probabilities EV would be wrong.',
      });
    }
    for (const ml of mls) {
      for (const t of totals) {
        // Favorite = lower decimal odds; fall back to model p when opp odds unknown.
        const favIsMLTeam =
          ml.oppOdds !== null && Number.isFinite(ml.oppOdds) && ml.oppOdds > 1
            ? ml.odds < ml.oppOdds
            : ml.p > 0.5;
        const dir = t.totalsDir === 'over' ? 'over' : 'under';
        const line = t.totalsLine !== undefined ? ` ${t.totalsLine}` : '';
        const mlLabel = `${ml.team} ML`;
        const totLabel = `${dir === 'over' ? 'Over' : 'Under'}${line} maps`;
        // Negative correlation: P(A&B) < P(A)*P(B) -> book's independent
        // pricing (product of odds) OVERPAYS relative to the true joint prob.
        // Positive correlation: book UNDERPAYS -> avoid.
        const negative = (favIsMLTeam && dir === 'over') || (!favIsMLTeam && dir === 'under');
        if (negative) {
          notes.push({
            matchKey,
            kind: 'value',
            title: `${mlLabel} + ${totLabel}: negatively correlated`,
            text:
              `If ${favIsMLTeam ? ml.team : ml.opponent} wins it is usually a stomp (fewer maps); ` +
              `if ${!favIsMLTeam ? ml.team : ml.opponent} wins it usually goes long. ` +
              `These outcomes fight each other, so the book's independent pricing likely OVERPAYS — ` +
              `structural value, unquantified (the model has no totals probability).`,
          });
        } else {
          notes.push({
            matchKey,
            kind: 'avoid',
            title: `${mlLabel} + ${totLabel}: positively correlated`,
            text:
              `These outcomes help each other (a ${favIsMLTeam ? 'stomp' : 'long series'} favors both), ` +
              `so the true joint probability exceeds the product — the book's independent pricing ` +
              `UNDERPAYS. Avoid; no EV is shown because the model cannot quantify it.`,
          });
        }
      }
    }
  }
  return notes;
}

export const PARLAY_CAVEAT =
  'Parlay EV assumes legs are independent — true across matches, false within one. ' +
  'Cross-match rankings use model probabilities; same-match combos get structural notes only, never numbers. ' +
  'Parlays multiply variance: Kelly stakes shrink accordingly.';

/* ------------------------- multi-game parlay ticket ------------------------- */

/**
 * One leg of a custom multi-game parlay. Unlike ParlayLeg.p (a per-map
 * probability in the manual builder), `pSeries` is the SERIES probability
 * for the picked side — side-averaged per-map prob converted with the
 * binomial for the leg's best-of. Books price series, so a Bo3/Bo5 ticket
 * must multiply series probabilities, not per-map ones: e.g. a 65% per-map
 * edge is ~76% over a Bo5, not 65%.
 *
 * Only valid for legs from UNRELATED matches. Two legs from the same
 * match must never go through here — use the joint simulation instead.
 */
export interface MultiGameLeg {
  /** e.g. "T1 vs LØS". Distinct across legs. */
  matchKey: string;
  /** e.g. "T1 wins series". */
  label: string;
  /** Picked side (model team name). */
  team: string;
  opponent: string;
  /** Series win probability for `team` (0–1, exclusive). */
  pSeries: number;
  /** Side-averaged per-map probability, for display. */
  pMapNeutral: number;
  bestOf: 1 | 3 | 5;
  /** Decimal odds for this leg at the ticket's book. */
  odds: number;
}

export interface MultiGameTicket {
  legs: MultiGameLeg[];
  /** Joint win probability under independence (product of series probs). */
  P: number;
  /** Ticket decimal odds (product of leg odds). */
  D: number;
  /** Fair ticket odds (1 / P). */
  fair: number;
  /** ROI per $1 staked: P*D - 1. Positive ⟺ the ticket has edge. */
  ev: number;
  /** Probability edge: P - 1/D. */
  edge: number;
  /** Full-Kelly fraction of bankroll: (P*D - 1) / (D - 1). */
  fStar: number;
  rec: KellyRecommendation;
  /** EV > 0. */
  value: boolean;
  perLeg: { leg: MultiGameLeg; implied: number; roiEdge: number }[];
}

const validMultiLeg = (l: MultiGameLeg): boolean =>
  Number.isFinite(l.pSeries) &&
  l.pSeries > 0 &&
  l.pSeries < 1 &&
  Number.isFinite(l.odds) &&
  l.odds > 1;

/**
 * Price one custom ticket from 2+ legs at a single book. Returns null when
 * fewer than 2 valid legs, when two legs share a match, or when any leg is
 * invalid — the UI then shows what's missing instead of a number.
 */
export function multiGameTicket(legs: MultiGameLeg[]): MultiGameTicket | null {
  if (legs.length < 2) return null;
  if (new Set(legs.map((l) => l.matchKey)).size !== legs.length) return null;
  if (!legs.every(validMultiLeg)) return null;
  const P = legs.reduce((a, l) => a * l.pSeries, 1);
  const D = legs.reduce((a, l) => a * l.odds, 1);
  const ev = P * D - 1;
  const edge = P - 1 / D;
  const fStar = D > 1 ? (P * D - 1) / (D - 1) : 0;
  // Joint-P bin: a low joint P lands in a thin calibration bin, which
  // correctly pushes the recommendation toward quarter Kelly — parlays
  // multiply variance, so the adaptive rule is conservative here by design.
  const rec = recommendKelly(edge, binNForP(P));
  return {
    legs,
    P,
    D,
    fair: 1 / P,
    ev,
    edge,
    fStar,
    rec,
    value: ev > 0,
    perLeg: legs.map((leg) => ({
      leg,
      implied: 1 / leg.odds,
      roiEdge: leg.pSeries * leg.odds - 1,
    })),
  };
}

export const MULTI_GAME_CAVEAT =
  'Multi-game parlays multiply series probabilities — only valid across unrelated ' +
  'matches. A ticket can be a loser even when every leg is a favourite, and a ' +
  'winner even when every leg is an underdog: what matters is model P vs the ' +
  'book price, leg by leg and on the ticket as a whole, not the win rate alone.';
