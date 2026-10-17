import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { OddsEvent } from '../model/odds';
import type { CalibrationMode, PredictionResult } from '../model/types';

export type KellySide = 'blue' | 'red';
export type ProbMode = 'map' | 'series';

const CALIBRATION_MODE_KEY = 'calibration_mode_v1';

interface PredictionState {
  result: PredictionResult | null;
  setResult: (r: PredictionResult | null) => void;
  /** Calibration map selector (Model tab toggle). Default 'standard'.
   *  Changing it clears the current result: a prediction computed under
   *  the other map is stale and must be re-run. */
  calibrationMode: CalibrationMode;
  setCalibrationMode: (m: CalibrationMode) => void;
  /** Side the Kelly tab is sizing a bet for. Defaults to the model's favorite. */
  kellySide: KellySide;
  setKellySide: (s: KellySide) => void;
  /** Per-map vs series probability mode (pre-draft Predict + Kelly). */
  probMode: ProbMode;
  setProbMode: (m: ProbMode) => void;
  /** Best-of for series mode (1, 3, or 5). */
  bestOf: number;
  setBestOf: (n: number) => void;
  oddsText: string;
  setOddsText: (s: string) => void;
  bankrollText: string;
  setBankrollText: (s: string) => void;
  /** Pinnacle's decimal prices for the current result (blue/red), from the Odds tab tap. Null when unknown. */
  pinBlue: number | null;
  setPinBlue: (n: number | null) => void;
  pinRed: number | null;
  setPinRed: (n: number | null) => void;
  /** Last odds fetch from the Odds tab, shared so the Parlay tab can build legs from it. */
  oddsEvents: OddsEvent[];
  setOddsEvents: (e: OddsEvent[]) => void;
}

const Ctx = createContext<PredictionState | null>(null);

export function PredictionProvider({ children }: { children: ReactNode }) {
  const [result, setResultState] = useState<PredictionResult | null>(null);
  const [calibrationMode, setCalibrationModeState] = useState<CalibrationMode>('standard');
  const [kellySide, setKellySide] = useState<KellySide>('blue');
  const [probMode, setProbMode] = useState<ProbMode>('map');
  const [bestOf, setBestOf] = useState<number>(5);
  const [oddsText, setOddsText] = useState('');
  const [bankrollText, setBankrollText] = useState('');
  const [pinBlue, setPinBlue] = useState<number | null>(null);
  const [pinRed, setPinRed] = useState<number | null>(null);
  const [oddsEvents, setOddsEvents] = useState<OddsEvent[]>([]);

  // Restore the persisted calibration mode (default 'standard' on first run).
  useEffect(() => {
    AsyncStorage.getItem(CALIBRATION_MODE_KEY).then(
      (v) => {
        if (v === 'honest' || v === 'standard') setCalibrationModeState(v);
      },
      () => {},
    );
  }, []);

  // A new prediction invalidates any stored Pinnacle prices (callers set them after).
  const setResult = useCallback((r: PredictionResult | null) => {
    setResultState(r);
    setPinBlue(null);
    setPinRed(null);
  }, []);

  // Flipping the calibration toggle invalidates the current prediction —
  // it was computed under the other map — and persists the choice.
  const setCalibrationMode = useCallback((m: CalibrationMode) => {
    setCalibrationModeState(m);
    setResultState(null);
    setPinBlue(null);
    setPinRed(null);
    void AsyncStorage.setItem(CALIBRATION_MODE_KEY, m);
  }, []);

  return (
    <Ctx.Provider
      value={{ result, setResult, calibrationMode, setCalibrationMode, kellySide, setKellySide, probMode, setProbMode, bestOf, setBestOf, oddsText, setOddsText, bankrollText, setBankrollText, pinBlue, setPinBlue, pinRed, setPinRed, oddsEvents, setOddsEvents }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function usePrediction(): PredictionState {
  const v = useContext(Ctx);
  if (!v) throw new Error('usePrediction must be used inside PredictionProvider');
  return v;
}
