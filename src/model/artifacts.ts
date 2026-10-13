import raw from '../data/phone_artifacts.json';
import type { Artifacts, TeamRecord } from './types';

const A = raw as unknown as Artifacts;

/** Is champion_power per-patch? v1.2+ carries champion_power_by_patch. */
export const PATCH_AWARE: boolean =
  typeof A.champion_power_by_patch === 'object' && A.champion_power_by_patch !== null;

/** patch -> {champLower: power}, normalized regardless of artifact version. */
export const POWER_BY_PATCH: Record<string, Record<string, number>> = (() => {
  if (PATCH_AWARE) return A.champion_power_by_patch as Record<string, Record<string, number>>;
  return { all: A.champion_power as Record<string, number> };
})();

/** Newest patch first. */
export const PATCHES: string[] = (() => {
  const list = PATCH_AWARE
    ? ((A.recent_patches as string[] | undefined) ?? Object.keys(POWER_BY_PATCH))
    : Object.keys(POWER_BY_PATCH);
  return [...list].sort().reverse();
})();

export const CURRENT_PATCH: string = PATCH_AWARE ? (A.current_patch as string) : 'all';

export const MODEL_VERSION: string = A.model_version;
export const SNAPSHOT_DATE: string = A.snapshot_date;

export const MODELS = A.models;
export const BLUE_EDGE: number = A.blue_edge;
export const TEAMS: Record<string, TeamRecord> = A.teams;
export const TEAM_ALIASES: Record<string, string> = A.team_aliases;
export const CHAMPIONS: string[] = A.champions; // display names
export const COMFORT: Record<string, Record<string, number>> = A.team_champion_comfort;
export const CALIBRATION_TABLE = A.calibration_table;
export const CALIBRATION_NOTE: string = A.calibration_note;
export const BACKTESTS = A.backtests;
export const METRICS = A.metrics;
export const ROSTER_FORMULA: string = A.roster_formula;

/** display name -> lowercase power-table key (verified 1:1 at build time). */
export function champKey(displayName: string): string {
  return displayName.toLowerCase();
}

const DISPLAY_BY_KEY: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const name of CHAMPIONS) m[champKey(name)] = name;
  return m;
})();

function toDisplay(key: string): string {
  return DISPLAY_BY_KEY[key] ?? key.split(' ').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

/** Display names of champions with power data on a patch (sorted). */
export function championNames(patch: string): string[] {
  const table = POWER_BY_PATCH[patch] ?? POWER_BY_PATCH[CURRENT_PATCH];
  return Object.keys(table).map(toDisplay).sort((a, b) => a.localeCompare(b));
}

export function championPower(displayName: string, patch: string): number {
  const table = POWER_BY_PATCH[patch] ?? POWER_BY_PATCH[CURRENT_PATCH];
  return table[champKey(displayName)] ?? 0.5; // mirrors Python: champ_power.get(c, 0.5)
}

export function hasChampionPower(displayName: string, patch: string): boolean {
  const table = POWER_BY_PATCH[patch] ?? POWER_BY_PATCH[CURRENT_PATCH];
  return champKey(displayName) in table;
}

export function teamComfort(team: string, displayName: string, fallbackForm: number): number {
  const t = COMFORT[team];
  if (t) {
    const v = t[champKey(displayName)];
    if (v !== undefined) return v;
  }
  return fallbackForm; // mirrors Python: tc.get(f"{team}||{c}", f)
}

/** Search index entries: team name + every alias that resolves to it. */
export interface TeamSearchEntry {
  name: string;
  elo: number;
  aliases: string[];
}

const POPULAR = new Set([
  'T1', 'Gen.G', 'Bilibili Gaming', "Anyone's Legend", 'Top Esports', 'G2 Esports',
  'Karmine Corp', 'Fnatic', 'Team Liquid', 'Cloud9', 'FlyQuest', 'CTBC Flying Oyster',
  'Hanwha Life Esports', 'Dplus Kia', 'Invictus Gaming', 'JD Gaming', 'LNG Esports',
  'Movistar KOI', 'FURIA', 'LØS', 'LOUD', 'GAM Esports', 'PSG Talon',
]);

export const TEAM_LIST: TeamSearchEntry[] = (() => {
  const aliasByTeam = new Map<string, string[]>();
  for (const [alias, team] of Object.entries(TEAM_ALIASES)) {
    if (!aliasByTeam.has(team)) aliasByTeam.set(team, []);
    aliasByTeam.get(team)!.push(alias);
  }
  const entries: TeamSearchEntry[] = Object.entries(TEAMS).map(([name, rec]) => ({
    name,
    elo: rec.elo,
    aliases: aliasByTeam.get(name) ?? [],
  }));
  entries.sort((a, b) => {
    const pa = POPULAR.has(a.name) ? 0 : 1;
    const pb = POPULAR.has(b.name) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return b.elo - a.elo;
  });
  return entries;
})();

export function searchTeams(query: string, limit = 60): TeamSearchEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return TEAM_LIST.slice(0, limit);
  const starts: TeamSearchEntry[] = [];
  const contains: TeamSearchEntry[] = [];
  for (const e of TEAM_LIST) {
    const name = e.name.toLowerCase();
    const aliasHit = e.aliases.some((a) => a === q);
    if (aliasHit || name === q) {
      starts.unshift(e);
      continue;
    }
    if (name.startsWith(q) || e.aliases.some((a) => a.startsWith(q))) starts.push(e);
    else if (name.includes(q) || e.aliases.some((a) => a.includes(q))) contains.push(e);
    if (starts.length + contains.length >= limit * 2) break;
  }
  return [...starts, ...contains].slice(0, limit);
}

export function searchChampions(query: string, patch: string, limit = 60) {
  const q = query.trim().toLowerCase();
  const rows = championNames(patch).map((name) => ({ name, power: championPower(name, patch) }));
  if (!q) return rows.slice(0, limit);
  return rows.filter((r) => r.name.toLowerCase().includes(q)).slice(0, limit);
}

export function rosterTurnoverNote(rec: TeamRecord): string {
  const t = rec.turnover_2025_2026;
  if (t === null || t === undefined) return 'roster data n/a';
  const changed = Math.round(t * 5);
  if (changed === 0) return 'same 5 starters as 2025';
  return `${changed}/5 starters changed 2025→2026`;
}
