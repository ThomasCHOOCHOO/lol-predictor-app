# Derivatives tab

The Derivatives tab (route `parlay.tsx`, displayed label "Derivatives")
prices single props and related (correlated) parlays from the fitted
prop model. Pricing/analysis only — no bets are placed.

Existing parlay functionality is preserved: manual legs, cached-odds
legs, American odds, Kelly, bankroll, and ranked independent combos.
The tab adds three sections on top: Prop pricer, Related parlay
builder, and Watch out for.

## Data

`src/data/prop_models.json` (136 KB) — fitted params copied from the
model repo's `model/prop_models.json`. The only transformation: `players`
goes from a dict keyed by Oracle's Elixir playerid to compact tuples
`[name, team, position, rate, games]` (958 players). All fitted params
are copied verbatim; nothing is omitted. See the model repo's
`reports/prop_pricing.md` for the full method + validation numbers.

## Props

All props are **pre-draft**. Pricing code: `src/model/props.ts`
(pure functions, no React Native imports).

| Prop | Model | Validation (out-of-sample, vs naive) |
|---|---|---|
| Total kills O/U per map | Poisson GLM on both teams' trailing-20 pace + \|Elo diff\|, NB dispersion | ΔLL **+0.0372** |
| Player kills O/U per map | Poisson GLM on shrunk player rate + team/opponent pace + Elo, NB dispersion, shrunk toward position mean | ΔLL **+0.0077** |
| First blood / dragon / tower | Logistic on Elo diff + both teams' trailing first-X rates | ΔLL +0.0025 / +0.0040 / +0.0491 |
| Series exact score | Binomial, fixed per-map p | ΔLL **+0.0884** |
| Total maps | Multinomial logistic on `[logit(p), \|logit(p)\|]` — NOT the binomial | ΔLL **+0.0042** |

Ship gate: beat naive by > 0.002 log-loss. Every prop above shipped.
The binomial total-maps distribution FAILED (ΔLL −0.0082) and is never
used — the standalone maps prop uses the conditional model.

The prop pricer shows model P + fair odds (decimal + American) for each
outcome. Entered book odds → edge + Kelly (via `src/model/kelly.ts`,
adaptive fraction by validation n). If a prop is unshipped or pace data
is missing, the tab says "No model price" instead of inventing one.

Elo convention: props use PLAIN `elo_diff` (no region offset) so Python
and TS price identically. Series props use the app's `predictMatchup`
per-map p (region-adjusted), consistent with the Python series
validation.

## Joint simulation (related parlays)

Naive independent multiplication misprices same-game parlays because
the legs correlate (a series win and over-kills reinforce each other).
The tab runs a seeded joint Monte Carlo (5,000 sims, mulberry32) that
mirrors the Python validator exactly — same strata, same buckets, same
cell probabilities, same raking:

Per map: winner ~ Bernoulli(p), then a (kill bucket, first-blood /
dragon / tower combo) cell drawn JOINTLY from an empirical table
stratified by (map winner, p-bin, map-index bucket, tied?). Sampling
kills + firsts from one cell preserves the kills↔firsts correlation;
the winner draw preserves the winner↔everything correlation.

- **Map-index bucket (1, 2, 3, 4+):** decider maps are slower (game-5
  maps average ~29.5 kills vs ~33.3 for game 2).
- **Tied flag:** level series are slower (~31.3 kills when tied vs
  ~33.4 when a side leads).
- **Raking:** each sim is weighted by `P_cond(maps | p) / P_binom(maps | p)`
  so the sim's maps marginal matches the shipped conditional maps model
  instead of the fixed-p binomial (which overstates long series). This
  keeps the related builder's maps marginal consistent with the
  standalone total-maps prop.

### Validation (out-of-sample, 310 Bo5 series)

| Combo | Joint LL | Naive LL | Delta |
|---|---|---|---|
| A-win + A first dragon (map 1) | −0.5123 | −0.5125 | +0.0002 |
| A-win + over kills | −0.5541 | −0.5591 | +0.0050 |
| A-win + over 3.5 maps | −0.5987 | −0.6068 | +0.0081 |
| Over 3.5 maps + over kills | −0.6786 | −0.7181 | +0.0395 |
| **Pooled** | **−0.5859** | **−0.5991** | **+0.0132** |

All four combos beat or tie naive; joint means track actual rates
(over-maps+over-kills: 0.435 sim vs 0.419 actual). Before raking, the
pooled delta was +0.0005 and over-maps+over-kills lost — the raking is
load-bearing.

## Related-leg highlighting

In the manual builder, same-match pairs (same `matchKey`) are
quantified, not just flagged:

- **ML + totals** and **totals + totals**: priced by the joint sim
  (bestOf inferred: any totals line > 3 → Bo5 else Bo3).
- **ML + ML, same side**: joint = min(p1, p2), φ ≈ +1 (perfectly
  correlated — same outcome twice).
- **ML + ML, opposite sides**: joint = 0, φ negative (mutually
  exclusive).

Quantified legs get a visually distinct **RELATED φ ≈ X.XX** badge +
amber-tinted row, and a "Related pairs — joint-sim price (not
independent)" card shows joint vs naive + adjustment + fair odds +
"Do NOT use the independent product". Groups that can't be quantified
fall back to the old structural same-match notes.

## Suggested related combos

After a first leg in the related builder, `suggestFor` shows the top-4
candidates containing that leg, ranked by |adjustment|, each tappable
to add the other leg ("Pairs well with \<first leg\>" + adjustment + φ).

## Prominent correlation adjustment

Every combo card shows the joint price vs the naive independent price
with the adjustment called out in large type, e.g.
"Correlation adjustment: −X pp vs independent" (+ relative % + fair
odds + φ for 2-leg combos). Book combo odds → edge + Kelly.

## Watch out for

For the selected matchup, a ranked list of related-parlay combos worth
watching. Exact-score legs are excluded — exact score is nested inside
series winner, so its "correlation" is structural, not insight.

- Rank: entries WITH book odds rank first by edge desc; entries without
  rank by |adjustment| desc.
- Each entry: legs, joint vs naive, fair odds, φ, prominent adjustment
  line, a plain-language reason (generated from the leg pattern + the
  measured adjustment sign), a per-entry book-odds input → edge, and a
  "Load into builder" button.
- Header states: "Candidates with the model's numbers, NOT bet
  recommendations — you decide."

## Limitations

- First blood is a marginal ship (+0.0025, gate cleared by 0.0005) —
  its prices are the least reliable of the set.
- The joint sim draws each map's winner from a fixed p (no momentum,
  no side-swap effects). Its maps marginal is corrected by raking,
  not by dynamics.
- The joint sim's validation is n = 310 Bo5 series — meaningful but
  not huge-sample.
- Props are pre-draft; the draft is a veto, same as the main model.
- Pace stats are trailing-20; roster changes make pace stale until
  20 games pass.
- Manual-builder ML+ML quantification is exact only for same-match
  moneyline legs (same outcome / mutually exclusive). ML+totals and
  totals+totals use the joint sim.
