import { router } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Image, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { ARB_ALERT_BAR, ARB_CAVEAT, BookmakerOdds, OddsEvent, arbFromBestLegs, bestPrices, clearOddsApiKey, detectArb, fetchOdds, getMyBooks, getOddsApiKey, mapOddsTeamName, mergeOddsEvents, setMyBooks, setOddsApiKey, splitStake } from '../model/odds';
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
import { fmtMoney, fmtPct, parseOddsInput } from '../model/kelly';
import { predictMatchup } from '../model/predict';
import { ocrImageToText } from '../model/screenshotOcr';
import {
  formatAmerican,
  mapScreenshotTeam,
  parseRowOdds,
  parseScreenshotOdds,
  verdictsForGames,
  type ScreenshotGame,
} from '../model/screenshotOdds';
import type { CalibrationMode } from '../model/types';
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

/** Absolute pull timestamp, always America/Toronto: "Fri, Oct 17, 1:32 PM EDT". */
function fmtPullTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', {
    timeZone: 'America/Toronto',
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
}

/** Relative age: "just now" / "32 min ago" / "3 hr 12 min ago" / "2 days ago". */
function relativeAge(iso: string, now: number): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diffMs = now - t;
  if (diffMs < 0) return 'just now';
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) {
    const rem = mins % 60;
    return rem === 0 ? `${hrs} hr ago` : `${hrs} hr ${rem} min ago`;
  }
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * The most recent saved pull: all snapshots sharing the latest ts. One pull
 * writes one snapshot per event with a single shared ts (see buildSnapshots),
 * so grouping by ts recovers exactly that pull's rows.
 */
function lastPullSnapshots(history: OddsSnapshot[]): OddsSnapshot[] | null {
  if (history.length === 0) return null;
  let latest = history[0].ts;
  for (const s of history) if (s.ts > latest) latest = s.ts;
  return history.filter((s) => s.ts === latest);
}

export default function OddsScreen() {
  const { setResult, setKellySide, setOddsText, setPinBlue, setPinRed, setProbMode, calibrationMode, bankrollText, oddsEvents: events, setOddsEvents: setEvents } = usePrediction();
  const [keyReady, setKeyReady] = useState<boolean | null>(null); // null = checking
  const [keyInput, setKeyInput] = useState('');
  const [remaining, setRemaining] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [myBooks, setMyBooksState] = useState<string[] | null>(null); // null = not loaded yet
  const [allBooks, setAllBooks] = useState<{ key: string; title: string }[]>([]);
  const [bookSearch, setBookSearch] = useState('');
  const [history, setHistory] = useState<OddsSnapshot[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [now, setNow] = useState(() => Date.now()); // ticks every 60s so the relative age stays fresh
  const [source, setSource] = useState<'oddsapi' | 'oddspapi' | 'both'>('both');
  const [papiKeyReady, setPapiKeyReady] = useState<boolean | null>(null); // null = checking
  const [papiKeyInput, setPapiKeyInput] = useState('');
  const [papiUsed, setPapiUsed] = useState<number | null>(null);
  const [partialError, setPartialError] = useState<string | null>(null);
  // Prefill for the arb calculator, set by tapping an arb row in the saved-pull banner.
  // The calculator remounts (fresh inputs from the prefill) on each tap via arbCalcKey.
  const [arbPrefill, setArbPrefill] = useState<ArbPrefill | null>(null);
  const [arbCalcKey, setArbCalcKey] = useState(0);
  const handleArbSelect = useCallback((p: ArbPrefill) => {
    setArbPrefill(p);
    setArbCalcKey((k) => k + 1);
  }, []);

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
      setHistoryLoaded(true);
    })();
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(id);
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

  // Saved snapshots store best-leg book keys only (no titles) — resolve via
  // the book catalog, falling back to the raw key when unknown.
  const titleOf = useCallback((key: string) => titleMap.get(key) ?? key, [titleMap]);

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

  const lastPull = useMemo(() => lastPullSnapshots(history), [history]);

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

        {/* -------- last saved pull: prominent, always visible -------- */}
        <LastPullBanner
          snapshots={lastPull}
          now={now}
          loaded={historyLoaded}
          titleOf={titleOf}
          onArbSelect={handleArbSelect}
        />

        {/* -------- screenshot odds: OCR a book board -> verdicts per game -------- */}
        <ScreenshotOddsSection calibrationMode={calibrationMode} bankrollText={bankrollText} />

        {/* -------- arb calculator: planning tool, manual inputs -------- */}
        <ArbCalculator key={arbCalcKey} prefill={arbPrefill} />

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

/* ------------------------------------------------------------------ */
/* Screenshot odds: pick a book-odds screenshot, OCR it on web, parse  */
/* the board into games, and price each game against the model.      */
/* Every parsed row stays editable — OCR misreads team names and      */
/* digits, so a verdict is only as good as the row you checked.      */
/* ------------------------------------------------------------------ */

function ScreenshotOddsSection({
  calibrationMode,
  bankrollText,
}: {
  calibrationMode: CalibrationMode;
  bankrollText: string;
}) {
  const [book, setBook] = useState('');
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [ocrText, setOcrText] = useState('');
  const [games, setGames] = useState<ScreenshotGame[]>([]);
  const [ocrRunning, setOcrRunning] = useState(false);
  const [shotError, setShotError] = useState<string | null>(null);
  const [localBank, setLocalBank] = useState('');

  const ctxBank = parseFloat(bankrollText.replace(',', '.'));
  const localN = parseFloat(localBank.replace(',', '.'));
  const bankroll =
    Number.isFinite(ctxBank) && ctxBank > 0
      ? ctxBank
      : Number.isFinite(localN) && localN > 0
        ? localN
        : null;

  const verdicts = useMemo(
    () => verdictsForGames(games, calibrationMode),
    [games, calibrationMode],
  );

  const pickAndRead = async (source: 'library' | 'camera') => {
    setShotError(null);
    try {
      // On web, launchCameraAsync maps to a file input with
      // capture="camera" — on a phone that opens the camera directly,
      // on desktop it asks for the webcam. Library opens the file
      // picker, which on iOS offers Photo Library / Take Photo / Files.
      const res =
        source === 'camera'
          ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1 })
          : await ImagePicker.launchImageLibraryAsync({
              mediaTypes: ['images'],
              base64: true,
              quality: 1,
            });
      if (res.canceled || !res.assets?.[0]) return;
      const asset = res.assets[0];
      setImageUri(asset.uri);
      if (Platform.OS !== 'web') {
        setShotError(
          'OCR runs on the web version only — open this site in your phone browser (not the Expo app) and pick the screenshot there. On the phone app, paste the odds text below (or add games by hand) and it still parses and prices them.',
        );
        return;
      }
      // On web, prefer the picker's blob URL over base64: a phone photo
      // as base64 is a second multi-megabyte copy, and the OCR step
      // loads a blob URL into a canvas just as well.
      const input =
        asset.uri ??
        (asset.base64
          ? `data:${asset.mimeType ?? 'image/png'};base64,${asset.base64}`
          : null);
      if (!input) {
        setShotError('Could not read that image — paste the odds text below instead.');
        return;
      }
      setOcrRunning(true);
      try {
        const text = await ocrImageToText(input);
        setOcrText(text);
        setGames(parseScreenshotOdds(text, book));
      } finally {
        setOcrRunning(false);
      }
    } catch (e: any) {
      setShotError(e?.message ?? 'Screenshot reading failed — paste the odds text below instead.');
    }
  };

  const updateGame = (id: string, patch: Partial<ScreenshotGame>) =>
    setGames((prev) => prev.map((g) => (g.id === id ? { ...g, ...patch } : g)));

  const addManualGame = () =>
    setGames((prev) => [
      ...prev,
      {
        id: `manual-${Date.now()}`,
        teamA: null,
        teamB: null,
        rawA: '',
        rawB: '',
        oddsA: null,
        oddsB: null,
        bestOf: 1,
        book,
        confidence: 'low',
        note: 'Added by hand — pick both teams and enter odds.',
      },
    ]);

  return (
    <View style={S.card}>
      <Text style={S.label}>Screenshot odds — should you bet?</Text>
      <Text style={[S.dim, { marginBottom: 8 }]}>
        Upload a screenshot of a book&apos;s moneyline board. On web it&apos;s read on-device
        (nothing is uploaded to a server), parsed into one row per game, and each game is
        priced against the model: model series probability vs book odds, ROI edge, and a
        Kelly stake. Verdicts are per game, not a parlay — the games are priced
        independently. BET needs ROI edge ≥ 5%; 0–5% is THIN (positive, quarter Kelly);
        at or below 0% is NO BET. Only &quot;(Match)&quot; rows are used — &quot;(Map 1)&quot;
        rows repeat the same match and are ignored, and a repeated match is kept once.
        Odds display in American format (+323 / -435); typing decimal odds still works.
      </Text>
      <Text style={[S.dim, { marginBottom: 10 }]}>
        Check every row before trusting it: OCR misreads names and digits, and it
        can&apos;t tell a series price from a map-1 or handicap price. Fix any wrong
        team or odds in place — verdicts update as you type.
      </Text>
      <TextInput
        style={[S.input, { marginBottom: 8 }]}
        placeholder="Book (e.g. Pinnacle) — optional"
        placeholderTextColor={C.faint}
        value={book}
        onChangeText={setBook}
      />
      <Text style={[S.dim, { marginBottom: 8 }]}>
        On your phone, open this site in Safari or Chrome — OCR does not work
        in the Expo app (no WebAssembly there). A full board can take
        ~20 seconds on a phone; keep the tab open while it reads. The first
        use downloads the OCR language data (~3 MB), so it needs a connection
        the first time, then it runs on-device.
      </Text>
      <View style={[S.row, { gap: 8 }]}>
        <Pressable
          style={[S.btn, { flex: 1 }]}
          onPress={() => void pickAndRead('library')}
          disabled={ocrRunning}
        >
          <Text style={S.btnText}>
            {ocrRunning ? 'Reading screenshot…' : 'Pick a screenshot'}
          </Text>
        </Pressable>
        <Pressable
          style={[S.btn, { flex: 1 }]}
          onPress={() => void pickAndRead('camera')}
          disabled={ocrRunning}
        >
          <Text style={S.btnText}>Take a photo</Text>
        </Pressable>
      </View>
      {imageUri && (
        <Image
          source={{ uri: imageUri }}
          style={{ width: '100%', height: 180, marginTop: 10, borderRadius: 8 }}
          resizeMode="contain"
        />
      )}
      {shotError && (
        <Text style={[S.body, { color: C.amber, marginTop: 8 }]}>{shotError}</Text>
      )}
      <Text style={[S.label, { marginTop: 12 }]}>OCR text (editable — re-parse after fixing)</Text>
      <TextInput
        style={[S.input, { minHeight: 110, textAlignVertical: 'top', marginBottom: 8 }]}
        placeholder="OCR text appears here, or paste a book board as text"
        placeholderTextColor={C.faint}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
        value={ocrText}
        onChangeText={setOcrText}
      />
      <View style={[S.row, { gap: 8 }]}>
        <Pressable
          style={[S.chip, { flex: 1 }]}
          onPress={() => setGames(parseScreenshotOdds(ocrText, book))}
        >
          <Text style={S.chipText}>Parse text into games</Text>
        </Pressable>
        <Pressable style={S.chip} onPress={addManualGame}>
          <Text style={S.chipText}>+ Add game by hand</Text>
        </Pressable>
      </View>

      {!(Number.isFinite(ctxBank) && ctxBank > 0) && (
        <View style={{ marginTop: 10 }}>
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

      {verdicts.map((v) => (
        <ScreenshotGameRow
          key={v.game.id}
          verdict={v}
          bankroll={bankroll}
          onUpdate={(patch) => updateGame(v.game.id, patch)}
          onRemove={() => setGames((prev) => prev.filter((g) => g.id !== v.game.id))}
        />
      ))}
      {games.length > 0 && (
        <Text style={[S.faint, { marginTop: 10 }]}>
          Pricing only — no bet is placed from here. Series probabilities use the
          side-averaged per-map prob (binomial for the row&apos;s best-of), the same
          conversion as the Predict tab&apos;s series mode.
        </Text>
      )}
    </View>
  );
}

function ScreenshotGameRow({
  verdict,
  bankroll,
  onUpdate,
  onRemove,
}: {
  verdict: ReturnType<typeof verdictsForGames>[number];
  bankroll: number | null;
  onUpdate: (patch: Partial<ScreenshotGame>) => void;
  onRemove: () => void;
}) {
  const g = verdict.game;
  const [teamAText, setTeamAText] = useState(g.rawA || g.teamA || '');
  const [teamBText, setTeamBText] = useState(g.rawB || g.teamB || '');
  const [oddsAText, setOddsAText] = useState(g.oddsA !== null ? formatAmerican(g.oddsA) : '');
  const [oddsBText, setOddsBText] = useState(g.oddsB !== null ? formatAmerican(g.oddsB) : '');

  return (
    <View style={[styles.shotRow, { marginTop: 12 }]}>
      <View style={[S.row, { justifyContent: 'space-between', alignItems: 'center' }]}>
        <Text style={[S.body, { fontWeight: '700', flex: 1 }]}>
          {g.teamA && g.teamB ? `${g.teamA} vs ${g.teamB}` : 'Unmapped game'}
          {g.book ? <Text style={S.dim}> · {g.book}</Text> : null}
        </Text>
        <Pressable style={S.chip} onPress={onRemove}>
          <Text style={S.chipText}>✕</Text>
        </Pressable>
      </View>
      <View style={[styles.segRow, { marginTop: 8 }]}>
        {([1, 3, 5] as const).map((n) => (
          <Pressable
            key={n}
            style={[S.chip, g.bestOf === n && { backgroundColor: C.blue, borderColor: C.blue }]}
            onPress={() => onUpdate({ bestOf: n })}
          >
            <Text style={[S.chipText, g.bestOf === n && { color: '#06121F' }]}>Bo{n}</Text>
          </Pressable>
        ))}
        <Text
          style={[
            S.dim,
            { color: g.confidence === 'high' && !verdict.warning ? C.green : C.amber, alignSelf: 'center' },
          ]}
        >
          {g.confidence === 'high' && !verdict.warning ? 'Parsed cleanly' : 'Check this row'}
        </Text>
      </View>
      {g.note ? <Text style={[S.faint, { marginTop: 4 }]}>{g.note}</Text> : null}
      <View style={[S.row, { gap: 8, marginTop: 8 }]}>
        <TextInput
          style={[S.input, { flex: 1 }]}
          placeholder="Team A"
          placeholderTextColor={C.faint}
          autoCapitalize="none"
          value={teamAText}
          onChangeText={(t) => {
            setTeamAText(t);
            onUpdate({ rawA: t, teamA: mapScreenshotTeam(t) });
          }}
        />
        <TextInput
          style={[S.input, { width: 92 }]}
          placeholder="Odds A"
          placeholderTextColor={C.faint}
          keyboardType="numbers-and-punctuation"
          autoCapitalize="none"
          autoCorrect={false}
          value={oddsAText}
          onChangeText={(t) => {
            setOddsAText(t);
            onUpdate({ oddsA: t.trim() === '' ? null : parseRowOdds(t) });
          }}
        />
      </View>
      <View style={[S.row, { gap: 8, marginTop: 8 }]}>
        <TextInput
          style={[S.input, { flex: 1 }]}
          placeholder="Team B"
          placeholderTextColor={C.faint}
          autoCapitalize="none"
          value={teamBText}
          onChangeText={(t) => {
            setTeamBText(t);
            onUpdate({ rawB: t, teamB: mapScreenshotTeam(t) });
          }}
        />
        <TextInput
          style={[S.input, { width: 92 }]}
          placeholder="Odds B"
          placeholderTextColor={C.faint}
          keyboardType="numbers-and-punctuation"
          autoCapitalize="none"
          autoCorrect={false}
          value={oddsBText}
          onChangeText={(t) => {
            setOddsBText(t);
            onUpdate({ oddsB: t.trim() === '' ? null : parseRowOdds(t) });
          }}
        />
      </View>

      <Text style={[S.body, { fontWeight: '800', marginTop: 10 }]}>{verdict.summary}</Text>
      {verdict.sides.map((s) => {
        const stake =
          (s.verdict === 'BET' || s.verdict === 'THIN') && bankroll !== null
            ? Math.max(0, s.fStar * s.kellyFrac) * bankroll
            : null;
        return (
          <Text key={s.team} style={S.dim}>
            {s.team}: model {fmtPct(s.pSeries)} vs implied {fmtPct(s.implied)} · ROI{' '}
            <Text style={{ color: s.roiEdge > 0 ? C.green : C.text, fontWeight: '700' }}>
              {s.roiEdge > 0 ? '+' : ''}
              {(s.roiEdge * 100).toFixed(1)}%
            </Text>{' '}
            · {s.verdict}
            {s.verdict !== 'NO BET' && ` · ${s.kellyLabel}`}
            {stake !== null ? (
              <>
                {' '}→ <Text style={[S.body, { fontWeight: '700' }]}>{fmtMoney(stake)}</Text>
              </>
            ) : null}
          </Text>
        );
      })}
    </View>
  );
}

/**
 * Prominent banner for the most recent SAVED pull (AsyncStorage
 * `odds_history_v1`, OddsPapi only — The Odds API pulls are never saved).
 * Shows the pull's timestamp (absolute + relative age, staleness never
 * hidden) and that pull's actual saved odds rows. Read-only: saved prices
 * are stale by definition, so rows never hand off to Kelly.
 */
function LastPullBanner({
  snapshots,
  now,
  loaded,
  titleOf,
  onArbSelect,
}: {
  snapshots: OddsSnapshot[] | null;
  now: number;
  loaded: boolean;
  titleOf: (key: string) => string;
  /** Tapping an arb row loads that pair into the arb calculator. */
  onArbSelect: (prefill: ArbPrefill) => void;
}) {
  if (!loaded) return null;
  if (!snapshots || snapshots.length === 0) {
    return (
      <View style={S.card}>
        <Text style={S.label}>Last saved pull</Text>
        <Text style={[S.body, { marginTop: 6 }]}>No odds pulled yet — pull odds to see them here.</Text>
        <Text style={[S.dim, { marginTop: 4 }]}>
          Saved pulls appear here after a successful OddsPapi refresh.
        </Text>
      </View>
    );
  }
  const ts = snapshots[0].ts;
  const pulled = new Date(ts).getTime();
  const ageMs = now - pulled;
  // 0 = fresh (<1h), 1 = aging (1–24h), 2 = stale (>24h). NaN timestamp counts as stale.
  const staleLevel = Number.isNaN(pulled) ? 2 : ageMs < 3600000 ? 0 : ageMs < 86400000 ? 1 : 2;
  const ageColor = staleLevel === 0 ? C.green : staleLevel === 1 ? C.amber : C.red;
  return (
    <View style={[S.card, { borderColor: ageColor }]}>
      <View style={[S.row, { justifyContent: 'space-between' }]}>
        <Text style={S.label}>Last saved pull</Text>
        <Text style={S.faint}>Saved pull — not live data</Text>
      </View>
      <Text style={[S.body, { fontSize: 16, fontWeight: '700', marginTop: 6 }]}>
        Last pulled: {fmtPullTime(ts)} <Text style={{ color: ageColor }}>({relativeAge(ts, now)})</Text>
      </Text>
      {staleLevel === 1 && (
        <Text style={[S.dim, { marginTop: 4 }]}>Prices may have moved — refresh before betting.</Text>
      )}
      {staleLevel === 2 && (
        <Text style={[S.body, { color: C.red, marginTop: 4 }]}>
          Stale — these prices are over a day old. Refresh before betting.
        </Text>
      )}
      <Text style={[S.dim, { marginTop: 8 }]}>
        {snapshots.length} game{snapshots.length === 1 ? '' : 's'} · OddsPapi pull
      </Text>
      {snapshots.map((s) => (
        <View key={s.eventId} style={{ marginTop: 10 }}>
          <Text style={[S.body, { fontWeight: '700' }]}>
            {s.homeTeam} <Text style={S.faint}>vs</Text> {s.awayTeam}
          </Text>
          <Text style={S.faint}>{fmtTime(s.commenceTime)}</Text>
          {s.books.map((b) => (
            <View key={b.key} style={[styles.row, { paddingVertical: 4 }]}>
              <Text style={[S.body, { flex: 1.4, fontSize: 13 }]} numberOfLines={1}>
                {b.title}
              </Text>
              <Text style={[S.body, { flex: 1, textAlign: 'center', fontSize: 13 }]}>
                {b.home !== null ? b.home.toFixed(2) : '–'}
              </Text>
              <Text style={[S.body, { flex: 1, textAlign: 'center', fontSize: 13 }]}>
                {b.away !== null ? b.away.toFixed(2) : '–'}
              </Text>
            </View>
          ))}
          {(s.bestHome || s.bestAway) && (
            <Text style={[S.dim, { marginTop: 4 }]}>
              Best: {s.bestHome ? `${s.bestHome.price.toFixed(2)} ${s.homeTeam} @ ${titleOf(s.bestHome.bookKey)}` : '–'}
              {' · '}
              {s.bestAway ? `${s.bestAway.price.toFixed(2)} ${s.awayTeam} @ ${titleOf(s.bestAway.bookKey)}` : '–'}
            </Text>
          )}
          {(() => {
            // Arb from THIS saved pull's best legs (best across all books in
            // the pull, not just the stored rows). Same formula as the live
            // board via arbFromBestLegs; only arbs at/above the alert bar
            // get a row. Labeled as saved-pull math — re-check live prices.
            const homeLeg = s.bestHome
              ? { price: s.bestHome.price, bookKey: s.bestHome.bookKey, bookTitle: titleOf(s.bestHome.bookKey) }
              : null;
            const awayLeg = s.bestAway
              ? { price: s.bestAway.price, bookKey: s.bestAway.bookKey, bookTitle: titleOf(s.bestAway.bookKey) }
              : null;
            const arb = arbFromBestLegs(homeLeg, awayLeg);
            if (!arb || arb.profitPct < ARB_ALERT_BAR) return null;
            return (
              <Pressable
                style={[styles.arbPanel, { marginTop: 8 }]}
                onPress={() =>
                  onArbSelect({
                    priceA: arb.home.price,
                    priceB: arb.away.price,
                    bookA: arb.home.bookTitle,
                    bookB: arb.away.bookTitle,
                    matchup: `${s.homeTeam} vs ${s.awayTeam}`,
                  })
                }
              >
                <Text style={[S.body, { color: C.green, fontWeight: '800' }]}>
                  ARB {(arb.profitPct * 100).toFixed(2)}% (saved pull)
                </Text>
                <Text style={[S.body, { marginTop: 4 }]}>
                  Back {s.homeTeam} @ {arb.home.price.toFixed(2)} ({arb.home.bookTitle}) + Back{' '}
                  {s.awayTeam} @ {arb.away.price.toFixed(2)} ({arb.away.bookTitle})
                </Text>
                <Text style={[S.faint, { marginTop: 4 }]}>
                  Computed from this saved pull — prices may have moved. Tap to load into the arb
                  calculator ↓
                </Text>
              </Pressable>
            );
          })()}
        </View>
      ))}
    </View>
  );
}

/** Prefill for the arb calculator: one arb pair's odds + book names. */
export interface ArbPrefill {
  priceA: number;
  priceB: number;
  bookA: string;
  bookB: string;
  matchup: string;
}

/**
 * Interactive 2-way arb calculator (planning tool only). Manual inputs:
 * odds per side (decimal or American, auto-detected like Kelly), total
 * stake, optional book-name labels. Outputs: arb % (or "No arb" with the
 * combined implied probability), the equal-payout stake split, guaranteed
 * profit, and ROI %. Places no bets, never hands off to Kelly, never
 * touches saved pulls. Tapping an arb row in the saved-pull banner prefills
 * it via the `prefill` prop.
 */
function ArbCalculator({ prefill }: { prefill: ArbPrefill | null }) {
  // Inputs initialize from the prefill (if any). The parent remounts this
  // component via `key` on every arb-row tap, so these initializers re-run
  // with the new prefill; user edits between taps are preserved.
  const [oddsA, setOddsA] = useState(prefill ? prefill.priceA.toFixed(2) : '');
  const [oddsB, setOddsB] = useState(prefill ? prefill.priceB.toFixed(2) : '');
  const [stakeText, setStakeText] = useState('100');
  const [bookA, setBookA] = useState(prefill ? prefill.bookA : '');
  const [bookB, setBookB] = useState(prefill ? prefill.bookB : '');
  const [prefillNote] = useState(prefill ? `Loaded from saved pull: ${prefill.matchup}` : '');

  const parsedA = useMemo(() => parseOddsInput(oddsA), [oddsA]);
  const parsedB = useMemo(() => parseOddsInput(oddsB), [oddsB]);
  const total = parseFloat(stakeText.replace(',', '.'));
  const totalOk = Number.isFinite(total) && total > 0;

  const inv = parsedA && parsedB ? 1 / parsedA.decimal + 1 / parsedB.decimal : null;
  const arbPct = inv !== null && inv < 1 ? 1 - inv : null;
  const split =
    arbPct !== null && parsedA && parsedB && totalOk
      ? splitStake(total, parsedA.decimal, parsedB.decimal)
      : null;
  const profit = arbPct !== null && totalOk ? total * arbPct : null;

  const fmtAmerican = (american: number) => (american > 0 ? `+${american}` : `${american}`);
  const labelA = bookA.trim() || 'Outcome A';
  const labelB = bookB.trim() || 'Outcome B';

  return (
    <View style={S.card}>
      <Text style={S.label}>Arb calculator</Text>
      <Text style={[S.dim, { marginTop: 4 }]}>
        2-way only. Enter odds as decimal (1.85) or American (-122 / +183) — auto-detected.
        Planning tool only: places no bets.
      </Text>
      {prefillNote !== '' && (
        <Text style={[S.body, { color: C.green, marginTop: 6 }]}>{prefillNote}</Text>
      )}
      <Text style={[S.label, { marginTop: 10 }]}>Odds — outcome A</Text>
      <TextInput
        style={[S.input, { marginBottom: 10 }]}
        placeholder="e.g. 2.10 or +110"
        placeholderTextColor={C.faint}
        keyboardType="numbers-and-punctuation"
        autoCapitalize="none"
        autoCorrect={false}
        value={oddsA}
        onChangeText={setOddsA}
      />
      <Text style={S.label}>Odds — outcome B</Text>
      <TextInput
        style={[S.input, { marginBottom: 10 }]}
        placeholder="e.g. 1.95 or -105"
        placeholderTextColor={C.faint}
        keyboardType="numbers-and-punctuation"
        autoCapitalize="none"
        autoCorrect={false}
        value={oddsB}
        onChangeText={setOddsB}
      />
      <Text style={S.label}>Total stake ($)</Text>
      <TextInput
        style={[S.input, { marginBottom: 10 }]}
        placeholder="e.g. 100"
        placeholderTextColor={C.faint}
        keyboardType="decimal-pad"
        value={stakeText}
        onChangeText={setStakeText}
      />
      <Text style={S.label}>Book for A (optional)</Text>
      <TextInput
        style={[S.input, { marginBottom: 10 }]}
        placeholder="e.g. Pinnacle"
        placeholderTextColor={C.faint}
        autoCapitalize="none"
        autoCorrect={false}
        value={bookA}
        onChangeText={setBookA}
      />
      <Text style={S.label}>Book for B (optional)</Text>
      <TextInput
        style={[S.input, { marginBottom: 10 }]}
        placeholder="e.g. bet365"
        placeholderTextColor={C.faint}
        autoCapitalize="none"
        autoCorrect={false}
        value={bookB}
        onChangeText={setBookB}
      />
      {(!parsedA || !parsedB) ? (
        <Text style={S.dim}>Enter valid odds for both sides to see the arb math.</Text>
      ) : !totalOk ? (
        <Text style={S.dim}>Enter a total stake above 0 to split it.</Text>
      ) : arbPct === null ? (
        <Text style={[S.body, { color: C.amber }]}>
          No arb — combined implied probability {((inv as number) * 100).toFixed(1)}%.
        </Text>
      ) : split && profit !== null ? (
        <>
          <Text style={[S.body, { color: C.green, fontWeight: '800', marginBottom: 6 }]}>
            ARB {(arbPct * 100).toFixed(2)}%
          </Text>
          <Text style={[S.dim, { marginBottom: 8 }]}>
            Odds A {parsedA.decimal.toFixed(2)} ({fmtAmerican(parsedA.american)}) · Odds B{' '}
            {parsedB.decimal.toFixed(2)} ({fmtAmerican(parsedB.american)})
          </Text>
          <View style={[S.row, { justifyContent: 'space-between', marginBottom: 4 }]}>
            <Text style={S.body}>
              ${split.stakeA.toFixed(2)} on {labelA}
            </Text>
            <Text style={S.dim}>{parsedA.decimal.toFixed(2)}</Text>
          </View>
          <View style={[S.row, { justifyContent: 'space-between', marginBottom: 8 }]}>
            <Text style={S.body}>
              ${split.stakeB.toFixed(2)} on {labelB}
            </Text>
            <Text style={S.dim}>{parsedB.decimal.toFixed(2)}</Text>
          </View>
          <Text style={[S.body, { color: C.green, fontWeight: '700' }]}>
            Guaranteed profit: ${profit.toFixed(2)} (ROI {(arbPct * 100).toFixed(2)}%) — same
            whichever side wins
          </Text>
        </>
      ) : null}
      <Text style={[S.faint, { marginTop: 8 }]}>⚠️ {ARB_CAVEAT}</Text>
    </View>
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
  segRow: { flexDirection: 'row', gap: 8, marginBottom: 8, flexWrap: 'wrap' },
  shotRow: {
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#26304A',
  },
});
