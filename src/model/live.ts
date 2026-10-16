import { LIVE_MODELS, TEAM_ALIASES } from './artifacts';
import { storeGet, storeSet } from './odds';
import { isotonicCalibrate } from './predict';
import type { LiveModelJson } from './types';

/**
 * Live in-game win probability (model v1.3+).
 *
 * Per-bucket logistic regression on [pre_logit, golddiff_k, killdiff]
 * (no scaler — raw features), then the bucket's isotonic calibration map.
 * Buckets: 10 / 15 / 20 / 25 minutes; below 10 min use the pre-game model.
 */

export const LIVE_BUCKETS = [10, 15, 20, 25] as const;

/** Largest bucket <= elapsed minutes, or null when the game is too young. */
export function bucketFor(minutes: number): number | null {
  let b: number | null = null;
  for (const t of LIVE_BUCKETS) if (minutes >= t) b = t;
  return b;
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

export interface LiveFeatures {
  preLogit: number; // logit of the v1.2 pre-game calibrated P(blue)
  goldDiffK: number; // (blue gold - red gold) / 1000
  killDiff: number; // blue kills - red kills
}

export function liveProba(f: LiveFeatures, bucket: number): { pRaw: number; pCal: number } | null {
  const m: LiveModelJson | undefined = LIVE_MODELS?.[String(bucket)];
  if (!m || m.features.length !== 3) return null;
  const x = [f.preLogit, f.goldDiffK, f.killDiff];
  let z = m.intercept;
  for (let i = 0; i < 3; i++) z += m.coef[i] * x[i];
  const pRaw = sigmoid(z);
  return { pRaw, pCal: isotonicCalibrate(pRaw, m.calibration) };
}

export function preLogit(p: number): number {
  const c = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
  return Math.log(c / (1 - c));
}

/* ------------------------------------------------------------------ */
/* Unofficial LoL Esports API (same feed lolesports.com uses).         */
/* Free, no signup. Poll politely; degrade gracefully on failure.      */
/* ------------------------------------------------------------------ */

const GW = 'https://esports-api.lolesports.com/persisted/gw/';
const FEED = 'https://feed.lolesports.com/livestats/v1/window/';
const API_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';

async function gw(path: string): Promise<any> {
  const r = await fetch(`${GW}${path}${path.includes('?') ? '&' : '?'}hl=en-US`, {
    headers: { 'x-api-key': API_KEY },
  });
  if (!r.ok) throw new Error(`lolesports ${r.status}`);
  return r.json();
}

export interface LiveMatch {
  matchId: string;
  league: string;
  blueCode: string;
  redCode: string;
  blueName: string;
  redName: string;
  state: string;
  strategy?: string;
}

interface GwTeam {
  code?: string;
  name?: string;
  id?: string;
}

/** In-progress matches across all leagues (caller filters to Worlds). */
export async function fetchLiveMatches(): Promise<LiveMatch[]> {
  const j = await gw('getLive');
  const events: any[] = j?.data?.schedule?.events ?? [];
  const out: LiveMatch[] = [];
  for (const e of events) {
    if (e?.state !== 'inProgress') continue;
    const teams: GwTeam[] = e?.match?.teams ?? [];
    if (teams.length < 2) continue;
    out.push({
      matchId: String(e.match.id),
      league: e?.league?.name ?? e?.league?.slug ?? 'LoL Esports',
      blueCode: teams[0].code ?? '',
      redCode: teams[1].code ?? '',
      blueName: teams[0].name ?? teams[0].code ?? '',
      redName: teams[1].name ?? teams[1].code ?? '',
      state: e.state,
      strategy: e?.match?.strategy?.count ? `Bo${e.match.strategy.count}` : undefined,
    });
  }
  return out;
}

export interface LiveGame {
  gameId: string;
  number: number;
  state: string;
  /** Per-game side codes (sides can flip between games in a series). */
  blueCode: string;
  redCode: string;
}

/** Games of a match; returns the in-progress one (or first unstarted). */
export async function fetchLiveGame(matchId: string): Promise<LiveGame | null> {
  const j = await gw(`getEventDetails?id=${encodeURIComponent(matchId)}`);
  const match: any = j?.data?.event?.match ?? {};
  const games: any[] = match?.games ?? [];
  const teams: any[] = match?.teams ?? [];
  const codeById = new Map<string, string>();
  for (const t of teams) if (t?.id) codeById.set(String(t.id), String(t?.code ?? ''));
  const inProg = games.find((g) => g?.state === 'inProgress');
  const pick = inProg ?? games.find((g) => g?.state === 'unstarted') ?? games[0];
  if (!pick) return null;
  const sideCode = (side: string) => {
    const t = (pick?.teams ?? []).find((x: any) => x?.side === side);
    return codeById.get(String(t?.id)) ?? '';
  };
  return {
    gameId: String(pick.id),
    number: pick.number ?? 0,
    state: pick.state ?? '',
    blueCode: sideCode('blue'),
    redCode: sideCode('red'),
  };
}

/* ------------------------- livestats frames ------------------------- */

export interface FrameTeam {
  totalGold: number;
  totalKills: number;
  towers: number;
  inhibitors: number;
  barons: number;
  dragons: string[];
}

export interface LiveFrame {
  gameState: string;
  timestampMs: number;
  blueTeam: FrameTeam;
  redTeam: FrameTeam;
}

function asTeam(t: any): FrameTeam {
  return {
    totalGold: Number(t?.totalGold ?? 0),
    totalKills: Number(t?.totalKills ?? 0),
    towers: Number(t?.towers ?? 0),
    inhibitors: Number(t?.inhibitors ?? 0),
    barons: Number(t?.barons ?? 0),
    dragons: Array.isArray(t?.dragons) ? t.dragons.map(String) : [],
  };
}

function tsMs(f: any, fallback: number): number {
  const s = f?.rfc460Timestamp ?? f?.rfc3339Timestamp ?? f?.timestamp;
  if (typeof s === 'string') {
    const ms = Date.parse(s);
    if (!Number.isNaN(ms)) return ms;
  }
  if (typeof s === 'number') return s > 1e12 ? s : s * 1000;
  return fallback;
}

/** Latest window frames for a game. Empty array on any failure. */
export async function fetchWindow(gameId: string): Promise<LiveFrame[]> {
  try {
    const r = await fetch(`${FEED}${encodeURIComponent(gameId)}`);
    if (!r.ok) return [];
    const j = await r.json();
    const raw: any[] = j?.frames ?? [];
    const now = Date.now();
    return raw.map((f, i) => ({
      gameState: String(f?.gameState ?? ''),
      timestampMs: tsMs(f, now - (raw.length - i) * 10000),
      blueTeam: asTeam(f?.blueTeam),
      redTeam: asTeam(f?.redTeam),
    }));
  } catch {
    return [];
  }
}

/** Elapsed game minutes from frame timestamps (first in_game frame ≈ 0:00). */
export function elapsedMinutes(frames: LiveFrame[]): number {
  const inGame = frames.filter((f) => f.gameState === 'in_game');
  if (inGame.length === 0) return 0;
  const t0 = inGame[0].timestampMs;
  const t1 = inGame[inGame.length - 1].timestampMs;
  const byTs = Math.max(0, (t1 - t0) / 60000);
  if (byTs > 0.5) return byTs;
  // fallback: frames arrive ~10s apart
  return (inGame.length * 10) / 60;
}

export interface LiveGameState {
  minutes: number;
  bucket: number | null;
  goldDiffK: number;
  killDiff: number;
  blueTowers: number;
  redTowers: number;
  blueDragons: string[];
  redDragons: string[];
  blueBarons: number;
  redBarons: number;
  gameState: string; // latest frame state
}

/** Latest in-game snapshot, or null when no in_game frame exists yet. */
export function snapshot(frames: LiveFrame[]): LiveGameState | null {
  const inGame = frames.filter((f) => f.gameState === 'in_game');
  if (inGame.length === 0) return null;
  const f = inGame[inGame.length - 1];
  const minutes = elapsedMinutes(frames);
  return {
    minutes,
    bucket: bucketFor(minutes),
    goldDiffK: (f.blueTeam.totalGold - f.redTeam.totalGold) / 1000,
    killDiff: f.blueTeam.totalKills - f.redTeam.totalKills,
    blueTowers: f.blueTeam.towers,
    redTowers: f.redTeam.towers,
    blueDragons: f.blueTeam.dragons,
    redDragons: f.redTeam.dragons,
    blueBarons: f.blueTeam.barons,
    redBarons: f.redTeam.barons,
    gameState: f.gameState,
  };
}

/* ------------------------- stream-OCR fallback ------------------------- */
// Snapshot served by ocr/worker.py when the lolesports data feed is stale.
// The worker OCRs the broadcast scoreboard (clock, kills, gold per side).
export interface OcrSnapshot {
  source: 'ocr';
  captured_at: string;
  game_time_min: number | null;
  left: { kills: number | null; gold_k: number | null };
  right: { kills: number | null; gold_k: number | null };
  stale: boolean;
  age_s: number;
}

const OCR_URL_SLOT = 'ocr_feed_url';

export async function getOcrUrl(): Promise<string | null> {
  return storeGet(OCR_URL_SLOT);
}

export async function setOcrUrl(url: string): Promise<void> {
  await storeSet(OCR_URL_SLOT, url.trim());
}

/** Fetch a fresh OCR snapshot. Null on any failure or stale snapshot. */
export async function fetchOcrSnapshot(url: string): Promise<OcrSnapshot | null> {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const j = await res.json();
    if (j?.source !== 'ocr' || j?.stale) return null;
    if (typeof j.game_time_min !== 'number' || j.left == null || j.right == null) return null;
    return j as OcrSnapshot;
  } catch {
    return null;
  }
}

/**
 * Convert an OCR snapshot to a LiveGameState. Broadcast convention: blue
 * side on the left of the scoreboard. Towers/dragons/barons are not in the
 * top bar, so they stay at 0 / empty -- the live model only uses
 * [preLogit, goldDiffK, killDiff] anyway.
 */
export function ocrToLiveState(o: OcrSnapshot): LiveGameState | null {
  if (
    o.game_time_min == null ||
    o.left.kills == null ||
    o.left.gold_k == null ||
    o.right.kills == null ||
    o.right.gold_k == null
  ) {
    return null;
  }
  const minutes = o.game_time_min;
  return {
    minutes,
    bucket: bucketFor(minutes),
    goldDiffK: o.left.gold_k - o.right.gold_k,
    killDiff: o.left.kills - o.right.kills,
    blueTowers: 0,
    redTowers: 0,
    blueDragons: [],
    redDragons: [],
    blueBarons: 0,
    redBarons: 0,
    gameState: 'in_game',
  };
}

/* ------------------------- team mapping ------------------------- */

/**
 * Map a lolesports team code (e.g. "T1", "BLG") to a model team name via
 * team_aliases. Returns null when unmapped — the UI then lets the user
 * pick/swap sides manually.
 */
export function mapTeamCode(code: string): string | null {
  if (!code) return null;
  const hit = TEAM_ALIASES[code.toLowerCase()];
  return hit ?? null;
}
