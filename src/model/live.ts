import { COMFORT, LIVE_MODELS, LIVE_MODELS_A, TEAM_ALIASES } from './artifacts';
import { storeGet, storeSet } from './odds';
import { isotonicCalibrate } from './predict';
import type { LiveModelJson } from './types';
import type { SeriesState } from './seriesState';

/**
 * Live in-game win probability (model v1.3+).
 *
 * Per-bucket logistic regression on [pre_logit, golddiff_k, killdiff]
 * (no scaler — raw features), then the bucket's isotonic calibration map.
 * Buckets: 10 / 15 / 20 / 25 minutes; below 10 min use the pre-game model.
 *
 * NOTE: golddiff_k was 2x the true team gold diff at TRAIN time (see the
 * 2x comment in liveProba); liveProba doubles the served 1x diff to match.
 * Variant A (liveProbaA) uses per-role gold, counted correctly — never doubled.
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
  // 2x serve-time correction: the live model was TRAINED on golddiff_k = 2x
  // the true team gold diff (the training script summed the `team` row, whose
  // gold already equals the five players, plus the five player rows). The app
  // serves the true 1x diff, so double it here to match training. Displayed
  // gold is untouched — only the model input is corrected. Variant A
  // (liveProbaA) uses per-role gold, which was counted correctly — never double it.
  const x = [f.preLogit, f.goldDiffK * 2, f.killDiff];
  let z = m.intercept;
  for (let i = 0; i < 3; i++) z += m.coef[i] * x[i];
  const pRaw = sigmoid(z);
  return { pRaw, pCal: isotonicCalibrate(pRaw, m.calibration) };
}

/* ------------------------- live variant A (role gold) ------------------------- */

/** Per-role gold diffs, blue − red, in k gold. The feed's frame
 *  participants carry per-player totalGold; roles come from gameMetadata
 *  participantMetadata (participantId -> role). */
export interface RoleGoldDiff {
  top: number;
  jng: number;
  mid: number;
  bot: number;
  sup: number;
}

export interface LiveFeaturesA {
  preLogit: number;
  roleGold: RoleGoldDiff;
  killDiff: number;
}

/**
 * Variant A (role-gold) live prob — SHADOW ONLY, never drives Kelly sizing.
 * No calibration map exists for variant A yet (the research export carries
 * metrics only), so this returns the RAW prob with uncalibrated: true and
 * pCal = pRaw. The UI must label it uncalibrated. A fitted calibration map
 * for A is a remaining integration item (docs/phase1-wave2.md).
 */
export function liveProbaA(
  f: LiveFeaturesA,
  bucket: number,
): { pRaw: number; pCal: number; uncalibrated: true } | null {
  const m = LIVE_MODELS_A?.[String(bucket)];
  if (!m || m.features.length !== 7) return null;
  const byName: Record<string, number> = {
    pre_logit: f.preLogit,
    top_gold: f.roleGold.top,
    jng_gold: f.roleGold.jng,
    mid_gold: f.roleGold.mid,
    bot_gold: f.roleGold.bot,
    sup_gold: f.roleGold.sup,
    killdiff: f.killDiff,
  };
  const x = m.features.map((name) => byName[name]);
  if (x.some((v) => v === undefined)) return null;
  let z = m.intercept;
  for (let i = 0; i < 7; i++) z += m.coef[i] * x[i];
  const pRaw = sigmoid(z);
  return { pRaw, pCal: pRaw, uncalibrated: true as const };
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
  const games = await fetchMatchGames(matchId);
  const pick =
    games.find((g) => g.state === 'inProgress') ??
    games.find((g) => g.state === 'unstarted') ??
    games[0];
  if (!pick) return null;
  return {
    gameId: pick.gameId,
    number: pick.number,
    state: pick.state,
    blueCode: pick.blueCode,
    redCode: pick.redCode,
  };
}

export interface MatchGameInfo {
  gameId: string;
  number: number;
  state: string;
  /** Per-game side codes (sides can flip between games in a series). */
  blueCode: string;
  redCode: string;
}

/**
 * All games of a match with per-game sides. NOTE: the GW API exposes no
 * per-game winner and no picks/bans — a completed game's winner must be
 * attributed from the match-level gameWins delta (see fetchMatchScore),
 * and picks come from the livestats window metadata (see fetchWindow).
 */
export async function fetchMatchGames(matchId: string): Promise<MatchGameInfo[]> {
  const j = await gw(`getEventDetails?id=${encodeURIComponent(matchId)}`);
  const match: any = j?.data?.event?.match ?? {};
  const games: any[] = match?.games ?? [];
  const teams: any[] = match?.teams ?? [];
  const codeById = new Map<string, string>();
  for (const t of teams) if (t?.id) codeById.set(String(t.id), String(t?.code ?? ''));
  return games.map((g) => {
    const sideCode = (side: string) => {
      const t = (g?.teams ?? []).find((x: any) => x?.side === side);
      return codeById.get(String(t?.id)) ?? '';
    };
    return {
      gameId: String(g.id),
      number: g.number ?? 0,
      state: g.state ?? '',
      blueCode: sideCode('blue'),
      redCode: sideCode('red'),
    };
  });
}

/**
 * Current series score as gameWins by team code. getLive first (live
 * updated while the match is in progress); getSchedule as fallback
 * (Worlds league — the Live tab is Worlds-focused, and getLive already
 * covers all leagues). Null when neither endpoint has the match.
 */
export async function fetchMatchScore(matchId: string): Promise<Record<string, number> | null> {
  const fromEvents = (events: any[]): Record<string, number> | null => {
    const e = events.find((x) => String(x?.match?.id) === String(matchId));
    if (!e) return null;
    const out: Record<string, number> = {};
    for (const t of e?.match?.teams ?? []) {
      const code = t?.code;
      const w = t?.result?.gameWins;
      if (code && typeof w === 'number') out[code] = w;
    }
    return Object.keys(out).length ? out : null;
  };
  try {
    const j = await gw('getLive');
    const r = fromEvents(j?.data?.schedule?.events ?? []);
    if (r) return r;
  } catch {
    /* fall through to the schedule */
  }
  try {
    const j = await gw('getSchedule?leagueId=98767975604431411');
    return fromEvents(j?.data?.schedule?.events ?? []);
  } catch {
    return null;
  }
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

export interface WindowData {
  frames: LiveFrame[];
  /** Champion IDs picked by each side, from gameMetadata participant data.
   *  Empty when the feed omits metadata (picks are then unknown, not zero). */
  bluePicks: string[];
  redPicks: string[];
  /** Per-role gold diffs (blue − red, k gold) from the latest in-game frame
   *  with complete participant data. Null when the feed omits participants
   *  or roles — variant A shadow comparison is then unavailable. */
  roleGold: RoleGoldDiff | null;
}

const ROLE_KEY: Record<string, keyof RoleGoldDiff> = {
  top: 'top',
  jungle: 'jng',
  mid: 'mid',
  bottom: 'bot',
  support: 'sup',
};

/** participantId -> role for one side, from gameMetadata participantMetadata. */
function roleById(meta: any, side: 'blue' | 'red'): Map<number, string> {
  const parts = meta?.[`${side}TeamMetadata`]?.participantMetadata;
  const m = new Map<number, string>();
  if (Array.isArray(parts)) {
    for (const p of parts) {
      const id = Number(p?.participantId);
      if (Number.isFinite(id) && typeof p?.role === 'string') m.set(id, p.role);
    }
  }
  return m;
}

/** Per-role gold diffs from one raw frame, or null when participant data
 *  is incomplete (missing roles, non-numeric gold, fewer than 5 players). */
function roleGoldFromFrame(
  f: any,
  blueRoles: Map<number, string>,
  redRoles: Map<number, string>,
): RoleGoldDiff | null {
  const perSide = (team: any, roles: Map<number, string>): Record<string, number> | null => {
    const parts = team?.participants;
    if (!Array.isArray(parts) || parts.length < 5) return null;
    const out: Record<string, number> = {};
    for (const p of parts) {
      const role = ROLE_KEY[roles.get(Number(p?.participantId)) ?? ''];
      const gold = Number(p?.totalGold);
      if (!role || !Number.isFinite(gold)) return null;
      out[role] = gold;
    }
    if (Object.keys(out).length < 5) return null;
    return out;
  };
  const b = perSide(f?.blueTeam, blueRoles);
  const r = perSide(f?.redTeam, redRoles);
  if (!b || !r) return null;
  return {
    top: (b.top - r.top) / 1000,
    jng: (b.jng - r.jng) / 1000,
    mid: (b.mid - r.mid) / 1000,
    bot: (b.bot - r.bot) / 1000,
    sup: (b.sup - r.sup) / 1000,
  };
}

/** Latest in-game frame with complete participant data, scanning backwards. */
function latestRoleGold(rawFrames: any[], meta: any): RoleGoldDiff | null {
  const blueRoles = roleById(meta, 'blue');
  const redRoles = roleById(meta, 'red');
  if (blueRoles.size < 5 || redRoles.size < 5) return null;
  for (let i = rawFrames.length - 1; i >= 0; i--) {
    const f = rawFrames[i];
    if (String(f?.gameState ?? '') !== 'in_game') continue;
    const rg = roleGoldFromFrame(f, blueRoles, redRoles);
    if (rg) return rg;
  }
  return null;
}

/** Latest window frames for a game + picks from gameMetadata. Empty arrays on any failure. */
export async function fetchWindow(gameId: string): Promise<WindowData> {
  const empty: WindowData = { frames: [], bluePicks: [], redPicks: [], roleGold: null };
  try {
    const r = await fetch(`${FEED}${encodeURIComponent(gameId)}`);
    if (!r.ok) return empty;
    const j = await r.json();
    const raw: any[] = j?.frames ?? [];
    const now = Date.now();
    const frames = raw.map((f, i) => ({
      gameState: String(f?.gameState ?? ''),
      timestampMs: tsMs(f, now - (raw.length - i) * 10000),
      blueTeam: asTeam(f?.blueTeam),
      redTeam: asTeam(f?.redTeam),
    }));
    const meta = j?.gameMetadata ?? {};
    const picks = (side: 'blue' | 'red'): string[] => {
      const parts = meta?.[`${side}TeamMetadata`]?.participantMetadata;
      if (!Array.isArray(parts)) return [];
      return parts.map((p: any) => String(p?.championId ?? '')).filter(Boolean);
    };
    return { frames, bluePicks: picks('blue'), redPicks: picks('red'), roleGold: latestRoleGold(raw, meta) };
  } catch {
    return empty;
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

/* ------------------------- stateful series model ------------------------- */

const SERIES_STATE_SLOT = (matchId: string) => `series_state_${matchId}`;

/** Load a persisted SeriesState for a match. Null when none / unparseable. */
export async function loadSeriesState(matchId: string): Promise<SeriesState | null> {
  try {
    const raw = await storeGet(SERIES_STATE_SLOT(matchId));
    if (!raw) return null;
    const s = JSON.parse(raw) as SeriesState;
    if (!s || typeof s.teamA !== 'string' || !Array.isArray(s.history)) return null;
    return s;
  } catch {
    return null;
  }
}

/** Persist a SeriesState so a refresh mid-series doesn't lose it. */
export async function saveSeriesState(matchId: string, state: SeriesState): Promise<void> {
  await storeSet(SERIES_STATE_SLOT(matchId), JSON.stringify(state));
}

/** Normalize a champion id/name for comparison (gameMetadata uses internal
 *  IDs like 'JarvanIV'; the comfort table uses keys like "bel'veth"). */
function normChamp(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Net burned comfort champions (depl_A − depl_B) for Fearless pool
 * depletion. "Burned" = champions in the team's top-5 comfort list already
 * used in this series. Provisional definition (top-5 count) pending a
 * fitted λ_pool — and λ_pool is currently 0, so this does not move any
 * probability yet; it is plumbing for when λ_pool is fitted.
 */
export function computeDeplNet(
  teamA: string,
  teamB: string,
  usedChamps: Record<string, string[]>,
): number {
  const burned = (team: string): number => {
    const table = COMFORT[team];
    if (!table) return 0;
    const top5 = Object.entries(table)
      .sort((x, y) => y[1] - x[1])
      .slice(0, 5)
      .map(([ch]) => normChamp(ch));
    const used = new Set((usedChamps[team] ?? []).map(normChamp));
    return top5.filter((ch) => used.has(ch)).length;
  };
  return burned(teamA) - burned(teamB);
}
