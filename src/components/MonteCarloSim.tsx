import React, { useMemo, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import Svg, { Line, Polygon, Polyline, Text as SvgText } from 'react-native-svg';
import { runMonteCarlo } from '../model/montecarlo';
import { C, S } from '../theme';

/**
 * Interactive Monte Carlo bankroll simulator.
 *
 * Inputs: starting bankroll, decimal odds, ROI edge, Kelly multiplier, number
 * of bets. Output: 500 simulated bankroll paths — median path, 10th–90th
 * percentile band, a few sample paths — on a log bankroll axis (compounding
 * is multiplicative, so log scale is the honest view), plus end-of-run stats.
 */

const N_SIMS = 500;
const W = 360;
const H = 230;
const PAD_L = 48;
const PAD_R = 8;
const PAD_T = 10;
const PAD_B = 24;

function fmtMoney(v: number): string {
  if (v >= 1000000) return `$${(v / 1000000).toFixed(1)}M`;
  if (v >= 10000) return `$${Math.round(v / 1000)}k`;
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}k`;
  if (v >= 100) return `$${Math.round(v)}`;
  if (v >= 10) return `$${v.toFixed(0)}`;
  return `$${v.toFixed(2)}`;
}

function fmtPct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

function toPoints(values: number[], xFor: (i: number) => number, yFor: (v: number) => number): string {
  return values.map((v, i) => `${xFor(i).toFixed(1)},${yFor(v).toFixed(1)}`).join(' ');
}

export default function MonteCarloSim() {
  const [bankrollText, setBankrollText] = useState('100');
  const [oddsText, setOddsText] = useState('2.00');
  const [edgeText, setEdgeText] = useState('5');
  const [kellyMult, setKellyMult] = useState(0.5);
  const [nBets, setNBets] = useState(500);

  const bankroll = parseFloat(bankrollText.replace(',', '.'));
  const odds = parseFloat(oddsText.replace(',', '.'));
  const edgePct = parseFloat(edgeText.replace(',', '.'));
  const edge = edgePct / 100;

  let error: string | null = null;
  if (!Number.isFinite(bankroll) || bankroll <= 0) error = 'Enter a bankroll above $0.';
  else if (!Number.isFinite(odds) || odds <= 1) error = 'Enter decimal odds above 1.00.';
  else if (!Number.isFinite(edgePct) || edgePct < 0) error = 'Enter an edge of 0% or more.';
  else if ((1 + edge) / odds >= 1) error = 'Edge too high for these odds — implied win prob would be 100%+.';

  const result = useMemo(() => {
    if (error) return null;
    return runMonteCarlo({ bankroll, odds, edge, kellyMultiplier: kellyMult, nBets, nSims: N_SIMS });
  }, [bankroll, odds, edge, kellyMult, nBets, error]);

  const chart = useMemo(() => {
    if (!result) return null;
    const allMin = Math.min(result.p10[0], ...result.samplePaths.map((p) => Math.min(...p)), bankroll);
    const allMax = Math.max(result.p90[0], ...result.samplePaths.map((p) => Math.max(...p)), bankroll);
    const logMin = Math.floor(Math.log10(Math.max(allMin, 0.01)));
    let logMax = Math.ceil(Math.log10(Math.max(allMax, 0.1)));
    if (logMax <= logMin) logMax = logMin + 1;
    const xFor = (i: number) => PAD_L + (i / nBets) * (W - PAD_L - PAD_R);
    const yFor = (v: number) =>
      PAD_T + (1 - (Math.log10(Math.max(v, 0.01)) - logMin) / (logMax - logMin)) * (H - PAD_T - PAD_B);
    const ticks: { value: number; y: number }[] = [];
    for (let e = logMin; e <= logMax; e++) ticks.push({ value: Math.pow(10, e), y: yFor(Math.pow(10, e)) });
    return { xFor, yFor, ticks, logMin, logMax };
  }, [result, nBets, bankroll]);

  return (
    <View style={S.card}>
      <Text style={S.h2}>Monte Carlo bankroll simulator</Text>
      <Text style={[S.dim, { marginBottom: 12 }]}>
        Same bet repeated: decimal odds, ROI edge, Kelly-sized stakes re-sized to the bankroll each
        time. {N_SIMS} simulated runs.
      </Text>

      <View style={[S.row, { gap: 8, marginBottom: 10 }]}>
        <View style={{ flex: 1 }}>
          <Text style={S.label}>Bankroll ($)</Text>
          <TextInput
            style={S.input}
            keyboardType="decimal-pad"
            value={bankrollText}
            onChangeText={setBankrollText}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={S.label}>Decimal odds</Text>
          <TextInput style={S.input} keyboardType="decimal-pad" value={oddsText} onChangeText={setOddsText} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={S.label}>Edge (%)</Text>
          <TextInput style={S.input} keyboardType="decimal-pad" value={edgeText} onChangeText={setEdgeText} />
        </View>
      </View>

      <Text style={S.label}>Kelly fraction</Text>
      <View style={[S.row, { marginBottom: 10 }]}>
        {[
          [0.25, 'Quarter'],
          [0.5, 'Half'],
          [1, 'Full'],
        ].map(([v, label]) => (
          <Pressable
            key={label as string}
            style={[S.chip, kellyMult === v && S.chipActive]}
            onPress={() => setKellyMult(v as number)}
          >
            <Text style={[S.chipText, kellyMult === v && S.chipTextActive]}>{label as string}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={S.label}>Number of bets</Text>
      <View style={[S.row, { marginBottom: 12 }]}>
        {[100, 500, 1000].map((n) => (
          <Pressable
            key={n}
            style={[S.chip, nBets === n && S.chipActive]}
            onPress={() => setNBets(n)}
          >
            <Text style={[S.chipText, nBets === n && S.chipTextActive]}>{n}</Text>
          </Pressable>
        ))}
      </View>

      {error ? (
        <Text style={[S.body, { color: C.red }]}>{error}</Text>
      ) : (
        result &&
        chart && (
          <>
            <Text style={[S.dim, { marginBottom: 6 }]}>
              Stake: {(result.stakeFraction * 100).toFixed(1)}% of bankroll per bet (
              {kellyMult === 1 ? 'full' : kellyMult === 0.5 ? 'half' : 'quarter'}-Kelly; full-Kelly{' '}
              {(result.fullKellyFraction * 100).toFixed(1)}% · win prob {fmtPct(result.winProb)})
            </Text>
            <Svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H}>
              {chart.ticks.map((t) => (
                <Line
                  key={t.value}
                  x1={PAD_L}
                  x2={W - PAD_R}
                  y1={t.y}
                  y2={t.y}
                  stroke={C.border}
                  strokeWidth={1}
                />
              ))}
              {chart.ticks.map((t) => (
                <SvgText key={`lbl-${t.value}`} x={PAD_L - 4} y={t.y + 3} fontSize={9} fill={C.faint} textAnchor="end">
                  {fmtMoney(t.value)}
                </SvgText>
              ))}
              {[0, nBets / 2, nBets].map((b) => (
                <SvgText
                  key={`x-${b}`}
                  x={chart.xFor(b)}
                  y={H - 6}
                  fontSize={9}
                  fill={C.faint}
                  textAnchor="middle"
                >
                  {b}
                </SvgText>
              ))}
              <Line
                x1={PAD_L}
                x2={W - PAD_R}
                y1={chart.yFor(bankroll)}
                y2={chart.yFor(bankroll)}
                stroke={C.amber}
                strokeWidth={1}
                strokeDasharray="4 4"
              />
              <Polygon
                points={`${toPoints(result.p10, chart.xFor, chart.yFor)} ${toPoints(
                  [...result.p90].reverse(),
                  (i) => chart.xFor(nBets - i),
                  chart.yFor,
                )}`}
                fill={C.blue}
                opacity={0.15}
              />
              {result.samplePaths.slice(0, 8).map((p, i) => (
                <Polyline
                  key={i}
                  points={toPoints(p, chart.xFor, chart.yFor)}
                  fill="none"
                  stroke={C.dim}
                  strokeWidth={1}
                  opacity={0.35}
                />
              ))}
              <Polyline
                points={toPoints(result.p90, chart.xFor, chart.yFor)}
                fill="none"
                stroke={C.faint}
                strokeWidth={1}
                strokeDasharray="3 3"
              />
              <Polyline
                points={toPoints(result.p10, chart.xFor, chart.yFor)}
                fill="none"
                stroke={C.faint}
                strokeWidth={1}
                strokeDasharray="3 3"
              />
              <Polyline
                points={toPoints(result.p50, chart.xFor, chart.yFor)}
                fill="none"
                stroke={C.blue}
                strokeWidth={2}
              />
            </Svg>
            <View style={[S.row, { justifyContent: 'space-between', marginTop: 4 }]}>
              <Text style={S.faint}>0 bets</Text>
              <Text style={S.faint}>
                <Text style={{ color: C.blue }}>— Median</Text> ·{' '}
                <Text style={{ color: C.faint }}>┄ 10th–90th band</Text> ·{' '}
                <Text style={{ color: C.amber }}>┄ Start</Text>
              </Text>
            </View>

            <View style={[S.row, { marginTop: 12 }]}>
              <View style={{ flex: 1 }}>
                <Text style={S.label}>Median final</Text>
                <Text style={[S.body, { fontWeight: '700' }]}>
                  {fmtMoney(result.finalMedian)} ({(result.finalMedian / bankroll).toFixed(1)}×)
                </Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={S.label}>10th–90th final</Text>
                <Text style={[S.body, { fontWeight: '700' }]}>
                  {fmtMoney(result.finalP10)} – {fmtMoney(result.finalP90)}
                </Text>
              </View>
            </View>
            <View style={[S.row, { marginTop: 10 }]}>
              <View style={{ flex: 1 }}>
                <Text style={S.label}>P(profit)</Text>
                <Text style={[S.body, { fontWeight: '700', color: C.green }]}>{fmtPct(result.probProfit)}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={S.label}>P(halved)</Text>
                <Text style={[S.body, { fontWeight: '700', color: C.amber }]}>{fmtPct(result.probHalved)}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={S.label}>P(bust &lt; $1)</Text>
                <Text style={[S.body, { fontWeight: '700', color: C.red }]}>{fmtPct(result.probBust)}</Text>
              </View>
            </View>
            <Text style={[S.faint, { marginTop: 10 }]}>
              How to read: each faint line is one simulated run of {nBets} bets. The blue band covers
              the middle 80% of runs. Full Kelly grows fastest on the median path but swings hardest —
              compare the 10th percentile across fractions before sizing up.
            </Text>
          </>
        )
      )}
    </View>
  );
}
