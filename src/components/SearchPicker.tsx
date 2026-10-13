import React, { useMemo, useState } from 'react';
import {
  FlatList,
  Modal,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { C, S } from '../theme';

export interface PickerItem {
  key: string;
  title: string;
  subtitle?: string;
}

interface Props {
  visible: boolean;
  title: string;
  placeholder: string;
  items: PickerItem[];
  onSearch: (q: string) => PickerItem[];
  onSelect: (item: PickerItem) => void;
  onClose: () => void;
  accent?: string;
}

/** Full-screen searchable list modal, iOS-native feel. */
export function SearchPicker({ visible, title, placeholder, items, onSearch, onSelect, onClose, accent }: Props) {
  const [q, setQ] = useState('');
  const results = useMemo(() => onSearch(q), [q, onSearch]);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={[S.screen, { paddingTop: 8 }]}>
        <View style={styles.header}>
          <Text style={S.h2}>{title}</Text>
          <Pressable onPress={() => { setQ(''); onClose(); }} hitSlop={12}>
            <Text style={[styles.done, { color: accent ?? C.blue }]}>Done</Text>
          </Pressable>
        </View>
        <View style={{ paddingHorizontal: 16, marginBottom: 8 }}>
          <TextInput
            style={S.input}
            placeholder={placeholder}
            placeholderTextColor={C.faint}
            value={q}
            onChangeText={setQ}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            clearButtonMode="while-editing"
          />
        </View>
        <FlatList
          data={results}
          keyExtractor={(i) => i.key}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [styles.row, pressed && { backgroundColor: C.card2 }]}
              onPress={() => { setQ(''); onSelect(item); }}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.title}>{item.title}</Text>
                {!!item.subtitle && <Text style={styles.sub}>{item.subtitle}</Text>}
              </View>
              <Text style={[styles.chev, { color: accent ?? C.blue }]}>›</Text>
            </Pressable>
          )}
          ListEmptyComponent={<Text style={[S.dim, { textAlign: 'center', marginTop: 32 }]}>No matches</Text>}
        />
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  done: { fontSize: 16, fontWeight: '600' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.border,
  },
  title: { color: C.text, fontSize: 16, fontWeight: '600' },
  sub: { color: C.dim, fontSize: 13, marginTop: 2 },
  chev: { fontSize: 22, fontWeight: '400' },
});
