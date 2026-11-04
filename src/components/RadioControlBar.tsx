import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Switch,
} from 'react-native';
import { RadioState } from '../types/ble';

interface RadioControlBarProps {
  radioState: RadioState;
  onToggleScan: () => void;
  onToggleAdvertising: () => void;
  onToggleAutoConnect: (enabled: boolean) => void;
}

export const RadioControlBar: React.FC<RadioControlBarProps> = ({
  radioState,
  onToggleScan,
  onToggleAdvertising,
  onToggleAutoConnect,
}) => {
  return (
    <View style={styles.container}>
      {/* Primary Toggle Action Cards */}
      <View style={styles.buttonRow}>
        {/* Auto Scan Toggle Button */}
        <TouchableOpacity
          style={[
            styles.actionButton,
            radioState.isScanning ? styles.activeScanBtn : styles.inactiveBtn,
          ]}
          onPress={onToggleScan}
          activeOpacity={0.8}
        >
          <View style={styles.btnHeader}>
            <Text style={styles.btnIcon}>
              {radioState.isScanning ? '🔍' : '⭕'}
            </Text>
            <View
              style={[
                styles.pulseIndicator,
                radioState.isScanning && styles.pulseActive,
              ]}
            />
          </View>
          <Text style={styles.btnTitle}>BLE AUTO-SCAN</Text>
          <Text style={styles.btnStatus}>
            {radioState.isScanning ? 'ACTIVE • SCANNING' : 'STOPPED • TAP TO RUN'}
          </Text>
        </TouchableOpacity>

        {/* BLE Advertising Toggle Button */}
        <TouchableOpacity
          style={[
            styles.actionButton,
            radioState.isAdvertising ? styles.activeAdvBtn : styles.inactiveBtn,
          ]}
          onPress={onToggleAdvertising}
          activeOpacity={0.8}
        >
          <View style={styles.btnHeader}>
            <Text style={styles.btnIcon}>
              {radioState.isAdvertising ? '📶' : '📴'}
            </Text>
            <View
              style={[
                styles.pulseIndicator,
                radioState.isAdvertising && styles.pulseAdvActive,
              ]}
            />
          </View>
          <Text style={styles.btnTitle}>BLE BEACON / ADV</Text>
          <Text style={styles.btnStatus}>
            {radioState.isAdvertising ? 'BROADCASTING NODE' : 'MUTED • NOT DISCOVERABLE'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Auto Connect & Stats Strip */}
      <View style={styles.statsStrip}>
        <View style={styles.autoConnectRow}>
          <Text style={styles.autoConnectLabel}>Auto-Connect Peers</Text>
          <Switch
            value={radioState.autoConnect}
            onValueChange={onToggleAutoConnect}
            trackColor={{ false: '#334155', true: '#0284C7' }}
            thumbColor={radioState.autoConnect ? '#38BDF8' : '#94A3B8'}
            style={styles.switchStyle}
          />
        </View>

        <View style={styles.metricsPills}>
          <View style={styles.statPill}>
            <Text style={styles.statNumber}>{radioState.discoveredCount}</Text>
            <Text style={styles.statLabel}>Discovered</Text>
          </View>

          <View style={styles.statDivider} />

          <View style={styles.statPill}>
            <Text style={[styles.statNumber, { color: '#10B981' }]}>
              {radioState.connectedCount}
            </Text>
            <Text style={styles.statLabel}>Connected</Text>
          </View>
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#0F172A',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 10,
  },
  actionButton: {
    flex: 1,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1.5,
  },
  activeScanBtn: {
    backgroundColor: '#0C4A6E',
    borderColor: '#38BDF8',
  },
  activeAdvBtn: {
    backgroundColor: '#064E3B',
    borderColor: '#34D399',
  },
  inactiveBtn: {
    backgroundColor: '#1E293B',
    borderColor: '#334155',
  },
  btnHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  btnIcon: {
    fontSize: 18,
  },
  pulseIndicator: {
    width: 9,
    height: 9,
    borderRadius: 4.5,
    backgroundColor: '#475569',
  },
  pulseActive: {
    backgroundColor: '#38BDF8',
  },
  pulseAdvActive: {
    backgroundColor: '#10B981',
  },
  btnTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: '#F8FAFC',
    letterSpacing: 0.5,
  },
  btnStatus: {
    fontSize: 9,
    fontWeight: '700',
    color: '#94A3B8',
    marginTop: 3,
  },
  statsStrip: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#1E293B',
    marginTop: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
  },
  autoConnectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  autoConnectLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#E2E8F0',
  },
  switchStyle: {
    transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }],
  },
  metricsPills: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  statPill: {
    alignItems: 'center',
  },
  statNumber: {
    fontSize: 15,
    fontWeight: '800',
    color: '#38BDF8',
  },
  statLabel: {
    fontSize: 10,
    color: '#94A3B8',
    fontWeight: '500',
  },
  statDivider: {
    width: 1,
    height: 20,
    backgroundColor: '#334155',
  },
});

