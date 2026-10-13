/** TS-vs-CLI parity check.
 *
 *  Compiles src/model/*.ts with tsc, runs the same 5 cases through the TS
 *  inference and the Python reference (which also runs src/predict.py's real
 *  CLI code path), and asserts agreement.
 *
 *  Usage: node scripts/parity_check.mjs
 *  The TS side uses eloField='elo_raw' so it matches the CLI, which predicts
 *  from raw snapshot Elo. The app itself defaults to roster-adjusted 'elo'.
 */
import { execSync } from 'child_process';
import { createRequire } from 'module';
import { existsSync, mkdirSync, copyFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = dirname(here);
const buildDir = '/tmp/parity_build';
const require = createRequire(import.meta.url);

console.log('compiling src/model/*.ts ...');
execSync(`npx tsc -p scripts/tsconfig.parity.json`, { cwd: appDir, stdio: 'pipe' });
mkdirSync(join(buildDir, 'data'), { recursive: true });
copyFileSync(
  join(appDir, 'src/data/phone_artifacts.json'),
  join(buildDir, 'data/phone_artifacts.json'),
);

const { predictMatchup } = require(join(buildDir, 'model/predict.js'));

const DRAFTS = {
  't1-blg-draft': {
    bluePicks: ['Aatrox', 'Vi', 'Ahri', "Kai'Sa", 'Renata Glasc'],
    redPicks: ['Gwen', 'Xin Zhao', 'Taliyah', 'Senna', 'Nautilus'],
    blueBans: ['Azir', 'Kalista', 'Neeko', 'Rumble', 'Sejuani'],
    redBans: ['Yone', 'Wukong', 'Orianna', 'Varus', 'Rell'],
  },
  'c9-kc-draft': {
    bluePicks: ['Jax', 'Skarner', 'Hwei', 'Caitlyn', 'Milio'],
    redPicks: ["K'Sante", 'Nocturne', 'Sylas', 'Jinx', 'Lulu'],
    blueBans: ['Aurora', 'Ambessa', 'Corki', 'Ziggs', 'Leona'],
    redBans: ['Smolder', 'Ezreal', 'Rakan', 'Braum', 'Alistar'],
  },
};
const TEAMS = {
  't1-blg-predraft': ['T1', 'Bilibili Gaming'],
  't1-blg-draft': ['T1', 'Bilibili Gaming'],
  'gen-g2-predraft': ['Gen.G', 'G2 Esports'],
  'c9-kc-draft': ['Cloud9', 'Karmine Corp'],
  'fur-los-predraft': ['FURIA', 'LØS'],
};

console.log('running python reference (incl. real CLI code path) ...');
const ref = JSON.parse(
  execSync('/home/hatch/workspace/lol-worlds-model/.venv/bin/python scripts/parity_ref.py', {
    cwd: appDir,
    maxBuffer: 64 * 1024 * 1024,
  }).toString(),
);

let maxDiff = 0;
let maxCliDiff = 0;
let ok = true;
for (const c of ref.cases) {
  const [blue, red] = TEAMS[c.id];
  const draft = DRAFTS[c.id] ?? null;
  const ts = predictMatchup(blue, red, draft, { patch: ref.patch, eloField: 'elo_raw' });
  const dCal = Math.abs(ts.pBlue - c.p_cal);
  const dRaw = Math.abs(ts.pBlueRaw - c.p_raw);
  maxDiff = Math.max(maxDiff, dCal, dRaw);
  let featDiff = 0;
  for (const k of Object.keys(c.features)) {
    featDiff = Math.max(featDiff, Math.abs(ts.features[k] - c.features[k]));
  }
  maxDiff = Math.max(maxDiff, featDiff);
  let cliLine = '';
  if (c.p_cli !== undefined) {
    const dCli = Math.abs(c.p_cal - c.p_cli);
    maxCliDiff = Math.max(maxCliDiff, dCli);
    cliLine = ` cliΔ=${dCli.toExponential(1)}`;
    if (dCli > 1e-4) ok = false;
  }
  const status = dCal < 1e-9 && dRaw < 1e-9 && featDiff < 1e-9 ? 'OK ' : 'FAIL';
  if (status === 'FAIL') ok = false;
  console.log(
    `${status} ${c.id}: p_cal ts=${ts.pBlue.toFixed(6)} py=${c.p_cal.toFixed(6)} ` +
      `Δ=${dCal.toExponential(1)} featΔ=${featDiff.toExponential(1)}${cliLine}`,
  );
  if (!existsSync(join(buildDir, 'model/predict.js'))) {
    throw new Error('compiled predict.js missing');
  }
}

console.log(`\nmodel_version=${ref.model_version} patch=${ref.patch}`);
console.log(`max |TS - python-ref| = ${maxDiff.toExponential(2)}`);
console.log(`max |python-ref - CLI predict_game| = ${maxCliDiff.toExponential(2)}`);
if (!ok) {
  console.error('PARITY CHECK FAILED');
  process.exit(1);
}
console.log('PARITY CHECK PASSED');
