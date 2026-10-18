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

interface ScannedDevicesSectionProps {
  peers: PeerNode[];
  isScanning: boolean;
  selectedTargetId: string;
  onSelectAndChat: (nodeId: string) => void;
  onConnectPeer: (address: string) => void;
  onDisconnectPeer: (address: string) => void;
  onToggleScan: () => void;
}

const getCleanUsername = (peer: PeerNode): string => {
  if (peer.name && !peer.name.startsWith('Android-') && !peer.name.startsWith('Device')) {
    return peer.name;
  }
  if (
    peer.nodeId &&
    !peer.nodeId.startsWith('Android-') &&
    !peer.nodeId.startsWith('Device') &&
    !peer.nodeId.startsWith('NODE-')
  ) {
    return peer.nodeId;
  }
  return `User (${peer.id.slice(-4).replace(':', '')})`;
};

const getInitials = (name: string): string => {
  const parts = name.trim().split(/[\s-_]+/);
  if (parts.length >= 2 && parts[0] && parts[1]) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return (name[0] || 'U').toUpperCase();
};

export const ScannedDevicesSection: React.FC<ScannedDevicesSectionProps> = ({
  peers,
  isScanning,
  selectedTargetId,
  onSelectAndChat,
  onConnectPeer,
  onDisconnectPeer,
  onToggleScan,
}) => {
  const connectedPeers = peers.filter((p) => p.connectionState === 'CONNECTED');
  const availablePeers = peers.filter((p) => p.connectionState !== 'CONNECTED');

  const renderDeviceCard = (peer: PeerNode, isConnected: boolean) => {
    const isConnecting = peer.connectionState === 'CONNECTING';
    const signal = getSignalQuality(peer.rssi);
    const username = getCleanUsername(peer);
    const initials = getInitials(username);
    const isSelected =
      selectedTargetId === peer.id ||
      selectedTargetId === peer.nodeId ||
      selectedTargetId === username;

    return (
      <View
        key={peer.id}
        style={[
          styles.deviceCard,
          isConnected && styles.connectedDeviceCard,
          isSelected && styles.deviceCardSelected,
        ]}
      >
        {/* Card Header: Avatar with Initials, Username, Signal & Distance */}
        <View style={styles.cardHeaderRow}>
          <View style={styles.avatarWrap}>
            <View
              style={[
                styles.avatar,
                isConnected && styles.connectedAvatar,
              ]}
            >
              <Text
                style={[
                  styles.avatarInitials,
                  isConnected && styles.connectedAvatarInitials,
                ]}
              >
                {initials}
              </Text>
            </View>
            <View
              style={[
                styles.dot,
                isConnected ? styles.dotGreen : styles.dotAmber,
              ]}
            />
          </View>

          <View style={styles.infoCol}>
            <View style={styles.nameRow}>
              <Text style={styles.deviceName} numberOfLines={1}>
                {username}
              </Text>
              <View style={styles.fixedIdBadge}>
                <Text style={styles.fixedIdText}>{peer.nodeId || 'ERVO-NODE'}</Text>
              </View>
              <View
                style={[
                  styles.statusPill,
                  isConnected
                    ? styles.statusPillConnected
                    : isConnecting
                    ? styles.statusPillConnecting
                    : styles.statusPillDiscovered,
                ]}
              >
                <Text
                  style={[
                    styles.statusPillText,
                    isConnected
                      ? styles.statusTextConnected
                      : isConnecting
                      ? styles.statusTextConnecting
                      : styles.statusTextDiscovered,
                  ]}
                >
                  {isConnected
                    ? 'CONNECTED'
                    : isConnecting
                    ? 'CONNECTING...'
                    : 'IN RANGE'}
                </Text>
              </View>
            </View>

            <View style={styles.metaRow}>
              <Text style={styles.distText}>
                ~{peer.distanceMeters}m away
              </Text>
              <Text style={styles.dotSeparator}>•</Text>
              <Text style={[styles.signalText, { color: signal.color }]}>
                {peer.rssi} dBm ({signal.level})
              </Text>
              <Text style={styles.dotSeparator}>•</Text>
              <Text style={styles.lastSeen}>
                {formatTimeAgo(peer.lastSeen)}
              </Text>
            </View>
          </View>
        </View>

        {/* Action Buttons: Clean & High Contrast */}
        <View style={styles.cardActionRow}>
          {isConnected ? (
            <>
              <TouchableOpacity
                style={styles.primaryChatBtn}
                onPress={() => onSelectAndChat(peer.nodeId || username)}
                activeOpacity={0.75}
              >
                <Text style={styles.primaryChatBtnText}>
                  Chat with {username}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.disconnectBtn}
                onPress={() => onDisconnectPeer(peer.id)}
                activeOpacity={0.7}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={styles.disconnectText}>Disconnect</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <TouchableOpacity
                style={[
                  styles.primaryConnectBtn,
                  isConnecting && styles.primaryConnectBtnDisabled,
                ]}
                onPress={() => onConnectPeer(peer.id)}
                disabled={isConnecting}
                activeOpacity={0.75}
              >
                <Text style={styles.primaryConnectBtnText}>
                  {isConnecting
                    ? `Connecting to ${username}...`
                    : `Connect with ${username}`}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.secondaryChatBtn}
                onPress={() => onSelectAndChat(peer.nodeId || username)}
                activeOpacity={0.7}
              >
                <Text style={styles.secondaryChatText}>Chat</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      {/* Sleek Header Bar */}
      <View style={styles.header}>
        <View>
          <View style={styles.titleRow}>
            <Text style={styles.title}>Scanned Devices</Text>
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{peers.length}</Text>
            </View>
          </View>
          <Text style={styles.subtitle}>
            {connectedPeers.length} active in mesh • {availablePeers.length} in direct range
          </Text>
        </View>

        {/* Scan Refresh Action */}
        <TouchableOpacity
          style={[styles.scanBtn, isScanning && styles.scanBtnActive]}
          onPress={onToggleScan}
          activeOpacity={0.7}
        >
          <Text style={styles.scanBtnText}>
            {isScanning ? 'Scanning...' : 'Scan'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Main List */}
      {peers.length === 0 ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>Scanning For Nearby People...</Text>
          <Text style={styles.emptyDesc}>
            ERVONET filters out background Bluetooth noise (smartwatches, TVs, cars). Only real phones running ERVONET will appear here.
          </Text>
          <TouchableOpacity
            style={styles.emptyActionBtn}
            onPress={onToggleScan}
            activeOpacity={0.8}
          >
            <Text style={styles.emptyActionText}>
              {isScanning ? 'Continuous Scanning Active...' : 'Restart BLE Scan'}
            </Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView
          style={styles.list}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
        >
          {/* Section 1: Connected Users */}
          {connectedPeers.length > 0 && (
            <View style={styles.groupSection}>
              <View style={styles.groupHeader}>
                <Text style={styles.groupTitle}>CONNECTED IN MESH</Text>
                <View style={styles.groupBadgeGreen}>
                  <Text style={styles.groupBadgeGreenText}>
                    {connectedPeers.length} Linked
                  </Text>
                </View>
              </View>
              {connectedPeers.map((peer) => renderDeviceCard(peer, true))}
            </View>
          )}

          {/* Section 2: Discovered Users In Range */}
          {availablePeers.length > 0 && (
            <View style={styles.groupSection}>
              <View style={styles.groupHeader}>
                <Text style={styles.groupTitle}>IN RANGE (AVAILABLE)</Text>
                <View style={styles.groupBadgeSlate}>
                  <Text style={styles.groupBadgeSlateText}>
                    {availablePeers.length} Found
                  </Text>
                </View>
              </View>
              {availablePeers.map((peer) => renderDeviceCard(peer, false))}
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#050811', // Pure OLED power saving dark
    paddingHorizontal: 14,
    paddingTop: 10,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  title: {
    fontSize: 17,
    fontWeight: '800',
    color: '#F8FAFC',
    letterSpacing: -0.2,
  },
  badge: {
    backgroundColor: '#0284C7',
    paddingHorizontal: 7,
    paddingVertical: 1.5,
    borderRadius: 10,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  subtitle: {
    fontSize: 11,
    color: '#94A3B8',
    marginTop: 2,
  },
  scanBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#111827',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    gap: 6,
    borderWidth: 1,
    borderColor: '#1F2937',
  },
  scanBtnActive: {
    borderColor: '#0284C7',
    backgroundColor: '#082F49',
  },
  scanBtnIcon: {
    fontSize: 12,
  },
  scanBtnText: {
    fontSize: 11.5,
    fontWeight: '700',
    color: '#F8FAFC',
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingBottom: 20,
    gap: 10,
  },
  groupSection: {
    gap: 6,
  },
  groupHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 2,
  },
  groupTitle: {
    fontSize: 10,
    fontWeight: '800',
    color: '#94A3B8',
    letterSpacing: 0.6,
  },
  groupBadgeGreen: {
    backgroundColor: '#064E3B',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 6,
  },
  groupBadgeGreenText: {
    fontSize: 9,
    fontWeight: '800',
    color: '#34D399',
  },
  groupBadgeSlate: {
    backgroundColor: '#1E293B',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 6,
  },
  groupBadgeSlateText: {
    fontSize: 9,
    fontWeight: '700',
    color: '#94A3B8',
  },
  deviceCard: {
    backgroundColor: '#0F172A',
    borderRadius: 10,
    padding: 9,
    borderWidth: 1,
    borderColor: '#1E293B',
  },
  connectedDeviceCard: {
    borderColor: '#059669',
    backgroundColor: '#06281E',
  },
  deviceCardSelected: {
    borderColor: '#38BDF8',
    backgroundColor: '#0C2A44',
  },
  cardHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
  },
  avatarWrap: {
    position: 'relative',
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#1E293B',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#334155',
  },
  connectedAvatar: {
    borderColor: '#10B981',
    backgroundColor: '#064E3B',
  },
  avatarInitials: {
    fontSize: 13,
    fontWeight: '800',
    color: '#38BDF8',
  },
  connectedAvatarInitials: {
    color: '#34D399',
  },
  dot: {
    position: 'absolute',
    right: -1,
    bottom: -1,
    width: 9,
    height: 9,
    borderRadius: 4.5,
    borderWidth: 1.5,
    borderColor: '#0F172A',
  },
  dotGreen: {
    backgroundColor: '#10B981',
  },
  dotAmber: {
    backgroundColor: '#F59E0B',
  },
  infoCol: {
    flex: 1,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginBottom: 2,
  },
  deviceName: {
    fontSize: 13.5,
    fontWeight: '800',
    color: '#F8FAFC',
    flex: 1,
  },
  fixedIdBadge: {
    backgroundColor: '#0C2A44',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    borderWidth: 0.8,
    borderColor: '#0284C7',
  },
  fixedIdText: {
    fontSize: 9,
    fontWeight: '800',
    color: '#38BDF8',
    letterSpacing: 0.3,
  },
  statusPill: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
  },
  statusPillConnected: {
    backgroundColor: '#064E3B',
  },
  statusPillConnecting: {
    backgroundColor: '#78350F',
  },
  statusPillDiscovered: {
    backgroundColor: '#1E3A8A',
  },
  statusPillText: {
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 0.4,
  },
  statusTextConnected: {
    color: '#34D399',
  },
  statusTextConnecting: {
    color: '#FDE047',
  },
  statusTextDiscovered: {
    color: '#60A5FA',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  distText: {
    fontSize: 10.5,
    color: '#CBD5E1',
    fontWeight: '500',
  },
  dotSeparator: {
    color: '#475569',
    fontSize: 9,
  },
  signalText: {
    fontSize: 10.5,
    fontWeight: '600',
  },
  lastSeen: {
    fontSize: 10,
    color: '#64748B',
  },
  cardActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
    paddingTop: 7,
    borderTopWidth: 1,
    borderTopColor: '#1E293B',
  },
  primaryConnectBtn: {
    flex: 1,
    backgroundColor: '#059669',
    paddingVertical: 7,
    paddingHorizontal: 10,
    borderRadius: 7,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  primaryConnectBtnDisabled: {
    backgroundColor: '#065F46',
    opacity: 0.8,
  },
  primaryConnectBtnText: {
    fontSize: 11.5,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  actionIcon: {
    fontSize: 11.5,
  },
  secondaryChatBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: '#1E293B',
    borderWidth: 1,
    borderColor: '#334155',
    paddingVertical: 6.5,
    paddingHorizontal: 10,
    borderRadius: 7,
  },
  secondaryChatIcon: {
    fontSize: 11,
  },
  secondaryChatText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#E2E8F0',
  },
  primaryChatBtn: {
    flex: 1,
    backgroundColor: '#0284C7',
    paddingVertical: 7,
    paddingHorizontal: 10,
    borderRadius: 7,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  primaryChatBtnText: {
    fontSize: 11.5,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  disconnectBtn: {
    paddingHorizontal: 8,
    paddingVertical: 6.5,
    borderRadius: 6,
    backgroundColor: '#1E293B',
  },
  disconnectText: {
    fontSize: 10.5,
    fontWeight: '700',
    color: '#F87171',
  },
  emptyCard: {
    backgroundColor: '#0F172A',
    borderRadius: 14,
    padding: 24,
    alignItems: 'center',
    marginTop: 20,
    borderWidth: 1,
    borderColor: '#1E293B',
  },
  emptyIconCircle: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#1E293B',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  emptyIcon: {
    fontSize: 28,
  },
  emptyTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: '#F8FAFC',
    marginBottom: 6,
  },
  emptyDesc: {
    fontSize: 12,
    color: '#94A3B8',
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: 16,
  },
  emptyActionBtn: {
    backgroundColor: '#0284C7',
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 8,
  },
  emptyActionText: {
    fontSize: 12,
    fontWeight: '800',
    color: '#FFFFFF',
  },
});
