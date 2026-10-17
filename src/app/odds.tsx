import { router } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { ARB_CAVEAT, BookmakerOdds, OddsEvent, bestPrices, clearOddsApiKey, detectArb, fetchOdds, getMyBooks, getOddsApiKey, mapOddsTeamName, mergeOddsEvents, setMyBooks, setOddsApiKey, splitStake } from '../model/odds';
import { clearOddsPapiKey, BOOK_TITLES, fetchOddsPapi, getOddsPapiKey, setOddsPapiKey } from '../model/oddspapi';
import {
  OddsSnapshot,
  appendOddsSnapshots,
  buildSnapshots,
  clearOddsHistory,
  computeArbPairs,
  computeBookStats,
  loadOddsHistory,
} from '../model/oddsHistory';
import { predictMatchup } from '../model/predict';
import { usePrediction } from '../state/PredictionContext';
import { C, S } from '../theme';

/** The user's five books. New installs default to these instead of every fetched book. */
const DEFAULT_MY_BOOKS = ['pinnacle', 'bet365', 'betway', 'betrivers', 'draftkings'];

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
  const { setResult, setKellySide, setOddsText, setPinBlue, setPinRed, setProbMode, calibrationMode, oddsEvents: events, setOddsEvents: setEvents } = usePrediction();
  const [keyReady, setKeyReady] = useState<boolean | null>(null); // null = checking
  const [keyInput, setKeyInput] = useState('');
  const [remaining, setRemaining] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [myBooks, setMyBooksState] = useState<string[] | null>(null); // null = not loaded yet
  const [allBooks, setAllBooks] = useState<{ key: string; title: string }[]>([]);
  const [bookSearch, setBookSearch] = useState('');
  const [history, setHistory] = useState<OddsSnapshot[]>([]);
  const [source, setSource] = useState<'oddsapi' | 'oddspapi' | 'both'>('both');
  const [papiKeyReady, setPapiKeyReady] = useState<boolean | null>(null); // null = checking
  const [papiKeyInput, setPapiKeyInput] = useState('');
  const [papiUsed, setPapiUsed] = useState<number | null>(null);
  const [partialError, setPartialError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const [k, b, pk, h] = await Promise.all([
        getOddsApiKey(),
        getMyBooks(),
        getOddsPapiKey(),
        loadOddsHistory(),
      ]);
      setKeyReady(!!k);
      if (b === null) {
        setMyBooksState(DEFAULT_MY_BOOKS);
        await setMyBooks(DEFAULT_MY_BOOKS);
      } else {
        setMyBooksState(b);
      }
      setPapiKeyReady(!!pk);
      setHistory(h);
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
  }, [setEvents]);

  const savePapiKey = useCallback(async () => {
    const k = papiKeyInput.trim();
    if (!k) return;
    await setOddsPapiKey(k);
    setPapiKeyInput('');
    setPapiKeyReady(true);
    setError(null);
  }, [papiKeyInput]);

  const removePapiKey = useCallback(async () => {
    await clearOddsPapiKey();
    setPapiKeyReady(false);
    setEvents([]);
    setPapiUsed(null);
  }, [setEvents]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    setPartialError(null);
    try {
      const wantOddsApi = source !== 'oddspapi';
      const wantPapi = source !== 'oddsapi';
      const [oddsKey, papiKey] = await Promise.all([getOddsApiKey(), getOddsPapiKey()]);
      const lists: OddsEvent[][] = [];
      const problems: string[] = [];
      let papiEvents: OddsEvent[] | null = null;
      if (wantOddsApi) {
        if (!oddsKey) {
          setKeyReady(false);
          problems.push('The Odds API: no key saved.');
        } else {
          try {
            const { events: evts, remaining: rem } = await fetchOdds(oddsKey);
            lists.push(evts);
            setRemaining(rem);
          } catch (e: any) {
            problems.push(`The Odds API: ${e?.message ?? 'fetch failed.'}`);
          }
        }
      }
      if (wantPapi) {
        if (!papiKey) {
          setPapiKeyReady(false);
          problems.push('OddsPapi: no key saved.');
        } else {
          try {
            const { events: evts, requestsUsed } = await fetchOddsPapi(papiKey);
            lists.push(evts);
            papiEvents = evts;
            setPapiUsed(requestsUsed);
          } catch (e: any) {
            problems.push(`OddsPapi: ${e?.message ?? 'fetch failed.'}`);
          }
        }
      }
      if (lists.length === 0) {
        setEvents([]);
        setError(problems.join(' ') || 'No API key saved.');
        return;
      }
      const merged = lists.length === 1 ? lists[0] : mergeOddsEvents(lists[0], lists[1]);
      setEvents(merged);
      if (problems.length > 0) setPartialError(problems.join(' '));
      const seen = new Map<string, string>();
      for (const e of merged) for (const b of e.bookmakers) seen.set(b.key, b.title);
      setAllBooks([...seen.entries()].map(([key, title]) => ({ key, title })));
      // Persist this OddsPapi pull: your books' prices + best legs per match.
      if (papiEvents) {
        const savedBooks = await getMyBooks();
        const snaps = buildSnapshots(papiEvents, new Set(savedBooks ?? DEFAULT_MY_BOOKS));
        if (snaps.length > 0) {
          const h = await appendOddsSnapshots(snaps);
          setHistory(h);
        }
      }
    } catch (e: any) {
      setError(e?.message ?? 'Failed to fetch odds.');
    } finally {
      setLoading(false);
    }
  }, [source, setEvents]);

  const toggleBook = useCallback(
    async (key: string) => {
      const current = myBooks ?? DEFAULT_MY_BOOKS;
      const next = current.includes(key) ? current.filter((k) => k !== key) : [...current, key];
      setMyBooksState(next);
      await setMyBooks(next);
    },
    [myBooks],
  );

  const resetBooks = useCallback(async () => {
    setMyBooksState(DEFAULT_MY_BOOKS);
    await setMyBooks(DEFAULT_MY_BOOKS);
  }, []);

  const activeBooks = useMemo(() => new Set(myBooks ?? DEFAULT_MY_BOOKS), [myBooks]);

  const pinnedOrder = useMemo(() => myBooks ?? DEFAULT_MY_BOOKS, [myBooks]);

  const titleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const [k, t] of Object.entries(BOOK_TITLES)) map.set(k, t);
    for (const b of allBooks) map.set(b.key, b.title);
    return map;
  }, [allBooks]);

  const bookCandidates = useMemo(() => {
    const q = bookSearch.trim().toLowerCase();
    if (!q) return [];
    const selected = new Set(myBooks ?? DEFAULT_MY_BOOKS);
    return [...titleMap.entries()]
      .filter(([key, title]) => !selected.has(key) && (title.toLowerCase().includes(q) || key.includes(q)))
      .slice(0, 6)
      .map(([key, title]) => ({ key, title }));
  }, [bookSearch, myBooks, titleMap]);

  const bookStats = useMemo(() => computeBookStats(history), [history]);

  const arbPairs = useMemo(
    () => computeArbPairs(history).filter((p) => p.arbCount > 0).slice(0, 5),
    [history],
  );

  const clearHistory = useCallback(async () => {
    await clearOddsHistory();
    setHistory([]);
  }, []);

  const toKelly = useCallback(
    (e: OddsEvent, side: 'home' | 'away', price: number) => {
      const homeModel = mapOddsTeamName(e.homeTeam);
      const awayModel = mapOddsTeamName(e.awayTeam);
      if (!homeModel || !awayModel) return;
      const result = predictMatchup(homeModel, awayModel, null, { eloField: 'elo', calibration: calibrationMode });
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
    [setResult, setKellySide, setOddsText, setPinBlue, setPinRed, setProbMode, calibrationMode],
  );

  if (keyReady === null || papiKeyReady === null) {
    return (
      <SafeAreaView style={S.screen}>
        <View style={[S.screen, { justifyContent: 'center', alignItems: 'center' }]}>
          <Text style={S.dim}>Loading…</Text>
        </View>
      </SafeAreaView>
    );
  }

  const canRefresh =
    source === 'oddsapi' ? keyReady : source === 'oddspapi' ? papiKeyReady : keyReady || papiKeyReady;

  return (
    <SafeAreaView style={S.screen}>
      <ScrollView contentContainerStyle={S.scroll} keyboardShouldPersistTaps="handled">
        <Text style={S.h1}>Sportsbook odds</Text>
        <Text style={[S.dim, { marginBottom: 12 }]}>
          Live moneyline odds for League of Legends, merged across The Odds API and OddsPapi.
          Refresh is manual — each tap costs requests from your monthly quotas.
        </Text>

        {/* -------- source -------- */}
        <View style={S.card}>
          <Text style={S.label}>Sources</Text>
          <View style={[S.row, { gap: 8 }]}>
            {(
              [
                ['oddsapi', 'The Odds API'],
                ['oddspapi', 'OddsPapi'],
                ['both', 'Both (merged)'],
              ] as const
            ).map(([value, label]) => (
              <Pressable
                key={value}
                style={[S.chip, source === value && { backgroundColor: C.blue, borderColor: C.blue }]}
                onPress={() => setSource(value)}
              >
                <Text style={[S.chipText, source === value && { color: '#06121F' }]}>{label}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={[S.faint, { marginTop: 8 }]}>
            Both merges the two feeds per match. Neither lists LoL Play-In odds right now; the
            union is what covers you when one of them starts.
          </Text>
        </View>

        {/* -------- settings -------- */}
        <View style={S.card}>
          <Text style={S.label}>The Odds API key</Text>
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

        <View style={S.card}>
          <Text style={S.label}>OddsPapi key</Text>
          {papiKeyReady ? (
            <View style={[S.row, { justifyContent: 'space-between' }]}>
              <Text style={[S.body, { color: C.green }]}>● Key saved</Text>
              <Pressable style={S.chip} onPress={() => void removePapiKey()}>
                <Text style={S.chipText}>Remove key</Text>
              </Pressable>
            </View>
          ) : (
            <>
              <Text style={[S.dim, { marginBottom: 8 }]}>
                Free signup at oddspapi.io — paste your key below. It&apos;s stored in the
                device keychain, never uploaded anywhere.
              </Text>
              <TextInput
                style={[S.input, { marginBottom: 10 }]}
                placeholder="Paste API key"
                placeholderTextColor={C.faint}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                value={papiKeyInput}
                onChangeText={setPapiKeyInput}
              />
              <Pressable style={S.btn} onPress={() => void savePapiKey()}>
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

        {partialError && !error && (
          <View style={[S.card, { borderColor: C.amber }]}>
            <Text style={[S.body, { color: C.amber }]}>Partial results — {partialError}</Text>
          </View>
        )}

        {canRefresh && (
          <>
            <Pressable style={[S.btn, { marginBottom: 8 }]} onPress={() => void refresh()} disabled={loading}>
              <Text style={S.btnText}>{loading ? 'Fetching…' : 'Refresh odds'}</Text>
            </Pressable>
            {(remaining !== null || papiUsed !== null) && (
              <Text style={[S.faint, { marginBottom: 12 }]}>
                {remaining !== null ? `The Odds API: ${remaining} / 500 left` : ''}
                {remaining !== null && papiUsed !== null ? ' · ' : ''}
                {papiUsed !== null ? `OddsPapi: ${papiUsed} request${papiUsed === 1 ? '' : 's'} used this refresh` : ''}
              </Text>
            )}

            <View style={S.card}>
              <View style={[S.row, { justifyContent: 'space-between', marginBottom: 8 }]}>
                <Text style={S.label}>Pinned books</Text>
                <Pressable onPress={() => void resetBooks()}>
                  <Text style={[S.dim, { textDecorationLine: 'underline' }]}>Reset to my 5</Text>
                </Pressable>
              </View>
              <View style={styles.chips}>
                {(myBooks ?? DEFAULT_MY_BOOKS).map((key) => (
                  <Pressable
                    key={key}
                    style={[S.chip, { backgroundColor: C.blue, borderColor: C.blue }]}
                    onPress={() => void toggleBook(key)}
                  >
                    <Text style={[S.chipText, { color: '#06121F' }]}>{titleMap.get(key) ?? key} ×</Text>
                  </Pressable>
                ))}
              </View>
              <TextInput
                style={[S.input, { marginTop: 10 }]}
                placeholder="Pin a book — search by name"
                placeholderTextColor={C.faint}
                autoCapitalize="none"
                autoCorrect={false}
                value={bookSearch}
                onChangeText={setBookSearch}
              />
              {bookCandidates.length > 0 && (
                <View style={[styles.chips, { marginTop: 8 }]}>
                  {bookCandidates.map((b) => (
                    <Pressable
                      key={b.key}
                      style={S.chip}
                      onPress={() => {
                        void toggleBook(b.key);
                        setBookSearch('');
                      }}
                    >
                      <Text style={S.chipText}>+ {b.title}</Text>
                    </Pressable>
                  ))}
                </View>
              )}
              <Text style={[S.faint, { marginTop: 8 }]}>
                Your pinned books sit at the top of every match card, above all other books. Tap a
                pinned book to unpin it.
              </Text>
            </View>

            {history.length > 0 && (
              <View style={S.card}>
                <View style={[S.row, { justifyContent: 'space-between', marginBottom: 8 }]}>
                  <Text style={S.label}>Saved pulls</Text>
                  <Pressable onPress={() => void clearHistory()}>
                    <Text style={[S.dim, { textDecorationLine: 'underline' }]}>Clear history</Text>
                  </Pressable>
                </View>
                <Text style={[S.dim, { marginBottom: 8 }]}>
                  {history.length} OddsPapi snapshots saved. Lowest margin = tightest spread.
                </Text>
                {bookStats.slice(0, 8).map((s) => (
                  <View key={s.key} style={[S.row, { justifyContent: 'space-between', paddingVertical: 3 }]}>
                    <Text style={S.body}>{s.title}</Text>
                    <Text style={S.dim}>
                      avg margin {(s.avgMargin * 100).toFixed(1)}% · n={s.n}
                    </Text>
                  </View>
                ))}
                <Text style={[S.label, { marginTop: 12 }]}>Top arb pairs</Text>
                {arbPairs.length === 0 ? (
                  <Text style={S.dim}>No cross-book arbs in saved pulls yet.</Text>
                ) : (
                  arbPairs.map((p) => (
                    <View
                      key={`${p.bookA}|${p.bookB}`}
                      style={[S.row, { justifyContent: 'space-between', paddingVertical: 3 }]}
                    >
                      <Text style={S.body}>
                        {p.titleA} × {p.titleB}
                      </Text>
                      <Text style={S.dim}>
                        {p.arbCount} arbs · best +{(p.bestArbPct * 100).toFixed(1)}%
                      </Text>
                    </View>
                  ))
                )}
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
                pinnedBooks={activeBooks}
                pinnedOrder={pinnedOrder}
                showSource={source === 'both'}
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
  pinnedBooks,
  pinnedOrder,
  showSource,
  onPick,
}: {
  event: OddsEvent;
  pinnedBooks: Set<string>;
  pinnedOrder: string[];
  showSource: boolean;
  onPick: (side: 'home' | 'away', price: number) => void;
}) {
  // Every book shows. Pinned books (yours) sit on top, in your order; the
  // rest follow in feed order. Best-price + arb math run over ALL books.
  const pinned = pinnedOrder
    .map((key) => e.bookmakers.find((b) => b.key === key))
    .filter((b): b is BookmakerOdds => b !== undefined);
  const rest = e.bookmakers.filter((b) => !pinnedBooks.has(b.key));
  const homeMapped = mapOddsTeamName(e.homeTeam);
  const awayMapped = mapOddsTeamName(e.awayTeam);
  const kellyOk = !!homeMapped && !!awayMapped;
  const [showArb, setShowArb] = useState(false);
  const [stakeText, setStakeText] = useState('100');

  const { home: bestHomeLeg, away: bestAwayLeg } = useMemo(() => bestPrices(e.bookmakers), [e.bookmakers]);
  const arb = useMemo(() => detectArb(e.bookmakers), [e.bookmakers]);
  const bestHome = bestHomeLeg?.price ?? 0;
  const bestAway = bestAwayLeg?.price ?? 0;
  const total = parseFloat(stakeText.replace(',', '.'));
  const split =
    arb && Number.isFinite(total) && total > 0
      ? splitStake(total, arb.home.price, arb.away.price)
      : null;

  const renderRow = (b: BookmakerOdds, pinnedRow: boolean) => (
    <View key={b.key} style={[styles.row, pinnedRow && styles.pinnedRow]}>
      <Text style={[S.body, { flex: 1.4, fontSize: 13 }]} numberOfLines={1}>
        {b.title}
        {showSource && b.source ? ` · ${b.source === 'oddspapi' ? 'OddsPapi' : 'Odds API'}` : ''}
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
  );

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
      {e.bookmakers.length === 0 ? (
        <Text style={S.dim}>No odds posted yet for this match.</Text>
      ) : (
        <>
          <View style={styles.head}>
            <Text style={[styles.headCell, { flex: 1.4 }]}>Book</Text>
            <Text style={styles.headCell}>{e.homeTeam}</Text>
            <Text style={styles.headCell}>{e.awayTeam}</Text>
          </View>
          {pinned.map((b) => renderRow(b, true))}
          {pinned.length > 0 && rest.length > 0 && (
            <Text style={[S.faint, { marginTop: 10, marginBottom: 2 }]}>All books ({rest.length})</Text>
          )}
          {rest.map((b) => renderRow(b, false))}
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
  pinnedRow: {
    borderLeftWidth: 3,
    borderLeftColor: '#4DA3FF',
    paddingLeft: 8,
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
