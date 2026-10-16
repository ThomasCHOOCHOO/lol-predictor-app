import React from 'react';
import { SafeAreaView, ScrollView, Text, View } from 'react-native';
import {
  BACKTESTS,
  CALIBRATION_NOTE,
  CURRENT_PATCH,
  METRICS,
  MODEL_VERSION,
  PATCHES,
  PATCH_AWARE,
  ROSTER_FORMULA,
  SNAPSHOT_DATE,
} from '../model/artifacts';
import { S } from '../theme';

export default function InfoScreen() {
  return (
    <SafeAreaView style={S.screen}>
      <ScrollView contentContainerStyle={S.scroll}>
        <Text style={S.h1}>Model card</Text>
        <Text style={[S.dim, { marginBottom: 12 }]}>What this app is predicting with — no black boxes.</Text>

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

        <View style={S.card}>
          <Text style={S.h2}>Coming later</Text>
          <Text style={S.dim}>
            Live sportsbook odds integration (The Odds API / PandaScore) to auto-fill the Kelly tab — parked for now.
            Kelly uses manually entered decimal odds.
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
