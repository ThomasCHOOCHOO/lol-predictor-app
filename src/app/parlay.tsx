import React, { useMemo, useState, useRef } from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { fmtMoney, fmtPct, kelly, parseOddsInput, recommendKelly, decimalToAmerican } from '../model/kelly';
import { bestPrices, mapOddsTeamName, type OddsEvent } from '../model/odds';
import {
  PARLAY_CAVEAT,
  rankParlays,
  sameMatchNotes,
  type ParlayCombo,
  type ParlayLeg,
} from '../model/parlay';
import { predictMatchup } from '../model/predict';
import {
  PROPS,
  buildCandidates,
  comboStats,
  simMapWeight,
  weightedMedian,
  eloDiffFor,
  firstXRate,
  legKey,
  legLabel,
  priceFirstX,
  pricePlayerKills,
  priceTotalKills,
  playerFromTuple,
  rankCandidates,
  seriesExactProbs,
  seriesMapsProbsConditional,
  simulateSeries,
  suggestFor,
  teamPropStats,
  type FirstObj,
  type RelatedLeg,
  type SimSeries,
} from '../model/props';
import { usePrediction } from '../state/PredictionContext';
import { C, S } from '../theme';

type LegKindTab = 'ml' | 'totals';
type PropKind = 'totalkills' | 'playerkills' | 'first' | 'exact' | 'maps';

const NSIMS = 5000;

const fmtOdds = (d: number) => d.toFixed(2);
const fmtAm = (d: number) => {
  const a = decimalToAmerican(d);
  return a === null ? '—' : a > 0 ? `+${a}` : `${a}`;
};

export default function DerivativesScreen() {
  const { bankrollText, oddsEvents, calibrationMode } = usePrediction();

  /* ---------------- shared matchup (props + related + watch-out-for) ---------------- */
  const [matchA, setMatchA] = useState('');
  const [matchB, setMatchB] = useState('');
  const [bestOf, setBestOf] = useState(5);

  /* ---------------- prop pricer ---------------- */
  const [propKind, setPropKind] = useState<PropKind>('totalkills');
  const [propLine, setPropLine] = useState('22.5');
  const [playerQuery, setPlayerQuery] = useState('');
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [firstObj, setFirstObj] = useState<FirstObj>('dragon');
  const [propSel, setPropSel] = useState(0);
  const [propBookOdds, setPropBookOdds] = useState('');

  /* ---------------- related builder ---------------- */
  const [relLegs, setRelLegs] = useState<RelatedLeg[]>([]);
  const [relKillsLine, setRelKillsLine] = useState('');
  const [relMapsLine, setRelMapsLine] = useState('3.5');
  const [relBookOdds, setRelBookOdds] = useState('');
  const [relError, setRelError] = useState<string | null>(null);

  /* ---------------- watch out for ---------------- */
  const [watchOddsText, setWatchOddsText] = useState<Record<string, string>>({});

  /* ---------------- manual parlay builder (existing) ---------------- */
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

  /* ---------------- matchup resolution + sim ---------------- */
  const modelA = matchA.trim() ? mapOddsTeamName(matchA.trim()) : null;
  const modelB = matchB.trim() ? mapOddsTeamName(matchB.trim()) : null;
  const matchupOk = !!modelA && !!modelB && modelA !== modelB;
  const pA = matchupOk
    ? predictMatchup(modelA as string, modelB as string, null, {
        eloField: 'elo',
        calibration: calibrationMode,
      }).pBlue
    : 0.5;
  const sims = useMemo(
    () => (matchupOk ? simulateSeries(pA, bestOf, NSIMS) : []),
    [matchupOk, pA, bestOf],
  );
  const candidates = useMemo(
    () =>
      matchupOk
        ? buildCandidates(modelA as string, modelB as string, bestOf, sims, pA)
        : [],
    [matchupOk, modelA, modelB, bestOf, sims, pA],
  );
  const killsMedianLine = useMemo(() => {
    if (sims.length === 0) return 22.5;
    const weights = sims.map((s) => simMapWeight(s.maps, pA, bestOf));
    return Math.floor(weightedMedian(sims.map((s) => s.kills), weights)) + 0.5;
  }, [sims, pA, bestOf]);

  /* ---------------- prop pricer outcomes ---------------- */
  // Selected player (playerId is an index into PROPS.players).
  const selPlayer =
    playerId !== null && PROPS.players[Number(playerId)]
      ? playerFromTuple(PROPS.players[Number(playerId)])
      : null;
  const propOutcomes = useMemo((): { label: string; p: number }[] => {
    if (!matchupOk) return [];
    const a = modelA as string;
    const b = modelB as string;
    const elo = eloDiffFor(a, b);
    if (propKind === 'totalkills') {
      const paceA = teamPropStats(a);
      const paceB = teamPropStats(b);
      if (!paceA || !paceB) return [];
      const line = parseFloat(propLine.replace(',', '.'));
      if (!(line > 0)) return [];
      const pr = priceTotalKills(paceA, paceB, elo, line);
      if (!pr) return [];
      return [
        { label: `Over ${line} total kills (map)`, p: pr.pOver },
        { label: `Under ${line} total kills (map)`, p: pr.pUnder },
      ];
    }
    if (propKind === 'playerkills') {
      const pl = selPlayer;
      if (!pl) return [];
      const oppTeam = pl.team === a ? b : pl.team === b ? a : null;
      if (!oppTeam) return [];
      const tStats = teamPropStats(pl.team);
      const oStats = teamPropStats(oppTeam);
      if (!tStats || !oStats) return [];
      const line = parseFloat(propLine.replace(',', '.'));
      if (!(line > 0)) return [];
      const eloSigned = pl.team === a ? elo : -elo;
      const pr = pricePlayerKills(pl, tStats.pace_for, oStats.pace_against, eloSigned, line);
      if (!pr) return [];
      return [
        { label: `Over ${line} kills — ${pl.name}`, p: pr.pOver },
        { label: `Under ${line} kills — ${pl.name}`, p: pr.pUnder },
      ];
    }
    if (propKind === 'first') {
      const ownA = firstXRate(a, firstObj);
      const oppA = firstXRate(b, firstObj);
      const ownB = firstXRate(b, firstObj);
      const oppB = firstXRate(a, firstObj);
      if (ownA === null || oppA === null || ownB === null || oppB === null) return [];
      const pFirstA = priceFirstX(firstObj, elo, ownA, oppA);
      const pFirstB = priceFirstX(firstObj, -elo, ownB, oppB);
      if (pFirstA === null || pFirstB === null) return [];
      const objName = firstObj === 'blood' ? 'first blood' : firstObj === 'dragon' ? 'first dragon' : 'first tower';
      return [
        { label: `${a} ${objName} (map 1)`, p: pFirstA },
        { label: `${b} ${objName} (map 1)`, p: pFirstB },
      ];
    }
    if (propKind === 'exact') {
      const e = seriesExactProbs(pA, bestOf);
      return Object.entries(e).map(([k, v]) => {
        const [aw, bw] = k.split('-').map(Number);
        return aw > bw
          ? { label: `${a} wins ${k}`, p: v }
          : { label: `${b} wins ${bw}-${aw}`, p: v };
      });
    }
    // maps — standalone prop uses the p-conditional model (the binomial
    // maps marginal fails the validation gate).
    const m = seriesMapsProbsConditional(pA, bestOf);
    const out: { label: string; p: number }[] = [];
    if (bestOf >= 5) {
      out.push({ label: 'Over 3.5 maps', p: (m['4'] ?? 0) + (m['5'] ?? 0) });
      out.push({ label: 'Under 3.5 maps', p: m['3'] ?? 0 });
      out.push({ label: 'Over 4.5 maps', p: m['5'] ?? 0 });
      out.push({ label: 'Under 4.5 maps', p: (m['3'] ?? 0) + (m['4'] ?? 0) });
    } else if (bestOf === 3) {
      out.push({ label: 'Over 2.5 maps', p: m['3'] ?? 0 });
      out.push({ label: 'Under 2.5 maps', p: m['2'] ?? 0 });
    }
    for (const [k, v] of Object.entries(m)) {
      out.push({ label: `Exactly ${k} maps`, p: v });
    }
    return out;
  }, [matchupOk, modelA, modelB, propKind, propLine, selPlayer, firstObj, pA, bestOf]);

  const propValidationN =
    propKind === 'totalkills'
      ? PROPS.total_kills.validation.n
      : propKind === 'playerkills'
        ? PROPS.player_kills.validation.n
        : propKind === 'first'
          ? (PROPS.first_x[firstObj]?.validation.n ?? 1000)
          : PROPS.series.validation.n;
  const selOutcome =
    propOutcomes.length > 0 ? propOutcomes[Math.min(propSel, propOutcomes.length - 1)] : null;
  const propParsedBook = parseOddsInput(propBookOdds);
  const propKelly = propParsedBook && selOutcome ? kelly(propParsedBook.decimal, selOutcome.p) : null;
  const propRec = propKelly ? recommendKelly(propKelly.edge, propValidationN) : null;
  const propStake =
    propKelly && propKelly.bet && bankroll !== null
      ? Math.max(0, propKelly.fStar * (propRec?.frac ?? 0.5)) * bankroll
      : null;

  const playerMatches = useMemo(() => {
    const q = playerQuery.trim().toLowerCase();
    if (!q) return [];
    return PROPS.players
      .map((t, i) => ({ id: String(i), pl: playerFromTuple(t) }))
      .filter(
        ({ pl }) => pl.name.toLowerCase().includes(q) || pl.team.toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [playerQuery]);

  /* ---------------- related builder ---------------- */
  const relStats = relLegs.length >= 2 && sims.length > 0 ? comboStats(sims, relLegs, pA, bestOf) : null;
  const suggestions = relLegs.length === 1 ? suggestFor(relLegs[0], candidates) : [];
  const relParsedBook = parseOddsInput(relBookOdds);
  const relKelly = relParsedBook && relStats ? kelly(relParsedBook.decimal, relStats.joint) : null;
  const relRec = relKelly ? recommendKelly(relKelly.edge, PROPS.joint.validation.n_series) : null;
  const relStake =
    relKelly && relKelly.bet && bankroll !== null
      ? Math.max(0, relKelly.fStar * (relRec?.frac ?? 0.5)) * bankroll
      : null;

  const addRelLeg = (leg: RelatedLeg) => {
    if (relLegs.some((l) => legKey(l) === legKey(leg))) {
      setRelError('That leg is already in the combo.');
      return;
    }
    if (relLegs.length >= 3) {
      setRelError('Max 3 legs in a related parlay.');
      return;
    }
    setRelLegs((prev) => [...prev, leg]);
    setRelError(null);
  };
  const removeRelLeg = (key: string) =>
    setRelLegs((prev) => prev.filter((l) => legKey(l) !== key));

  /* ---------------- watch out for ---------------- */
  const watchOdds = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(watchOddsText)) {
      const parsed = parseOddsInput(v);
      if (parsed) out[k] = parsed.decimal;
    }
    return out;
  }, [watchOddsText]);
  const rankedWatch = useMemo(
    () => rankCandidates(candidates, watchOdds),
    [candidates, watchOdds],
  );

  /* ---------------- manual builder (existing) ---------------- */
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
    const res = predictMatchup(a, b, null, { eloField: 'elo', calibration: calibrationMode });
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
      p: NaN, // no standalone model probability — quantified via the joint sim when paired
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
    const res = predictMatchup(homeModel, awayModel, null, { eloField: 'elo', calibration: calibrationMode });
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

  /* ---- related-pair quantification for manual legs (same matchKey) ---- */
  const manualPairs = useMemo(
    () => quantifyManualPairs(legs, calibrationMode),
    [legs, calibrationMode],
  );
  const relatedLegIds = useMemo(() => {
    const s = new Set<string>();
    for (const pr of manualPairs) {
      s.add(pr.legId1);
      s.add(pr.legId2);
    }
    return s;
  }, [manualPairs]);
  const phiByLegId = useMemo(() => {
    const m = new Map<string, number>();
    for (const pr of manualPairs) {
      for (const [id, phi] of [
        [pr.legId1, pr.phi],
        [pr.legId2, pr.phi],
      ] as const) {
        const prev = m.get(id);
        if (prev === undefined || Math.abs(phi) > Math.abs(prev)) m.set(id, phi);
      }
    }
    return m;
  }, [manualPairs]);
  const quantifiedKeys = useMemo(
    () => new Set(manualPairs.map((pr) => pr.matchKey)),
    [manualPairs],
  );
  const notes = useMemo(
    () => sameMatchNotes(legs.filter((l) => !quantifiedKeys.has(l.matchKey))),
    [legs, quantifiedKeys],
  );

  return (
    <SafeAreaView style={S.screen}>
      <ScrollView contentContainerStyle={S.scroll} keyboardShouldPersistTaps="handled">
        <Text style={S.h1}>Derivatives</Text>
        <Text style={[S.dim, { marginBottom: 12 }]}>
          Prop pricing, related (correlated) parlays, and independent parlays. A parlay is
          one ticket at one book, so combos only mix legs from the same book. Same-game
          legs correlate — the joint simulation prices them together instead of
          multiplying independent probabilities.
        </Text>

        {/* -------- shared matchup -------- */}
        <View style={S.card}>
          <Text style={S.label}>Matchup (props + related parlays + watch out for)</Text>
          <View style={[S.row, { gap: 8, marginBottom: 8 }]}>
            <TextInput
              style={[S.input, { flex: 1 }]}
              placeholder="Team A"
              placeholderTextColor={C.faint}
              autoCapitalize="none"
              value={matchA}
              onChangeText={setMatchA}
            />
            <TextInput
              style={[S.input, { flex: 1 }]}
              placeholder="Team B"
              placeholderTextColor={C.faint}
              autoCapitalize="none"
              value={matchB}
              onChangeText={setMatchB}
            />
          </View>
          <View style={styles.segRow}>
            {([1, 3, 5] as const).map((n) => (
              <Pressable
                key={n}
                style={[S.chip, bestOf === n && { backgroundColor: C.blue, borderColor: C.blue }]}
                onPress={() => setBestOf(n)}
              >
                <Text style={[S.chipText, bestOf === n && { color: '#06121F' }]}>Bo{n}</Text>
              </Pressable>
            ))}
            {matchupOk && (
              <Text style={[S.dim, { marginLeft: 8, alignSelf: 'center' }]}>
                Model: {modelA} {fmtPct(pA)} per map
              </Text>
            )}
          </View>
          {!matchupOk && (
            <Text style={S.faint}>Enter two model teams (e.g. KC, MVK) to price props.</Text>
          )}
        </View>

        {/* -------- prop pricer -------- */}
        <View style={S.card}>
          <Text style={S.label}>Prop pricer</Text>
          <View style={styles.segRow}>
            {(
              [
                ['totalkills', 'Total kills'],
                ['playerkills', 'Player kills'],
                ['first', 'First objective'],
                ['exact', 'Exact score'],
                ['maps', 'Total maps'],
              ] as [PropKind, string][]
            ).map(([k, label]) => (
              <Pressable
                key={k}
                style={[S.chip, propKind === k && { backgroundColor: C.blue, borderColor: C.blue }]}
                onPress={() => {
                  setPropKind(k);
                  setPropSel(0);
                  if (k === 'totalkills') setPropLine('22.5');
                  if (k === 'playerkills') setPropLine('3.5');
                }}
              >
                <Text style={[S.chipText, propKind === k && { color: '#06121F' }]}>{label}</Text>
              </Pressable>
            ))}
          </View>
          {propKind === 'first' && (
            <View style={[styles.segRow, { marginBottom: 8 }]}>
              {(
                [
                  ['blood', 'First blood'],
                  ['dragon', 'First dragon'],
                  ['tower', 'First tower'],
                ] as [FirstObj, string][]
              ).map(([o, label]) => (
                <Pressable
                  key={o}
                  style={[S.chip, firstObj === o && { backgroundColor: C.blue, borderColor: C.blue }]}
                  onPress={() => {
                    setFirstObj(o);
                    setPropSel(0);
                  }}
                >
                  <Text style={[S.chipText, firstObj === o && { color: '#06121F' }]}>{label}</Text>
                </Pressable>
              ))}
            </View>
          )}
          {(propKind === 'totalkills' || propKind === 'playerkills') && (
            <TextInput
              style={[S.input, { marginBottom: 8 }]}
              placeholder={propKind === 'totalkills' ? 'Kills line (22.5)' : 'Kills line (3.5)'}
              placeholderTextColor={C.faint}
              keyboardType="decimal-pad"
              value={propLine}
              onChangeText={setPropLine}
            />
          )}
          {propKind === 'playerkills' && (
            <>
              <TextInput
                style={[S.input, { marginBottom: 8 }]}
                placeholder="Player name (e.g. Kratos)"
                placeholderTextColor={C.faint}
                autoCapitalize="none"
                value={playerQuery}
                onChangeText={(t) => {
                  setPlayerQuery(t);
                  setPlayerId(null);
                }}
              />
              {playerMatches.map(({ id, pl }) => (
                <Pressable
                  key={id}
                  style={styles.pickRow}
                  onPress={() => {
                    setPlayerId(id);
                    setPlayerQuery(pl.name);
                  }}
                >
                  <Text style={S.body}>
                    {pl.name} <Text style={S.dim}>({pl.team}, {pl.position}) — trailing {pl.rate.toFixed(1)} kills/map</Text>
                  </Text>
                </Pressable>
              ))}
              {selPlayer && (
                <Text style={[S.faint, { marginBottom: 8 }]}>
                  Selected: {selPlayer.name} ({selPlayer.team}).
                  {selPlayer.team !== modelA &&
                    selPlayer.team !== modelB &&
                    ' Player’s team is not in this matchup — pick a player from one of the two teams.'}
                </Text>
              )}
            </>
          )}
          {!matchupOk ? (
            <Text style={S.dim}>Enter a matchup above to see model prices.</Text>
          ) : propOutcomes.length === 0 ? (
            <Text style={S.dim}>
              No model price for this prop (missing team/player pace data, or this prop did not
              clear the validation gate).
            </Text>
          ) : (
            <>
              {propOutcomes.map((o, i) => {
                const fair = 1 / o.p;
                const selected = i === Math.min(propSel, propOutcomes.length - 1);
                return (
                  <Pressable
                    key={o.label}
                    style={[styles.pickRow, selected && { borderColor: C.blue, backgroundColor: C.card2 }]}
                    onPress={() => setPropSel(i)}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={[S.body, { fontWeight: '700' }]}>{o.label}</Text>
                      <Text style={S.dim}>
                        Model {fmtPct(o.p)} · fair {fmtOdds(fair)} ({fmtAm(fair)})
                      </Text>
                    </View>
                    {selected && <Text style={[S.body, { color: C.blue }]}>✓</Text>}
                  </Pressable>
                );
              })}
              <Text style={[S.label, { marginTop: 10 }]}>Your book odds (for the selected outcome)</Text>
              <TextInput
                style={[S.input, { marginBottom: 8 }]}
                placeholder="Book odds (1.85 or -122)"
                placeholderTextColor={C.faint}
                keyboardType="numbers-and-punctuation"
                autoCapitalize="none"
                autoCorrect={false}
                value={propBookOdds}
                onChangeText={setPropBookOdds}
              />
              {propKelly && selOutcome && (
                <View style={[styles.adjBox, { borderColor: propKelly.bet ? C.green : C.border }]}>
                  <Text style={S.body}>
                    Edge{' '}
                    <Text style={{ color: propKelly.edge > 0 ? C.green : C.text, fontWeight: '700' }}>
                      {fmtPct(propKelly.edge)}
                    </Text>{' '}
                    · {propRec?.label}
                    {propStake !== null && (
                      <>
                        {' '}→ <Text style={{ fontWeight: '700' }}>{fmtMoney(propStake)}</Text>
                      </>
                    )}
                  </Text>
                  {!propKelly.bet && (
                    <Text style={S.faint}>Negative edge — no Kelly stake.</Text>
                  )}
                </View>
              )}
            </>
          )}
        </View>

        {/* -------- related parlay builder -------- */}
        <View style={S.card}>
          <Text style={S.label}>Related parlay builder (joint simulation)</Text>
          <Text style={[S.dim, { marginBottom: 8 }]}>
            Legs from the same series correlate. The joint price comes from a {NSIMS.toLocaleString()}-sim
            Monte Carlo of the series (map-by-map: winner, kills, first objectives drawn jointly),
            not from multiplying independent probabilities.
          </Text>
          {!matchupOk ? (
            <Text style={S.dim}>Enter a matchup above to build a related parlay.</Text>
          ) : (
            <>
              <Text style={[S.label, { marginTop: 4 }]}>Add a leg</Text>
              <View style={styles.segRow}>
                <Pressable style={S.chip} onPress={() => addRelLeg({ kind: 'series', team: 'A' })}>
                  <Text style={S.chipText}>{modelA} wins</Text>
                </Pressable>
                <Pressable style={S.chip} onPress={() => addRelLeg({ kind: 'series', team: 'B' })}>
                  <Text style={S.chipText}>{modelB} wins</Text>
                </Pressable>
              </View>
              <View style={[S.row, { gap: 8, marginBottom: 8 }]}>
                <TextInput
                  style={[S.input, { flex: 1 }]}
                  placeholder={`Kills line (${killsMedianLine})`}
                  placeholderTextColor={C.faint}
                  keyboardType="decimal-pad"
                  value={relKillsLine}
                  onChangeText={setRelKillsLine}
                />
                <Pressable
                  style={S.chip}
                  onPress={() =>
                    addRelLeg({
                      kind: 'kills',
                      dir: 'over',
                      line: parseFloat(relKillsLine.replace(',', '.')) || killsMedianLine,
                    })
                  }
                >
                  <Text style={S.chipText}>+ Over kills</Text>
                </Pressable>
                <Pressable
                  style={S.chip}
                  onPress={() =>
                    addRelLeg({
                      kind: 'kills',
                      dir: 'under',
                      line: parseFloat(relKillsLine.replace(',', '.')) || killsMedianLine,
                    })
                  }
                >
                  <Text style={S.chipText}>+ Under kills</Text>
                </Pressable>
              </View>
              {bestOf > 1 && (
                <View style={[S.row, { gap: 8, marginBottom: 8 }]}>
                  <TextInput
                    style={[S.input, { flex: 1 }]}
                    placeholder="Maps line (3.5)"
                    placeholderTextColor={C.faint}
                    keyboardType="decimal-pad"
                    value={relMapsLine}
                    onChangeText={setRelMapsLine}
                  />
                  <Pressable
                    style={S.chip}
                    onPress={() =>
                      addRelLeg({
                        kind: 'maps',
                        dir: 'over',
                        line: parseFloat(relMapsLine.replace(',', '.')) || 3.5,
                      })
                    }
                  >
                    <Text style={S.chipText}>+ Over maps</Text>
                  </Pressable>
                  <Pressable
                    style={S.chip}
                    onPress={() =>
                      addRelLeg({
                        kind: 'maps',
                        dir: 'under',
                        line: parseFloat(relMapsLine.replace(',', '.')) || 3.5,
                      })
                    }
                  >
                    <Text style={S.chipText}>+ Under maps</Text>
                  </Pressable>
                </View>
              )}
              <View style={styles.segRow}>
                {(['A', 'B'] as const).map((side) => (
                  <React.Fragment key={side}>
                    {(['fd', 'fb', 'ft'] as const).map((obj) => (
                      <Pressable
                        key={`${side}-${obj}`}
                        style={S.chip}
                        onPress={() => addRelLeg({ kind: 'first', obj, team: side })}
                      >
                        <Text style={S.chipText}>
                          {side === 'A' ? modelA : modelB}{' '}
                          {obj === 'fd' ? 'dragon' : obj === 'fb' ? 'blood' : 'tower'}
                        </Text>
                      </Pressable>
                    ))}
                  </React.Fragment>
                ))}
              </View>
              {relError && <Text style={[S.body, { color: C.red }]}>{relError}</Text>}

              {relLegs.length > 0 && (
                <View style={{ marginTop: 8 }}>
                  <Text style={S.label}>Combo ({relLegs.length}/3)</Text>
                  {relLegs.map((l) => (
                    <View key={legKey(l)} style={styles.legRow}>
                      <Text style={[S.body, { flex: 1 }]}>{legLabel(l, modelA as string, modelB as string)}</Text>
                      <Pressable style={S.chip} onPress={() => removeRelLeg(legKey(l))}>
                        <Text style={S.chipText}>✕</Text>
                      </Pressable>
                    </View>
                  ))}
                </View>
              )}

              {relLegs.length === 1 && suggestions.length > 0 && (
                <View style={[styles.suggestBox, { marginTop: 10 }]}>
                  <Text style={[S.body, { fontWeight: '700', marginBottom: 6 }]}>
                    Pairs well with {legLabel(relLegs[0], modelA as string, modelB as string)}
                  </Text>
                  {suggestions.map((c) => {
                    const other = c.legs.find((l) => legKey(l) !== legKey(relLegs[0]))!;
                    return (
                      <Pressable
                        key={c.legs.map(legKey).join('|')}
                        style={styles.pickRow}
                        onPress={() => addRelLeg(other)}
                      >
                        <View style={{ flex: 1 }}>
                          <Text style={S.body}>
                            + {legLabel(other, modelA as string, modelB as string)}
                          </Text>
                          <Text style={S.dim}>
                            Adjustment {c.stats.adjustmentPp >= 0 ? '+' : ''}
                            {c.stats.adjustmentPp.toFixed(1)}pp vs independent
                            {c.stats.phi !== null && ` · φ ≈ ${c.stats.phi.toFixed(2)}`}
                          </Text>
                        </View>
                        <Text style={[S.body, { color: C.blue }]}>Add</Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}

              {relStats && (
                <View style={[styles.adjBox, { marginTop: 10 }]}>
                  <Text style={[S.body, { fontWeight: '700', marginBottom: 4 }]}>
                    Correlation adjustment:{' '}
                    <Text
                      style={{
                        color: relStats.adjustmentPp >= 0 ? C.green : C.red,
                        fontWeight: '800',
                      }}
                    >
                      {relStats.adjustmentPp >= 0 ? '+' : ''}
                      {relStats.adjustmentPp.toFixed(1)}pp vs independent
                    </Text>
                  </Text>
                  <Text style={S.dim}>
                    Joint {fmtPct(relStats.joint)} vs naive independent {fmtPct(relStats.naive)} ·{' '}
                    {relStats.adjustmentRel >= 0 ? '+' : ''}
                    {(relStats.adjustmentRel * 100).toFixed(1)}% relative · fair odds{' '}
                    {fmtOdds(1 / relStats.joint)} ({fmtAm(1 / relStats.joint)})
                    {relStats.phi !== null && ` · φ ≈ ${relStats.phi.toFixed(2)}`}
                  </Text>
                  <Text style={[S.label, { marginTop: 10 }]}>Book combo odds</Text>
                  <TextInput
                    style={[S.input, { marginBottom: 8 }]}
                    placeholder="Book odds for the whole combo (1.85 or -122)"
                    placeholderTextColor={C.faint}
                    keyboardType="numbers-and-punctuation"
                    autoCapitalize="none"
                    autoCorrect={false}
                    value={relBookOdds}
                    onChangeText={setRelBookOdds}
                  />
                  {relKelly && (
                    <Text style={S.body}>
                      Edge{' '}
                      <Text style={{ color: relKelly.edge > 0 ? C.green : C.text, fontWeight: '700' }}>
                        {fmtPct(relKelly.edge)}
                      </Text>{' '}
                      · {relRec?.label}
                      {relStake !== null && (
                        <>
                          {' '}→ <Text style={{ fontWeight: '700' }}>{fmtMoney(relStake)}</Text>
                        </>
                      )}
                    </Text>
                  )}
                </View>
              )}
            </>
          )}
        </View>

        {/* -------- watch out for -------- */}
        <View style={S.card}>
          <Text style={S.label}>Watch out for — related combos worth a look</Text>
          <Text style={[S.dim, { marginBottom: 8 }]}>
            Candidates with the model&apos;s numbers, NOT bet recommendations — you decide.
            Ranked by correlation-adjustment magnitude; enter book odds on any entry and it
            re-ranks by edge.
          </Text>
          {!matchupOk ? (
            <Text style={S.dim}>Enter a matchup above to see candidates.</Text>
          ) : (
            rankedWatch.slice(0, 8).map(({ candidate, key, edge }) => (
              <View key={key} style={styles.watchRow}>
                <Text style={[S.body, { fontWeight: '700' }]}>
                  {candidate.legs.map((l) => legLabel(l, modelA as string, modelB as string)).join(' × ')}
                </Text>
                <Text
                  style={[
                    S.body,
                    {
                      fontWeight: '800',
                      color: candidate.stats.adjustmentPp >= 0 ? C.green : C.red,
                      marginVertical: 2,
                    },
                  ]}
                >
                  Correlation adjustment: {candidate.stats.adjustmentPp >= 0 ? '+' : ''}
                  {candidate.stats.adjustmentPp.toFixed(1)}pp vs independent
                </Text>
                <Text style={S.dim}>
                  Joint {fmtPct(candidate.stats.joint)} vs naive {fmtPct(candidate.stats.naive)} ·{' '}
                  fair {fmtOdds(1 / candidate.stats.joint)} ({fmtAm(1 / candidate.stats.joint)})
                  {candidate.stats.phi !== null && ` · φ ≈ ${candidate.stats.phi.toFixed(2)}`}
                </Text>
                <Text style={[S.dim, { marginTop: 4 }]}>{candidate.reason}</Text>
                <View style={[S.row, { gap: 8, marginTop: 8 }]}>
                  <TextInput
                    style={[S.input, { flex: 1, paddingVertical: 8 }]}
                    placeholder="Book combo odds"
                    placeholderTextColor={C.faint}
                    keyboardType="numbers-and-punctuation"
                    autoCapitalize="none"
                    autoCorrect={false}
                    value={watchOddsText[key] ?? ''}
                    onChangeText={(t) => setWatchOddsText((prev) => ({ ...prev, [key]: t }))}
                  />
                  <Pressable style={S.chip} onPress={() => setRelLegs(candidate.legs)}>
                    <Text style={S.chipText}>Load into builder</Text>
                  </Pressable>
                </View>
                {edge !== null && (
                  <Text style={[S.body, { marginTop: 6 }]}>
                    Edge{' '}
                    <Text style={{ color: edge > 0 ? C.green : C.text, fontWeight: '700' }}>
                      {fmtPct(edge)}
                    </Text>{' '}
                    at those book odds
                  </Text>
                )}
              </View>
            ))
          )}
        </View>

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
          <Text style={S.label}>Add leg manually (independent parlay builder)</Text>
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
                Totals legs paired with a moneyline from the same match get a joint-sim
                price below — no longer structural notes only.
              </Text>
            </>
          )}
          {formError && (
            <Text style={[S.body, { color: C.red, marginTop: 8 }]}>{formError}</Text>
          )}
        </View>

        {/* -------- current legs (with Related badges) -------- */}
        {legs.length > 0 && (
          <View style={S.card}>
            <Text style={S.label}>Legs ({legs.length})</Text>
            {legs.map((l) => {
              const phi = phiByLegId.get(l.id);
              const related = relatedLegIds.has(l.id);
              return (
                <View
                  key={l.id}
                  style={[styles.legRow, related && { borderColor: C.amber, backgroundColor: 'rgba(255,184,77,0.06)' }]}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={S.body}>
                      {l.label}
                      <Text style={S.dim}> @ {l.book}</Text>
                      {related && (
                        <Text style={[styles.relatedBadge, { color: C.amber, borderColor: C.amber }]}>
                          {' '}RELATED{phi !== undefined ? ` φ ≈ ${phi.toFixed(2)}` : ''}
                        </Text>
                      )}
                    </Text>
                    <Text style={S.dim}>
                      {l.matchKey} · {l.odds.toFixed(2)}
                      {l.kind === 'ml' ? ` · model ${fmtPct(l.p)}` : ' · joint-sim priced if paired'}
                    </Text>
                  </View>
                  <Pressable style={S.chip} onPress={() => removeLeg(l.id)}>
                    <Text style={S.chipText}>✕</Text>
                  </Pressable>
                </View>
              );
            })}
          </View>
        )}

        {/* -------- quantified related pairs (manual builder) -------- */}
        {manualPairs.length > 0 && (
          <View style={S.card}>
            <Text style={S.label}>Related pairs — joint-sim price (not independent)</Text>
            {manualPairs.map((pr, i) => (
              <View key={i} style={[styles.adjBox, { marginBottom: 8 }]}>
                <Text style={[S.body, { fontWeight: '700' }]}>
                  {pr.label1} × {pr.label2}
                </Text>
                <Text
                  style={[S.body, { fontWeight: '800', color: pr.adjPp >= 0 ? C.green : C.red, marginVertical: 2 }]}
                >
                  Correlation adjustment: {pr.adjPp >= 0 ? '+' : ''}
                  {pr.adjPp.toFixed(1)}pp vs independent
                </Text>
                <Text style={S.dim}>
                  Joint {fmtPct(pr.joint)} vs naive {fmtPct(pr.naive)} · fair{' '}
                  {fmtOdds(1 / pr.joint)} ({fmtAm(1 / pr.joint)}) · φ ≈ {pr.phi.toFixed(2)}
                </Text>
                <Text style={[S.faint, { marginTop: 4 }]}>
                  Do NOT use the independent product for this pair — the legs are correlated.
                </Text>
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

        {/* -------- ranked combos (independent only) -------- */}
        <ComboSection title="Top 2-leg parlays (independent legs only)" combos={twos} bankroll={bankroll} />
        <ComboSection title="Top 3-leg parlays (independent legs only)" combos={threes} bankroll={bankroll} />

        {/* -------- same-match structural notes (unquantified only) -------- */}
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
          <Text style={[S.dim, { marginTop: 6 }]}>
            Related-parlay prices come from the joint Monte Carlo (model repo
            src/prop_models.py, validated out-of-sample). They are model estimates, not
            guarantees — correlation estimates are noisier than single-leg probabilities.
          </Text>
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

/* ------------------------------------------------------------------ */
/* Quantify same-match pairs in the manual builder via the joint sim.  */
/* A pair is quantifiable when both legs resolve to one matchup.       */
/* ------------------------------------------------------------------ */

export interface ManualPair {
  matchKey: string;
  legId1: string;
  legId2: string;
  label1: string;
  label2: string;
  joint: number;
  naive: number;
  adjPp: number;
  phi: number;
}

function manualLegToRelated(
  leg: ParlayLeg,
  teamA: string,
  teamB: string,
): RelatedLeg | null {
  if (leg.kind === 'ml') {
    if (leg.team === teamA) return { kind: 'series', team: 'A' };
    if (leg.team === teamB) return { kind: 'series', team: 'B' };
    return null;
  }
  if (leg.totalsDir && leg.totalsLine !== undefined) {
    return { kind: 'maps', dir: leg.totalsDir, line: leg.totalsLine };
  }
  return null;
}

function quantifyManualPairs(legs: ParlayLeg[], calibrationMode: 'standard' | 'honest'): ManualPair[] {
  const groups = new Map<string, ParlayLeg[]>();
  for (const l of legs) {
    const arr = groups.get(l.matchKey) ?? [];
    arr.push(l);
    groups.set(l.matchKey, arr);
  }
  const out: ManualPair[] = [];
  for (const [matchKey, g] of groups) {
    if (g.length < 2) continue;
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        const l1 = g[i];
        const l2 = g[j];
        // Resolve the matchup: prefer an ML leg's (team, opponent); else map totals teams.
        let teamA: string | null = null;
        let teamB: string | null = null;
        for (const l of [l1, l2]) {
          if (l.kind === 'ml') {
            teamA = l.team;
            teamB = l.opponent;
            break;
          }
        }
        if (!teamA || !teamB) {
          const a1 = mapOddsTeamName(l1.team);
          const b1 = mapOddsTeamName(l1.opponent);
          if (a1 && b1) {
            teamA = a1;
            teamB = b1;
          }
        }
        if (!teamA || !teamB || teamA === teamB) continue;
        const r1 = manualLegToRelated(l1, teamA, teamB);
        const r2 = manualLegToRelated(l2, teamA, teamB);
        if (!r1 || !r2) continue;
        const p = predictMatchup(teamA, teamB, null, { eloField: 'elo', calibration: calibrationMode }).pBlue;

        if (r1.kind === 'series' && r2.kind === 'series') {
          // Same side -> perfectly correlated; opposite sides -> mutually exclusive.
          const p1 = Number.isFinite(l1.p) ? l1.p : p;
          const p2 = Number.isFinite(l2.p) ? l2.p : 1 - p;
          if (r1.team === r2.team) {
            const joint = Math.min(p1, p2);
            const naive = p1 * p2;
            const denom = Math.sqrt(p1 * (1 - p1) * p2 * (1 - p2));
            out.push({
              matchKey, legId1: l1.id, legId2: l2.id, label1: l1.label, label2: l2.label,
              joint, naive, adjPp: (joint - naive) * 100,
              phi: denom > 1e-9 ? (joint - naive) / denom : 1,
            });
          } else {
            const joint = 0;
            const naive = p1 * p2;
            const denom = Math.sqrt(p1 * (1 - p1) * p2 * (1 - p2));
            out.push({
              matchKey, legId1: l1.id, legId2: l2.id, label1: l1.label, label2: l2.label,
              joint, naive, adjPp: (joint - naive) * 100,
              phi: denom > 1e-9 ? (joint - naive) / denom : -1,
            });
          }
          continue;
        }

        const bestOf =
          [l1, l2].some((l) => l.kind === 'totals' && (l.totalsLine ?? 0) > 3) ? 5 : 3;
        const sims: SimSeries[] = simulateSeries(p, bestOf, NSIMS);
        const stats = comboStats(sims, [r1, r2], p, bestOf);
        out.push({
          matchKey, legId1: l1.id, legId2: l2.id, label1: l1.label, label2: l2.label,
          joint: stats.joint, naive: stats.naive, adjPp: stats.adjustmentPp,
          phi: stats.phi ?? 0,
        });
      }
    }
  }
  return out;
}

const styles = StyleSheet.create({
  segRow: { flexDirection: 'row', gap: 8, marginBottom: 8, flexWrap: 'wrap' },
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
  pickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.border,
    borderWidth: 1,
    borderColor: 'transparent',
    borderRadius: 10,
  },
  adjBox: {
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 10,
    padding: 10,
    backgroundColor: C.card2,
  },
  suggestBox: {
    borderWidth: 1,
    borderColor: C.blue,
    borderRadius: 10,
    padding: 10,
    backgroundColor: 'rgba(77,163,255,0.06)',
  },
  watchRow: {
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.border,
  },
  relatedBadge: {
    fontSize: 10,
    fontWeight: '800',
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
});
