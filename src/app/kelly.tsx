import { router } from 'expo-router';
import React, { useMemo } from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { KELLY_CAVEAT, agreementAdjust, binNForP, fmtMoney, fmtPct, kelly, parseOddsInput, recommendKelly } from '../model/kelly';
import { usePrediction, type KellySide } from '../state/PredictionContext';
import { C, S } from '../theme';

export default function KellyScreen() {
  const { result, kellySide, setKellySide, oddsText, setOddsText, bankrollText, setBankrollText, pinBlue, pinRed } = usePrediction();

  const p = useMemo(() => {
    if (!result) return null;
    return kellySide === 'blue' ? result.pBlue : 1 - result.pBlue;
  }, [result, kellySide]);

  const sideName = result ? (kellySide === 'blue' ? result.blue : result.red) : null;
  // Odds field accepts decimal (1.85) OR American (-122 / +183) — auto-detected.
  const parsedOdds = parseOddsInput(oddsText);
  const odds = parsedOdds ? parsedOdds.decimal : NaN;
  const bankroll = parseFloat(bankrollText.replace(',', '.'));
  const k = p !== null ? kelly(odds, p) : null;
  const hasBankroll = Number.isFinite(bankroll) && bankroll > 0;
  const rec = k && k.bet ? recommendKelly(k.edge, binNForP(k.p)) : null;

  // Smart-money agreement: Pinnacle's price on this side vs the book's price.
  const dPinX = kellySide === 'blue' ? pinBlue : pinRed;
  const dPinOther = kellySide === 'blue' ? pinRed : pinBlue;
  const agr = k && k.bet && rec ? agreementAdjust(k.p, k.odds, dPinX, dPinOther, rec.frac) : null;
  const finalFrac = agr ? agr.adjFrac : (rec ? rec.frac : null);
  const reason = rec
    ? rec.reason +
      (agr && agr.agrees === true
        ? ' Pinnacle agrees.'
        : agr && agr.agrees === false
          ? ' Pinnacle disagrees — sizing down.'
          : '')
    : '';

  const stake = (frac: number) =>
    k && hasBankroll ? fmtMoney(Math.max(0, k.fStar * frac) * bankroll) : '—';

  return (
    <SafeAreaView style={S.screen}>
      <ScrollView contentContainerStyle={S.scroll} keyboardShouldPersistTaps="handled">
        <Text style={S.h1}>Kelly sizing</Text>
        <Text style={[S.dim, { marginBottom: 12 }]}>
          Enter the book's odds as decimal (1.85) or American (-122 / +183) — the app sizes the stake from the model's calibrated probability.
        </Text>

        {!result ? (
          <View style={S.card}>
            <Text style={S.body}>No prediction yet.</Text>
            <Text style={[S.dim, { marginTop: 6, marginBottom: 12 }]}>
              Run a prediction on the Predict tab first — Kelly needs the model's win probability.
            </Text>
            <Pressable style={S.btn} onPress={() => router.replace('/')}>
              <Text style={S.btnText}>Go to Predict</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <View style={S.card}>
              <Text style={S.label}>Betting side</Text>
              <View style={styles.segment}>
                {(['blue', 'red'] as KellySide[]).map((s) => {
                  const name = s === 'blue' ? result.blue : result.red;
                  const prob = s === 'blue' ? result.pBlue : 1 - result.pBlue;
                  const active = kellySide === s;
                  return (
                    <Pressable
                      key={s}
                      style={[styles.segBtn, active && { backgroundColor: s === 'blue' ? C.blue : C.red }]}
                      onPress={() => setKellySide(s)}
                    >
                      <Text style={[styles.segText, active && styles.segTextActive]} numberOfLines={1}>
                        {name}
                      </Text>
                      <Text style={[styles.segSub, active && styles.segTextActive]}>{fmtPct(prob)}</Text>
                    </Pressable>
                  );
                })}
              </View>
              <Text style={S.label}>Odds (your book) — decimal or American</Text>
              <TextInput
                style={[S.input, { marginBottom: 4 }]}
                placeholder="e.g. 1.85 or -122"
                placeholderTextColor={C.faint}
                keyboardType="numbers-and-punctuation"
                autoCapitalize="none"
                autoCorrect={false}
                value={oddsText}
                onChangeText={setOddsText}
              />
              {parsedOdds && (
                <Text style={[S.faint, { marginBottom: 12 }]}>
                  {parsedOdds.format === 'american'
                    ? `≈ ${parsedOdds.decimal.toFixed(2)} decimal`
                    : `≈ ${parsedOdds.american > 0 ? '+' : ''}${parsedOdds.american} American`}
                </Text>
              )}
              <Text style={S.label}>Bankroll (optional)</Text>
              <TextInput
                style={S.input}
                placeholder="e.g. 1000"
                placeholderTextColor={C.faint}
                keyboardType="decimal-pad"
                value={bankrollText}
                onChangeText={setBankrollText}
              />
            </View>

            {k ? (
              <View style={S.card}>
                {k.bet ? (
                  <>
                    <View style={[S.row, { justifyContent: 'space-between', marginBottom: 4 }]}>
                      <Text style={S.h2}>Edge found</Text>
                      <Text style={[styles.edge, { color: C.green }]}>+{fmtPct(k.edge)}</Text>
                    </View>
                    <Text style={[S.dim, { marginBottom: 12 }]}>
                      Model {fmtPct(k.p, 1)} vs implied {fmtPct(k.implied, 1)} on {sideName} @ {k.odds.toFixed(2)} ({parsedOdds && parsedOdds.american > 0 ? '+' : ''}{parsedOdds?.american})
                    </Text>
                    <KellyRow label="Full Kelly" frac={1} fStar={k.fStar} amount={stake(1)} highlight={finalFrac === 1} recommended={finalFrac === 1} />
                    <KellyRow label="Half Kelly" frac={0.5} fStar={k.fStar} amount={stake(0.5)} highlight={finalFrac === 0.5} recommended={finalFrac === 0.5} />
                    <KellyRow label="Quarter Kelly" frac={0.25} fStar={k.fStar} amount={stake(0.25)} highlight={finalFrac === 0.25} recommended={finalFrac === 0.25} />
                    {rec && (
                      <Text style={[S.dim, { marginTop: 10 }]}>
                        {reason}
                      </Text>
                    )}
                    {agr && (
                      <Text style={[S.dim, { marginTop: 6 }]}>
                        {agr.agrees === true ? '✓ ' : agr.agrees === false ? '⚠ ' : '• '}{agr.note}
                      </Text>
                    )}
                    {!hasBankroll && (
                      <Text style={[S.faint, { marginTop: 8 }]}>Enter a bankroll to see dollar stakes.</Text>
                    )}
                  </>
                ) : (
                  <>
                    <Text style={[S.h2, { color: C.red }]}>NO BET</Text>
                    <Text style={[S.dim, { marginTop: 6 }]}>
                      Model {fmtPct(k.p, 1)} vs implied {fmtPct(k.implied, 1)} — edge {fmtPct(k.edge)}.
                      The price is fair or worse; Kelly says stake nothing.
                    </Text>
                  </>
                )}
              </View>
            ) : (
              <View style={S.card}>
                <Text style={S.dim}>Enter valid odds above 1.00 (decimal) or ±100+ (American) to compute Kelly stakes.</Text>
              </View>
            )}

            <View style={[S.card, { borderColor: C.amber }]}>
              <Text style={[S.body, { color: C.amber, fontWeight: '600', marginBottom: 4 }]}>⚠️ Read this</Text>
              <Text style={S.dim}>{KELLY_CAVEAT}</Text>
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function KellyRow({ label, frac, fStar, amount, highlight, recommended }: {
  label: string; frac: number; fStar: number; amount: string; highlight: boolean; recommended: boolean;
}) {
  const pct = Math.max(0, fStar * frac);
  return (
    <View style={[styles.krow, highlight && styles.krowHi]}>
      <View>
        <Text style={[S.body, { fontWeight: '700' }]}>{label}{recommended ? ' ★' : ''}</Text>
        <Text style={S.dim}>{fmtPct(pct, 2)} of bankroll</Text>
      </View>
      <Text style={[styles.amount, highlight && { color: C.green }]}>{amount}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  segment: { flexDirection: 'row', backgroundColor: C.card2, borderRadius: 12, padding: 4, marginBottom: 12, borderWidth: 1, borderColor: C.border },
  segBtn: { flex: 1, paddingVertical: 10, borderRadius: 9, alignItems: 'center', paddingHorizontal: 4 },
  segText: { color: C.dim, fontSize: 13, fontWeight: '700' },
  segSub: { color: C.faint, fontSize: 12, marginTop: 2 },
  segTextActive: { color: '#06121F' },
  edge: { fontSize: 22, fontWeight: '800' },
  krow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border,
  },
  krowHi: { backgroundColor: 'rgba(61,220,132,0.07)', marginHorizontal: -14, paddingHorizontal: 14, borderRadius: 8 },
  amount: { color: C.text, fontSize: 18, fontWeight: '800' },
});
