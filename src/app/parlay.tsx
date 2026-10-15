import React, { useMemo, useRef, useState } from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { fmtMoney, fmtPct, parseOddsInput } from '../model/kelly';
import { bestPrices, mapOddsTeamName, type OddsEvent } from '../model/odds';
import {
  PARLAY_CAVEAT,
  rankParlays,
  sameMatchNotes,
  type ParlayCombo,
  type ParlayLeg,
} from '../model/parlay';
import { predictMatchup } from '../model/predict';
import { usePrediction } from '../state/PredictionContext';
import { C, S } from '../theme';

type LegKindTab = 'ml' | 'totals';

export default function ParlayScreen() {
  const { bankrollText, oddsEvents } = usePrediction();
  const [legs, setLegs] = useState<ParlayLeg[]>([]);
  const [kind, setKind] = useState<LegKindTab>('ml');
  const [teamA, setTeamA] = useState('');
  const [teamB, setTeamB] = useState('');
  const [side, setSide] = useState<'A' | 'B'>('A');
  const [book, setBook] = useState('');
  const [odds, setOdds] = useState('');
  const [oppOdds, setOppOdds] = useState('');
  const [totalsDir, setTotalsDir] = useState<'over' | 'under'>('over');
  const [totalsLine, setTotalsLine] = useState('4.5');
  const [formError, setFormError] = useState<string | null>(null);
  const [localBank, setLocalBank] = useState('');
  const idRef = useRef(0);
  const nextId = () => `leg-${Date.now()}-${idRef.current++}`;

  const ctxBank = parseFloat(bankrollText.replace(',', '.'));
  const localN = parseFloat(localBank.replace(',', '.'));
  const bankroll =
    Number.isFinite(ctxBank) && ctxBank > 0
      ? ctxBank
      : Number.isFinite(localN) && localN > 0
        ? localN
        : null;

  const pushLeg = (leg: Omit<ParlayLeg, 'id'>): boolean => {
    const dupe = legs.some(
      (l) =>
        l.matchKey === leg.matchKey &&
        l.label === leg.label &&
        l.book === leg.book &&
        l.odds === leg.odds,
    );
    if (dupe) {
      setFormError('That leg is already added.');
      return false;
    }
    setLegs((prev) => [...prev, { ...leg, id: nextId() }]);
    setFormError(null);
    return true;
  };

  const removeLeg = (id: string) => setLegs((prev) => prev.filter((l) => l.id !== id));

  const addManualML = () => {
    const a = mapOddsTeamName(teamA.trim());
    const b = mapOddsTeamName(teamB.trim());
    if (!a || !b) {
      setFormError('Both teams must match model teams (check spelling).');
      return;
    }
    if (a === b) {
      setFormError('Pick two different teams.');
      return;
    }
    const parsed = parseOddsInput(odds);
    if (!parsed) {
      setFormError('Enter decimal odds above 1.00 or American odds ±100+ for your side.');
      return;
    }
    const d = parsed.decimal;
    const res = predictMatchup(a, b, null, { eloField: 'elo' });
    const p = side === 'A' ? res.pBlue : 1 - res.pBlue;
    if (!(p >= 0.05)) {
      setFormError(`Model probability ${fmtPct(p)} is below 5% — excluded from combos.`);
      return;
    }
    const oppParsed = oppOdds.trim() ? parseOddsInput(oppOdds) : null;
    const team = side === 'A' ? a : b;
    const opp = side === 'A' ? b : a;
    pushLeg({
      kind: 'ml',
      matchKey: `${teamA.trim()} vs ${teamB.trim()}`,
      label: `${team} ML`,
      team,
      opponent: opp,
      p,
      book: book.trim() || '—',
      odds: d,
      oppOdds: oppParsed ? oppParsed.decimal : null,
    });
  };

  const addManualTotals = () => {
    if (!teamA.trim() || !teamB.trim()) {
      setFormError('Enter both teams so the leg can be matched to a game.');
      return;
    }
    const parsed = parseOddsInput(odds);
    if (!parsed) {
      setFormError('Enter decimal odds above 1.00 or American odds ±100+.');
      return;
    }
    const d = parsed.decimal;
    const line = parseFloat(totalsLine.replace(',', '.'));
    if (!(line > 0)) {
      setFormError('Enter a valid maps line (e.g. 4.5).');
      return;
    }
    pushLeg({
      kind: 'totals',
      matchKey: `${teamA.trim()} vs ${teamB.trim()}`,
      label: `${totalsDir === 'over' ? 'Over' : 'Under'} ${line} maps`,
      team: teamA.trim(),
      opponent: teamB.trim(),
      p: NaN, // no model probability for totals — structural notes only
      book: book.trim() || '—',
      odds: d,
      oppOdds: null,
      totalsDir,
      totalsLine: line,
    });
  };

  const addOddsLeg = (e: OddsEvent, which: 'home' | 'away') => {
    const { home, away } = bestPrices(e.bookmakers);
    const best = which === 'home' ? home : away;
    if (!best) return;
    const homeModel = mapOddsTeamName(e.homeTeam);
    const awayModel = mapOddsTeamName(e.awayTeam);
    if (!homeModel || !awayModel) return;
    const res = predictMatchup(homeModel, awayModel, null, { eloField: 'elo' });
    const p = which === 'home' ? res.pBlue : 1 - res.pBlue;
    if (!(p >= 0.05)) {
      setFormError(`Model probability ${fmtPct(p)} is below 5% — excluded from combos.`);
      return;
    }
    const bm = e.bookmakers.find((b) => b.key === best.bookKey);
    const oppPrice = which === 'home' ? (bm?.away ?? null) : (bm?.home ?? null);
    const team = which === 'home' ? homeModel : awayModel;
    pushLeg({
      kind: 'ml',
      matchKey: `${e.homeTeam} vs ${e.awayTeam}`,
      label: `${team} ML`,
      team,
      opponent: which === 'home' ? awayModel : homeModel,
      p,
      book: best.bookTitle,
      odds: best.price,
      oppOdds: oppPrice !== null && oppPrice > 1 ? oppPrice : null,
    });
  };

  const twos = useMemo(() => rankParlays(legs, 2), [legs]);
  const threes = useMemo(() => rankParlays(legs, 3), [legs]);
  const notes = useMemo(() => sameMatchNotes(legs), [legs]);

  return (
    <SafeAreaView style={S.screen}>
      <ScrollView contentContainerStyle={S.scroll} keyboardShouldPersistTaps="handled">
        <Text style={S.h1}>Parlay builder</Text>
        <Text style={[S.dim, { marginBottom: 12 }]}>
          Ranked by expected value per $1 staked, net of the books' compounded holds
          (EV = P × D − 1). A parlay is one ticket at one book, so combos only mix legs
          from the same book. Cross-match legs are treated as independent.
        </Text>

        {/* -------- legs from cached odds -------- */}
        {oddsEvents.length > 0 && (
          <View style={S.card}>
            <Text style={S.label}>Add from cached odds</Text>
            <Text style={[S.dim, { marginBottom: 8 }]}>
              Best price per side from your last Odds-tab refresh.
            </Text>
            {oddsEvents.map((e) => (
              <CachedEventRow key={e.id} event={e} onAdd={addOddsLeg} />
            ))}
          </View>
        )}

        {/* -------- manual leg entry -------- */}
        <View style={S.card}>
          <Text style={S.label}>Add leg manually</Text>
          <View style={styles.segRow}>
            {(['ml', 'totals'] as LegKindTab[]).map((k) => (
              <Pressable
                key={k}
                style={[S.chip, kind === k && { backgroundColor: C.blue, borderColor: C.blue }]}
                onPress={() => setKind(k)}
              >
                <Text style={[S.chipText, kind === k && { color: '#06121F' }]}>
                  {k === 'ml' ? 'Moneyline' : 'Totals (maps)'}
                </Text>
              </Pressable>
            ))}
          </View>
          <View style={[S.row, { gap: 8, marginBottom: 8 }]}>
            <TextInput
              style={[S.input, { flex: 1 }]}
              placeholder="Team A"
              placeholderTextColor={C.faint}
              autoCapitalize="none"
              value={teamA}
              onChangeText={setTeamA}
            />
            <TextInput
              style={[S.input, { flex: 1 }]}
              placeholder="Team B"
              placeholderTextColor={C.faint}
              autoCapitalize="none"
              value={teamB}
              onChangeText={setTeamB}
            />
          </View>
          {kind === 'ml' ? (
            <>
              <Text style={S.label}>Betting side</Text>
              <View style={[styles.segRow, { marginBottom: 8 }]}>
                {(['A', 'B'] as const).map((s) => (
                  <Pressable
                    key={s}
                    style={[S.chip, side === s && { backgroundColor: C.blue, borderColor: C.blue }]}
                    onPress={() => setSide(s)}
                  >
                    <Text style={[S.chipText, side === s && { color: '#06121F' }]}>
                      Team {s}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <View style={[S.row, { gap: 8, marginBottom: 8 }]}>
                <TextInput
                  style={[S.input, { flex: 1 }]}
                  placeholder="Book (e.g. Pinnacle)"
                  placeholderTextColor={C.faint}
                  value={book}
                  onChangeText={setBook}
                />
                <TextInput
                  style={[S.input, { flex: 1 }]}
                  placeholder="Your odds (1.85 or -122)"
                  placeholderTextColor={C.faint}
                  keyboardType="numbers-and-punctuation"
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={odds}
                  onChangeText={setOdds}
                />
              </View>
              <TextInput
                style={[S.input, { marginBottom: 10 }]}
                placeholder="Opponent odds, optional (1.85 or -122)"
                placeholderTextColor={C.faint}
                keyboardType="numbers-and-punctuation"
                autoCapitalize="none"
                autoCorrect={false}
                value={oppOdds}
                onChangeText={setOppOdds}
              />
              <Pressable style={S.btn} onPress={addManualML}>
                <Text style={S.btnText}>Add moneyline leg</Text>
              </Pressable>
            </>
          ) : (
            <>
              <View style={[styles.segRow, { marginBottom: 8 }]}>
                {(['over', 'under'] as const).map((d) => (
                  <Pressable
                    key={d}
                    style={[S.chip, totalsDir === d && { backgroundColor: C.blue, borderColor: C.blue }]}
                    onPress={() => setTotalsDir(d)}
                  >
                    <Text style={[S.chipText, totalsDir === d && { color: '#06121F' }]}>
                      {d === 'over' ? 'Over' : 'Under'}
                    </Text>
                  </Pressable>
                ))}
                <TextInput
                  style={[S.input, { flex: 1, marginLeft: 8 }]}
                  placeholder="Line (4.5)"
                  placeholderTextColor={C.faint}
                  keyboardType="decimal-pad"
                  value={totalsLine}
                  onChangeText={setTotalsLine}
                />
              </View>
              <View style={[S.row, { gap: 8, marginBottom: 10 }]}>
                <TextInput
                  style={[S.input, { flex: 1 }]}
                  placeholder="Book"
                  placeholderTextColor={C.faint}
                  value={book}
                  onChangeText={setBook}
                />
                <TextInput
                  style={[S.input, { flex: 1 }]}
                  placeholder="Odds (1.90 or -122)"
                  placeholderTextColor={C.faint}
                  keyboardType="numbers-and-punctuation"
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={odds}
                  onChangeText={setOdds}
                />
              </View>
              <Pressable style={S.btn} onPress={addManualTotals}>
                <Text style={S.btnText}>Add totals leg</Text>
              </Pressable>
              <Text style={[S.faint, { marginTop: 8 }]}>
                Totals legs get structural notes only — the model has no maps-total probability.
              </Text>
            </>
          )}
          {formError && (
            <Text style={[S.body, { color: C.red, marginTop: 8 }]}>{formError}</Text>
          )}
        </View>

        {/* -------- current legs -------- */}
        {legs.length > 0 && (
          <View style={S.card}>
            <Text style={S.label}>Legs ({legs.length})</Text>
            {legs.map((l) => (
              <View key={l.id} style={styles.legRow}>
                <View style={{ flex: 1 }}>
                  <Text style={S.body}>
                    {l.label}
                    <Text style={S.dim}> @ {l.book}</Text>
                  </Text>
                  <Text style={S.dim}>
                    {l.matchKey} · {l.odds.toFixed(2)}
                    {l.kind === 'ml' ? ` · model ${fmtPct(l.p)}` : ' · structural only'}
                  </Text>
                </View>
                <Pressable style={S.chip} onPress={() => removeLeg(l.id)}>
                  <Text style={S.chipText}>✕</Text>
                </Pressable>
              </View>
            ))}
          </View>
        )}

        {/* -------- bankroll -------- */}
        {!(Number.isFinite(ctxBank) && ctxBank > 0) && (
          <View style={S.card}>
            <Text style={S.label}>Bankroll (for Kelly stakes)</Text>
            <TextInput
              style={S.input}
              placeholder="e.g. 100"
              placeholderTextColor={C.faint}
              keyboardType="decimal-pad"
              value={localBank}
              onChangeText={setLocalBank}
            />
            <Text style={[S.faint, { marginTop: 6 }]}>
              Tip: set it once on the Kelly tab and it carries over here.
            </Text>
          </View>
        )}

        {/* -------- ranked combos -------- */}
        <ComboSection title="Top 2-leg parlays" combos={twos} bankroll={bankroll} />
        <ComboSection title="Top 3-leg parlays" combos={threes} bankroll={bankroll} />

        {/* -------- same-match structural notes -------- */}
        {notes.length > 0 && (
          <View style={S.card}>
            <Text style={S.label}>Same-match correlation notes</Text>
            {notes.map((n, i) => (
              <View
                key={i}
                style={[
                  styles.note,
                  n.kind === 'value' && { borderColor: C.green },
                  n.kind === 'avoid' && { borderColor: C.red },
                ]}
              >
                <Text style={[S.body, { fontWeight: '700', marginBottom: 4 }]}>
                  {n.kind === 'value' ? '✓ ' : n.kind === 'avoid' ? '✕ ' : 'ℹ '}
                  {n.title}
                </Text>
                <Text style={S.dim}>{n.text}</Text>
              </View>
            ))}
          </View>
        )}

        <View style={[S.card, { borderColor: C.amber }]}>
          <Text style={[S.body, { color: C.amber, fontWeight: '600', marginBottom: 4 }]}>
            ⚠️ Read this
          </Text>
          <Text style={S.dim}>{PARLAY_CAVEAT}</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function CachedEventRow({
  event: e,
  onAdd,
}: {
  event: OddsEvent;
  onAdd: (e: OddsEvent, side: 'home' | 'away') => void;
}) {
  const { home, away } = bestPrices(e.bookmakers);
  const homeMapped = mapOddsTeamName(e.homeTeam);
  const awayMapped = mapOddsTeamName(e.awayTeam);
  return (
    <View style={styles.cachedRow}>
      <Text style={[S.body, { flex: 1 }]} numberOfLines={1}>
        {e.homeTeam} <Text style={S.faint}>vs</Text> {e.awayTeam}
      </Text>
      <Pressable
        style={[S.chip, { marginRight: 6 }]}
        disabled={!home || !homeMapped}
        onPress={() => onAdd(e, 'home')}
      >
        <Text style={[S.chipText, (!home || !homeMapped) && { color: C.faint }]}>
          {e.homeTeam} {home ? `${home.price.toFixed(2)}` : '–'}
        </Text>
      </Pressable>
      <Pressable style={S.chip} disabled={!away || !awayMapped} onPress={() => onAdd(e, 'away')}>
        <Text style={[S.chipText, (!away || !awayMapped) && { color: C.faint }]}>
          {e.awayTeam} {away ? `${away.price.toFixed(2)}` : '–'}
        </Text>
      </Pressable>
    </View>
  );
}

function ComboSection({
  title,
  combos,
  bankroll,
}: {
  title: string;
  combos: ParlayCombo[];
  bankroll: number | null;
}) {
  if (combos.length === 0) return null;
  return (
    <View style={S.card}>
      <Text style={S.label}>{title}</Text>
      {combos.map((c, i) => {
        const stake =
          c.value && bankroll !== null ? Math.max(0, c.fStar * c.rec.frac) * bankroll : null;
        return (
          <View key={i} style={[styles.combo, c.value && styles.comboValue]}>
            <View style={[S.row, { justifyContent: 'space-between', marginBottom: 4 }]}>
              <Text style={[S.body, { fontWeight: '700', flex: 1 }]} numberOfLines={2}>
                {c.legs.map((l) => l.label).join(' × ')}
              </Text>
              <Text
                style={[
                  styles.badge,
                  { color: c.value ? C.green : C.amber, borderColor: c.value ? C.green : C.amber },
                ]}
              >
                {c.value ? 'VALUE' : 'cover'}
              </Text>
            </View>
            <Text style={S.dim}>
              {c.book} · P {fmtPct(c.P)} · D {c.D.toFixed(2)} · EV{' '}
              <Text style={{ color: c.ev > 0 ? C.green : C.text, fontWeight: '700' }}>
                {c.ev > 0 ? '+' : ''}
                {fmtMoney(c.ev)}
              </Text>{' '}
              per $1 · edge {fmtPct(c.edge)}
            </Text>
            {c.value ? (
              <Text style={S.dim}>
                {c.rec.label} ({(c.rec.frac * 100).toFixed(0)}%)
                {stake !== null ? (
                  <>
                    {' '}→ <Text style={[S.body, { fontWeight: '700' }]}>{fmtMoney(stake)}</Text>
                  </>
                ) : (
                  ' — enter a bankroll for $ stakes'
                )}
              </Text>
            ) : (
              <Text style={S.faint}>
                Negative EV — cover candidate only (camouflage, no Kelly stake).
              </Text>
            )}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  segRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  legRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.border,
  },
  cachedRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },
  combo: {
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.border,
  },
  comboValue: {
    backgroundColor: 'rgba(61,220,132,0.05)',
    marginHorizontal: -14,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  badge: {
    fontSize: 11,
    fontWeight: '800',
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginLeft: 8,
  },
  note: {
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
    backgroundColor: C.card2,
  },
});
