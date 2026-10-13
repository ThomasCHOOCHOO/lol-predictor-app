import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { championPower, searchChampions } from '../model/artifacts';
import { C, S } from '../theme';
import { SearchPicker, type PickerItem } from './SearchPicker';

interface Props {
  side: 'blue' | 'red';
  team: string | null;
  picks: (string | null)[];
  bans: (string | null)[];
  patch: string;
  onPicksChange: (p: (string | null)[]) => void;
  onBansChange: (b: (string | null)[]) => void;
}

const ROLES = ['Top', 'Jungle', 'Mid', 'ADC', 'Support'];

export function DraftEditor({ side, team, picks, bans, patch, onPicksChange, onBansChange }: Props) {
  const [slot, setSlot] = useState<{ kind: 'pick' | 'ban'; idx: number } | null>(null);
  const accent = side === 'blue' ? C.blue : C.red;

  const openPicker = (kind: 'pick' | 'ban', idx: number) => setSlot({ kind, idx });

  const handleSelect = (item: PickerItem) => {
    if (!slot) return;
    const name = item.title;
    if (slot.kind === 'pick') {
      const next = [...picks];
      next[slot.idx] = next[slot.idx] === name ? null : name;
      // prevent duplicate picks on the same side
      if (next.filter((x) => x === name).length > 1) next[slot.idx] = null;
      onPicksChange(next);
    } else {
      const next = [...bans];
      next[slot.idx] = next[slot.idx] === name ? null : name;
      onBansChange(next);
    }
    setSlot(null);
  };

  const renderSlot = (kind: 'pick' | 'ban', idx: number, value: string | null, label: string) => (
    <Pressable
      key={`${kind}-${idx}`}
      style={[styles.slot, value && { borderColor: accent }]}
      onPress={() => openPicker(kind, idx)}
    >
      <Text style={styles.slotLabel}>{label}</Text>
      <Text style={[styles.slotValue, !value && { color: C.faint }]}>
        {value ?? '—'}
      </Text>
      {value && (
        <Text style={styles.slotPower}>{(championPower(value, patch) * 100).toFixed(1)}%</Text>
      )}
    </Pressable>
  );

  return (
    <View style={[S.card, { borderLeftWidth: 3, borderLeftColor: accent }]}>
      <Text style={[S.label, { color: accent }]}>{side === 'blue' ? 'Blue' : 'Red'} draft{team ? ` — ${team}` : ''}</Text>
      <Text style={[S.faint, { marginBottom: 8 }]}>Picks</Text>
      <View style={styles.grid}>
        {picks.map((p, i) => renderSlot('pick', i, p, ROLES[i]))}
      </View>
      <Text style={[S.faint, { marginBottom: 8, marginTop: 10 }]}>Bans (optional)</Text>
      <View style={styles.grid}>
        {bans.map((b, i) => renderSlot('ban', i, b, `Ban ${i + 1}`))}
      </View>
      <SearchPicker
        visible={slot !== null}
        title={slot?.kind === 'ban' ? 'Select ban' : 'Select pick'}
        placeholder="Search champions…"
        items={[]}
        onSearch={(q) =>
          searchChampions(q, patch).map((c) => ({
            key: c.name,
            title: c.name,
            subtitle: `power ${(c.power * 100).toFixed(1)}%`,
          }))
        }
        onSelect={handleSelect}
        onClose={() => setSlot(null)}
        accent={accent}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  slot: {
    width: '18%',
    minWidth: 62,
    backgroundColor: C.card2,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 4,
    alignItems: 'center',
  },
  slotLabel: { color: C.faint, fontSize: 10, fontWeight: '600' },
  slotValue: { color: C.text, fontSize: 11, fontWeight: '700', marginTop: 2, textAlign: 'center' },
  slotPower: { color: C.dim, fontSize: 10, marginTop: 2 },
});
