import { router } from 'expo-router';
import React, { useMemo } from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { KELLY_CAVEAT, fmtMoney, fmtPct, kelly } from '../model/kelly';
import { usePrediction, type KellySide } from '../state/PredictionContext';
import { C, S } from '../theme';

export default function KellyScreen() {
  const { result, kellySide, setKellySide, oddsText, setOddsText, bankrollText, setBankrollText } = usePrediction();

  const p = useMemo(() => {
    if (!result) return null;
    return kellySide === 'blue' ? result.pBlue : 1 - result.pBlue;
  }, [result, kellySide]);

  const sideName = result ? (kellySide === 'blue' ? result.blue : result.red) : null;
  const odds = parseFloat(oddsText.replace(',', '.'));
  const bankroll = parseFloat(bankrollText.replace(',', '.'));
  const k = p !== null ? kelly(odds, p) : null;
  const hasBankroll = Number.isFinite(bankroll) && bankroll > 0;

  const stake = (frac: number) =>
    k && hasBankroll ? fmtMoney(Math.max(0, k.fStar * frac) * bankroll) : '—';

  return (
    <SafeAreaView style={S.screen}>
      <ScrollView contentContainerStyle={S.scroll} keyboardShouldPersistTaps="handled">
        <Text style={S.h1}>Kelly sizing</Text>
        <Text style={[S.dim, { marginBottom: 12 }]}>
          Enter the book's decimal odds — the app sizes the stake from the model's calibrated probability.
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
              <Text style={S.label}>Decimal odds (your book)</Text>
              <TextInput
                style={[S.input, { marginBottom: 12 }]}
                placeholder="e.g. 1.85"
                placeholderTextColor={C.faint}
                keyboardType="decimal-pad"
                value={oddsText}
                onChangeText={setOddsText}
              />
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
                      Model {fmtPct(k.p, 1)} vs implied {fmtPct(k.implied, 1)} on {sideName} @ {k.odds.toFixed(2)}
                    </Text>
                    <KellyRow label="Full Kelly" frac={1} fStar={k.fStar} amount={stake(1)} highlight={false} />
                    <KellyRow label="Half Kelly ★ default" frac={0.5} fStar={k.fStar} amount={stake(0.5)} highlight />
                    <KellyRow label="Quarter Kelly" frac={0.25} fStar={k.fStar} amount={stake(0.25)} highlight={false} />
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
                <Text style={S.dim}>Enter valid decimal odds above 1.00 to compute Kelly stakes.</Text>
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

function KellyRow({ label, frac, fStar, amount, highlight }: {
  label: string; frac: number; fStar: number; amount: string; highlight: boolean;
}) {
  const pct = Math.max(0, fStar * frac);
  return (
    <View style={[styles.krow, highlight && styles.krowHi]}>
      <View>
        <Text style={[S.body, { fontWeight: '700' }]}>{label}</Text>
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
