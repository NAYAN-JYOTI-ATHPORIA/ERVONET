import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
} from 'react-native';
import { PeerNode } from '../types/ble';
import { MessageRecord } from '../types/message';
import { getSignalQuality } from '../utils/distance';

interface NearbyPeopleBarProps {
  peers: PeerNode[];
  selectedTargetId: string;
  onSelectTarget: (targetId: string) => void;
  messages?: MessageRecord[];
}

export const NearbyPeopleBar: React.FC<NearbyPeopleBarProps> = ({
  peers,
  selectedTargetId,
  onSelectTarget,
  messages = [],
}) => {
  const isEveryoneSelected =
    selectedTargetId === 'BROADCAST' || selectedTargetId === '#all';

  // Peers already arrive deduplicated and self-filtered from bleService.getDeduplicatedPeers()
  const displayPeers = React.useMemo(
    () => peers.filter((p) => p.connectionState === 'CONNECTED' || p.connectionState === 'DISCOVERED'),
    [peers]
  );

  const connectedPeers = displayPeers.filter(
    (p) => p.connectionState === 'CONNECTED'
  );

  return (
    <View style={styles.container}>
      {/* Compact Header Row */}
      <View style={styles.headerRow}>
        <Text style={styles.sectionTitle}>
          NEARBY PEOPLE & TARGETS ({displayPeers.length + 1})
        </Text>
        <Text style={styles.autoHint}>
          {connectedPeers.length > 0
            ? `${connectedPeers.length} Mesh Active`
            : displayPeers.length > 0
            ? `${displayPeers.length} In Range`
            : 'Listening'}
        </Text>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollRow}
      >
        {/* 'Everyone Nearby' Broadcast Card */}
        <TouchableOpacity
          style={[
            styles.card,
            isEveryoneSelected && styles.cardSelected,
          ]}
          onPress={() => onSelectTarget('BROADCAST')}
          activeOpacity={0.75}
        >
          <View style={styles.avatarWrap}>
            <View style={[styles.avatar, styles.broadcastAvatar]}>
              <Text style={styles.broadcastInitial}>ALL</Text>
            </View>
            <View style={[styles.onlineBadge, { backgroundColor: '#38BDF8' }]} />
          </View>
          <Text style={styles.cardName} numberOfLines={1}>
            Everyone
          </Text>
          <Text style={styles.cardDeviceId}>BROADCAST</Text>
          <Text style={styles.cardDist}>All Nearby</Text>
          <View style={styles.factorWrap}>
            <Text style={styles.broadcastFactor}>Mesh Cast</Text>
          </View>
        </TouchableOpacity>

        {/* Real Users Cards with Distance, Signal Strength & Factors */}
        {displayPeers.map((peer) => {
          const username = peer.name || peer.nodeId || 'User';
          const isSelected =
            selectedTargetId === peer.id ||
            selectedTargetId === peer.nodeId ||
            selectedTargetId === username;
          const isConnected = peer.connectionState === 'CONNECTED';
          const signal = getSignalQuality(peer.rssi);

          const directMsgCount = messages.filter(
            (m) =>
              m.direction === 'INCOMING' &&
              (m.packet.senderId === peer.nodeId ||
                m.packet.senderId === peer.id ||
                (!!peer.name && m.packet.senderName === peer.name)) &&
              m.packet.destinationId !== 'BROADCAST' &&
              m.packet.destinationId !== '#all' &&
              !m.packet.destinationId.startsWith('#')
          ).length;

          return (
            <TouchableOpacity
              key={peer.id}
              style={[
                styles.card,
                isSelected && styles.cardSelected,
              ]}
              onPress={() => onSelectTarget(peer.nodeId || peer.id)}
              activeOpacity={0.75}
            >
              <View style={styles.avatarWrap}>
                <View style={styles.avatar}>
                  <Text style={styles.avatarInitials}>
                    {(username[0] || 'U').toUpperCase()}
                  </Text>
                </View>
                <View
                  style={[
                    styles.onlineBadge,
                    {
                      backgroundColor: peer.isMultiHop
                        ? '#A855F7'
                        : isConnected
                        ? '#10B981'
                        : '#38BDF8',
                    },
                  ]}
                />
                {directMsgCount > 0 && (
                  <View style={styles.unreadCountBadge}>
                    <Text style={styles.unreadCountText}>{directMsgCount}</Text>
                  </View>
                )}
              </View>

              <Text style={styles.cardName} numberOfLines={1}>
                {username}
              </Text>

              {/* Fixed Device ID */}
              <Text style={styles.cardDeviceId} numberOfLines={1}>
                {peer.nodeId || 'ERVO-NODE'}
              </Text>

              {/* Distance Factor */}
              <Text style={styles.cardDist} numberOfLines={1}>
                {peer.isMultiHop
                  ? `${peer.hopCount || 2} Hops Relay`
                  : `~${peer.distanceMeters}m • ${isConnected ? 'Active' : 'Nearby'}`}
              </Text>

              {/* Signal Strength & Network Factor */}
              <View style={styles.factorWrap}>
                <Text
                  style={[
                    styles.signalText,
                    { color: peer.isMultiHop ? '#C084FC' : signal.color },
                  ]}
                  numberOfLines={1}
                >
                  {peer.isMultiHop
                    ? (peer.viaNodeId ? `via ${peer.viaNodeId.replace('ERVO-', '').replace('RESQ-', '')}` : 'Dijkstra')
                    : `${peer.rssi} dBm`}
                </Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#090D1A',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#162032',
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 14,
    marginBottom: 6,
  },
  sectionTitle: {
    fontSize: 10,
    fontWeight: '800',
    color: '#64748B',
    letterSpacing: 0.6,
  },
  autoHint: {
    fontSize: 10,
    color: '#10B981',
    fontWeight: '700',
  },
  scrollRow: {
    paddingHorizontal: 12,
    gap: 8,
  },
  card: {
    width: 98,
    backgroundColor: '#0F172A',
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 5,
    alignItems: 'center',
    borderWidth: 1.2,
    borderColor: '#1E293B',
  },
  cardSelected: {
    borderColor: '#38BDF8',
    backgroundColor: '#0C2A44',
  },
  avatarWrap: {
    position: 'relative',
    marginBottom: 4,
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#1E293B',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#334155',
  },
  broadcastAvatar: {
    backgroundColor: '#0284C7',
    borderColor: '#38BDF8',
  },
  broadcastInitial: {
    fontSize: 10,
    fontWeight: '900',
    color: '#FFFFFF',
    letterSpacing: 0.5,
  },
  avatarInitials: {
    fontSize: 12.5,
    fontWeight: '800',
    color: '#38BDF8',
  },
  onlineBadge: {
    position: 'absolute',
    right: -1,
    bottom: -1,
    width: 8.5,
    height: 8.5,
    borderRadius: 4.5,
    backgroundColor: '#10B981',
    borderWidth: 1.2,
    borderColor: '#0F172A',
  },
  cardName: {
    fontSize: 11.5,
    fontWeight: '700',
    color: '#F8FAFC',
    textAlign: 'center',
    width: 88,
  },
  cardDeviceId: {
    fontSize: 8.5,
    fontWeight: '800',
    color: '#38BDF8',
    letterSpacing: 0.3,
    marginTop: 1,
  },
  cardDist: {
    fontSize: 9,
    color: '#94A3B8',
    marginTop: 2,
    textAlign: 'center',
  },
  factorWrap: {
    marginTop: 3,
    paddingHorizontal: 5,
    paddingVertical: 1.5,
    borderRadius: 4,
    backgroundColor: '#070D1A',
  },
  signalText: {
    fontSize: 8.5,
    fontWeight: '700',
  },
  broadcastFactor: {
    fontSize: 8.5,
    fontWeight: '700',
    color: '#38BDF8',
  },
  unreadCountBadge: {
    position: 'absolute',
    top: -4,
    right: -4,
    backgroundColor: '#0284C7',
    borderRadius: 7,
    paddingHorizontal: 4,
    minWidth: 14,
    height: 14,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#38BDF8',
  },
  unreadCountText: {
    fontSize: 7.5,
    fontWeight: '900',
    color: '#FFFFFF',
  },
});
