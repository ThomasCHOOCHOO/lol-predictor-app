import React, { createContext, useContext, useState, type ReactNode } from 'react';
import type { PredictionResult } from '../model/types';

export type KellySide = 'blue' | 'red';

interface PredictionState {
  result: PredictionResult | null;
  setResult: (r: PredictionResult | null) => void;
  /** Side the Kelly tab is sizing a bet for. Defaults to the model's favorite. */
  kellySide: KellySide;
  setKellySide: (s: KellySide) => void;
  oddsText: string;
  setOddsText: (s: string) => void;
  bankrollText: string;
  setBankrollText: (s: string) => void;
}

const Ctx = createContext<PredictionState | null>(null);

export function PredictionProvider({ children }: { children: ReactNode }) {
  const [result, setResult] = useState<PredictionResult | null>(null);
  const [kellySide, setKellySide] = useState<KellySide>('blue');
  const [oddsText, setOddsText] = useState('');
  const [bankrollText, setBankrollText] = useState('');

  return (
    <Ctx.Provider
      value={{ result, setResult, kellySide, setKellySide, oddsText, setOddsText, bankrollText, setBankrollText }}
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
