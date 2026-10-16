import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  LIVE_BUCKETS,
  LiveGame,
  LiveGameState,
  LiveMatch,
  bucketFor,
  elapsedMinutes,
  fetchLiveGame,
  fetchLiveMatches,
  fetchWindow,
  liveProba,
  mapTeamCode,
  preLogit,
  snapshot,
} from '../model/live';
import { predictMatchup } from '../model/predict';
import { usePrediction } from '../state/PredictionContext';
import { C, S } from '../theme';

const POLL_MS = 12000;

function ProbBar({ pBlue, blue, red }: { pBlue: number; blue: string; red: string }) {
  const pct = Math.round(pBlue * 100);
  return (
    <View>
      <View style={styles.probRow}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.probTeam, { color: C.blue }]} numberOfLines={1}>
            {blue}
          </Text>
          <Text style={styles.probBig}>{pct}%</Text>
        </View>
        <View style={{ flex: 1, alignItems: 'flex-end' }}>
          <Text style={[styles.probTeam, { color: C.red }]} numberOfLines={1}>
            {red}
          </Text>
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

function StatCell({ label, blue, red }: { label: string; blue: string; red: string }) {
  return (
    <View style={styles.statCell}>
      <Text style={[styles.statVal, { color: C.blue }]}>{blue}</Text>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statVal, { color: C.red }]}>{red}</Text>
    </View>
  );
}

export default function LiveScreen() {
  const { result: ctxResult } = usePrediction();
  const [matches, setMatches] = useState<LiveMatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [match, setMatch] = useState<LiveMatch | null>(null);
  const [game, setGame] = useState<LiveGame | null>(null);
  const [swapped, setSwapped] = useState(false);
  const [snap, setSnap] = useState<LiveGameState | null>(null);
  const [liveP, setLiveP] = useState<number | null>(null);
  const [preP, setPreP] = useState<number | null>(null);
  const [priorNote, setPriorNote] = useState<string | null>(null);
  const [feedDown, setFeedDown] = useState(false);
  const [ended, setEnded] = useState(false);
  const [betweenGames, setBetweenGames] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  // Latest game/match for the poll interval (avoids stale closures when the
  // game advances mid-series). pollRef always points at the freshest poll.
  const gameIdRef = useRef<string | null>(null);
  const matchRef = useRef<LiveMatch | null>(null);
  const gameRef = useRef<LiveGame | null>(null);
  const pollRef = useRef<(gameId: string | null, m: LiveMatch | null, g: LiveGame | null) => Promise<void>>(
    async () => {},
  );

  // team assignment: feed blue/red side <-> model team (user can swap).
  // Sides can flip between games in a series, so prefer the current game's
  // sides and fall back to the match-level codes.
  const gameBlue = game?.blueCode || match?.blueCode;
  const gameRed = game?.redCode || match?.redCode;
  const blueTeam = swapped ? gameRed : gameBlue;
  const redTeam = swapped ? gameBlue : gameRed;
  const blueModel = blueTeam ? mapTeamCode(blueTeam) ?? blueTeam : null;
  const redModel = redTeam ? mapTeamCode(redTeam) ?? redTeam : null;

  // setState lives only inside the .then() callbacks below, which the
  // set-state-in-effect rule permits (setState in a callback when external
  // state changes). The effect only starts the fetch. Callers set
  // loading/error synchronously before invoking (see the refresh button);
  // on mount the initial state already has loading=true.
  const refreshMatches = useCallback(() => {
    fetchLiveMatches().then(
      (data) => {
        setMatches(data);
        setError(null);
        setLoading(false);
      },
      () => {
        setError('Could not reach the LoL Esports API.');
        setLoading(false);
      },
    );
  }, []);

  useEffect(() => {
    void refreshMatches();
  }, [refreshMatches]);

  const stopPoll = useCallback(() => {
    if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => stopPoll, [stopPoll]);

  const poll = useCallback(
    async (gameId: string | null, m: LiveMatch | null, g: LiveGame | null) => {
      if (!gameId || !m) return;
      const frames = await fetchWindow(gameId);
      const last = frames[frames.length - 1];
      const s = last && last.gameState === 'in_game' ? snapshot(frames) : null;
      if (!s) {
        // Current game over / not started / feed gap: re-discover the live
        // game instead of stopping. The tab advances across games in a
        // series on its own; it only stops when the match is over.
        let next: LiveGame | null = null;
        try {
          next = await fetchLiveGame(m.matchId);
        } catch {
          next = null;
        }
        if (!next) {
          setFeedDown(true);
          return;
        }
        if (next.state === 'inProgress' && next.gameId !== gameId) {
          setGame(next);
          gameRef.current = next;
          gameIdRef.current = next.gameId;
          setSnap(null);
          setLiveP(null);
          setPreP(null);
          setPriorNote(null);
          setBetweenGames(false);
          setEnded(false);
          setFeedDown(false);
          // No immediate re-poll here: the next interval tick uses the
          // fresh poll closure (via pollRef) with the new game's sides.
          return;
        }
        if (next.state === 'inProgress') {
          setFeedDown(true); // same game, transient feed gap
          return;
        }
        if (next.state === 'unstarted') {
          setBetweenGames(true);
          setFeedDown(false);
          return;
        }
        setEnded(true);
        stopPoll();
        return;
      }
      setFeedDown(false);
      setBetweenGames(false);
      setSnap(s);
      // Derive sides from the game being polled (not render closure) so a
      // just-advanced game uses its own sides on the first tick.
      const pollBlue = swapped ? g?.redCode || m.redCode : g?.blueCode || m.blueCode;
      const pollRed = swapped ? g?.blueCode || m.blueCode : g?.redCode || m.redCode;
      const pollBlueModel = pollBlue ? mapTeamCode(pollBlue) ?? pollBlue : null;
      const pollRedModel = pollRed ? mapTeamCode(pollRed) ?? pollRed : null;
      if (pollBlueModel && pollRedModel) {
        // Prior: prefer a draft-adjusted prediction for this exact matchup
        // (run on the Predict tab); fall back to the pre-draft model.
        let priorP: number;
        let note: string | null = null;
        const r = ctxResult;
        const sameSides = r && r.blue === pollBlueModel && r.red === pollRedModel;
        const flippedSides = r && r.blue === pollRedModel && r.red === pollBlueModel;
        if (r && r.mode === 'draft' && (sameSides || flippedSides)) {
          priorP = sameSides ? r.pBlue : 1 - r.pBlue;
          note = 'using draft-adjusted prior';
        } else {
          priorP = predictMatchup(pollBlueModel, pollRedModel, null, { eloField: 'elo' }).pBlue;
        }
        setPreP(priorP);
        setPriorNote(note);
        const b = bucketFor(s.minutes);
        if (b !== null) {
          const lr = liveProba(
            { preLogit: preLogit(priorP), goldDiffK: s.goldDiffK, killDiff: s.killDiff },
            b,
          );
          setLiveP(lr ? lr.pCal : null);
        } else {
          setLiveP(null); // <10 min: fall back to pre-game
        }
      }
    },
    [swapped, stopPoll, ctxResult],
  );

  // Keep the interval pointed at the freshest poll closure.
  useEffect(() => {
    pollRef.current = poll;
  });

  const selectMatch = useCallback(
    async (m: LiveMatch) => {
      stopPoll();
      setMatch(m);
      matchRef.current = m;
      setSwapped(false);
      setSnap(null);
      setLiveP(null);
      setPreP(null);
      setPriorNote(null);
      setEnded(false);
      setFeedDown(false);
      setBetweenGames(false);
      setError(null);
      try {
        const g = await fetchLiveGame(m.matchId);
        if (!g) {
          setError('No game found for this match.');
          return;
        }
        setGame(g);
        gameRef.current = g;
        gameIdRef.current = g.gameId;
        await poll(g.gameId, m, g);
        timer.current = setInterval(
          () => void pollRef.current(gameIdRef.current, matchRef.current, gameRef.current),
          POLL_MS,
        );
      } catch {
        setError('Could not load game details.');
      }
    },
    [poll, stopPoll],
  );

  const back = useCallback(() => {
    stopPoll();
    setMatch(null);
    matchRef.current = null;
    setGame(null);
    gameRef.current = null;
    gameIdRef.current = null;
    setSnap(null);
    setLiveP(null);
    setPreP(null);
    setPriorNote(null);
    setEnded(false);
    setBetweenGames(false);
  }, [stopPoll]);

  const shownP = liveP ?? preP;
  const bucket = snap ? bucketFor(snap.minutes) : null;

  return (
    <SafeAreaView style={S.screen}>
      <ScrollView contentContainerStyle={S.scroll}>
        <Text style={S.h1}>Live win probability</Text>
        <Text style={S.dim}>
          Pre-game model + live gold/kill state, recalibrated per game minute. Polls the LoL
          Esports feed every {POLL_MS / 1000}s.
        </Text>

        {error && (
          <View style={[S.card, { borderColor: C.red }]}>
            <Text style={[S.body, { color: C.red }]}>{error}</Text>
          </View>
        )}

        {!match && (
          <>
            <Pressable
              style={[S.btn, { marginBottom: 12 }]}
              onPress={() => {
                setError(null);
                setLoading(true);
                void refreshMatches();
              }}
            >
              <Text style={S.btnText}>{loading ? 'Checking…' : 'Refresh live matches'}</Text>
            </Pressable>
            {!loading && matches.length === 0 && !error && (
              <View style={S.card}>
                <Text style={S.body}>No live games right now.</Text>
                <Text style={S.dim}>Worlds 2026 Play-In starts Oct 16 — check back during a match.</Text>
              </View>
            )}
            {matches.map((m) => (
              <Pressable key={m.matchId} style={S.card} onPress={() => void selectMatch(m)}>
                <Text style={S.label}>{m.league}</Text>
                <Text style={S.h2}>
                  {m.blueCode} <Text style={S.faint}>vs</Text> {m.redCode}
                </Text>
                <Text style={S.dim}>
                  {m.blueName} vs {m.redName}
                  {m.strategy ? ` · ${m.strategy}` : ''}
                </Text>
              </Pressable>
            ))}
          </>
        )}

        {match && (
          <>
            <Pressable style={[S.chip, { alignSelf: 'flex-start', marginBottom: 12 }]} onPress={back}>
              <Text style={S.chipText}>← All live matches</Text>
            </Pressable>

            <View style={S.card}>
              <Text style={S.label}>Watching</Text>
              <Text style={S.h2}>
                {match.blueCode} vs {match.redCode}
                {match.strategy ? ` · ${match.strategy}` : ''}
                {game ? ` · Game ${game.number}` : ''}
              </Text>
              <View style={[S.row, { marginTop: 8, justifyContent: 'space-between' }]}>
                <Text style={S.dim}>
                  Feed blue: <Text style={{ color: C.blue }}>{blueTeam}</Text>
                  {'  '}Feed red: <Text style={{ color: C.red }}>{redTeam}</Text>
                </Text>
                <Pressable style={S.chip} onPress={() => setSwapped((s) => !s)}>
                  <Text style={S.chipText}>Swap sides</Text>
                </Pressable>
              </View>
              {betweenGames && (
                <Text style={[S.body, { color: C.amber, marginTop: 8 }]}>
                  Between games — waiting for the next game to start.
                </Text>
              )}
              {ended && <Text style={[S.body, { color: C.amber, marginTop: 8 }]}>Match over.</Text>}
              {feedDown && (
                <Text style={[S.body, { color: C.amber, marginTop: 8 }]}>
                  Live feed unavailable — showing pre-game probability.
                </Text>
              )}
            </View>

            {shownP !== null && blueModel && redModel && (
              <View style={S.card}>
                <ProbBar pBlue={shownP} blue={blueModel} red={redModel} />
                <Text style={[S.faint, { marginTop: 8 }]}>
                  {liveP !== null && bucket !== null
                    ? `Live t=${bucket} model · ${snap!.minutes.toFixed(1)} min elapsed`
                    : snap
                      ? `Game under 10 min — pre-game model (${snap.minutes.toFixed(1)} min)`
                      : 'Pre-game model'}
                  {priorNote ? ` · ${priorNote}` : ''}
                </Text>
              </View>
            )}

            {snap && (
              <View style={S.card}>
                <Text style={S.label}>Game state</Text>
                <View style={S.row}>
                  <StatCell
                    label="Gold diff (k)"
                    blue={(snap.goldDiffK >= 0 ? '+' : '') + snap.goldDiffK.toFixed(1)}
                    red={(snap.goldDiffK <= 0 ? '+' : '') + (-snap.goldDiffK).toFixed(1)}
                  />
                  <StatCell
                    label="Kills"
                    blue={String(Math.max(0, snap.killDiff))}
                    red={String(Math.max(0, -snap.killDiff))}
                  />
                  <StatCell
                    label="Towers"
                    blue={String(snap.blueTowers)}
                    red={String(snap.redTowers)}
                  />
                </View>
                <Text style={[S.dim, { marginTop: 8 }]}>
                  Dragons — <Text style={{ color: C.blue }}>{snap.blueDragons.length || '–'}</Text>
                  {' / '}
                  <Text style={{ color: C.red }}>{snap.redDragons.length || '–'}</Text>
                  {'  '}· Barons —{' '}
                  <Text style={{ color: C.blue }}>{snap.blueBarons}</Text> /{' '}
                  <Text style={{ color: C.red }}>{snap.redBarons}</Text>
                </Text>
              </View>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  probRow: { flexDirection: 'row', marginBottom: 8 },
  probTeam: { fontSize: 13, fontWeight: '700' },
  probBig: { color: '#F2F5FA', fontSize: 44, fontWeight: '800' },
  bar: { flexDirection: 'row', height: 10, borderRadius: 5, overflow: 'hidden' },
  barFill: { height: '100%' },
  statCell: { flex: 1, alignItems: 'center' },
  statVal: { fontSize: 18, fontWeight: '800' },
  statLabel: { color: '#5E6B8C', fontSize: 11, marginVertical: 2 },
});
