/**
 * Screenshot odds -> per-game bet verdicts.
 *
 * Pipeline (all on-device for OCR on web; see the Odds tab):
 *   screenshot -> OCR text -> parseScreenshotOdds() -> editable rows ->
 *   verdictForGame() per game.
 *
 * This file is pure (no React Native imports) so the parser and the
 * verdict math can be unit-tested on OCR text without an image.
 *
 * Honest limits, stated in the UI too:
 * - Book screenshots are not a standard format. Team names get abbreviated,
 *   OCR misreads digits (1 vs 7, 8 vs 9) and decimal points, and a board
 *   can mix moneyline with map/handicap markets. The parser therefore
 *   returns a confidence flag per row and the UI requires a human check:
 *   every parsed row is editable before any verdict is trusted.
 * - Only h2h (match-winner / series-winner) odds are priced. If a
 *   screenshot shows map 1, handicap, or totals odds, those rows must be
 *   deleted or corrected — the model has no price for them here.
 * - Verdict bar: BET only at ROI edge >= 5% (the edge-watch bar), THIN
 *   for 0–5% (positive but thin — quarter Kelly, user decides), NO BET
 *   at or below 0%. A verdict is a model read on the entered odds, never
 *   a placed bet.
 */
import { TEAM_ALIASES, TEAMS } from './artifacts';
import { americanToDecimal, binNForP, kelly, parseOddsInput, recommendKelly } from './kelly';
import { seriesConversion } from './predict';
import type { CalibrationMode } from './types';

export interface ScreenshotGame {
  id: string;
  /** Model team names (null when the OCR team didn't map). */
  teamA: string | null;
  teamB: string | null;
  /** Raw OCR team strings, for the correction UI. */
  rawA: string;
  rawB: string;
  /** Decimal h2h odds per side (null when missing/unparseable). */
  oddsA: number | null;
  oddsB: number | null;
  /** Series format for the verdict. Defaults to 1 (Swiss rounds 1–2). */
  bestOf: 1 | 3 | 5;
  /** Book name if the screenshot header named one, else ''. */
  book: string;
  /** 'high' = both teams mapped + both odds present, no ambiguity. */
  confidence: 'high' | 'low';
  /** Why confidence is low, when it is. */
  note: string;
}

export type SideVerdict = 'BET' | 'THIN' | 'NO BET' | 'UNPRICED';

export interface SideResult {
  team: string;
  /** Series win probability for this side. */
  pSeries: number;
  odds: number;
  implied: number;
  /** ROI edge: p * odds - 1. */
  roiEdge: number;
  /** Probability edge: p - implied. */
  edge: number;
  fStar: number;
  /** Adaptive Kelly recommendation (label + fraction). */
  kellyLabel: string;
  kellyFrac: number;
  verdict: SideVerdict;
}

export interface GameVerdict {
  game: ScreenshotGame;
  /** Series prob for teamA (null when unmapped). */
  pA: number | null;
  sides: SideResult[];
  /** Sides worth acting on (BET first, then THIN), in verdict order. */
  actionable: SideResult[];
  /** One-line summary for the card header. */
  summary: string;
}

/* ------------------------- team matching ------------------------- */

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

// Candidate match strings, longest first so "Bilibili Gaming" beats "Bilibili".
const TEAM_CANDIDATES: { key: string; normKey: string; model: string }[] = (() => {
  const map = new Map<string, string>();
  for (const [alias, model] of Object.entries(TEAM_ALIASES)) map.set(alias.toLowerCase(), model);
  for (const name of Object.keys(TEAMS)) map.set(name.toLowerCase(), name);
  // Book-board truncations the artifact aliases don't cover. "Liquid" on a
  // board is Team Liquid; "KOI" alone is Movistar KOI in a Worlds board.
  // Kept parser-local (not in the artifact) so a future artifact refresh
  // can't silently change screenshot matching.
  if (!map.has('liquid')) map.set('liquid', 'Team Liquid');
  if (!map.has('koi')) map.set('koi', 'Movistar KOI');
  const out = [...map.entries()].map(([key, model]) => ({ key, normKey: norm(key), model }));
  out.sort((a, b) => b.key.length - a.key.length);
  return out;
})();

/** Normalize OCR punctuation so matching isn't fooled by it: curly
 *  apostrophes (Anyone's), em/en dashes, and a space after a sign (- 417). */
function cleanLine(line: string): string {
  return line
    .replace(/[’‘]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/([+-])\s+(\d)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Map one OCR team string to a model team, or null. Tries exact, then normalized, then substring. */
export function mapScreenshotTeam(raw: string): string | null {
  const cleaned = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!cleaned) return null;
  for (const c of TEAM_CANDIDATES) if (cleaned === c.key) return c.model;
  const n = norm(cleaned);
  if (!n) return null;
  for (const c of TEAM_CANDIDATES) if (n === c.normKey) return c.model;
  // Substring on the normalized form: OCR often appends junk ("T1Live", "Gen.G1").
  for (const c of TEAM_CANDIDATES) {
    if (c.normKey.length >= 3 && n.includes(c.normKey)) return c.model;
  }
  return null;
}

/** Find all team matches in one OCR line, longest-first, non-overlapping. */
function teamsInLine(line: string): { model: string; raw: string; start: number; end: number }[] {
  const cleaned = cleanLine(line);
  const lower = cleaned.toLowerCase();
  const found: { model: string; raw: string; start: number; end: number }[] = [];
  const taken: [number, number][] = [];
  for (const c of TEAM_CANDIDATES) {
    const idx = lower.indexOf(c.key);
    if (idx === -1) continue;
    if (taken.some(([s, e]) => idx < e && idx + c.key.length > s)) continue;
    taken.push([idx, idx + c.key.length]);
    found.push({ model: c.model, raw: cleaned.slice(idx, idx + c.key.length), start: idx, end: idx + c.key.length });
  }
  found.sort((a, b) => a.start - b.start);
  return found;
}

/* ------------------------- odds tokens ------------------------- */

interface OddsToken {
  value: number;
  start: number;
  end: number;
}

function oddsInLine(line: string): OddsToken[] {
  const cleaned = cleanLine(line);
  const out: OddsToken[] = [];
  // American odds first (+150 / -122), then decimal (1.85 or 1,85).
  // Decimal regex skips times (12:30) because it requires '.' or ','.
  const amRe = /[+-]\d{3,4}\b/g;
  let m: RegExpExecArray | null;
  const spans: [number, number][] = [];
  while ((m = amRe.exec(cleaned)) !== null) {
    const d = americanToDecimal(parseInt(m[0], 10));
    if (d !== null) {
      out.push({ value: d, start: m.index, end: m.index + m[0].length });
      spans.push([m.index, m.index + m[0].length]);
    }
  }
  const decRe = /\b\d{1,2}[.,]\d{1,2}\b/g;
  while ((m = decRe.exec(cleaned)) !== null) {
    if (spans.some(([s, e]) => m!.index < e && m!.index + m![0].length > s)) continue;
    const v = parseFloat(m[0].replace(',', '.'));
    if (v >= 1.01 && v <= 50) {
      out.push({ value: v, start: m.index, end: m.index + m[0].length });
      spans.push([m.index, m.index + m[0].length]);
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/* ------------------------- parser ------------------------- */

/**
 * Parse OCR text into games. Board rules learned from a real Pinnacle
 * Oct 23 board (2026-10-20):
 * - Only "(Match)" rows are series prices. "(Map 1)" rows repeat the same
 *   match at the same odds and are SKIPPED, or the board doubles.
 * - Teams and odds may split across lines (team column, then odds
 *   column) or arrive column-wise (all teams, then all odds). Teams
 *   without odds queue up; odds-only lines drain that queue in order.
 *   The old single-pending-team slot overwrote the first team when a
 *   second team-only line arrived — the queue fixes that.
 * - Extra odds tokens on a team line are discarded (they belong to
 *   other markets on that row, e.g. handicap) rather than spilling
 *   onto the next team.
 * - Odds on a team line are assigned to pending teams first: Tesseract
 *   puts both moneyline odds on the second team's line on this board,
 *   so position-only pairing would shift every favourite's price onto
 *   the underdog.
 * - A game with a missing team or missing odds is still returned
 *   (marked low confidence, unpriced) so the user can fix it instead
 *   of it silently vanishing.
 * - Duplicate team pairs are dropped (keep the first): a board that
 *   repeats a match under a misread "(Map 1)" label still yields one row.
 */
export function parseScreenshotOdds(text: string, book = ''): ScreenshotGame[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => cleanLine(l))
    .filter(Boolean)
    .filter((l) => {
      const lower = l.toLowerCase();
      // Map rows only — "(Map 1)", "Map 1", "Map1" (OCR may drop the paren).
      return !lower.includes('(map') && !/\bmap\s*1\b/.test(lower) && !lower.includes('map1');
    });
  interface Cand {
    model: string;
    raw: string;
    odds: number | null;
  }
  const cands: Cand[] = [];
  const pendingTeams: { model: string; raw: string }[] = [];
  for (const line of lines) {
    const teams = teamsInLine(line);
    const odds = oddsInLine(line);
    if (teams.length === 0) {
      // Odds-only line: drain the pending-team queue in order.
      for (const tok of odds) {
        const team = pendingTeams.shift();
        if (!team) break;
        cands.push({ model: team.model, raw: team.raw, odds: tok.value });
      }
      continue;
    }
    // Odds on this line go to pending teams FIRST, then to teams on
    // this line, in order. Real Tesseract output for a Pinnacle board
    // puts both moneyline odds on the second team's line:
    //   Gen.G (Match)
    //   Invictus (Match) -417 +312
    // Position-only pairing would give Invictus -417 (wrong). With a
    // pending Gen.G, -417 -> Gen.G and +312 -> Invictus (right).
    const recipients = [
      ...pendingTeams,
      ...teams.map((t) => ({ model: t.model, raw: t.raw })),
    ];
    pendingTeams.length = 0;
    for (let ri = 0; ri < recipients.length; ri++) {
      const r = recipients[ri];
      const o = odds[ri]?.value ?? null;
      if (o === null) pendingTeams.push(r);
      else cands.push({ model: r.model, raw: r.raw, odds: o });
    }
  }
  for (const team of pendingTeams) cands.push({ model: team.model, raw: team.raw, odds: null });

  const games: ScreenshotGame[] = [];
  const seenPairs = new Set<string>();
  let i = 0;
  let n = 0;
  while (i < cands.length) {
    const a = cands[i];
    const b = cands[i + 1];
    if (b && b.model !== a.model) {
      const pairKey = [a.model, b.model].sort().join('|');
      if (seenPairs.has(pairKey)) {
        i += 2;
        continue;
      }
      seenPairs.add(pairKey);
      games.push({
        id: `shot-${n++}`,
        teamA: a.model,
        teamB: b.model,
        rawA: a.raw,
        rawB: b.raw,
        oddsA: a.odds,
        oddsB: b.odds,
        bestOf: 1,
        book,
        confidence: a.odds !== null && b.odds !== null ? 'high' : 'low',
        note: a.odds === null || b.odds === null ? 'Missing odds on one side — enter it below.' : '',
      });
      i += 2;
    } else {
      // Lone team (duplicate, or its pair never arrived): keep it visible.
      if (seenPairs.has(`lone|${a.model}`)) {
        i += 1;
        continue;
      }
      seenPairs.add(`lone|${a.model}`);
      games.push({
        id: `shot-${n++}`,
        teamA: a.model,
        teamB: null,
        rawA: a.raw,
        rawB: '',
        oddsA: a.odds,
        oddsB: null,
        bestOf: 1,
        book,
        confidence: 'low',
        note: 'Only one team parsed for this game — add the opponent below.',
      });
      i += 1;
    }
  }
  return games;
}

/* ------------------------- verdicts ------------------------- */

export const BET_BAR = 0.05;

export function verdictForGame(
  game: ScreenshotGame,
  calibration: CalibrationMode = 'standard',
): GameVerdict {
  if (!game.teamA || !game.teamB) {
    return {
      game,
      pA: null,
      sides: [],
      actionable: [],
      summary: 'Unmapped — pick both teams to price this game.',
    };
  }
  const conv = seriesConversion(game.teamA, game.teamB, game.bestOf, calibration);
  const pA = conv.pSeries;
  const sides: SideResult[] = [];
  const specs: { team: string; p: number; odds: number | null }[] = [
    { team: game.teamA, p: pA, odds: game.oddsA },
    { team: game.teamB, p: 1 - pA, odds: game.oddsB },
  ];
  for (const s of specs) {
    if (s.odds === null || !(s.odds > 1)) continue;
    const k = kelly(s.odds, s.p);
    if (!k) continue;
    const rec = recommendKelly(k.edge, binNForP(s.p));
    const roi = s.p * s.odds - 1;
    const verdict: SideVerdict = roi >= BET_BAR ? 'BET' : roi > 0 ? 'THIN' : 'NO BET';
    sides.push({
      team: s.team,
      pSeries: s.p,
      odds: s.odds,
      implied: k.implied,
      roiEdge: roi,
      edge: k.edge,
      fStar: k.fStar,
      kellyLabel: rec.label,
      kellyFrac: rec.frac,
      verdict,
    });
  }
  const actionable = sides
    .filter((s) => s.verdict === 'BET' || s.verdict === 'THIN')
    .sort((a, b) => (a.verdict === 'BET' ? 0 : 1) - (b.verdict === 'BET' ? 0 : 1));
  const summary =
    sides.length === 0
      ? 'Enter odds on both sides to price this game.'
      : actionable.length > 0
        ? actionable.map((s) => `${s.verdict}: ${s.team} @ ${s.odds.toFixed(2)} (ROI ${s.roiEdge >= 0 ? '+' : ''}${(s.roiEdge * 100).toFixed(1)}%)`).join(' · ')
        : 'NO BET on either side — neither price beats the model.';
  return { game, pA, sides, actionable, summary };
}

/** Re-run the whole card from edited rows (used after any edit). */
export function verdictsForGames(
  games: ScreenshotGame[],
  calibration: CalibrationMode = 'standard',
): GameVerdict[] {
  return games.map((g) => verdictForGame(g, calibration));
}

/** Parse an odds string the user typed into a row (decimal or American). */
export function parseRowOdds(text: string): number | null {
  const p = parseOddsInput(text);
  return p ? p.decimal : null;
}
