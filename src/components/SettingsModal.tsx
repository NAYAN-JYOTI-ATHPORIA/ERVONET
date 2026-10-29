import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  ScrollView,
  Switch,
} from 'react-native';
import { RadioState } from '../types/ble';
import { NetworkMetrics } from '../types/metrics';
import { Alert } from 'react-native';

interface SettingsModalProps {
  visible: boolean;
  radioState: RadioState;
  metrics: NetworkMetrics;
  onToggleMode: () => void;
  onToggleScan: () => void;
  onToggleAdvertising: () => void;
  onToggleAutoConnect: (enabled: boolean) => void;
  onWipeData?: () => void;
  onClose: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  visible,
  radioState,
  metrics,
  onToggleMode,
  onToggleScan,
  onToggleAdvertising,
  onToggleAutoConnect,
  onWipeData,
  onClose,
}) => {
  const isSim = radioState.operatingMode === 'SIMULATION_TESTBED';

  const handlePanicWipe = () => {
    Alert.alert(
      'Confirm Emergency Wipe',
      'This will instantly purge all local messages, outbox queues, peer connections, and mesh routing history from this phone. This action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'WIPE EVERYTHING',
          style: 'destructive',
          onPress: () => {
            if (onWipeData) onWipeData();
            onClose();
          },
        },
      ]
    );
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={true}
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          {/* Header */}
          <View style={styles.header}>
            <View>
              <Text style={styles.title}>ERVONET Engine Controls</Text>
              <Text style={styles.sub}>
                Emergency Relay Via Offline Nodes for Emergency Transmission
              </Text>
            </View>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
              <Text style={styles.closeText}>✕</Text>
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.body} showsVerticalScrollIndicator={false}>
            {/* Mode Switch Card */}
            <View style={styles.card}>
              <Text style={styles.cardTitle}>ENGINE OPERATING MODE</Text>
              <View style={styles.toggleRow}>
                <View style={styles.toggleLabelWrap}>
                  <Text style={styles.toggleLabel}>
                    {isSim ? 'Simulation Testbed Mode' : 'Physical BLE Hardware'}
                  </Text>
                  <Text style={styles.toggleDesc}>
                    {isSim
                      ? 'Simulates nearby phones for quick UI testing.'
                      : 'Uses real Bluetooth LE radio on this phone.'}
                  </Text>
                </View>
                <TouchableOpacity
                  style={[
                    styles.modeSwitchBtn,
                    isSim ? styles.simActiveBtn : styles.nativeActiveBtn,
                  ]}
                  onPress={onToggleMode}
                >
                  <Text style={styles.modeSwitchText}>
                    {isSim ? 'Switch to BLE' : 'Switch to Sim'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* Bluetooth Radio Settings */}
            <View style={styles.card}>
              <Text style={styles.cardTitle}>RADIO SETTINGS</Text>

              <View style={styles.settingRow}>
                <View>
                  <Text style={styles.settingLabel}>Auto-Scan Nearby Devices</Text>
                  <Text style={styles.settingSub}>
                    Continuously searches for nearby ERVONET phones
                  </Text>
                </View>
                <Switch
                  value={radioState.isScanning}
                  onValueChange={onToggleScan}
                  trackColor={{ false: '#334155', true: '#0284C7' }}
                  thumbColor={radioState.isScanning ? '#38BDF8' : '#94A3B8'}
                />
              </View>

              <View style={styles.settingRow}>
                <View>
                  <Text style={styles.settingLabel}>Beacon / Advertising</Text>
                  <Text style={styles.settingSub}>
                    Allows other phones to detect you
                  </Text>
                </View>
                <Switch
                  value={radioState.isAdvertising}
                  onValueChange={onToggleAdvertising}
                  trackColor={{ false: '#334155', true: '#059669' }}
                  thumbColor={radioState.isAdvertising ? '#34D399' : '#94A3B8'}
                />
              </View>

              <View style={[styles.settingRow, { borderBottomWidth: 0 }]}>
                <View>
                  <Text style={styles.settingLabel}>Auto-Connect</Text>
                  <Text style={styles.settingSub}>
                    Automatically links to discovered devices
                  </Text>
                </View>
                <Switch
                  value={radioState.autoConnect}
                  onValueChange={onToggleAutoConnect}
                  trackColor={{ false: '#334155', true: '#0284C7' }}
                  thumbColor={radioState.autoConnect ? '#38BDF8' : '#94A3B8'}
                />
              </View>
            </View>

            {/* Paper Diagnostic Metrics (Summary) */}
            <View style={styles.card}>
              <Text style={styles.cardTitle}>RESEARCH EVALUATION METRICS</Text>
              <View style={styles.metricsGrid}>
                <View style={styles.metricItem}>
                  <Text style={styles.metricNumber}>
                    {metrics.packetDeliveryRatio}%
                  </Text>
                  <Text style={styles.metricName}>Delivery Ratio</Text>
                </View>

                <View style={styles.metricItem}>
                  <Text style={styles.metricNumber}>
                    {metrics.avgLatencyMs || '< 45'} ms
                  </Text>
                  <Text style={styles.metricName}>Avg Latency</Text>
                </View>

                <View style={styles.metricItem}>
                  <Text style={styles.metricNumber}>
                    {metrics.activeLinksCount}
                  </Text>
                  <Text style={styles.metricName}>Active Links</Text>
                </View>

                <View style={styles.metricItem}>
                  <Text style={styles.metricNumber}>
                    {metrics.totalRelayed}
                  </Text>
                  <Text style={styles.metricName}>Mesh Relays</Text>
                </View>

                <View style={styles.metricItem}>
                  <Text style={styles.metricNumber}>
                    {metrics.duplicatesDropped}
                  </Text>
                  <Text style={styles.metricName}>Duplicates Filtered</Text>
                </View>
              </View>
            </View>

            {/* BitChat Emergency Panic Wipe Card */}
            <View style={[styles.card, styles.panicCard]}>
              <Text style={[styles.cardTitle, { color: '#EF4444' }]}>
                EMERGENCY PANIC WIPE (DATA PRIVACY)
              </Text>
              <Text style={styles.panicDesc}>
                Instantly clear all cached messages, peer identities, outbox queues, and mesh routing logs from local memory in crisis situations.
              </Text>
              <TouchableOpacity
                style={styles.panicBtn}
                onPress={handlePanicWipe}
                activeOpacity={0.8}
              >
                <Text style={styles.panicBtnText}>PURGE ALL LOCAL DATA</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>

          <TouchableOpacity style={styles.doneBtn} onPress={onClose}>
            <Text style={styles.doneBtnText}>CLOSE</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.75)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#0F172A',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '85%',
    padding: 16,
    borderWidth: 1,
    borderColor: '#334155',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#1E293B',
    paddingBottom: 10,
  },
  title: {
    fontSize: 15,
    fontWeight: '800',
    color: '#F8FAFC',
  },
  sub: {
    fontSize: 11,
    color: '#94A3B8',
    marginTop: 2,
  },
  closeBtn: {
    padding: 6,
    backgroundColor: '#1E293B',
    borderRadius: 8,
  },
  closeText: {
    color: '#CBD5E1',
    fontWeight: '700',
  },
  body: {
    marginBottom: 14,
  },
  card: {
    backgroundColor: '#1E293B',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#334155',
  },
  cardTitle: {
    fontSize: 10,
    fontWeight: '800',
    color: '#64748B',
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  toggleLabelWrap: {
    flex: 1,
    marginRight: 10,
  },
  toggleLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: '#F8FAFC',
  },
  toggleDesc: {
    fontSize: 11,
    color: '#94A3B8',
    marginTop: 2,
  },
  modeSwitchBtn: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
  },
  simActiveBtn: {
    backgroundColor: '#4338CA',
  },
  nativeActiveBtn: {
    backgroundColor: '#059669',
  },
  modeSwitchText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  settingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
  },
  settingLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#F8FAFC',
  },
  settingSub: {
    fontSize: 10,
    color: '#94A3B8',
    marginTop: 1,
  },
  metricsGrid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  metricItem: {
    alignItems: 'center',
  },
  metricNumber: {
    fontSize: 16,
    fontWeight: '800',
    color: '#38BDF8',
  },
  metricName: {
    fontSize: 9,
    color: '#94A3B8',
    marginTop: 2,
  },
  doneBtn: {
    backgroundColor: '#0284C7',
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  doneBtnText: {
    fontSize: 13,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  panicCard: {
    borderColor: '#7F1D1D',
    backgroundColor: '#1E1215',
    marginTop: 10,
  },
  panicDesc: {
    fontSize: 11,
    color: '#F87171',
    lineHeight: 16,
    marginBottom: 10,
  },
  panicBtn: {
    backgroundColor: '#DC2626',
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  panicBtnText: {
    color: '#FFFFFF',
    fontWeight: '800',
    fontSize: 12,
    letterSpacing: 0.5,
  },
});

