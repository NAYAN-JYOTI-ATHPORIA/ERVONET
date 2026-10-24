import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
} from 'react-native';
import { USER_FRIENDLY_PRESETS, EmergencyPreset } from '../protocol/emergencyAlerts';

interface QuickStatusBarProps {
  onSendPreset: (preset: EmergencyPreset) => void;
  onSendSos: () => void;
}

export const QuickStatusBar: React.FC<QuickStatusBarProps> = ({
  onSendPreset,
  onSendSos,
}) => {
  const handleSosPress = () => {
    Alert.alert(
      'Send Emergency SOS Alert?',
      'This broadcasts an immediate critical distress beacon to ALL nearby phones within Bluetooth reach.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Send SOS Now',
          style: 'destructive',
          onPress: onSendSos,
        },
      ]
    );
  };

  return (
    <View style={styles.container}>
      {/* 1-Tap SOS Emergency Pill */}
      <TouchableOpacity
        style={styles.sosPill}
        onPress={handleSosPress}
        activeOpacity={0.8}
      >
        <Text style={styles.sosText}>SOS</Text>
      </TouchableOpacity>

      <View style={styles.divider} />

      {/* Quick Crisis Preset Chips */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chipsScroll}
      >
        {USER_FRIENDLY_PRESETS.map((preset) => (
          <TouchableOpacity
            key={preset.id}
            style={[
              styles.chip,
              { borderColor: preset.color || '#38BDF8' },
            ]}
            onPress={() => onSendPreset(preset)}
            activeOpacity={0.7}
          >
            <Text style={styles.chipText}>{preset.title}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#090D1A',
    paddingHorizontal: 10,
    paddingVertical: 5,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#162032',
    gap: 8,
  },
  sosPill: {
    backgroundColor: '#DC2626',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 9,
    paddingVertical: 4.5,
    borderRadius: 8,
    gap: 4,
  },
  sosIcon: {
    fontSize: 12,
  },
  sosText: {
    fontSize: 11,
    fontWeight: '900',
    color: '#FFFFFF',
    letterSpacing: 0.5,
  },
  divider: {
    width: 1,
    height: 16,
    backgroundColor: '#1E293B',
  },
  chipsScroll: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingRight: 6,
  },
  chip: {
    backgroundColor: '#111827',
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
  },
  chipText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#CBD5E1',
  },
});
