import React, { useMemo, useState } from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { DraftEditor } from '../components/DraftEditor';
import { SearchPicker, type PickerItem } from '../components/SearchPicker';
import {
  CALIBRATION_TABLE,
  CURRENT_PATCH,
  METRICS,
  PATCHES,
  PATCH_AWARE,
  PLAYER_GAPS,
  PLAYER_GAP_FLAG_THRESHOLD,
  SNAPSHOT_DATE,
  TEAMS,
  rosterTurnoverNote,
  searchTeams,
} from '../model/artifacts';
import { honestyNote, predictMatchup, seriesConversion } from '../model/predict';
import type { PredictionResult } from '../model/types';
import { usePrediction } from '../state/PredictionContext';
import { C, S } from '../theme';

type Mode = 'predraft' | 'draft';

function TeamSelector({
  side,
  team,
  onSelect,
}: {
  side: 'blue' | 'red';
  team: string | null;
  onSelect: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const accent = side === 'blue' ? C.blue : C.red;
  const rec = team ? TEAMS[team] : null;

  return (
    <>
      <Pressable
        style={[S.card, { borderLeftWidth: 3, borderLeftColor: accent, marginBottom: 8 }]}
        onPress={() => setOpen(true)}
      >
        <Text style={[S.label, { color: accent }]}>{side === 'blue' ? 'Blue side' : 'Red side'}</Text>
        <Text style={[S.h1, { marginBottom: 2 }]}>{team ?? 'Select team…'}</Text>
        {rec && (
          <>
            <Text style={S.dim}>
              Elo {rec.elo.toFixed(0)} (raw {rec.elo_raw.toFixed(0)}, roster Δ {rec.roster_delta >= 0 ? '+' : ''}{rec.roster_delta.toFixed(0)})
            </Text>
            <Text style={S.faint}>{rosterTurnoverNote(rec)}</Text>
            {rec.roster_2026.length > 0 && (
              <Text style={S.faint} numberOfLines={1}>2026: {rec.roster_2026.join(' · ')}</Text>
            )}
          </>
        )}
      </Pressable>
      <SearchPicker
        visible={open}
        title={`Select ${side}-side team`}
        placeholder="Search teams or tags (t1, g2, c9…)…"
        items={[]}
        onSearch={(q) =>
          searchTeams(q).map((e) => ({
            key: e.name,
            title: e.name,
            subtitle: `Elo ${e.elo.toFixed(0)}${e.aliases.length ? ` · ${e.aliases.slice(0, 4).join(', ')}` : ''}`,
          }))
        }
        onSelect={(item: PickerItem) => { onSelect(item.title); setOpen(false); }}
        onClose={() => setOpen(false)}
        accent={accent}
      />
    </>
  );
}

function ProbBar({ pBlue, blue, red }: { pBlue: number; blue: string; red: string }) {
  const pct = Math.round(pBlue * 100);
  return (
    <View>
      <View style={styles.probRow}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.probTeam, { color: C.blue }]} numberOfLines={1}>{blue}</Text>
          <Text style={styles.probBig}>{pct}%</Text>
        </View>
        <View style={{ flex: 1, alignItems: 'flex-end' }}>
          <Text style={[styles.probTeam, { color: C.red }]} numberOfLines={1}>{red}</Text>
          <Text style={styles.probBig}>{100 - pct}%</Text>
        </View>
      </View>
      <View style={styles.bar}>
        <View style={[styles.barFill, { flex: pBlue, backgroundColor: C.blue }]} />
        <View style={[styles.barFill, { flex: 1 - pBlue, backgroundColor: C.red }]} />
      </View>
    </View>
  );
}

export default function PredictScreen() {
  const { setResult, setKellySide, probMode, setProbMode, bestOf, setBestOf, calibrationMode } = usePrediction();
  const [mode, setMode] = useState<Mode>('draft');
  const [patch, setPatch] = useState<string>(CURRENT_PATCH);
  const [blue, setBlue] = useState<string | null>('T1');
  const [red, setRed] = useState<string | null>('Bilibili Gaming');
  const [bluePicks, setBluePicks] = useState<(string | null)[]>([null, null, null, null, null]);
  const [redPicks, setRedPicks] = useState<(string | null)[]>([null, null, null, null, null]);
  const [blueBans, setBlueBans] = useState<(string | null)[]>([null, null, null, null, null]);
  const [redBans, setRedBans] = useState<(string | null)[]>([null, null, null, null, null]);
  const [result, setLocalResult] = useState<PredictionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const draftComplete = useMemo(
    () => bluePicks.every(Boolean) && redPicks.every(Boolean),
    [bluePicks, redPicks],
  );

  const canPredict = !!blue && !!red && blue !== red && (mode === 'predraft' || draftComplete);

  const runPrediction = () => {
    setError(null);
    if (!blue || !red) { setError('Pick both teams.'); return; }
    if (blue === red) { setError('Blue and red must be different teams.'); return; }
    const draft =
      mode === 'draft'
        ? {
            bluePicks: bluePicks.filter(Boolean) as string[],
            redPicks: redPicks.filter(Boolean) as string[],
            blueBans: blueBans.filter(Boolean) as string[],
            redBans: redBans.filter(Boolean) as string[],
          }
        : null;
    if (draft && (draft.bluePicks.length !== 5 || draft.redPicks.length !== 5)) {
      setError('Draft mode needs all 5 picks per side.');
      return;
    }
    const r = predictMatchup(blue, red, draft, { patch, calibration: calibrationMode });
    setLocalResult(r);
    setResult(r);
    setKellySide(r.pBlue >= 0.5 ? 'blue' : 'red');
  };

  const swap = () => {
    setBlue(red); setRed(blue);
    setBluePicks(redPicks); setRedPicks(bluePicks);
    setBlueBans(redBans); setRedBans(blueBans);
    setLocalResult(null); setResult(null);
  };

  // Series display (pre-draft only): convert via the side-averaged per-map
  // prob, since sides alternate in a real series. Draft stays per-map.
  const showSeries = result?.mode === 'predraft' && probMode === 'series';
  const conv = useMemo(
    () => (result && showSeries ? seriesConversion(result.blue, result.red, bestOf, calibrationMode) : null),
    [result, showSeries, bestOf, calibrationMode],
  );
  const displayP = conv ? conv.pSeries : (result?.pBlue ?? 0);

  // Diagnostic flag (display only — NEVER changes the prediction): either
  // team's mean player Elo differs from its team Elo by > 100. A large gap
  // means the roster on paper is much stronger/weaker than the org's
  // results suggest — e.g. a rebuilt lineup or a star player carrying a
  // weak org. No gap data for a team = no flag.
  const gapFlags = useMemo(() => {
    if (!result) return [];
    const out: { team: string; gap: number }[] = [];
    for (const team of [result.blue, result.red]) {
      const gap = PLAYER_GAPS[team];
      if (gap !== undefined && Math.abs(gap) > PLAYER_GAP_FLAG_THRESHOLD) out.push({ team, gap });
    }
    return out;
  }, [result]);

  return (
    <SafeAreaView style={S.screen}>
      <ScrollView contentContainerStyle={S.scroll} keyboardShouldPersistTaps="handled">
        <Text style={S.h1}>Match predictor</Text>
        <Text style={[S.dim, { marginBottom: 12 }]}>
          Calibrated win probability — this percentage is the confidence figure.
        </Text>

        {/* mode toggle */}
        <View style={styles.segment}>
          {(['predraft', 'draft'] as Mode[]).map((m) => (
            <Pressable
              key={m}
              style={[styles.segBtn, mode === m && styles.segActive]}
              onPress={() => { setMode(m); setLocalResult(null); }}
            >
              <Text style={[styles.segText, mode === m && styles.segTextActive]}>
                {m === 'predraft' ? 'Pre-draft' : 'Draft'}
              </Text>
            </Pressable>
          ))}
        </View>

        {/* patch selector */}
        {PATCH_AWARE && (
          <View style={{ marginBottom: 12 }}>
            <Text style={S.label}>Champion patch{patch === CURRENT_PATCH ? ' (Worlds patch)' : ''}</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              {PATCHES.map((p) => (
                <Pressable key={p} style={[S.chip, patch === p && S.chipActive]} onPress={() => setPatch(p)}>
                  <Text style={[S.chipText, patch === p && S.chipTextActive]}>
                    {p}{p === CURRENT_PATCH ? ' ★' : ''}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        )}

        <TeamSelector side="blue" team={blue} onSelect={(t) => { setBlue(t); setLocalResult(null); }} />
        <View style={{ alignItems: 'center', marginVertical: 2 }}>
          <Pressable onPress={swap} hitSlop={12} style={styles.swap}>
            <Text style={styles.swapText}>⇅ swap sides</Text>
          </Pressable>
        </View>
        <TeamSelector side="red" team={red} onSelect={(t) => { setRed(t); setLocalResult(null); }} />

        {/* per-map vs series (pre-draft only) */}
        {mode === 'predraft' && (
          <View style={{ marginBottom: 12 }}>
            <Text style={S.label}>Probability</Text>
            <View style={styles.segment}>
              {(['map', 'series'] as const).map((m) => (
                <Pressable
                  key={m}
                  style={[styles.segBtn, probMode === m && styles.segActive]}
                  onPress={() => setProbMode(m)}
                >
                  <Text style={[styles.segText, probMode === m && styles.segTextActive]}>
                    {m === 'map' ? 'Per-map' : 'Series'}
                  </Text>
                </Pressable>
              ))}
            </View>
            {probMode === 'series' && (
              <View style={[S.row, { gap: 8, marginTop: 8 }]}>
                <Text style={[S.dim, { alignSelf: 'center' }]}>Best of</Text>
                {([1, 3, 5] as const).map((n) => (
                  <Pressable key={n} style={[S.chip, bestOf === n && S.chipActive]} onPress={() => setBestOf(n)}>
                    <Text style={[S.chipText, bestOf === n && S.chipTextActive]}>Bo{n}</Text>
                  </Pressable>
                ))}
                <Text style={[S.faint, { alignSelf: 'center', flex: 1 }]}>
                  Series prob from the side-averaged per-map prob.
                </Text>
              </View>
            )}
          </View>
        )}

        {mode === 'draft' && (
          <>
            <DraftEditor side="blue" team={blue} picks={bluePicks} bans={blueBans} patch={patch}
              onPicksChange={setBluePicks} onBansChange={setBlueBans} />
            <DraftEditor side="red" team={red} picks={redPicks} bans={redBans} patch={patch}
              onPicksChange={setRedPicks} onBansChange={setRedBans} />
            {!draftComplete && (
              <Text style={[S.faint, { marginBottom: 8 }]}>Select all 5 picks per side to enable prediction.</Text>
            )}
          </>
        )}

        {!!error && <Text style={[styles.error, { marginBottom: 8 }]}>{error}</Text>}
        <Pressable style={[S.btn, !canPredict && { opacity: 0.4 }]} onPress={runPrediction} disabled={!canPredict}>
          <Text style={S.btnText}>Predict winner</Text>
        </Pressable>

        {result && (
          <View style={[S.card, { marginTop: 14 }]}>
            <View style={[S.row, { justifyContent: 'space-between', marginBottom: 10 }]}>
              <Text style={S.h2}>Prediction</Text>
              <Text style={S.faint}>
                {result.mode === 'draft'
                  ? `draft · patch ${result.patch}`
                  : conv
                    ? `pre-draft · Bo${bestOf} series`
                    : 'pre-draft · per-map'}
              </Text>
            </View>
            <ProbBar pBlue={displayP} blue={result.blue} red={result.red} />
            <Text style={[S.faint, { marginTop: 6 }]}>
              Calibration: {result.calibration === 'honest' ? 'Honest (fit Jul–Aug, graded on untouched Sep games)' : 'Standard (v1.3.2 shipped)'} — switch in the Model tab.
            </Text>
            {gapFlags.map(({ team, gap }) => (
              <View key={team} style={[styles.noteBox, { borderColor: C.amber }]}>
                <Text style={[styles.noteText, { color: C.amber }]}>
                  ⚠️ Roster note: {team}&apos;s player ratings sit {Math.abs(gap).toFixed(0)} Elo points{' '}
                  {gap > 0 ? 'above' : 'below'} its team Elo (|gap| &gt; 100). The roster on paper is
                  much {gap > 0 ? 'stronger' : 'weaker'} than the org&apos;s results suggest. Display
                  only — this does not change the prediction.
                </Text>
              </View>
            ))}
            {conv && (
              <Text style={[S.dim, { marginTop: 8 }]}>
                Neutral per-map {(conv.pNeutral * 100).toFixed(0)}% (as blue {(conv.pMapAsBlue * 100).toFixed(0)}% / as red {(conv.pMapAsRed * 100).toFixed(0)}%) — sides alternate in a series.
              </Text>
            )}
            <View style={styles.noteBox}>
              <Text style={styles.noteText}>📐 {honestyNote(conv ? conv.pNeutral : result.pBlue, CALIBRATION_TABLE)}</Text>
            </View>
            <View style={{ marginTop: 10 }}>
              <Text style={S.label}>Feature contributions (blue − red)</Text>
              {result.mode === 'draft' ? (
                <>
                  <FeatRow k="Elo diff" v={result.features.elo_diff} fmt={(x) => `${x >= 0 ? '+' : ''}${x.toFixed(0)}`} />
                  <FeatRow k="Gold@15 diff" v={result.features.eg_gold_diff} fmt={(x) => `${x >= 0 ? '+' : ''}${x.toFixed(0)}g`} />
                  <FeatRow k="Champ power Δ" v={result.features.d_power} fmt={(x) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}`} />
                  <FeatRow k="Comfort Δ" v={result.features.d_comfort} fmt={(x) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}`} />
                  <FeatRow k="Ban edge" v={result.features.ban_edge} fmt={(x) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}`} />
                </>
              ) : (
                <>
                  <FeatRow k="Elo diff" v={result.features.elo_diff} fmt={(x) => `${x >= 0 ? '+' : ''}${x.toFixed(0)}`} />
                  <FeatRow k="Gold@15 diff" v={result.features.eg_gold_diff} fmt={(x) => `${x >= 0 ? '+' : ''}${x.toFixed(0)}g`} />
                </>
              )}
            </View>
            <Text style={[S.faint, { marginTop: 10 }]}>
              Holdout accuracy {(METRICS.holdout_accuracy * 100).toFixed(1)}% (n={METRICS.holdout_n.toLocaleString()},
              ECE {METRICS.holdout_ece.toFixed(3)}) · snapshot {SNAPSHOT_DATE}
            </Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function FeatRow({ k, v, fmt }: { k: string; v: number; fmt: (x: number) => string }) {
  return (
    <View style={[S.row, { justifyContent: 'space-between', paddingVertical: 3 }]}>
      <Text style={S.dim}>{k}</Text>
      <Text style={[S.body, { color: v >= 0 ? C.blue : C.red, fontWeight: '600' }]}>{fmt(v)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  segment: {
    flexDirection: 'row',
    backgroundColor: C.card2,
    borderRadius: 12,
    padding: 4,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: C.border,
  },
  segBtn: { flex: 1, paddingVertical: 10, borderRadius: 9, alignItems: 'center' },
  segActive: { backgroundColor: C.blue },
  segText: { color: C.dim, fontSize: 14, fontWeight: '700' },
  segTextActive: { color: '#06121F' },
  swap: { paddingVertical: 6, paddingHorizontal: 14 },
  swapText: { color: C.blue, fontSize: 13, fontWeight: '600' },
  error: { color: C.red, fontSize: 13, fontWeight: '600' },
  probRow: { flexDirection: 'row', marginBottom: 10 },
  probTeam: { fontSize: 13, fontWeight: '700' },
  probBig: { color: C.text, fontSize: 40, fontWeight: '800', letterSpacing: -1 },
  bar: { flexDirection: 'row', height: 10, borderRadius: 5, overflow: 'hidden', backgroundColor: C.card2 },
  barFill: { height: '100%' },
  noteBox: {
    backgroundColor: C.card2,
    borderRadius: 10,
    padding: 10,
    marginTop: 12,
    borderWidth: 1,
    borderColor: C.border,
  },
  noteText: { color: C.dim, fontSize: 13, lineHeight: 18 },
});
