import { router } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { ARB_CAVEAT, OddsEvent, bestPrices, clearOddsApiKey, detectArb, fetchOdds, getMyBooks, getOddsApiKey, mapOddsTeamName, setMyBooks, setOddsApiKey, splitStake } from '../model/odds';
import { predictMatchup } from '../model/predict';
import { usePrediction } from '../state/PredictionContext';
import { C, S } from '../theme';

function fmtTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

export default function OddsScreen() {
  const { setResult, setKellySide, setOddsText, setPinBlue, setPinRed, setProbMode, oddsEvents: events, setOddsEvents: setEvents } = usePrediction();
  const [keyReady, setKeyReady] = useState<boolean | null>(null); // null = checking
  const [keyInput, setKeyInput] = useState('');
  const [remaining, setRemaining] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [myBooks, setMyBooksState] = useState<string[] | null>(null); // null = all
  const [allBooks, setAllBooks] = useState<{ key: string; title: string }[]>([]);

  useEffect(() => {
    (async () => {
      const [k, b] = await Promise.all([getOddsApiKey(), getMyBooks()]);
      setKeyReady(!!k);
      setMyBooksState(b);
    })();
  }, []);

  const saveKey = useCallback(async () => {
    const k = keyInput.trim();
    if (!k) return;
    await setOddsApiKey(k);
    setKeyInput('');
    setKeyReady(true);
    setError(null);
  }, [keyInput]);

  const removeKey = useCallback(async () => {
    await clearOddsApiKey();
    setKeyReady(false);
    setEvents([]);
    setRemaining(null);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const key = await getOddsApiKey();
      if (!key) {
        setKeyReady(false);
        setError('No API key saved.');
        return;
      }
      const { events: evts, remaining: rem } = await fetchOdds(key);
      setEvents(evts);
      setRemaining(rem);
      const seen = new Map<string, string>();
      for (const e of evts) for (const b of e.bookmakers) seen.set(b.key, b.title);
      setAllBooks([...seen.entries()].map(([key, title]) => ({ key, title })));
    } catch (e: any) {
      setError(e?.message ?? 'Failed to fetch odds.');
    } finally {
      setLoading(false);
    }
  }, []);

  const toggleBook = useCallback(
    async (key: string) => {
      const current = myBooks ?? allBooks.map((b) => b.key);
      const next = current.includes(key) ? current.filter((k) => k !== key) : [...current, key];
      setMyBooksState(next);
      await setMyBooks(next);
    },
    [myBooks, allBooks],
  );

  const resetBooks = useCallback(async () => {
    setMyBooksState(null);
    await setMyBooks(allBooks.map((b) => b.key));
  }, [allBooks]);

  const activeBooks = useMemo(() => new Set(myBooks ?? allBooks.map((b) => b.key)), [myBooks, allBooks]);

  const toKelly = useCallback(
    (e: OddsEvent, side: 'home' | 'away', price: number) => {
      const homeModel = mapOddsTeamName(e.homeTeam);
      const awayModel = mapOddsTeamName(e.awayTeam);
      if (!homeModel || !awayModel) return;
      const result = predictMatchup(homeModel, awayModel, null, { eloField: 'elo' });
      setResult(result);
      // Odds-tab Match markets are series bets, so Kelly uses the series prob.
      setProbMode('series');
      // Pinnacle's prices for the tapped side feed the smart-money agreement check.
      const pin = e.bookmakers.find((b) => b.key === 'pinnacle');
      setPinBlue(pin && pin.home !== null ? pin.home : null);
      setPinRed(pin && pin.away !== null ? pin.away : null);
      setKellySide(side === 'home' ? 'blue' : 'red');
      setOddsText(price.toFixed(2));
      router.push('/kelly');
    },
    [setResult, setKellySide, setOddsText, setPinBlue, setPinRed, setProbMode],
  );

  if (keyReady === null) {
    return (
      <SafeAreaView style={S.screen}>
        <View style={[S.screen, { justifyContent: 'center', alignItems: 'center' }]}>
          <Text style={S.dim}>Loading…</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={S.screen}>
      <ScrollView contentContainerStyle={S.scroll} keyboardShouldPersistTaps="handled">
        <Text style={S.h1}>Sportsbook odds</Text>
        <Text style={[S.dim, { marginBottom: 12 }]}>
          Live moneyline odds for League of Legends via The Odds API. Refresh is manual —
          each tap costs one request from your monthly quota.
        </Text>

        {/* -------- settings -------- */}
        <View style={S.card}>
          <Text style={S.label}>API key</Text>
          {keyReady ? (
            <View style={[S.row, { justifyContent: 'space-between' }]}>
              <Text style={[S.body, { color: C.green }]}>● Key saved</Text>
              <Pressable style={S.chip} onPress={() => void removeKey()}>
                <Text style={S.chipText}>Remove key</Text>
              </Pressable>
            </View>
          ) : (
            <>
              <Text style={[S.dim, { marginBottom: 8 }]}>
                Free signup at the-odds-api.com — paste your key below. It&apos;s stored in the
                device keychain, never uploaded anywhere.
              </Text>
              <TextInput
                style={[S.input, { marginBottom: 10 }]}
                placeholder="Paste API key"
                placeholderTextColor={C.faint}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                value={keyInput}
                onChangeText={setKeyInput}
              />
              <Pressable style={S.btn} onPress={() => void saveKey()}>
                <Text style={S.btnText}>Save key</Text>
              </Pressable>
            </>
          )}
        </View>

        {error && (
          <View style={[S.card, { borderColor: C.red }]}>
            <Text style={[S.body, { color: C.red }]}>{error}</Text>
          </View>
        )}

        {keyReady && (
          <>
            <Pressable style={[S.btn, { marginBottom: 8 }]} onPress={() => void refresh()} disabled={loading}>
              <Text style={S.btnText}>{loading ? 'Fetching…' : 'Refresh odds'}</Text>
            </Pressable>
            {remaining !== null && (
              <Text style={[S.faint, { marginBottom: 12 }]}>
                Quota remaining this month: {remaining} / 500
              </Text>
            )}

            {allBooks.length > 0 && (
              <View style={S.card}>
                <View style={[S.row, { justifyContent: 'space-between', marginBottom: 8 }]}>
                  <Text style={S.label}>My books</Text>
                  <Pressable onPress={() => void resetBooks()}>
                    <Text style={[S.dim, { textDecorationLine: 'underline' }]}>Select all</Text>
                  </Pressable>
                </View>
                <View style={styles.chips}>
                  {allBooks.map((b) => {
                    const on = activeBooks.has(b.key);
                    return (
                      <Pressable
                        key={b.key}
                        style={[S.chip, on && { backgroundColor: C.blue, borderColor: C.blue }]}
                        onPress={() => void toggleBook(b.key)}
                      >
                        <Text style={[S.chipText, on && { color: '#06121F' }]}>{b.title}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            )}

            {!loading && events.length === 0 && !error && (
              <View style={S.card}>
                <Text style={S.body}>No odds fetched yet.</Text>
                <Text style={S.dim}>Hit &quot;Refresh odds&quot; to pull the latest prices.</Text>
              </View>
            )}

            {events.map((e) => (
              <MatchCard
                key={e.id}
                event={e}
                activeBooks={activeBooks}
                onPick={(side, price) => toKelly(e, side, price)}
              />
            ))}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function MatchCard({
  event: e,
  activeBooks,
  onPick,
}: {
  event: OddsEvent;
  activeBooks: Set<string>;
  onPick: (side: 'home' | 'away', price: number) => void;
}) {
  const books = e.bookmakers.filter((b) => activeBooks.has(b.key));
  const homeMapped = mapOddsTeamName(e.homeTeam);
  const awayMapped = mapOddsTeamName(e.awayTeam);
  const kellyOk = !!homeMapped && !!awayMapped;
  const [showArb, setShowArb] = useState(false);
  const [stakeText, setStakeText] = useState('100');

  const { home: bestHomeLeg, away: bestAwayLeg } = useMemo(() => bestPrices(books), [books]);
  const arb = useMemo(() => detectArb(books), [books]);
  const bestHome = bestHomeLeg?.price ?? 0;
  const bestAway = bestAwayLeg?.price ?? 0;
  const total = parseFloat(stakeText.replace(',', '.'));
  const split =
    arb && Number.isFinite(total) && total > 0
      ? splitStake(total, arb.home.price, arb.away.price)
      : null;

  return (
    <View style={S.card}>
      <Text style={S.label}>{fmtTime(e.commenceTime)}</Text>
      <View style={[S.row, { justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }]}>
        <Text style={[S.h2, { marginBottom: 0, flex: 1 }]}>
          {e.homeTeam} <Text style={S.faint}>vs</Text> {e.awayTeam}
        </Text>
        {arb && (
          <Pressable style={styles.arbBadge} onPress={() => setShowArb((s) => !s)}>
            <Text style={styles.arbBadgeText}>
              ARB +{(arb.profitPct * 100).toFixed(1)}%
            </Text>
          </Pressable>
        )}
      </View>
      {books.length === 0 ? (
        <Text style={S.dim}>No odds posted yet for your selected books.</Text>
      ) : (
        <>
          <View style={styles.head}>
            <Text style={[styles.headCell, { flex: 1.4 }]}>Book</Text>
            <Text style={styles.headCell}>{e.homeTeam}</Text>
            <Text style={styles.headCell}>{e.awayTeam}</Text>
          </View>
          {books.map((b) => (
            <View key={b.key} style={styles.row}>
              <Text style={[S.body, { flex: 1.4, fontSize: 13 }]} numberOfLines={1}>
                {b.title}
              </Text>
              <OddsCell
                price={b.home}
                best={b.home !== null && b.home >= bestHome && bestHome > 0}
                enabled={kellyOk}
                onPress={() => b.home !== null && onPick('home', b.home)}
              />
              <OddsCell
                price={b.away}
                best={b.away !== null && b.away >= bestAway && bestAway > 0}
                enabled={kellyOk}
                onPress={() => b.away !== null && onPick('away', b.away)}
              />
            </View>
          ))}
          <Text style={[S.faint, { marginTop: 8 }]}>
            Green = best price for that side. Tap a price to size it in Kelly.
          </Text>
        </>
      )}
      {arb && showArb && (
        <View style={styles.arbPanel}>
          <Text style={[S.h2, { color: C.green }]}>
            Arbitrage — guaranteed +{(arb.profitPct * 100).toFixed(2)}%
          </Text>
          <View style={styles.arbRow}>
            <View style={{ flex: 1 }}>
              <Text style={[S.body, { fontWeight: '700' }]}>{e.homeTeam}</Text>
              <Text style={S.dim}>
                {arb.home.price.toFixed(2)} @ {arb.home.bookTitle}
              </Text>
            </View>
            <View style={{ flex: 1, alignItems: 'flex-end' }}>
              <Text style={[S.body, { fontWeight: '700' }]}>{e.awayTeam}</Text>
              <Text style={S.dim}>
                {arb.away.price.toFixed(2)} @ {arb.away.bookTitle}
              </Text>
            </View>
          </View>
          <Text style={[S.dim, { marginBottom: 8 }]}>
            Place the {e.homeTeam} leg at {arb.home.bookTitle} and the {e.awayTeam} leg at{' '}
            {arb.away.bookTitle}.
          </Text>
          <Text style={S.label}>Total stake</Text>
          <TextInput
            style={[S.input, { marginBottom: 10 }]}
            placeholder="e.g. 100"
            placeholderTextColor={C.faint}
            keyboardType="decimal-pad"
            value={stakeText}
            onChangeText={setStakeText}
          />
          {split ? (
            <>
              <View style={[S.row, { justifyContent: 'space-between', marginBottom: 4 }]}>
                <Text style={S.body}>
                  ${split.stakeA.toFixed(2)} on {e.homeTeam}
                </Text>
                <Text style={S.dim}>{arb.home.bookTitle}</Text>
              </View>
              <View style={[S.row, { justifyContent: 'space-between', marginBottom: 8 }]}>
                <Text style={S.body}>
                  ${split.stakeB.toFixed(2)} on {e.awayTeam}
                </Text>
                <Text style={S.dim}>{arb.away.bookTitle}</Text>
              </View>
              <Text style={[S.body, { color: C.green, fontWeight: '700' }]}>
                Guaranteed return: ${(total * (1 + arb.profitPct)).toFixed(2)} (+
                {(arb.profitPct * 100).toFixed(2)}%)
              </Text>
            </>
          ) : (
            <Text style={S.dim}>Enter a total stake above 0 to split it.</Text>
          )}
          <Text style={[S.faint, { marginTop: 8 }]}>⚠️ {ARB_CAVEAT}</Text>
        </View>
      )}
      {!kellyOk && (
        <Text style={[S.dim, { marginTop: 8, color: C.amber }]}>
          ⚠️ {!homeMapped ? e.homeTeam : e.awayTeam} isn&apos;t in the model — odds shown only,
          Kelly handoff disabled.
        </Text>
      )}
    </View>
  );
}

function OddsCell({
  price,
  best,
  enabled,
  onPress,
}: {
  price: number | null;
  best: boolean;
  enabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={[styles.cell, best && styles.cellBest]}
      onPress={onPress}
      disabled={!enabled || price === null}
    >
      <Text style={[styles.cellText, best && { color: C.green }, !enabled && { color: C.faint }]}>
        {price !== null ? price.toFixed(2) : '–'}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  head: { flexDirection: 'row', marginTop: 8, marginBottom: 4 },
  headCell: { flex: 1, color: '#5E6B8C', fontSize: 11, fontWeight: '700', textAlign: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#26304A',
  },
  cell: {
    flex: 1,
    marginHorizontal: 4,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#1B2233',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#26304A',
  },
  cellBest: { borderColor: '#3DDC84' },
  cellText: { color: '#F2F5FA', fontSize: 15, fontWeight: '700' },
  arbBadge: {
    backgroundColor: 'rgba(61,220,132,0.15)',
    borderWidth: 1,
    borderColor: '#3DDC84',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  arbBadgeText: { color: '#3DDC84', fontSize: 13, fontWeight: '800' },
  arbPanel: {
    marginTop: 12,
    padding: 12,
    borderRadius: 10,
    backgroundColor: 'rgba(61,220,132,0.06)',
    borderWidth: 1,
    borderColor: '#3DDC84',
  },
  arbRow: { flexDirection: 'row', marginBottom: 8 },
});
