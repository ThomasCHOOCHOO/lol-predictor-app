import { Tabs } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Text } from 'react-native';
import { PredictionProvider } from '../state/PredictionContext';
import { C } from '../theme';

function TabIcon({ label, focused }: { label: string; focused: boolean }) {
  return <Text style={{ fontSize: 22, opacity: focused ? 1 : 0.45 }}>{label}</Text>;
}

export default function RootLayout() {
  return (
    <PredictionProvider>
      <StatusBar style="light" />
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarStyle: { backgroundColor: '#0B0E14', borderTopColor: '#26304A' },
          tabBarActiveTintColor: C.blue,
          tabBarInactiveTintColor: C.faint,
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: 'Predict',
            tabBarIcon: ({ focused }) => <TabIcon label="🎯" focused={focused} />,
          }}
        />
        <Tabs.Screen
          name="kelly"
          options={{
            title: 'Kelly',
            tabBarIcon: ({ focused }) => <TabIcon label="💰" focused={focused} />,
          }}
        />
        <Tabs.Screen
          name="info"
          options={{
            title: 'Model',
            tabBarIcon: ({ focused }) => <TabIcon label="📊" focused={focused} />,
          }}
        />
      </Tabs>
    </PredictionProvider>
  );
}
