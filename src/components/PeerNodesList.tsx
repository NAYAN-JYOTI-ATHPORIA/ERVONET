import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
} from 'react-native';
import { PeerNode } from '../types/ble';
import { getSignalQuality } from '../utils/distance';
import { formatTimeAgo } from '../utils/formatters';

interface PeerNodesListProps {
  peers: PeerNode[];
  selectedTargetId: string;
  isScanning: boolean;
  onSelectTarget: (nodeId: string) => void;
  onConnectPeer: (address: string) => void;
  onDisconnectPeer: (address: string) => void;
  onStartScan: () => void;
}

export const PeerNodesList: React.FC<PeerNodesListProps> = ({
  peers,
  selectedTargetId,
  isScanning,
  onSelectTarget,
  onConnectPeer,
  onDisconnectPeer,
  onStartScan,
}) => {
  return (
    <View style={styles.container}>
      <View style={styles.sectionHeader}>
        <View style={styles.headerLeft}>
          <Text style={styles.sectionTitle}>NEARBY MOBILE NODES</Text>
          <View style={styles.counterBadge}>
            <Text style={styles.counterText}>{peers.length}</Text>
          </View>
        </View>
        <Text style={styles.autoScanStatus}>
          {isScanning ? '⚡ Auto-Scanning' : '⏸️ Scanning Paused'}
        </Text>
      </View>

      {peers.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyIcon}>📡</Text>
          <Text style={styles.emptyTitle}>No Nearby ERVONET Nodes Detected</Text>
          <Text style={styles.emptySubtitle}>
            Bring another Android device nearby with ERVONET active, or tap Auto-Scan to start discovery.
          </Text>
          {!isScanning && (
            <TouchableOpacity style={styles.emptyScanBtn} onPress={onStartScan}>
              <Text style={styles.emptyScanBtnText}>Start Auto-Scan</Text>
            </TouchableOpacity>
          )}
        </View>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.scrollList}
        >
          {peers.map((peer) => {
            const isSelected = selectedTargetId === peer.id || selectedTargetId === peer.nodeId;
            const isConnected = peer.connectionState === 'CONNECTED';
            const isConnecting = peer.connectionState === 'CONNECTING';
            const signal = getSignalQuality(peer.rssi);

            return (
              <View
                key={peer.id}
                style={[
                  styles.nodeCard,
                  isSelected && styles.selectedNodeCard,
                  isConnected && styles.connectedNodeCard,
                ]}
              >
                {/* Top Row: Node ID & State Badge */}
                <View style={styles.cardTop}>
                  <View>
                    <Text style={styles.nodeIdText}>{peer.nodeId}</Text>
                    <Text style={styles.deviceNameText} numberOfLines={1}>
                      {peer.name}
                    </Text>
                  </View>
                  <View
                    style={[
                      styles.stateBadge,
                      isConnected
                        ? styles.stateBadgeConnected
                        : isConnecting
                        ? styles.stateBadgeConnecting
                        : styles.stateBadgeDiscovered,
                    ]}
                  >
                    <Text
                      style={[
                        styles.stateBadgeText,
                        isConnected
                          ? styles.stateTextConnected
                          : isConnecting
                          ? styles.stateTextConnecting
                          : styles.stateTextDiscovered,
                      ]}
                    >
                      {peer.connectionState}
                    </Text>
                  </View>
                </View>

                {/* Role Pill */}
                <View style={styles.rolePill}>
                  <Text style={styles.roleText}>🛡️ {peer.role}</Text>
                </View>

                {/* Signal RSSI & Distance Row */}
                <View style={styles.signalRow}>
                  {/* Visual 4-bar Signal Meter */}
                  <View style={styles.signalBars}>
                    {[1, 2, 3, 4].map((bar) => (
                      <View
                        key={bar}
                        style={[
                          styles.barSegment,
                          { height: bar * 3 + 4 },
                          bar <= signal.bars
                            ? { backgroundColor: signal.color }
                            : styles.barInactive,
                        ]}
                      />
                    ))}
                  </View>
                  <View style={styles.signalDetails}>
                    <Text style={[styles.rssiValue, { color: signal.color }]}>
                      {peer.rssi} dBm
                    </Text>
                    <Text style={styles.distanceValue}>
                      ~{peer.distanceMeters}m away
                    </Text>
                  </View>
                  <Text style={styles.lastSeenText}>
                    {formatTimeAgo(peer.lastSeen)}
                  </Text>
                </View>

                {/* Actions: Target & Connect */}
                <View style={styles.cardActions}>
                  <TouchableOpacity
                    style={[
                      styles.targetBtn,
                      isSelected && styles.targetBtnActive,
                    ]}
                    onPress={() => onSelectTarget(peer.nodeId)}
                  >
                    <Text
                      style={[
                        styles.targetBtnText,
                        isSelected && styles.targetBtnTextActive,
                      ]}
                    >
                      {isSelected ? '✓ TARGET SELECTED' : '🎯 TARGET NODE'}
                    </Text>
                  </TouchableOpacity>

                  {isConnected ? (
                    <TouchableOpacity
                      style={styles.disconnectBtn}
                      onPress={() => onDisconnectPeer(peer.id)}
                    >
                      <Text style={styles.disconnectBtnText}>DISCONNECT</Text>
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity
                      style={[
                        styles.connectBtn,
                        isConnecting && styles.connectBtnDisabled,
                      ]}
                      disabled={isConnecting}
                      onPress={() => onConnectPeer(peer.id)}
                    >
                      <Text style={styles.connectBtnText}>
                        {isConnecting ? 'LINKING...' : 'CONNECT'}
                      </Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#0B1120',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1E293B',
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: '#94A3B8',
    letterSpacing: 0.5,
  },
  counterBadge: {
    backgroundColor: '#0284C7',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 10,
  },
  counterText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  autoScanStatus: {
    fontSize: 11,
    color: '#38BDF8',
    fontWeight: '600',
  },
  scrollList: {
    paddingHorizontal: 16,
    gap: 12,
  },
  nodeCard: {
    width: 250,
    backgroundColor: '#1E293B',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1.5,
    borderColor: '#334155',
  },
  selectedNodeCard: {
    borderColor: '#38BDF8',
    backgroundColor: '#0F2942',
  },
  connectedNodeCard: {
    borderColor: '#10B981',
  },
  cardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 6,
  },
  nodeIdText: {
    fontSize: 15,
    fontWeight: '800',
    color: '#F8FAFC',
  },
  deviceNameText: {
    fontSize: 11,
    color: '#94A3B8',
    width: 120,
  },
  stateBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  stateBadgeConnected: {
    backgroundColor: '#064E3B',
  },
  stateBadgeConnecting: {
    backgroundColor: '#1E3A8A',
  },
  stateBadgeDiscovered: {
    backgroundColor: '#451A03',
  },
  stateBadgeText: {
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  stateTextConnected: {
    color: '#34D399',
  },
  stateTextConnecting: {
    color: '#60A5FA',
  },
  stateTextDiscovered: {
    color: '#FBBF24',
  },
  rolePill: {
    backgroundColor: '#0F172A',
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    marginBottom: 8,
  },
  roleText: {
    fontSize: 10,
    color: '#CBD5E1',
    fontWeight: '600',
  },
  signalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0F172A',
    borderRadius: 8,
    padding: 8,
    marginBottom: 10,
    gap: 8,
  },
  signalBars: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 2,
    height: 16,
    width: 20,
  },
  barSegment: {
    width: 3.5,
    borderRadius: 1,
  },
  barInactive: {
    backgroundColor: '#334155',
  },
  signalDetails: {
    flex: 1,
  },
  rssiValue: {
    fontSize: 11,
    fontWeight: '700',
  },
  distanceValue: {
    fontSize: 10,
    color: '#94A3B8',
  },
  lastSeenText: {
    fontSize: 9,
    color: '#64748B',
  },
  cardActions: {
    gap: 6,
  },
  targetBtn: {
    backgroundColor: '#334155',
    paddingVertical: 6,
    borderRadius: 6,
    alignItems: 'center',
  },
  targetBtnActive: {
    backgroundColor: '#0284C7',
  },
  targetBtnText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#CBD5E1',
  },
  targetBtnTextActive: {
    color: '#FFFFFF',
  },
  connectBtn: {
    backgroundColor: '#059669',
    paddingVertical: 6,
    borderRadius: 6,
    alignItems: 'center',
  },
  connectBtnDisabled: {
    backgroundColor: '#1E3A8A',
  },
  connectBtnText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  disconnectBtn: {
    backgroundColor: '#7F1D1D',
    paddingVertical: 6,
    borderRadius: 6,
    alignItems: 'center',
  },
  disconnectBtnText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#FCA5A5',
  },
  emptyState: {
    marginHorizontal: 16,
    backgroundColor: '#1E293B',
    borderRadius: 12,
    padding: 20,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#334155',
  },
  emptyIcon: {
    fontSize: 32,
    marginBottom: 8,
  },
  emptyTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#F8FAFC',
    marginBottom: 4,
  },
  emptySubtitle: {
    fontSize: 11,
    color: '#94A3B8',
    textAlign: 'center',
    lineHeight: 16,
    marginBottom: 12,
  },
  emptyScanBtn: {
    backgroundColor: '#0284C7',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
  },
  emptyScanBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#FFFFFF',
  },
});

