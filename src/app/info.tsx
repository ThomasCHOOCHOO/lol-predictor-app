import React from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import MonteCarloSim from '../components/MonteCarloSim';
import {
  BACKTESTS,
  CALIBRATION_NOTE,
  CURRENT_PATCH,
  HONEST_EVAL,
  METRICS,
  MODEL_VERSION,
  PATCHES,
  PATCH_AWARE,
  ROSTER_FORMULA,
  SNAPSHOT_DATE,
} from '../model/artifacts';
import type { CalibrationMode } from '../model/types';
import { usePrediction } from '../state/PredictionContext';
import { C, S } from '../theme';

export default function InfoScreen() {
  const { calibrationMode, setCalibrationMode } = usePrediction();
  const full = HONEST_EVAL.full;
  const nodraft = HONEST_EVAL.nodraft;
  return (
    <SafeAreaView style={S.screen}>
      <ScrollView contentContainerStyle={S.scroll}>
        <Text style={S.h1}>Model card</Text>
        <Text style={[S.dim, { marginBottom: 12 }]}>What this app is predicting with — no black boxes.</Text>

        <View style={S.card}>
          <Text style={S.h2}>Calibration</Text>
          <Text style={S.dim}>
            Active model: <Text style={[S.body, { fontWeight: '700' }]}>{calibrationMode === 'honest' ? 'Honest calibration' : `Standard (v${MODEL_VERSION})`}</Text>
          </Text>
          <View style={styles.segment}>
            {(['standard', 'honest'] as CalibrationMode[]).map((m) => (
              <Pressable
                key={m}
                style={[styles.segBtn, calibrationMode === m && styles.segActive]}
                onPress={() => setCalibrationMode(m)}
              >
                <Text style={[styles.segText, calibrationMode === m && styles.segTextActive]}>
                  {m === 'standard' ? `Standard (v${MODEL_VERSION})` : 'Honest'}
                </Text>
              </Pressable>
            ))}
          </View>
          <Text style={S.dim}>
            The toggle switches the calibration map used by Predict, Kelly, and Live — the same
            model, same features, only the final mapping from raw score to probability changes.
            Standard is the shipped map, fit on Jul–Oct games and graded on those same games, so
            its ~0 calibration error is in-sample, not real. Honest is fit on Jul–Aug only and
            graded on untouched September games. Flipping the toggle clears the current prediction —
            re-run it under the new map.
          </Text>
        </View>

        <View style={S.card}>
          <Text style={S.h2}>Calibration, honestly measured</Text>
          <Text style={[S.dim, { marginBottom: 8 }]}>
            Same September games (n=1,142) for the Honest and Raw rows; the Standard row is graded
            on the games that built its map — shown for transparency, never as quality.
          </Text>
          <Text style={[S.label, { marginTop: 4 }]}>Full model (draft mode)</Text>
          <MetricRow label="Standard — log-loss" value={full.shipped_style_in_sample.logloss.toFixed(4)} note="in-sample, n=3,368" />
          <MetricRow label="Standard — calibration error" value={full.shipped_style_in_sample.ece.toFixed(3)} note="in-sample" />
          <MetricRow label="Honest — log-loss" value={full.honest_eval.logloss.toFixed(4)} note="untouched Sep" />
          <MetricRow label="Honest — calibration error" value={full.honest_eval.ece.toFixed(3)} note="untouched Sep" />
          <MetricRow label="Raw, no calibration — log-loss" value={full.raw_eval.logloss.toFixed(4)} note="untouched Sep" />
          <Text style={[S.label, { marginTop: 12 }]}>Pre-draft model</Text>
          <MetricRow label="Standard — log-loss" value={nodraft.shipped_style_in_sample.logloss.toFixed(4)} note="in-sample, n=3,368" />
          <MetricRow label="Honest — log-loss" value={nodraft.honest_eval.logloss.toFixed(4)} note="untouched Sep" />
          <MetricRow label="Honest — calibration error" value={nodraft.honest_eval.ece.toFixed(3)} note="untouched Sep" />
          <MetricRow label="Raw, no calibration — log-loss" value={nodraft.raw_eval.logloss.toFixed(4)} note="untouched Sep" />
          <Text style={[S.faint, { marginTop: 8 }]}>
            On that September slice the raw model still beats both maps — September was a different
            world (blue won 49.5% vs 56.7% in Jul–Aug). The toggle exists to answer which map wins
            on future games, not to claim the honest map already does.
          </Text>
        </View>

        <View style={S.card}>
          <Text style={S.h2}>Bundle</Text>
          <InfoRow k="Model version" v={MODEL_VERSION} />
          <InfoRow k="Snapshot date" v={SNAPSHOT_DATE} />
          <InfoRow k="Champion patch" v={PATCH_AWARE ? `${CURRENT_PATCH} (Worlds, default)` : 'single global table'} />
          {PATCH_AWARE && <InfoRow k="Patches in bundle" v={PATCHES.join(', ')} />}
          <InfoRow k="Type" v="Logistic regression + isotonic calibration, fully offline" />
        </View>

        <View style={S.card}>
          <Text style={S.h2}>Honest metrics</Text>
          <InfoRow k="2026 holdout accuracy" v={`${(METRICS.holdout_accuracy * 100).toFixed(1)}% (n=${METRICS.holdout_n.toLocaleString()})`} />
          <InfoRow k="Holdout period" v={`${METRICS.holdout_period[0]} → ${METRICS.holdout_period[1]}`} />
          <InfoRow k="Expected calibration error" v={METRICS.holdout_ece.toFixed(3)} />
          <InfoRow k="Worlds 2025 backtest" v={`${(BACKTESTS.worlds_2025.accuracy * 100).toFixed(1)}% (n=${BACKTESTS.worlds_2025.n})`} />
          <InfoRow k="MSI 2026 backtest" v={`${(BACKTESTS.msi_2026.accuracy * 100).toFixed(1)}% (n=${BACKTESTS.msi_2026.n})`} />
          <Text style={[S.faint, { marginTop: 8 }]}>{METRICS.holdout_ece_note}</Text>
          <Text style={[S.faint, { marginTop: 6 }]}>{CALIBRATION_NOTE}</Text>
        </View>

        <View style={S.card}>
          <Text style={S.h2}>Roster-aware team strength</Text>
          <Text style={S.dim}>
            Rosters reset every year, so raw Elo would overrate rebuilt teams. Each team&apos;s rating blends its
            prior-year Elo with the prior Elo of incoming players&apos; old teams, regressed toward league average
            in proportion to starter turnover.
          </Text>
          <Text style={[S.faint, { marginTop: 8, fontFamily: 'monospace' }]}>{ROSTER_FORMULA}</Text>
        </View>

        <View style={S.card}>
          <Text style={S.h2}>Features</Text>
          <Text style={S.dim}>
            elo_diff (roster-adjusted), eg_gold_diff (trailing-20 avg gold diff at 15 min),
            blue_edge (blue-side win rate),
            d_power (champion strength by patch), d_comfort (team-champion win rate), ban_edge.
            Standardized, logistic regression, then isotonic calibration maps the raw score to an honest probability.
          </Text>
        </View>

        <MonteCarloSim />

        <View style={S.card}>
          <Text style={S.h2}>Odds feeds</Text>
          <Text style={S.dim}>
            The Odds tab pulls live moneylines from The Odds API + OddsPapi (merged view) — tap any
            price to size it in Kelly. The Kelly tab also accepts manual odds. Every OddsPapi pull is
            saved, and the tab ranks books by average margin and tracks cross-book arb pairs.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function InfoRow({ k, v }: { k: string; v: string }) {
  return (
    <View style={[S.row, { justifyContent: 'space-between', paddingVertical: 4 }]}>
      <Text style={S.dim}>{k}</Text>
      <Text style={[S.body, { fontWeight: '600', textAlign: 'right', flexShrink: 1, marginLeft: 12 }]}>{v}</Text>
    </View>
  );
}

function MetricRow({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <View style={[S.row, { justifyContent: 'space-between', paddingVertical: 3 }]}>
      <Text style={S.dim}>{label}</Text>
      <Text style={[S.body, { fontWeight: '600' }]}>{value} <Text style={S.faint}>({note})</Text></Text>
    </View>
  );
}

const styles = StyleSheet.create({
  segment: {
    flexDirection: 'row',
    backgroundColor: C.card2,
    borderRadius: 12,
    padding: 4,
    marginVertical: 12,
    borderWidth: 1,
    borderColor: C.border,
  },
  segBtn: { flex: 1, paddingVertical: 10, borderRadius: 9, alignItems: 'center' },
  segActive: { backgroundColor: C.blue },
  segText: { color: C.dim, fontSize: 14, fontWeight: '700' },
  segTextActive: { color: '#06121F' },
});
